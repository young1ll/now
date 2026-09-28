// 하이브리드 회상(recall) — 어휘(FTS/LIKE) · 의미(벡터 KNN) · 관계(그래프) · 직접 참조를 순위 융합(RRF)으로 합친다
// (docs/MEMORY.md §5). 벡터는 캐시다: 활성 공간이 없거나, 벡터가 꺼졌거나, 질의 임베딩이 실패하면
// 의미 목록만 빠지고 어휘 + 관계로 그대로 동작한다 (실패는 degraded 로 알린다).
import type { DB } from "@/lib/db";
import { IN_JSON, jsonList } from "@/lib/db/sql";
import { edgesOf, nodeInfo, parseRef } from "@/lib/ontology/graph";
import { OBJECT_TYPES, type ObjectType, type Ref, refKey } from "@/lib/ontology/types";
import { activeSpace } from "@/lib/repos/embeddings";
import type { Scope } from "@/lib/repos/scope";
import { embedQuery, outageUntil } from "./embedder";
import { ensureIndexed } from "./indexer";
import { attachVectors, knn, vectorStoreInfo, vectorsEnabled } from "./vectors";

/** hybrid = 참조 + 어휘 + 의미 + 관계 (+ 주변) · lexical = 참조 + 어휘 · vector = 의미만 (평가용) */
export type RecallMode = "hybrid" | "lexical" | "vector";
export type Why = "ref" | "lexical" | "semantic" | "graph" | "about";

export type RecallQuery = {
  query: string;
  /** 이 객체 주변을 우선 (예: 지금 보고 있는 고객) */
  about?: Ref;
  scope?: Scope;
  types?: ObjectType[];
  k?: number;
  mode?: RecallMode;
  /** 대체·보관된 기억(superseded · retired)도 포함 (기본 제외) */
  includeInactive?: boolean;
};

export type RecallHit = {
  ref: Ref;
  key: string;
  displayId: string;
  title: string;
  status?: { label: string; tone: string };
  businessId: number | null;
  score: number;
  why: Why[];
  /** 어휘 일치한 검색어 */
  matched: string[];
  snippet: string;
  /** 관계로 들어온 경우: 어느 결과에서 어떤 링크로 */
  via?: { from: string; label: string };
  /** 의미 목록으로 들어온 경우: 가장 가까운 구획의 코사인 유사도 */
  similarity?: number;
  /** 기억이면 원래 상태·오염 여부 (점수에 상태 가중이 곱해져 있다) */
  memory?: { status: string; tainted: boolean; kind: string };
  /** 문서면 종류(note · playbook · episode · brief · source)·오염 여부 (오염이면 점수 ×0.7) */
  note?: { kind: string; tainted: boolean };
};

export type RecallResult = {
  hits: RecallHit[];
  terms: string[];
  tookMs: number;
  /** 의미 검색에 쓴 공간 (없으면 어휘 + 관계만) */
  vector: { space: string; model: string } | null;
  /** 의미 검색을 시도했지만 못 한 이유 (공급자 장애 등) — 결과는 어휘 + 관계 */
  degraded?: string;
};

export type RecallOpts = {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  /** 질의 임베딩 시간 제한 (기본 embedder.QUERY_TIMEOUT_MS — 요청 경로라 짧다) */
  queryTimeoutMs?: number;
};

// ── 검색어 분석 ───────────────────────────────────────

const STOP = new Set(["누가", "누구", "언제", "어디", "어디서", "무엇", "뭐", "무슨", "어떤", "어떻게", "왜", "관련", "대한", "대해", "관해", "있는", "있나", "알려줘", "찾아줘", "보여줘", "것", "좀", "the", "a", "an", "of", "for", "and", "or", "to", "in"]);
const ENDINGS = ["했는지", "하는지", "했나요", "했어요", "합니까", "하나요", "인가요", "했나", "했어", "했던", "했다", "하는", "인가", "인지", "나요", "해줘", "할"];
const JOSA = ["에게서", "으로써", "으로서", "에서는", "이라는", "에게", "에서", "까지", "부터", "으로", "라는", "처럼", "보다", "하고", "이나", "이랑", "과", "와", "은", "는", "이", "가", "을", "를", "의", "에", "로", "도", "만", "랑"];
const HANGUL_END = /[\uac00-\ud7a3]$/;

function strip(word: string, suffixes: string[]): string {
  if (!HANGUL_END.test(word)) return word;
  for (const s of suffixes) if (word.endsWith(s) && [...word].length - [...s].length >= 2) return word.slice(0, -s.length);
  return word;
}

export type Term = { text: string; forms: string[] };

/** 유형을 가리키는 말. 한국어 명사구는 핵심어가 끝에 오므로("Acme 담당 업무") 마지막 검색어만 유형 힌트로 쓴다. */
const TYPE_WORDS: Record<string, ObjectType> = {
  고객: "client", 거래처: "client", 리드: "client", 업무: "task", 할일: "task", 작업: "task", 청구서: "invoice", 인보이스: "invoice",
  문서: "note", 노트: "note", 메모: "note", 지출: "expense", 비용: "expense", 에이전트: "agent", 사업: "business", 기억: "memory",
};

/** 질의당 검색어·객체 참조 상한 — 긴 질의(붙여 넣은 문서)가 SQL 식 깊이·비용을 키우지 않게. 앞에서부터 쓴다 */
export const MAX_TERMS = 64;
export const MAX_QUERY_REFS = 32;

/** 검색어 → (원형, 조사·어미 뗀 형태). 둘 중 하나만 맞아도 일치로 본다 (명사 끝 글자가 조사처럼 생긴 경우 대비). */
export function analyze(query: string): { terms: Term[]; refs: Ref[]; typeHint?: ObjectType } {
  const refs: Ref[] = [];
  const terms: Term[] = [];
  const seen = new Set<string>();
  // 제어 문자(NUL 등)는 구분자로 — FTS MATCH 구문에 들어가면 SQLite 가 문자열을 끝내지 못한다
  for (const raw of query.normalize("NFKC").replace(/\p{Cc}/gu, " ").split(/[\s,.;!?"'`()[\]{}<>/\\|]+/)) {
    if (!raw) continue;
    const r = parseRef(raw);
    if (r) {
      if (refs.length < MAX_QUERY_REFS) refs.push(r);
      continue;
    }
    if (terms.length >= MAX_TERMS) continue;
    const w = raw.toLowerCase().replace(/^[-:#*]+|[-:#*]+$/g, "");
    if (!w || STOP.has(w)) continue;
    const base = strip(strip(w, ENDINGS), JOSA);
    if (STOP.has(base)) continue;
    const forms = [...new Set([w, base])].filter((f) => [...f].length >= 2);
    if (!forms.length || seen.has(base)) continue;
    seen.add(base);
    terms.push({ text: base, forms });
  }
  const last = terms.at(-1)?.text;
  const typeHint = terms.length > 1 && last && Object.hasOwn(TYPE_WORDS, last) ? TYPE_WORDS[last] : undefined;
  return { terms, refs, typeHint };
}

// ── 어휘 ─────────────────────────────────────────────

type ChunkRow = { id: number; owner_type: ObjectType; owner_id: number; business_id: number | null; seq: number; text: string };

const scopeSql = (scope: Scope | undefined, col = "business_id") =>
  scope === null || scope === undefined ? (["", []] as const) : ([` AND (${col} = ? OR ${col} IS NULL)`, [scope]] as const);

/** 작은 색인에서는 2글자 검색어를 LIKE 로 정확히(어절 중간 — "법인카드"의 "카드" — 까지), 큰 색인에서는 어절 접두 FTS 로 */
const LIKE_MAX = 5000;
/** 문서빈도 상한 — 이보다 흔한 검색어는 idf 가 어차피 바닥이라 끝까지 셀 필요가 없다 */
const DF_CAP = 5000;
/** 질의당 bm25 상위 후보 수 */
const POOL_PER_QUERY = 1000;
/** 제목 줄 일치의 bm25 가중치 */
const HEAD_WEIGHT = 5;
const KNOWN = new Set<string>(OBJECT_TYPES);

const phrase = (f: string) => `"${f.replaceAll('"', '""')}"`;
const likeOf = (f: string) => `%${f.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

type Source = { sql: string; args: unknown[] };

/** 검색어 형태 하나를 찾는 조건 (FTS trigram · FTS 어절 접두 · LIKE) */
function sourceFor(form: string, small: boolean): Source & { table?: string } {
  if ([...form].length >= 3) return { table: "chunks_fts", sql: "", args: [phrase(form)] };
  if (small) return { sql: "text LIKE ? ESCAPE '\\'", args: [likeOf(form)] };
  return { table: "chunks_words", sql: "", args: [`${phrase(form)}*`] };
}

function ftsQuery(db: DB, table: string, match: string, scope: Scope | undefined, limit: number): number[] {
  const [sc, sp] = scopeSql(scope, "c.business_id");
  const join = sc ? "JOIN chunks c ON c.id = f.rowid" : "";
  return (db.prepare(`SELECT f.rowid AS id FROM ${table} f ${join} WHERE ${table} MATCH ?${sc} ORDER BY bm25(${table}, ${HEAD_WEIGHT}, 1) LIMIT ?`).all(match, ...sp, limit) as { id: number }[]).map((r) => r.id);
}

function docFreq(db: DB, src: Source & { table?: string }, scope: Scope | undefined): number {
  if (src.table) {
    const [sc, sp] = scopeSql(scope, "c.business_id");
    const join = sc ? "JOIN chunks c ON c.id = f.rowid" : "";
    return (db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${src.table} f ${join} WHERE ${src.table} MATCH ?${sc} LIMIT ${DF_CAP})`).get(src.args[0], ...sp) as { n: number }).n;
  }
  const [sc, sp] = scopeSql(scope);
  return (db.prepare(`SELECT COUNT(*) AS n FROM chunks WHERE ${src.sql}${sc}`).get(...src.args, ...sp) as { n: number }).n;
}

/** 채점용 텍스트: 카드의 필드 이름("[고객]", "마감: ")은 모든 카드에 있으므로 일치로 치지 않는다 */
function matchText(text: string): string {
  return text.replace(/^\[[^\]\n]{1,12}\] /, "").replace(/^[^\n:]{1,12}:(?: |$)/gm, "").toLowerCase();
}

type Lexical = { key: string; ref: Ref; score: number; matched: string[]; best: ChunkRow };

function lexical(db: DB, terms: Term[], scope: Scope | undefined, types?: ObjectType[]): Lexical[] {
  if (!terms.length) return [];
  const [sc, sp] = scopeSql(scope);
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM chunks WHERE 1=1${sc}`).get(...sp) as { n: number }).n;
  if (!total) return [];
  const small = total <= LIKE_MAX;
  const sets = terms.map((t) => {
    const df = Math.max(...t.forms.map((f) => docFreq(db, sourceFor(f, small), scope)));
    return { term: t, idf: Math.log(1 + total / (1 + df)) };
  });

  // 후보: 검색어들을 OR 로 묶어 bm25 상위만 (희귀어·여러 검색어가 함께 맞는 청크가 위로 온다)
  const pool = new Set<number>();
  const forms = [...new Set(terms.flatMap((t) => t.forms))];
  const long = forms.filter((f) => [...f].length >= 3);
  const short = forms.filter((f) => [...f].length < 3);
  if (long.length) for (const id of ftsQuery(db, "chunks_fts", long.map(phrase).join(" OR "), scope, POOL_PER_QUERY)) pool.add(id);
  if (short.length && !small) for (const id of ftsQuery(db, "chunks_words", short.map((f) => `${phrase(f)}*`).join(" OR "), scope, POOL_PER_QUERY)) pool.add(id);
  if (short.length && small) {
    // 검색어마다 따로 (OR 로 이어 붙이면 검색어가 많을 때 SQL 식 깊이 한도에 걸린다 — SQL 문도 검색어 수와 상관없이 같다)
    const stmt = db.prepare(`SELECT id FROM chunks WHERE text LIKE ? ESCAPE '\\'${sc} LIMIT ${POOL_PER_QUERY}`);
    for (const f of short) for (const r of stmt.all(likeOf(f), ...sp) as { id: number }[]) pool.add(r.id);
  }
  if (!pool.size) return [];
  const ids = [...pool];
  const rows: ChunkRow[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    rows.push(...(db.prepare(`SELECT id, owner_type, owner_id, business_id, seq, text FROM chunks WHERE id IN ${IN_JSON}`).all(jsonList(part)) as ChunkRow[]));
  }
  const owners = new Map<string, Lexical & { hits: number }>();
  for (const c of rows) {
    if (!KNOWN.has(c.owner_type) || (types && !types.includes(c.owner_type))) continue;
    const text = matchText(c.text);
    const head = text.slice(0, text.indexOf("\n") >>> 0);
    let score = 0;
    const matched: string[] = [];
    for (const s of sets) {
      if (!s.term.forms.some((f) => text.includes(f))) continue;
      matched.push(s.term.text);
      // 제목(첫 줄)에 있으면 가중
      score += s.idf * (s.term.forms.some((f) => head.includes(f)) ? 1.6 : 1);
    }
    if (!matched.length) continue;
    const key = `${c.owner_type}:${c.owner_id}`;
    const cur = owners.get(key);
    if (!cur) owners.set(key, { key, ref: { type: c.owner_type, id: c.owner_id }, score, matched, best: c, hits: 1 });
    else {
      cur.hits++;
      for (const m of matched) if (!cur.matched.includes(m)) cur.matched.push(m);
      if (score > cur.score) Object.assign(cur, { score, best: c });
    }
  }
  // 여러 구획에 걸쳐 맞은 문서, 다른 구획에서 나머지 검색어가 맞은 경우를 약간 가산
  return [...owners.values()]
    .map((o) => ({ ...o, score: o.score + 0.05 * (o.hits - 1) + 0.15 * o.matched.length }))
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}

function snippetOf(c: ChunkRow | undefined, terms: Term[], width = 140): string {
  if (!c) return "";
  // 카드(seq 0)의 첫 줄은 제목·식별자·상태 — 결과 행에 이미 보이므로 뺀다 (문서 구획의 첫 줄은 제목 경로라 남긴다)
  const body = c.seq === 0 ? c.text.slice(c.text.indexOf("\n") + 1 || c.text.length) : c.text;
  const flat = body.replace(/\s*\n\s*(?:[-*]\s+(?:\[[ xX]\]\s+)?)?/g, " · ").replace(/: · /g, ": ");
  const lower = flat.toLowerCase();
  let at = -1;
  for (const t of terms) for (const f of t.forms) {
    const i = lower.indexOf(f);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0 || at < width / 2) return flat.length > width ? `${flat.slice(0, width)}…` : flat;
  const start = Math.max(0, at - Math.floor(width / 3));
  return `…${flat.slice(start, start + width)}${start + width < flat.length ? "…" : ""}`;
}

// ── 의미 ─────────────────────────────────────────────

/**
 * 의미 목록에 넣을 최소 코사인 유사도. 공간(모델)마다 분포가 달라 절대값에 큰 뜻은 없다 — 명백한 잡음만 자른다.
 * 평가(npm run eval:recall -- --embed-url …)로 조정한다.
 */
export const MIN_SEMANTIC = 0.25;
/** 의미 검색의 최소 bit 후보 수 */
const KNN_CANDIDATES = 200;

/** score 는 순위용(유형 힌트로 가중될 수 있음), sim 은 원래 코사인 */
type Semantic = { key: string; ref: Ref; score: number; sim: number; best: ChunkRow };
type SemanticOut = { list: Semantic[]; vector: RecallResult["vector"]; degraded?: string };

async function semantic(db: DB, query: string, scope: Scope | undefined, types: ObjectType[] | undefined, k: number, o: RecallOpts): Promise<SemanticOut> {
  if (!vectorsEnabled(o.env)) return { list: [], vector: null };
  const space = activeSpace(db);
  if (!space) return { list: [], vector: null };
  const vector = { space: space.name, model: space.model };
  if (!attachVectors(db)) return { list: [], vector: null, degraded: vectorStoreInfo(db).error ?? "벡터 저장소를 열 수 없습니다" };
  // 워커가 공급자 장애(연결 실패·시간 초과·5xx)를 확인해 백오프 중이면 묻지 않는다 — 검색마다 시간 초과를 기다리지 않게
  const outage = outageUntil(db, space.id);
  if (outage) return { list: [], vector, degraded: `임베딩 공급자 장애 — ${new Date(outage).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}까지 의미 검색을 건너뜁니다${space.last_error ? ` (${space.last_error})` : ""}` };
  let q: Float32Array;
  try {
    q = await embedQuery(space, query, { fetchImpl: o.fetchImpl, env: o.env, timeoutMs: o.queryTimeoutMs });
  } catch (e) {
    return { list: [], vector, degraded: `질의 임베딩 실패 — ${e instanceof Error ? e.message : String(e)}` };
  }
  // 1차 bit 후보는 max(200, 2×요청 수) — vec0 의 top-k 선택 비용이 후보 수에 거의 비례한다
  // (5만 × 1024차원: 후보 200 ≈ 14ms · 800 ≈ 70ms). 재정렬 후 앞쪽 순위만 RRF 에 의미가 있으므로 이 정도면 충분하다.
  const want = Math.max(k * 4, 40);
  let near: { hash: string; score: number }[];
  let rows: (ChunkRow & { content_hash: string })[];
  // 벡터 저장소 오류(손상된 파일·잠금·차원 불일치)도 검색 전체를 죽이지 않고 어휘 + 관계로 강등한다
  try {
    near = knn(db, space, q, want, { candidates: Math.max(KNN_CANDIDATES, want * 2) });
    if (!near.length) return { list: [], vector };
    const [sc, sp] = scopeSql(scope);
    const hashes = near.map((n) => n.hash);
    rows = db
      .prepare(`SELECT id, owner_type, owner_id, business_id, seq, text, content_hash FROM chunks WHERE content_hash IN ${IN_JSON}${sc}`)
      .all(jsonList(hashes), ...sp) as (ChunkRow & { content_hash: string })[];
  } catch (e) {
    return { list: [], vector, degraded: `벡터 검색 실패 — ${e instanceof Error ? e.message : String(e)}` };
  }
  const sim = new Map(near.map((n) => [n.hash, n.score]));
  const owners = new Map<string, Semantic>();
  for (const c of rows) {
    // 알 수 없는 소유자(합성·과거 데이터)는 결과가 될 수 없다
    if (!KNOWN.has(c.owner_type) || (types && !types.includes(c.owner_type))) continue;
    const score = sim.get(c.content_hash) ?? 0;
    if (score < MIN_SEMANTIC) continue;
    const key = `${c.owner_type}:${c.owner_id}`;
    const cur = owners.get(key);
    if (!cur || score > cur.score) owners.set(key, { key, ref: { type: c.owner_type, id: c.owner_id }, score, sim: score, best: c });
  }
  return { list: [...owners.values()].sort((a, b) => b.score - a.score || a.key.localeCompare(b.key)), vector };
}

/** 의미 검색을 일부러 건너뛴 경우에도 활성 공간은 알린다 (null 은 "활성 공간 없음"으로 읽힌다) */
function skippedVector(db: DB, o: RecallOpts): RecallResult["vector"] {
  const space = vectorsEnabled(o.env) ? activeSpace(db) : undefined;
  return space ? { space: space.name, model: space.model } : null;
}

// ── 관계 ─────────────────────────────────────────────

const EDGE_WEIGHT = { custom: 1, intrinsic: 0.6, derived: 0 } as const;
const MEMORY_EDGE = 0.3;
const GRAPH_SEEDS = 8;

type GraphCand = { key: string; ref: Ref; score: number; via: { from: string; label: string } };

function graphExpand(db: DB, seeds: Ref[]): GraphCand[] {
  const out = new Map<string, GraphCand>();
  seeds.slice(0, GRAPH_SEEDS).forEach((seed, rank) => {
    const memSeen = new Set<number>();
    for (const e of edgesOf(db, seed)) {
      const other = refKey(e.from) === refKey(seed) ? e.to : e.from;
      // 기억은 대상에 붙은 주석이지 구조적 관계가 아니다 — 이웃으로 올 때는 약하게, 씨앗당 한 번만
      // (대상 + 근거로 두 번 이어진 기억이 고객의 실제 관계보다 앞서거나, 허브 고객의 기억들이 관계 목록을 채우지 않도록)
      if (other.type === "memory" && memSeen.has(other.id)) continue;
      if (other.type === "memory") memSeen.add(other.id);
      // 에피소드의 언급(mentions)도 약하게 — 세션 기록은 여러 객체를 스쳐 가므로 구조적 관계가 아니다
      const w = EDGE_WEIGHT[e.source] * (other.type === "memory" || e.linkType === "mentions" ? MEMORY_EDGE : 1);
      if (!w) continue;
      // 사업은 거의 모든 객체와 연결된 허브 — 관계 신호가 아니라 범위(scope)다
      if (other.type === "business") continue;
      const s = w / (1 + rank);
      const key = refKey(other);
      const cur = out.get(key);
      if (!cur) out.set(key, { key, ref: other, score: s, via: { from: refKey(seed), label: e.label } });
      else cur.score += s;
    }
  });
  return [...out.values()].sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}

// ── 융합 ─────────────────────────────────────────────

const RRF_K = 20;
const TYPE_BOOST = 1.5;
const MAX_GRAPH_ONLY = 3;
const WEIGHT: Record<Why, number> = { ref: 3, lexical: 1, semantic: 1, about: 0.7, graph: 0.5 };

/**
 * 기억의 상태 가중 (융합 점수에 곱한다) — 사람이 확인한 것일수록 앞에. 오염(외부 출처)은 ×0.7.
 * 대체·보관된 기억은 기본적으로 결과에서 빠지고, include_inactive 일 때만 낮은 가중으로 나온다.
 */
export const MEMORY_STATUS_WEIGHT: Record<string, number> = { verified: 1, active: 0.85, proposed: 0.6, disputed: 0.4, superseded: 0.3, retired: 0.3 };
export const TAINT_WEIGHT = 0.7;
const INACTIVE = new Set(["superseded", "retired"]);

type MemState = { status: string; tainted: number; kind: string };

type NoteState = { kind: string; tainted: number };

function noteStates(db: DB, ids: number[]): Map<number, NoteState> {
  const out = new Map<number, NoteState>();
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    for (const r of db.prepare(`SELECT id, kind, tainted FROM notes WHERE id IN ${IN_JSON}`).all(jsonList(part)) as (NoteState & { id: number })[]) out.set(r.id, r);
  }
  return out;
}

function memoryStates(db: DB, ids: number[]): Map<number, MemState> {
  const out = new Map<number, MemState>();
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    for (const r of db.prepare(`SELECT id, status, tainted, kind FROM memories WHERE id IN ${IN_JSON}`).all(jsonList(part)) as (MemState & { id: number })[]) out.set(r.id, r);
  }
  return out;
}

/** 관계 확장의 씨앗: 참조 → 어휘·의미 상위를 번갈아 (각 목록의 순위를 유지하며 중복 제거) */
function seedsOf(refs: Ref[], ...lists: { ref: Ref }[][]): Ref[] {
  const out = new Map<string, Ref>();
  for (const r of refs) out.set(refKey(r), r);
  const n = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < n && out.size < GRAPH_SEEDS * 2; i++) for (const l of lists) if (l[i] && !out.has(refKey(l[i].ref))) out.set(refKey(l[i].ref), l[i].ref);
  return [...out.values()];
}

export async function recall(db: DB, q: RecallQuery, o: RecallOpts = {}): Promise<RecallResult> {
  const t0 = performance.now();
  const index = ensureIndexed(db);
  const k = Math.min(Math.max(q.k ?? 10, 1), 100);
  const mode = q.mode ?? "hybrid";
  const { terms, refs, typeHint } = analyze(q.query);
  const hint = <T extends { ref: Ref; score: number; key: string }>(xs: T[]) =>
    typeHint ? xs.map((x) => (x.ref.type === typeHint ? { ...x, score: x.score * TYPE_BOOST } : x)).sort((a, b) => b.score - a.score || a.key.localeCompare(b.key)) : xs;

  // 보관된 기억은 결과뿐 아니라 관계 확장의 씨앗도 되지 않게 미리 뺀다
  const active = <T extends { ref: Ref }>(xs: T[]): T[] => {
    if (q.includeInactive) return xs;
    const ids = xs.filter((x) => x.ref.type === "memory").map((x) => x.ref.id);
    if (!ids.length) return xs;
    const st = memoryStates(db, ids);
    return xs.filter((x) => x.ref.type !== "memory" || (st.has(x.ref.id) && !INACTIVE.has(st.get(x.ref.id)!.status)));
  };
  const lex = mode === "vector" ? [] : active(hint(lexical(db, terms, q.scope, q.types)));
  // 의미: 식별자만 있는 질의(CLT-0003)는 임베딩하지 않는다 — 그 밖에는 한 글자 질의(돈·차)나 불용어뿐인 질의도
  // 임베딩한다 (어휘 검색어가 비어도 뜻은 있을 수 있다)
  const idOnly = refs.length > 0 && !terms.length;
  const sem: SemanticOut =
    mode === "lexical" || !q.query.trim()
      ? { list: [], vector: null }
      : idOnly
        ? { list: [], vector: skippedVector(db, o) }
        : await semantic(db, q.query, q.scope, q.types, k, o);
  const semList = active(hint(sem.list));
  const lists: [Why, { key: string; ref: Ref }[]][] =
    mode === "vector"
      ? [["semantic", semList]]
      : [
          ["ref", refs.map((r) => ({ key: refKey(r), ref: r }))],
          ["lexical", lex],
        ];
  let graph: GraphCand[] = [];
  if (mode === "hybrid") {
    lists.push(["semantic", semList]);
    graph = hint(graphExpand(db, seedsOf(refs, lex, semList)));
    lists.push(["graph", graph]);
    if (q.about) {
      const around = graphExpand(db, [q.about]);
      lists.push(["about", [{ key: refKey(q.about), ref: q.about }, ...around]]);
    }
  }

  const fused = new Map<string, { ref: Ref; score: number; why: Why[] }>();
  for (const [why, list] of lists) {
    list.forEach((item, i) => {
      const cur = fused.get(item.key) ?? { ref: item.ref, score: 0, why: [] };
      cur.score += WEIGHT[why] / (RRF_K + i + 1);
      if (!cur.why.includes(why)) cur.why.push(why);
      fused.set(item.key, cur);
    });
  }

  // 기억: 상태 가중 · 오염 가중, 보관된 기억은 (요청이 없으면) 제외
  const mems = memoryStates(db, [...fused.values()].filter((v) => v.ref.type === "memory").map((v) => v.ref.id));
  for (const [key, v] of fused) {
    if (v.ref.type !== "memory") continue;
    const m = mems.get(v.ref.id);
    if (!m || (INACTIVE.has(m.status) && !q.includeInactive)) {
      fused.delete(key);
      continue;
    }
    v.score *= (MEMORY_STATUS_WEIGHT[m.status] ?? 0.5) * (m.tainted ? TAINT_WEIGHT : 1);
  }
  // 문서: 외부 자료·미검증 에피소드는 오염 가중 (기억과 같은 ×0.7)
  const notes = noteStates(db, [...fused.values()].filter((v) => v.ref.type === "note").map((v) => v.ref.id));
  for (const v of fused.values()) if (v.ref.type === "note" && notes.get(v.ref.id)?.tainted) v.score *= TAINT_WEIGHT;

  // 표시 정보 · 범위 · 유형 필터 (그래프로 들어온 객체도 같은 규칙)
  const ranked = [...fused.entries()].sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]));
  const nodes = nodeInfo(db, ranked.slice(0, k * 4).map(([, v]) => v.ref));
  const lexMap = new Map(lex.map((l) => [l.key, l]));
  const semMap = new Map(semList.map((x) => [x.key, x]));
  const graphMap = new Map(graph.map((g) => [g.key, g]));
  const card = db.prepare("SELECT * FROM chunks WHERE owner_type = ? AND owner_id = ? AND seq = 0");
  const hits: RecallHit[] = [];
  let graphOnly = 0;
  for (const [key, v] of ranked) {
    if (hits.length >= k) break;
    const n = nodes.get(key);
    if (!n) continue;
    // 관계로만 들어온 결과는 몇 개만 — 허브(자주 거래한 고객 등)의 이웃이 목록을 채우지 않도록
    if (v.why.length === 1 && v.why[0] === "graph" && ++graphOnly > MAX_GRAPH_ONLY) continue;
    if (q.types && !q.types.includes(n.type)) continue;
    if (q.scope !== null && q.scope !== undefined && n.type !== "agent" && n.businessId !== null && n.businessId !== q.scope) continue;
    const l = lexMap.get(key);
    const sm = semMap.get(key);
    const g = graphMap.get(key);
    const viaNode = g && !l && !sm ? nodes.get(g.via.from) ?? nodeInfo(db, [parseRef(g.via.from)!]).get(g.via.from) : undefined;
    hits.push({
      ref: v.ref,
      key,
      displayId: n.displayId,
      title: n.title,
      status: n.status,
      businessId: n.businessId,
      score: Math.round(v.score * 10_000) / 10_000,
      why: v.why,
      matched: l?.matched ?? [],
      // 어휘 일치가 없으면 의미상 가장 가까운 구획을 보여준다
      snippet: l ? snippetOf(l.best, terms) : sm ? snippetOf(sm.best, terms) : snippetOf(card.get(v.ref.type, v.ref.id) as ChunkRow | undefined, []),
      via: g && !l && !sm ? { from: viaNode ? `${viaNode.displayId} ${viaNode.title}` : g.via.from, label: g.via.label } : undefined,
      similarity: sm ? Math.round(sm.sim * 1000) / 1000 : undefined,
      ...(v.ref.type === "memory" && mems.has(v.ref.id) ? { memory: { status: mems.get(v.ref.id)!.status, tainted: !!mems.get(v.ref.id)!.tainted, kind: mems.get(v.ref.id)!.kind } } : {}),
      ...(v.ref.type === "note" && notes.has(v.ref.id) ? { note: { kind: notes.get(v.ref.id)!.kind, tainted: !!notes.get(v.ref.id)!.tainted } } : {}),
    });
  }
  return {
    hits,
    terms: terms.map((t) => t.text),
    tookMs: Math.round((performance.now() - t0) * 10) / 10,
    vector: sem.vector,
    ...(sem.degraded || index === "building"
      ? { degraded: [index === "building" ? "검색 색인을 만드는 중 — 결과가 불완전할 수 있습니다" : "", sem.degraded ?? ""].filter(Boolean).join(" · ") }
      : {}),
  };
}
