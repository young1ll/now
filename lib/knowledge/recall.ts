// 하이브리드 회상(recall) — 어휘(FTS/LIKE) · 관계(그래프) · 직접 참조를 순위 융합(RRF)으로 합친다.
// M2 에서 벡터 목록이 같은 자리에 하나 더 들어온다 (docs/MEMORY.md §5).
import type { DB } from "@/lib/db";
import { edgesOf, nodeInfo, parseRef } from "@/lib/ontology/graph";
import { OBJECT_TYPES, type ObjectType, type Ref, refKey } from "@/lib/ontology/types";
import type { Scope } from "@/lib/repos/scope";
import { ensureIndexed } from "./indexer";

export type RecallMode = "hybrid" | "lexical";
export type Why = "ref" | "lexical" | "graph" | "about";

export type RecallQuery = {
  query: string;
  /** 이 객체 주변을 우선 (예: 지금 보고 있는 고객) */
  about?: Ref;
  scope?: Scope;
  types?: ObjectType[];
  k?: number;
  mode?: RecallMode;
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
};

export type RecallResult = { hits: RecallHit[]; terms: string[]; tookMs: number };

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
  문서: "note", 노트: "note", 메모: "note", 지출: "expense", 비용: "expense", 에이전트: "agent", 사업: "business",
};

/** 검색어 → (원형, 조사·어미 뗀 형태). 둘 중 하나만 맞아도 일치로 본다 (명사 끝 글자가 조사처럼 생긴 경우 대비). */
export function analyze(query: string): { terms: Term[]; refs: Ref[]; typeHint?: ObjectType } {
  const refs: Ref[] = [];
  const terms: Term[] = [];
  const seen = new Set<string>();
  for (const raw of query.normalize("NFKC").split(/[\s,.;!?"'`()[\]{}<>/\\|]+/)) {
    if (!raw) continue;
    const r = parseRef(raw);
    if (r) {
      refs.push(r);
      continue;
    }
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
    const where = short.map(() => "text LIKE ? ESCAPE '\\'").join(" OR ");
    for (const r of db.prepare(`SELECT id FROM chunks WHERE (${where})${sc} LIMIT ${POOL_PER_QUERY}`).all(...short.map(likeOf), ...sp) as { id: number }[]) pool.add(r.id);
  }
  if (!pool.size) return [];
  const ids = [...pool];
  const rows: ChunkRow[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    rows.push(...(db.prepare(`SELECT id, owner_type, owner_id, business_id, seq, text FROM chunks WHERE id IN (${part.map(() => "?").join(",")})`).all(...part) as ChunkRow[]));
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

// ── 관계 ─────────────────────────────────────────────

const EDGE_WEIGHT = { custom: 1, intrinsic: 0.6, derived: 0 } as const;
const GRAPH_SEEDS = 8;

type GraphCand = { key: string; ref: Ref; score: number; via: { from: string; label: string } };

function graphExpand(db: DB, seeds: Ref[]): GraphCand[] {
  const out = new Map<string, GraphCand>();
  seeds.slice(0, GRAPH_SEEDS).forEach((seed, rank) => {
    for (const e of edgesOf(db, seed)) {
      const w = EDGE_WEIGHT[e.source];
      if (!w) continue;
      const other = refKey(e.from) === refKey(seed) ? e.to : e.from;
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
const WEIGHT: Record<Why, number> = { ref: 3, lexical: 1, about: 0.7, graph: 0.5 };

export function recall(db: DB, q: RecallQuery): RecallResult {
  const t0 = performance.now();
  ensureIndexed(db);
  const k = Math.min(Math.max(q.k ?? 10, 1), 100);
  const mode = q.mode ?? "hybrid";
  const { terms, refs, typeHint } = analyze(q.query);
  const hint = <T extends { ref: Ref; score: number; key: string }>(xs: T[]) =>
    typeHint ? xs.map((x) => (x.ref.type === typeHint ? { ...x, score: x.score * TYPE_BOOST } : x)).sort((a, b) => b.score - a.score || a.key.localeCompare(b.key)) : xs;

  const lex = hint(lexical(db, terms, q.scope, q.types));
  const lists: [Why, { key: string; ref: Ref }[]][] = [
    ["ref", refs.map((r) => ({ key: refKey(r), ref: r }))],
    ["lexical", lex],
  ];
  let graph: GraphCand[] = [];
  if (mode === "hybrid") {
    graph = hint(graphExpand(db, [...refs, ...lex.map((l) => l.ref)]));
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

  // 표시 정보 · 범위 · 유형 필터 (그래프로 들어온 객체도 같은 규칙)
  const ranked = [...fused.entries()].sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]));
  const nodes = nodeInfo(db, ranked.slice(0, k * 4).map(([, v]) => v.ref));
  const lexMap = new Map(lex.map((l) => [l.key, l]));
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
    const g = graphMap.get(key);
    const viaNode = g && !l ? nodes.get(g.via.from) ?? nodeInfo(db, [parseRef(g.via.from)!]).get(g.via.from) : undefined;
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
      snippet: l ? snippetOf(l.best, terms) : snippetOf(card.get(v.ref.type, v.ref.id) as ChunkRow | undefined, []),
      via: g && !l ? { from: viaNode ? `${viaNode.displayId} ${viaNode.title}` : g.via.from, label: g.via.label } : undefined,
    });
  }
  return { hits, terms: terms.map((t) => t.text), tookMs: Math.round((performance.now() - t0) * 10) / 10 };
}
