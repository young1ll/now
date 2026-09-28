// 기억(memory) 액션 — AI 가 제안하고 사람이 확정한다 (docs/MEMORY.md §3).
// 사람이 말한 것은 곧바로 verified, 에이전트가 추론한 것은 proposed. 정정은 수정이 아니라 대체(새 행 + 이전 행 superseded).
// 중복은 어휘로만 합친다 (의미 유사 중복은 M4 큐레이터가 벡터로 — 액션은 동기라 여기선 임베딩을 부르지 않는다).
import type { DB } from "@/lib/db";
import { PAIRS_JSON, refPairs } from "@/lib/db/sql";
import { redactSecrets } from "@/lib/knowledge/redact";
import { MEMORY_KIND } from "@/lib/labels";
import { emitEvent } from "@/lib/repos/events";
import {
  INACTIVE_STATUSES, LIVE_STATUSES, MEMORY_KINDS, type Memory, type MemoryStatus, actorKey, addMemoryLink, getMemory, insertMemory, memoryLinks,
  moveMemoryLinks, removeContradiction, updateMemory,
} from "@/lib/repos/memories";
import { getAgent } from "@/lib/repos/agents";
import { getNote } from "@/lib/repos/notes";
import type { RunResult } from "@/lib/repos/runs";
import { type ActionCtx, defineAction } from "../action";
import { f } from "../fields";
import { nodeInfo, objectExists, parseRef } from "../graph";
import { displayId } from "../ids";
import { ActionError, type Actor, type Ref, refKey } from "../types";
import { checkBusiness, must } from "./util";

const MEM = (id: number) => displayId("memory", id);
const memRef = (id: number): Ref => ({ type: "memory", id });
const short = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s);

// ── 문장 검증 ──────────────────────────────────────────

/** AI 에게 명령하는 문장 — 기억은 지시가 아니라 서술이어야 한다 (프롬프트 주입 경로 차단) */
const DIRECTIVE: RegExp[] = [
  /무시\s*(하라|해라|하세요|하십시오|해)(?=[\s.!,]|$)/,
  /(지시|명령|규칙|프롬프트)(를|을|에)\s*(따르|따라|무시|잊)/,
  /지시를/,
  /시스템\s*프롬프트/,
  /\b(ignore|disregard|forget)\b[^.]{0,40}\b(previous|prior|above|earlier|all|instructions?)\b/i,
  /\byou\s+(must|should|shall|will|are\s+required)\b/i,
  /\bsystem\s+prompt\b/i,
  /\b(act|behave)\s+as\b/i,
  // 존대 명령형 어미로 끝나는 문장: "…하세요", "…하십시오" (반말 "…하라" 는 아래 imperativeRa — 이름으로 끝나는 문장과 구별)
  /(하|해|되|말|보내|따르|따라|지키|쓰|주|두|알리)(세요|십시오|시오)[.!。\s]*$/,
  /(할|말|하지\s*말)\s*것[.!。\s]*$/,
  /하지\s*마[.!。\s]*$/,
  // 컨텍스트 팩의 데이터 펜스 태그 (팩은 이스케이프하지만 문장 자체로도 받지 않는다)
  /<\s*\/?\s*memory-context/i,
];

const RA_STEM = "(하|해|되|말|보내|따르|따라|지키|지켜|쓰|써|주|줘|두|둬|알리|알려)";

/**
 * "…하라" 형 명령문. 마지막 어절이 동사형인 경우만: 맨 동사("보내라"), 목적어 뒤의 동사("청구서를 … 발행하라"),
 * 또는 두 음절 이상 어근 + 하라/해라("발행하라"). "대표는 이하라" 처럼 이름(3음절)으로 끝나는 서술은 통과한다.
 */
function imperativeRa(s: string): boolean {
  const t = s.replace(/[.!。\s]+$/, "");
  const last = t.split(" ").pop() ?? "";
  if (!new RegExp(`${RA_STEM}라$`).test(last)) return false;
  if (new RegExp(`^${RA_STEM}라$`).test(last)) return true;
  if (/[을를](\s+\S+){1,2}$/.test(t)) return true;
  return /(하|해)라$/.test(last) && [...last].length >= 4;
}

/**
 * 문맥 없이는 대상을 알 수 없는 지시어 — "그 고객은 …" 은 다른 세션에서 읽으면 뜻이 없다.
 * 어절 경계로만 찾는다: '단위의'·'범위의'(위의), '차이분석'(이분), '같이 고객'(이 고객) 은 지시어가 아니다.
 */
const B = "(?:^|[^\\p{L}\\p{N}])";
const PARTICLE = "(?=$|[^\\p{L}\\p{N}]|은|는|이|가|께|의|을|를|에게|도|과|와)";
const DEICTIC: RegExp[] = [
  new RegExp(`${B}(그|이|저)\\s+고객`, "u"),
  new RegExp(`${B}해당\\s+(건|고객)`, "u"),
  new RegExp(`${B}(그|이)분${PARTICLE}`, "u"),
  new RegExp(`${B}위의(?=\\s|$)`, "u"),
  new RegExp(`${B}상기(?=\\s)`, "u"),
];

/** 공백 정리 + 검증. 통과한 문장을 돌려준다. */
export function validateStatement(raw: string): string {
  const s = raw.replace(/\s+/g, " ").trim();
  if (!s) throw new ActionError("문장을 입력하세요");
  if (DIRECTIVE.some((re) => re.test(s)) || imperativeRa(s)) throw new ActionError("기억은 지시가 아니라 사실·선호·교훈을 서술하는 문장이어야 합니다");
  if (DEICTIC.some((re) => re.test(s))) throw new ActionError("대상을 이름으로 적으세요 — 예: '한빛상사는 …'");
  if (redactSecrets(s) !== s) throw new ActionError("비밀값(토큰·키·비밀번호)은 기억에 넣을 수 없습니다");
  return s;
}

// ── 중복 · 충돌 (어휘 규칙) ─────────────────────────────

/** 공백·문장부호 제거, 소문자 (숫자 자리표시 '#' 은 남긴다) */
export function normalizeStatement(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}#]/gu, "");
}

function trigrams(s: string): Set<string> {
  const cs = [...s];
  if (cs.length < 3) return new Set([s]);
  const out = new Set<string>();
  for (let i = 0; i + 3 <= cs.length; i++) out.add(cs.slice(i, i + 3).join(""));
  return out;
}

/** 문자 trigram Jaccard */
export function similarity(a: string, b: string): number {
  const x = trigrams(a);
  const y = trigrams(b);
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  const union = x.size + y.size - inter;
  return union ? inter / union : 1;
}

const NUM = /\d+(?:[.,]\d+)*/g;

/**
 * 숫자 조각 → 정규화한 값들: 천 단위 쉼표 제거("1,200,000" → 1200000), 앞자리 0 제거, 소수는 하나("1.5").
 * 그 밖의 구분자 조각("2026.01.10" 같은 점 날짜, "3,4" 같은 나열)은 자리마다 따로 — 대시 날짜 "2026-01-10" 과 같은 모양이 된다.
 */
function numberParts(t: string): string[] {
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return [String(Number(t.replace(/,/g, "")))];
  if (/^\d+(\.\d+)?$/.test(t)) return [String(Number(t))];
  return t.split(/[.,]/).map((p) => String(Number(p)));
}

/** 문장 속 숫자·날짜 조각 — 등장 순서대로 (순서가 뜻이다: "2026-01-10" ≠ "2026-10-01") */
export function numbersOf(s: string): string[] {
  return (s.normalize("NFKC").match(NUM) ?? []).flatMap(numberParts);
}

/** 숫자·날짜를 '#' 로 바꾼 뼈대 (자리마다 하나 — 점 날짜와 대시 날짜가 같은 뼈대) */
export function skeletonOf(s: string): string {
  return normalizeStatement(s.normalize("NFKC").replace(NUM, (t) => numberParts(t).map(() => "#").join("-")));
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * 두 문장의 숫자가 같은가. 뼈대가 같으면 자리별로 비교하고("매월 3일 … 10일" ≠ "매월 10일 … 3일"),
 * 뼈대가 다르면(어순이 바뀐 비슷한 문장) 순서 없이 비교한다.
 */
export function sameNumbers(a: string, b: string): boolean {
  const x = numbersOf(a);
  const y = numbersOf(b);
  if (skeletonOf(a) === skeletonOf(b)) return sameList(x, y);
  return sameList([...x].sort(), [...y].sort());
}

const DUP_THRESHOLD = 0.85;
const CONFLICT_THRESHOLD = 0.7;

/**
 * 같은 사업 범위 · 살아 있는 상태 · about 이 겹치거나 둘 다 없음 · 정규화 문장이 같거나 trigram Jaccard ≥ 0.85
 * — 단, 숫자 집합이 다르면 중복이 아니라 충돌 후보다 ("10% 할인" ≠ "15% 할인").
 */
export function findDuplicate(db: DB, q: { businessId: number | null; about: Ref[]; statement: string; excludeIds?: number[] }): Memory | undefined {
  const norm = normalizeStatement(q.statement);
  // about 겹침은 SQL 에서: 대상이 있으면 그 대상 중 하나를 가리키는 기억, 없으면 대상이 없는 기억만 후보
  const aboutCond = q.about.length
    ? `id IN (SELECT from_id FROM links WHERE link_type = 'about' AND from_type = 'memory' AND (to_type, to_id) IN ${PAIRS_JSON})`
    : "NOT EXISTS (SELECT 1 FROM links l WHERE l.link_type = 'about' AND l.from_type = 'memory' AND l.from_id = memories.id)";
  const rows = db
    .prepare(`SELECT * FROM memories WHERE business_id IS ? AND status IN (${LIVE_STATUSES.map(() => "?").join(",")}) AND ${aboutCond} ORDER BY id`)
    .all(q.businessId, ...LIVE_STATUSES, ...(q.about.length ? [refPairs(q.about)] : [])) as Memory[];
  let best: { m: Memory; score: number } | undefined;
  for (const m of rows) {
    if (q.excludeIds?.includes(m.id)) continue;
    if (!sameNumbers(q.statement, m.statement)) continue;
    const other = normalizeStatement(m.statement);
    const score = other === norm ? 1 : similarity(norm, other);
    if (score >= DUP_THRESHOLD && (!best || score > best.score)) best = { m, score };
  }
  return best?.m;
}

/**
 * 숫자·날짜 충돌: about 이 겹치는 살아 있는 기억 중 뼈대가 같거나(또는 trigram Jaccard ≥ 0.7) 숫자 집합이 다른 것.
 * 양쪽 모두 숫자가 있어야 한다 ("할인 가능" vs "10% 할인 가능" 은 충돌이 아니라 구체화).
 */
export function findConflicts(db: DB, q: { about: Ref[]; statement: string; excludeIds?: number[] }): Memory[] {
  const nums = numbersOf(q.statement);
  if (!q.about.length || !nums.length) return [];
  const skel = skeletonOf(q.statement);
  const ids = new Set<number>();
  for (const a of q.about) {
    for (const r of db.prepare("SELECT from_id AS id FROM links WHERE link_type = 'about' AND from_type = 'memory' AND to_type = ? AND to_id = ?").all(a.type, a.id) as { id: number }[]) ids.add(r.id);
  }
  const out: Memory[] = [];
  for (const id of [...ids].sort((x, y) => x - y)) {
    if (q.excludeIds?.includes(id)) continue;
    const m = getMemory(db, id);
    if (!m || !LIVE_STATUSES.includes(m.status)) continue;
    if (!numbersOf(m.statement).length || sameNumbers(q.statement, m.statement)) continue;
    const s2 = skeletonOf(m.statement);
    if (s2 === skel || similarity(skel, s2) >= CONFLICT_THRESHOLD) out.push(m);
  }
  return out;
}

// ── 공통 도우미 ─────────────────────────────────────────

function parseRefs(db: DB, list: string[] | undefined, what: string): Ref[] {
  const out = new Map<string, Ref>();
  for (const s of list ?? []) {
    const r = parseRef(s);
    if (!r) throw new ActionError(`${what} 참조 형식이 올바르지 않습니다: ${s}`);
    if (!objectExists(db, r)) throw new ActionError(`${what} ${displayId(r.type, r.id)} 을(를) 찾을 수 없습니다`);
    out.set(refKey(r), r);
  }
  return [...out.values()];
}

/**
 * 사업을 명시하지 않으면 대상들의 사업에서 추론 — 하나로 모이면 그 사업, 여럿이거나 없으면 전역(NULL).
 * null 도 "지정 안 함"이다: 사람 폼의 빈 선택('— 없음 —')은 null 로 들어오고, 필드 도움말대로 추론해야 한다.
 * (대상이 한 사업에만 있는데 전역으로 두고 싶은 경우는 드물다 — 대상 없이 기록하면 전역이 된다.)
 */
function resolveBusiness(db: DB, given: number | null | undefined, about: Ref[], evidence: Ref[] = []): number | null {
  if (given != null) {
    checkBusiness(db, given);
    return given;
  }
  // 대상이 없으면 근거의 사업을 본다 — 근거가 한 사업에 있는 기억을 전역으로 두면, 기억 카드의 "근거:" 줄(고객명·청구서 번호)이
  // 다른 사업 범위의 에이전트에게 공용으로 보인다
  const from = about.length ? about : evidence;
  const info = nodeInfo(db, from);
  const ids = new Set(from.map((r) => (r.type === "business" ? r.id : (info.get(refKey(r))?.businessId ?? null))).filter((x): x is number => x !== null));
  return ids.size === 1 ? [...ids][0] : null;
}

/** 근거 중 오염된 기억·문서(외부 자료·미검증 에피소드)가 있으면 오염을 물려받는다 */
export function inheritsTaint(db: DB, evidence: Ref[]): boolean {
  return evidence.some((r) => (r.type === "memory" ? !!getMemory(db, r.id)?.tainted : r.type === "note" ? !!getNote(db, r.id)?.tainted : false));
}

/** 활성 착지에 필요한 근거 수 */
export const ACTIVE_LANDING_EVIDENCE = 2;

/**
 * 에이전트가 제안한 기억이 어디에 착지하는가 (M5 신뢰 사다리): 에이전트의 기억 등급(memory_trust)이 active 이고
 * 외부 출처(tainted)가 아니고 근거가 2개 이상이면 active, 아니면 proposed. tainted 는 사람 확인 없이 active/verified 가 될 수 없다.
 */
export function landingStatus(db: DB, actor: Actor, m: { tainted: boolean; evidence: number }): MemoryStatus {
  if (actor.type !== "agent" || m.tainted || m.evidence < ACTIVE_LANDING_EVIDENCE) return "proposed";
  return getAgent(db, Number(actor.id))?.memory_trust === "active" ? "active" : "proposed";
}

const isHuman = (a: Actor) => a.type !== "agent";
const verifier = (a: Actor) => `${actorKey(a)}${a.name ? ` ${a.name}` : ""}`;

function live(db: DB, id: number, what = "기억"): Memory {
  const m = must(getMemory(db, id), what);
  if (!LIVE_STATUSES.includes(m.status)) throw new ActionError(`${MEM(id)} 은(는) 이미 ${m.status === "superseded" ? "대체된" : "보관된"} 기억입니다`);
  return m;
}

/** 아직 살아 있는 충돌 상대 (exclude 제외) */
function liveContradictions(db: DB, id: number, exclude: number[] = []): number[] {
  return memoryLinks(db, id).contradicts.filter((o) => !exclude.includes(o) && LIVE_STATUSES.includes(getMemory(db, o)?.status ?? "retired"));
}

/** 에이전트가 이 기억의 상태를 저위험으로 바꿔도 되는가 — 사람이 확인한 기억(지금 verified 이거나 확인된 적 있음)·고정 기억은 안 된다 */
const humanVouched = (m: Pick<Memory, "status" | "verified_at" | "pinned">) => m.status === "verified" || !!m.verified_at || !!m.pinned;

/**
 * 나중에 붙은 근거·합쳐진 기억의 오염이 이 기억으로 번지는가 — 사람이 확인·고정한 기억(humanVouched)은 새 근거로 흔들지 않는다.
 * 중복 보강(memory.propose/record) · link.create evidenced_by · memory.merge 가 같은 규칙을 쓴다.
 */
export const absorbsTaint = (m: Pick<Memory, "status" | "verified_at" | "pinned" | "tainted">) => !m.tainted && !humanVouched(m);

/**
 * 충돌 표시: contradicts 링크 + 양쪽 disputed + memory.disputed 이벤트.
 * 에이전트의 제안은 사람이 확인한 기억(verified · 확인된 적 있음 · 고정)의 상태를 바꾸지 못한다 — 상대든 자기 자신이든(중복 보강 경로에서는
 * self 가 기존 기억이다). 그 기억은 상태를 유지하고, 링크·이벤트·신호로 사람에게 알린다.
 */
function markConflicts(ctx: ActionCtx, id: number, others: Memory[]): number[] {
  const { db, actor } = ctx;
  const touched: number[] = [];
  const self = getMemory(db, id)!;
  // 사람이 확인·고정한 기억(humanVouched — correct·merge·retire 의 고위험 판정과 같은 정의)은 에이전트의 제안이 끌어내리지 못한다
  const keep = (m: Memory) => actor.type === "agent" && humanVouched(m);
  for (const o of others) {
    if (o.id === id) continue;
    addMemoryLink(db, "contradicts", id, memRef(o.id));
    if (o.status !== "disputed" && !keep(o)) updateMemory(db, o.id, { status: "disputed" });
    touched.push(o.id);
    emitEvent(db, {
      type: "memory.disputed",
      actor,
      subject: memRef(id),
      payload: { memory_id: id, other_id: o.id, statement: self.statement, other_statement: o.statement, business_id: self.business_id },
    });
  }
  if (touched.length && self.status !== "disputed" && !keep(self)) updateMemory(db, id, { status: "disputed" });
  return touched;
}

// ── 필드 ───────────────────────────────────────────────

const statementField = f.text("문장", {
  required: true,
  max: 300,
  help: "자기완결적인 한 문장 — 대상을 이름으로 (예: '한빛상사는 세금계산서를 월말에 일괄 발행받기를 원한다'). 지시문·비밀값 금지",
});
const kindField = f.enum("종류", MEMORY_KINDS, MEMORY_KIND, { required: true });

const common = {
  statement: statementField,
  kind: kindField,
  about: f.refs("대상", { max: 5, help: "이 기억이 무엇에 관한 것인가 — 객체 참조 최대 5개 ([\"client:3\"])" }),
  evidence: f.refs("근거", { max: 10, help: "이 기억을 뒷받침하는 객체 (접촉 이력이 있는 고객·청구서·문서·다른 기억) — 에이전트는 1개 이상 필수" }),
  business_id: f.ref("사업", "business", { nullable: true, help: "비우면 대상(대상이 없으면 근거)의 사업에서 추론 (여러 사업이거나 둘 다 없으면 전역)" }),
  confidence: f.number("신뢰도", { min: 0, max: 1, help: "0~1 자기평가 (기본: 사람 0.9 · 에이전트 0.5)" }),
  valid_from: f.date("유효 시작"),
  valid_to: f.date("유효 종료"),
  tainted: f.boolean("외부 출처(미검증)", { help: "메일·웹훅·웹페이지 같은 비신뢰 입력에서 유래 — 사람 확인 전에는 확정되지 않는다" }),
  contradicts: f.ids("충돌하는 기억", "memory", { max: 5, help: "명시적으로 모순되는 기억 id (숫자·날짜 충돌은 자동 감지)" }),
};

type RememberInput = {
  statement: string;
  kind: Memory["kind"];
  about?: string[];
  evidence?: string[];
  business_id?: number | null;
  confidence?: number;
  valid_from?: string;
  valid_to?: string;
  tainted?: boolean;
  contradicts?: number[];
};

/** propose · record 공통: 검증 → 중복 보강 또는 새 행 → 링크 → 충돌 */
function remember(ctx: ActionCtx, i: RememberInput, mode: "propose" | "record"): RunResult {
  const { db, actor } = ctx;
  const statement = validateStatement(i.statement);
  const about = parseRefs(db, i.about, "대상");
  const evidence = parseRefs(db, i.evidence, "근거");
  if (!isHuman(actor) && !evidence.length) throw new ActionError("에이전트의 기억 제안에는 근거(evidence)가 1개 이상 필요합니다 — 이 기억을 뒷받침하는 객체 참조");
  if (i.valid_from && i.valid_to && i.valid_from > i.valid_to) throw new ActionError("유효 시작이 유효 종료보다 늦습니다");
  const explicit = (i.contradicts ?? []).map((id) => live(db, id, `충돌 기억 ${MEM(id)}`));
  const businessId = resolveBusiness(db, i.business_id, about, evidence);
  // 오염은 되돌릴 수 없다: 입력이 false 여도 근거에서 물려받은 오염은 유지
  const tainted = !!i.tainted || inheritsTaint(db, evidence);

  const dup = findDuplicate(db, { businessId, about, statement });
  if (dup) {
    for (const e of evidence) if (!(e.type === "memory" && e.id === dup.id)) addMemoryLink(db, "evidenced_by", dup.id, e);
    // 사람의 진술은 확인이다 — 제안·활성·충돌 중 기억을 verified 로 (memory.confirm 과 같다: 충돌 링크와 상대 상태는 그대로, 해결은 memory.resolve)
    const confirm = isHuman(actor) && dup.status !== "verified";
    updateMemory(db, dup.id, {
      confidence: Math.min(1, Math.round((dup.confidence + 0.1) * 100) / 100),
      // 오염은 보강에도 따라간다 (입력 표시 · 오염된 근거). 사람이 확인·고정한 기억은 새 근거로 흔들지 않는다 (absorbsTaint — memory.merge · link.create 와 같은 규칙)
      ...(tainted && absorbsTaint(dup) ? { tainted: 1 } : {}),
      ...(confirm ? { status: "verified", verified_by: verifier(actor), verified_at: new Date().toISOString() } : {}),
    });
    const conflicts = markConflicts(ctx, dup.id, explicit);
    const after = getMemory(db, dup.id)!;
    return {
      summary: `기존 기억 ${MEM(dup.id)} 보강${confirm ? " · 확인됨" : ""}: ${short(after.statement)}`,
      refs: [memRef(dup.id), ...about, ...conflicts.map(memRef)],
      data: { memory_id: dup.id, deduped: true, status: after.status, conflicts },
    };
  }

  const human = isHuman(actor);
  const status: MemoryStatus = human ? "verified" : landingStatus(db, actor, { tainted, evidence: evidence.length });
  const id = insertMemory(db, {
    business_id: businessId,
    kind: i.kind,
    statement,
    status,
    confidence: i.confidence ?? (human ? 0.9 : 0.5),
    origin: human ? "human" : "agent",
    tainted,
    valid_from: i.valid_from ?? null,
    valid_to: i.valid_to ?? null,
    created_by: actorKey(actor),
    verified_by: status === "verified" ? verifier(actor) : null,
  });
  for (const a of about) addMemoryLink(db, "about", id, a);
  for (const e of evidence) addMemoryLink(db, "evidenced_by", id, e);
  const found = findConflicts(db, { about, statement, excludeIds: [id] });
  const conflicts = markConflicts(ctx, id, [...new Map([...found, ...explicit].map((m) => [m.id, m])).values()]);
  const after = getMemory(db, id)!;
  const verb = mode === "record" ? "기록" : human ? "기록" : "제안";
  return {
    summary: `기억 ${MEM(id)} ${verb}${conflicts.length ? ` · 충돌 ${conflicts.map(MEM).join(", ")}` : ""}: ${short(statement)}`,
    refs: [memRef(id), ...about, ...conflicts.map(memRef)],
    // landing = 처음 착지한 상태 (충돌로 곧바로 disputed 가 되어도 — 신뢰 지표의 "활성 착지" 근거)
    data: { memory_id: id, deduped: false, status: after.status, landing: status, conflicts },
  };
}

const idField = f.ref("기억", "memory", { required: true });
const target = { type: "memory" as const, param: "id" as const };
/** 위험도 함수용: 사람이 확인했거나(지금 또는 과거) 고정된 기억 */
const vouched = (db: DB, id: number) => {
  const m = getMemory(db, id);
  return !!m && humanVouched(m);
};

// ── 액션 ───────────────────────────────────────────────

export const memoryActions = [
  defineAction({
    name: "memory.propose",
    title: "기억 제안",
    description:
      "반복해서 쓸 만한 사실·선호·교훈을 기억으로 제안한다. 에이전트가 제안하면 proposed(사람 확인 전 — 기억 등급 active 인 에이전트가 근거 2개 이상·외부 출처 아닌 제안을 하면 active), 사람이 하면 verified. evidence(근거 객체) 1개 이상 필수(에이전트). 문장은 대상을 이름으로 적은 자기완결적 한 문장 — 지시문·비밀값 금지. 같은 기억이 있으면 새로 만들지 않고 근거만 보강하고, 숫자·날짜가 다른 기억과 충돌하면 disputed 가 된다.",
    objectType: "memory",
    risk: "low",
    fields: common,
    preview: (_db, i) => `기억 제안: ${short(i.statement)}`,
    run: (ctx, i) => remember(ctx, i, "propose"),
  }),
  defineAction({
    name: "memory.record",
    title: "기억 기록",
    description: "사람이 직접 진술한 기억 — 곧바로 verified. 같은 기억이 있으면 그것을 확인(verified)하고 근거를 보강한다.",
    objectType: "memory",
    risk: "low",
    humanOnly: true,
    fields: common,
    run: (ctx, i) => remember(ctx, i, "record"),
  }),
  defineAction({
    name: "memory.confirm",
    title: "기억 확인",
    description: "제안·활성·충돌 중인 기억을 사람이 확인한다 (verified). 충돌 중인 기억을 확인해도 상대와의 충돌 링크와 상대 상태는 그대로 — 해결은 memory.resolve.",
    objectType: "memory",
    risk: "low",
    humanOnly: true,
    target,
    fields: { id: idField },
    run({ db, actor }, i) {
      const m = live(db, i.id);
      if (m.status === "verified") throw new ActionError(`${MEM(m.id)} 은(는) 이미 확인된 기억입니다`);
      updateMemory(db, m.id, { status: "verified", verified_by: verifier(actor), verified_at: new Date().toISOString() });
      return { summary: `기억 ${MEM(m.id)} 확인: ${short(m.statement)}`, refs: [memRef(m.id), ...memoryLinks(db, m.id).about] };
    },
  }),
  defineAction({
    name: "memory.reject",
    title: "기억 거절",
    description: "제안·활성 기억을 거절해 보관(retired)한다.",
    objectType: "memory",
    risk: "low",
    humanOnly: true,
    target,
    fields: { id: idField, reason: f.text("사유", { max: 300 }) },
    run({ db }, i) {
      const m = live(db, i.id);
      if (m.status !== "proposed" && m.status !== "active") throw new ActionError(`제안·활성 기억만 거절할 수 있습니다 (현재: ${m.status}) — 충돌은 memory.resolve, 확인된 기억은 memory.retire`);
      updateMemory(db, m.id, { status: "retired", pinned: 0, retired_reason: `거절: ${i.reason?.trim() || "사유 없음"}` });
      return { summary: `기억 ${MEM(m.id)} 거절: ${short(m.statement)}`, refs: [memRef(m.id), ...memoryLinks(db, m.id).about] };
    },
  }),
  defineAction({
    name: "memory.correct",
    title: "기억 정정",
    description:
      "틀린 기억을 새 문장으로 대체한다 (수정이 아니라 대체: 새 기억이 생기고 이전 기억은 superseded). 대상·근거는 복사된다. 에이전트가 사람이 확인한 기억(verified · 확인된 적 있음 · 고정)을 정정하면 고위험(승인 필요할 수 있음)이고 새 기억은 proposed.",
    objectType: "memory",
    // 사람이 확인한 적 있는 기억(충돌로 disputed 가 됐어도)·고정 기억도 high — 상태를 먼저 끌어내려 저위험으로 대체하는 길을 막는다
    risk: (db, i) => (vouched(db, i.id) ? "high" : "low"),
    target,
    fields: {
      id: idField,
      statement: statementField,
      kind: f.enum("종류", MEMORY_KINDS, MEMORY_KIND),
      evidence: f.refs("추가 근거", { max: 10 }),
      confidence: f.number("신뢰도", { min: 0, max: 1 }),
      valid_from: f.date("유효 시작"),
      valid_to: f.date("유효 종료"),
      note: f.text("정정 사유", { max: 300 }),
    },
    prefill: (db, id) => {
      const m = getMemory(db, id);
      return m && { statement: m.statement, kind: m.kind, confidence: m.confidence, valid_from: m.valid_from ?? undefined, valid_to: m.valid_to ?? undefined };
    },
    preview: (db, i) => `기억 ${MEM(i.id)} 정정 → ${short(i.statement)}`,
    run(ctx, i) {
      const { db, actor } = ctx;
      const old = live(db, i.id);
      const statement = validateStatement(i.statement);
      const links = memoryLinks(db, old.id);
      const extra = parseRefs(db, i.evidence, "근거");
      const evidence = [...new Map([...links.evidence, ...extra].map((r) => [refKey(r), r])).values()];
      if (i.valid_from && i.valid_to && i.valid_from > i.valid_to) throw new ActionError("유효 시작이 유효 종료보다 늦습니다");
      const human = isHuman(actor);
      const tainted = inheritsTaint(db, evidence) || (!human && !!old.tainted);
      const status: MemoryStatus = human ? "verified" : "proposed";
      const id = insertMemory(db, {
        business_id: old.business_id,
        kind: i.kind ?? old.kind,
        statement,
        status,
        confidence: i.confidence ?? (human ? Math.max(old.confidence, 0.9) : old.confidence),
        origin: human ? "human" : "agent",
        tainted,
        valid_from: i.valid_from ?? old.valid_from,
        valid_to: i.valid_to ?? old.valid_to,
        supersedes_id: old.id,
        created_by: actorKey(actor),
        verified_by: status === "verified" ? verifier(actor) : null,
      });
      for (const a of links.about) addMemoryLink(db, "about", id, a);
      for (const e of evidence) addMemoryLink(db, "evidenced_by", id, e);
      updateMemory(db, old.id, { status: "superseded", superseded_by_id: id, pinned: 0, retired_reason: `정정 → ${MEM(id)}${i.note?.trim() ? `: ${i.note.trim()}` : ""}` });
      if (old.pinned && human) updateMemory(db, id, { pinned: 1 });
      const found = findConflicts(db, { about: links.about, statement, excludeIds: [id, old.id] });
      const conflicts = markConflicts(ctx, id, found);
      return {
        summary: `기억 ${MEM(old.id)} 정정 → ${MEM(id)}: ${short(statement)}`,
        refs: [memRef(id), memRef(old.id), ...links.about, ...conflicts.map(memRef)],
        data: { memory_id: id, supersedes: old.id, status: getMemory(db, id)!.status, conflicts },
      };
    },
  }),
  defineAction({
    name: "memory.retire",
    title: "기억 보관",
    description: "더 이상 맞지 않거나 쓸모없는 기억을 보관(retired)한다. 에이전트가 사람이 확인한 기억(verified · 확인된 적 있음) 또는 고정된 기억을 보관하면 고위험.",
    objectType: "memory",
    risk: (db, i) => (vouched(db, i.id) ? "high" : "low"),
    target,
    fields: { id: idField, reason: f.text("사유", { required: true, max: 300 }) },
    preview: (db, i) => `기억 ${MEM(i.id)} 보관: ${short(getMemory(db, i.id)?.statement ?? "")}`,
    run({ db }, i) {
      const m = live(db, i.id);
      updateMemory(db, m.id, { status: "retired", pinned: 0, retired_reason: i.reason });
      return { summary: `기억 ${MEM(m.id)} 보관 (${short(i.reason, 40)}): ${short(m.statement)}`, refs: [memRef(m.id), ...memoryLinks(db, m.id).about] };
    },
  }),
  defineAction({
    name: "memory.pin",
    title: "기억 고정",
    description: "기억을 항상 컨텍스트 팩에 넣는다(고정) 또는 해제한다. 토큰 예산을 쓰므로 사람만. 확인됨·활성 기억만 고정할 수 있다.",
    objectType: "memory",
    risk: "low",
    humanOnly: true,
    target,
    fields: { id: idField, pinned: f.boolean("고정", { required: true }) },
    run({ db }, i) {
      const m = must(getMemory(db, i.id), "기억");
      if (i.pinned && m.status !== "verified" && m.status !== "active") throw new ActionError("확인됨·활성 기억만 고정할 수 있습니다");
      updateMemory(db, m.id, { pinned: i.pinned ? 1 : 0 });
      return { summary: `기억 ${MEM(m.id)} ${i.pinned ? "고정" : "고정 해제"}: ${short(m.statement)}`, refs: [memRef(m.id), ...memoryLinks(db, m.id).about] };
    },
  }),
  defineAction({
    name: "memory.resolve",
    title: "기억 충돌 해결",
    description: "충돌하는 두 기억 중 하나를 남기거나(this/other — 남기는 쪽 verified, 버리는 쪽 retired) 둘 다 맞다고 확인한다(both — 충돌 링크 삭제 후 둘 다 verified).",
    objectType: "memory",
    risk: "low",
    humanOnly: true,
    target,
    fields: {
      id: idField,
      other_id: f.ref("상대 기억", "memory", { required: true }),
      keep: f.enum("남길 쪽", ["this", "other", "both"] as const, { this: "이 기억", other: "상대 기억", both: "둘 다 (충돌 아님)" }, { required: true }),
    },
    run({ db, actor }, i) {
      const a = live(db, i.id);
      const b = live(db, i.other_id, "상대 기억");
      if (!memoryLinks(db, a.id).contradicts.includes(b.id)) throw new ActionError(`${MEM(a.id)} 와 ${MEM(b.id)} 사이에 충돌 링크가 없습니다`);
      const at = new Date().toISOString();
      const settle = (m: Memory, exclude: number[]) =>
        updateMemory(db, m.id, liveContradictions(db, m.id, exclude).length ? { status: "disputed" } : { status: "verified", verified_by: verifier(actor), verified_at: at });
      if (i.keep === "both") {
        removeContradiction(db, a.id, b.id);
        settle(a, []);
        settle(b, []);
      } else {
        const [keep, drop] = i.keep === "this" ? [a, b] : [b, a];
        updateMemory(db, drop.id, { status: "retired", pinned: 0, retired_reason: `충돌 해결: ${MEM(keep.id)} 유지` });
        settle(keep, [drop.id]);
      }
      const label = i.keep === "both" ? "둘 다 유지" : `${MEM(i.keep === "this" ? a.id : b.id)} 유지`;
      return { summary: `기억 충돌 해결 ${MEM(a.id)} ↔ ${MEM(b.id)}: ${label}`, refs: [memRef(a.id), memRef(b.id), ...memoryLinks(db, a.id).about] };
    },
  }),
  defineAction({
    name: "memory.merge",
    title: "기억 합치기",
    description: "같은 뜻의 기억 id 를 into 로 합친다: id 의 대상·근거를 into 로 옮기고 id 는 superseded. 합쳐지는 쪽(id)이 사람이 확인한 기억(verified · 확인된 적 있음 · 고정)이면 에이전트에게 고위험.",
    objectType: "memory",
    risk: (db, i) => (vouched(db, i.id) ? "high" : "low"),
    target,
    fields: { id: idField, into: f.ref("합칠 대상 기억", "memory", { required: true }) },
    preview: (_db, i) => `기억 ${MEM(i.id)} → ${MEM(i.into)} 합치기`,
    run({ db }, i) {
      if (i.id === i.into) throw new ActionError("같은 기억끼리는 합칠 수 없습니다");
      const from = live(db, i.id);
      const into = live(db, i.into, "합칠 대상 기억");
      moveMemoryLinks(db, from.id, into.id);
      updateMemory(db, into.id, {
        confidence: Math.max(from.confidence, into.confidence),
        use_count: into.use_count + from.use_count,
        ...(from.tainted && absorbsTaint(into) ? { tainted: 1 } : {}),
        ...(from.pinned && (into.status === "verified" || into.status === "active") ? { pinned: 1 } : {}),
      });
      updateMemory(db, from.id, { status: "superseded", superseded_by_id: into.id, pinned: 0, retired_reason: `${MEM(into.id)} 로 합침` });
      return { summary: `기억 ${MEM(from.id)} → ${MEM(into.id)} 합치기: ${short(into.statement)}`, refs: [memRef(into.id), memRef(from.id), ...memoryLinks(db, into.id).about] };
    },
  }),
  defineAction({
    name: "memory.promote",
    title: "기억 승격",
    description: "구조화된 객체(고객 속성·업무·문서 등)로 옮겨진 기억을 표시한다: 기억은 superseded 가 되고 promoted_to 링크로 대체물을 가리킨다.",
    objectType: "memory",
    risk: "low",
    humanOnly: true,
    target,
    fields: { id: idField, to: f.objref("옮겨간 객체", { required: true }), note: f.text("메모", { max: 300 }) },
    run({ db }, i) {
      const m = live(db, i.id);
      const to = parseRefs(db, [i.to], "대상")[0];
      if (to.type === "memory" && to.id === m.id) throw new ActionError("자기 자신으로 승격할 수 없습니다");
      if (memoryLinks(db, m.id).promotedTo) throw new ActionError("이미 승격된 기억입니다");
      addMemoryLink(db, "promoted_to", m.id, to, i.note ?? "");
      updateMemory(db, m.id, { status: "superseded", pinned: 0, retired_reason: `승격 → ${displayId(to.type, to.id)}${i.note?.trim() ? `: ${i.note.trim()}` : ""}` });
      return { summary: `기억 ${MEM(m.id)} 승격 → ${displayId(to.type, to.id)}: ${short(m.statement)}`, refs: [memRef(m.id), to, ...memoryLinks(db, m.id).about.filter((r) => refKey(r) !== refKey(to))] };
    },
  }),
];

/** 상태별로 의미 있는 액션 (OBJECTS.memory.actionsFor) */
export function memoryActionsFor(status: string, pinned = false): string[] {
  switch (status) {
    case "proposed":
      return ["memory.confirm", "memory.reject", "memory.correct", "memory.merge", "memory.retire", "memory.promote"];
    case "active":
      return ["memory.confirm", "memory.reject", "memory.pin", "memory.correct", "memory.merge", "memory.retire", "memory.promote"];
    case "verified":
      return ["memory.pin", "memory.correct", "memory.merge", "memory.retire", "memory.promote"];
    case "disputed":
      return ["memory.resolve", "memory.confirm", "memory.correct", "memory.retire"];
    default:
      return (INACTIVE_STATUSES as string[]).includes(status) && pinned ? ["memory.pin"] : [];
  }
}
