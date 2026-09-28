// 큐레이터 (결정적 정리) — 기억의 만료 · 의미 중복 합치기 · 승격 후보를 규칙으로 처리한다 (docs/MEMORY.md §3.4, §6.1, §14).
// LLM 이 필요한 일(에피소드에서 기억 추출)은 "야간 기억 정리" 트리거의 큐레이터 에이전트가 remember 로 한다 — 여기는 규칙만.
// 모든 변경은 SYSTEM 행위자의 액션(memory.retire · memory.merge)으로 — 감사 로그에 규칙이 사유로 남는다.
// 워커가 시간당 1회 부른다 (settings.curator_last_run 조건부 갱신으로 점유 — 여러 프로세스가 돌아도 한 번).
import type { DB } from "@/lib/db";
import { toYmd } from "@/lib/dates";
import { executeAction } from "@/lib/ontology/execute";
import { useSince, promotionSignal } from "@/lib/ontology/signals";
import { type Ref, SYSTEM, refKey } from "@/lib/ontology/types";
import { activeSpace } from "@/lib/repos/embeddings";
import { emitEvent } from "@/lib/repos/events";
import { type Memory, effectiveUses, getMemory, listMemories, memoryLinks } from "@/lib/repos/memories";
import { getSetting } from "@/lib/repos/settings";
import { ensureIndexed } from "./indexer";
import { attachVectors, dot, vectorsEnabled, vectorsFor } from "./vectors";

export const CURATOR_LAST_RUN = "curator_last_run";
const CURATOR_MERGE_RETRY = "curator_merge_retry";
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** a. 제안 상태로 이 기간 동안 쓰이지 않으면 보관 */
export const UNUSED_DAYS = 30;
/** c. 기억 카드 벡터의 코사인이 이 이상이면 같은 뜻 */
export const MERGE_COSINE = 0.92;
/** c. 한 번 실행에서 비교할 새 기억 수 상한 (워커는 Next 서버와 같은 프로세스 — 동기 SQLite 로 오래 막지 않게). 넘는 것은 다음 실행으로 */
export const MERGE_PER_RUN = 200;
/** c. 첫 실행(지난 실행 기록 없음)에서 볼 기간 — 업그레이드 직후 전체 비교를 피한다 */
const FIRST_RUN_DAYS = 30;
const MAX_RETRY = 5000;

export const RULE_REASON = {
  unused: "미확인·미사용 30일 — 자동 보관",
  validTo: "유효기간 만료",
  duplicate: "의미 중복 — 자동 합치기",
} as const;

export type CurateOpts = {
  now?: Date;
  /** 지금은 쓰지 않는다 (규칙은 저장된 벡터만 본다) — LLM 판정을 붙일 때를 위한 자리 */
  fetchImpl?: typeof fetch;
  /** NOW_VECTORS=off 등 */
  env?: Record<string, string | undefined>;
  /** 지난 실행 시각 (c 의 "새 기억" 기준). 생략하면 settings.curator_last_run */
  since?: string | null;
};

export type CurateResult = {
  at: string;
  since: string | null;
  /** a. 미확인·미사용 30일 → 보관 */
  expired_unused: number;
  /** b. 유효기간 만료 → 보관 */
  expired_valid_to: number;
  /** c. 의미 중복 → 합침 */
  merged: number;
  /** c. 벡터가 아직 없어 비교하지 못한 새 기억 (다음 실행에서 다시 본다) */
  merge_skipped: number;
  /** c. 실행당 상한(MERGE_PER_RUN)을 넘어 다음 실행으로 미룬 새 기억 */
  merge_deferred: number;
  /** c. 활성 임베딩 공간이 없어 의미 중복 규칙을 건너뜀 */
  merge_disabled: boolean;
  /** d. 승격 후보 (신호 memory.promotable — 계산형이라 저장하지 않는다) */
  promotable: number;
  runs: number[];
  errors: string[];
};

/** 사람이 확인했거나(지금·과거) 고정된 기억 — 자동으로 합쳐 없애지 않는다 */
const vouched = (m: Pick<Memory, "status" | "verified_at" | "pinned">) => m.status === "verified" || !!m.verified_at || !!m.pinned;
const LIVE_UNVERIFIED = ["proposed", "active"];

function act(db: DB, out: CurateResult, action: string, params: Record<string, unknown>, reason: string): boolean {
  try {
    const r = executeAction(db, { actor: SYSTEM, action, params, reason });
    out.runs.push(r.id);
    if (r.status === "applied") return true;
    out.errors.push(`${action} ${JSON.stringify(params)}: ${r.error ?? r.status}`);
  } catch (e) {
    out.errors.push(`${action} ${JSON.stringify(params)}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return false;
}

/** 기억 카드(seq 0)의 content_hash — 벡터는 이 해시로 저장된다 */
function cardHashes(db: DB, ids: number[]): Map<number, string> {
  const out = new Map<number, string>();
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    for (const r of db.prepare(`SELECT owner_id AS id, content_hash AS h FROM chunks WHERE owner_type = 'memory' AND seq = 0 AND owner_id IN (${part.map(() => "?").join(",")})`).all(...part) as { id: number; h: string }[]) out.set(r.id, r.h);
  }
  return out;
}

/** 같은 사업 범위 · about 이 겹치는(둘 다 없으면 둘 다 없는) 살아 있는 기억 (disputed 제외 — 충돌은 사람이 푼다). 같은 about 묶음끼리 한 번만 읽는다 */
function peers(db: DB, businessId: number | null, about: Ref[]): Memory[] {
  const aboutCond = about.length
    ? `id IN (SELECT from_id FROM links WHERE link_type = 'about' AND from_type = 'memory' AND (${about.map(() => "(to_type = ? AND to_id = ?)").join(" OR ")}))`
    : "NOT EXISTS (SELECT 1 FROM links l WHERE l.link_type = 'about' AND l.from_type = 'memory' AND l.from_id = memories.id)";
  return db
    .prepare(`SELECT * FROM memories WHERE business_id IS ? AND status IN ('proposed','active','verified') AND ${aboutCond} ORDER BY id`)
    .all(businessId, ...about.flatMap((r) => [r.type, r.id])) as Memory[];
}

/** c 의 미룬 기억 (벡터가 아직 없음 · 실행당 상한 초과) — 다음 실행이 이어받는다. 큐레이터 자신의 진행 상태라 액션이 아니다 (curator_last_run 과 같은 취급) */
function readRetry(db: DB): number[] {
  try {
    const v = JSON.parse(getSetting(db, CURATOR_MERGE_RETRY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : [];
  } catch {
    return [];
  }
}

function writeRetry(db: DB, ids: number[]) {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(CURATOR_MERGE_RETRY, JSON.stringify(ids.slice(0, MAX_RETRY)));
}

/**
 * 결정적 정리 한 번. 규칙:
 *  a. 제안(proposed) · 생성 30일 경과 · 최근 90일 실제 사용 0 → memory.retire "미확인·미사용 30일 — 자동 보관"
 *  b. valid_to < 오늘 · 제안/활성/확인됨 → memory.retire "유효기간 만료" (확인됨도 — 사람이 정한 유효기간이다)
 *  c. 활성 임베딩 공간이 있으면: 지난 실행 이후 생긴(처음이면 최근 30일) 제안/활성 기억 + 지난번에 미룬 기억(벡터 없음 —
 *     하루 동안 · 상한 초과)마다 같은 사업 · about 이 겹치는 기억 중 카드 벡터 코사인 ≥ 0.92 인 것과
 *     memory.merge {id: 새것, into: 오래된 것 또는 확인됨}. 확인된 기억은 합쳐 없애지 않는다. 실행당 최대 200개.
 *  d. 승격 후보 수 (신호 memory.promotable 는 computeSignals 가 계산한다)
 *  e. 이벤트 curator.ran (규칙별 처리 수)
 */
export async function curate(db: DB, o: CurateOpts = {}): Promise<CurateResult> {
  const now = o.now ?? new Date();
  const on = toYmd(now);
  const since = o.since === undefined ? (getSetting(db, CURATOR_LAST_RUN) ?? null) : o.since;
  const out: CurateResult = { at: now.toISOString(), since, expired_unused: 0, expired_valid_to: 0, merged: 0, merge_skipped: 0, merge_deferred: 0, merge_disabled: false, promotable: 0, runs: [], errors: [] };

  // a. 미확인·미사용 30일
  const cutoff = new Date(now.getTime() - UNUSED_DAYS * DAY_MS).toISOString();
  const stale = db.prepare("SELECT id FROM memories WHERE status = 'proposed' AND created_at <= ? ORDER BY id").pluck().all(cutoff) as number[];
  const used = effectiveUses(db, useSince(on), stale);
  for (const id of stale) {
    if ((used.get(id) ?? 0) > 0) continue;
    if (act(db, out, "memory.retire", { id, reason: RULE_REASON.unused }, `큐레이터 규칙 a: 제안 후 ${UNUSED_DAYS}일 동안 확인·사용되지 않음`)) out.expired_unused++;
  }

  // b. 유효기간 만료
  const expired = db.prepare("SELECT id FROM memories WHERE valid_to IS NOT NULL AND valid_to < ? AND status IN ('proposed','active','verified') ORDER BY id").pluck().all(on) as number[];
  for (const id of expired) {
    if (act(db, out, "memory.retire", { id, reason: RULE_REASON.validTo }, `큐레이터 규칙 b: 유효기간(valid_to) < ${on}`)) out.expired_valid_to++;
  }

  // c. 의미 중복 (저장된 카드 벡터로 — 질의 임베딩 없음)
  const space = vectorsEnabled(o.env) ? activeSpace(db) : undefined;
  if (!space || space.dim <= 0 || !attachVectors(db)) out.merge_disabled = true;
  else {
    ensureIndexed(db);
    // 대상 = 지난 실행 이후 생긴 기억 (처음이면 최근 FIRST_RUN_DAYS 일) + 지난번에 미룬 기억(벡터 없음 · 실행당 상한 초과).
    // 하루 여유 창을 전체에 두지 않는다 — 매시간 같은 전체 비교를 되풀이하지 않게. 벡터가 늦게 채워진 기억만 다시 본다.
    const from = since ?? new Date(now.getTime() - FIRST_RUN_DAYS * DAY_MS).toISOString();
    const retry = new Set(readRetry(db));
    const fresh = [...new Set([...(db.prepare("SELECT id FROM memories WHERE status IN ('proposed','active') AND created_at > ? ORDER BY id").pluck().all(from) as number[]), ...retry])].sort((a, b) => a - b);
    const nextRetry: number[] = [];
    const retryUntil = new Date(now.getTime() - DAY_MS).toISOString();
    // 벡터 · 동료 목록은 실행 동안 한 번만 읽는다 (기억마다 동료 전원을 다시 디코드하지 않게)
    const vecCache = new Map<number, Float32Array | null>();
    const vecOf = (ids: number[]) => {
      const missing = ids.filter((id) => !vecCache.has(id));
      if (missing.length) {
        const hashes = cardHashes(db, missing);
        const vecs = vectorsFor(db, space, [...hashes.values()]);
        for (const id of missing) vecCache.set(id, vecs.get(hashes.get(id) ?? "") ?? null);
      }
      return (id: number) => vecCache.get(id) ?? null;
    };
    const peerCache = new Map<string, Memory[]>();
    const gone = new Set<number>();
    let processed = 0;
    for (const id of fresh) {
      if (processed >= MERGE_PER_RUN) {
        nextRetry.push(id); // 실행당 상한 — 다음 실행으로
        out.merge_deferred++;
        continue;
      }
      if (gone.has(id)) continue;
      const m = getMemory(db, id);
      if (!m || !LIVE_UNVERIFIED.includes(m.status) || vouched(m)) continue;
      processed++;
      const about = memoryLinks(db, m.id).about;
      const key = `${m.business_id ?? ""}|${about.map(refKey).sort().join(",")}`;
      if (!peerCache.has(key)) peerCache.set(key, peers(db, m.business_id, about));
      const cands = peerCache.get(key)!.filter((c) => c.id !== m.id && !gone.has(c.id));
      if (!cands.length) continue;
      const vec = vecOf([m.id, ...cands.map((c) => c.id)]);
      const mine = vec(m.id);
      if (!mine) {
        out.merge_skipped++;
        if (m.created_at > retryUntil) nextRetry.push(m.id);
        continue;
      }
      let best: { c: Memory; sim: number } | undefined;
      for (const c of cands) {
        const v = vec(c.id);
        if (!v) continue;
        const sim = dot(mine, v);
        if (sim >= MERGE_COSINE && (!best || sim > best.sim || (sim === best.sim && c.id < best.c.id))) best = { c, sim };
      }
      if (!best) continue;
      // 방향: 확인된(사람이 본) 쪽이 남는다. 둘 다 미확인이면 오래된 쪽이 남는다. 없어질 쪽이 사람이 본 기억이면 합치지 않는다.
      const other = best.c;
      const [drop, keep] = vouched(other) ? [m, other] : other.id < m.id ? [m, other] : [other, m];
      if (vouched(drop)) continue;
      if (act(db, out, "memory.merge", { id: drop.id, into: keep.id }, `큐레이터 규칙 c: ${RULE_REASON.duplicate} (코사인 ${best.sim.toFixed(3)} ≥ ${MERGE_COSINE})`)) {
        out.merged++;
        gone.add(drop.id);
      }
    }
    writeRetry(db, nextRetry);
  }

  // d. 승격 후보 수 (신호는 계산형 — computeSignals 가 같은 규칙으로 만든다)
  const verified = listMemories(db, null, { status: ["verified"], limit: -1 });
  const uses = effectiveUses(db, useSince(on), verified.map((m) => m.id));
  out.promotable = verified.filter((m) => promotionSignal(db, m, on, uses.get(m.id) ?? 0)).length;

  // e. 결과 요약
  emitEvent(db, {
    type: "curator.ran",
    actor: SYSTEM,
    payload: {
      at: out.at,
      since,
      expired_unused: out.expired_unused,
      expired_valid_to: out.expired_valid_to,
      merged: out.merged,
      merge_skipped: out.merge_skipped,
      merge_deferred: out.merge_deferred,
      merge_disabled: out.merge_disabled,
      promotable: out.promotable,
      errors: out.errors.length,
    },
  });
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(CURATOR_LAST_RUN, out.at);
  return out;
}

/**
 * 워커용: 지난 실행에서 1시간이 지났으면 점유하고 curate. 점유는 조건부 UPDATE (여러 워커 중 하나만 — 같은 값을 본 쪽만 바꾼다).
 * settings.curator = 'off' 면 끈다.
 */
export async function maybeCurate(db: DB, o: CurateOpts = {}): Promise<CurateResult | null> {
  if (getSetting(db, "curator") === "off") return null;
  const now = o.now ?? new Date();
  const prev = getSetting(db, CURATOR_LAST_RUN) ?? null;
  if (prev && now.getTime() - Date.parse(prev) < HOUR_MS) return null;
  const at = now.toISOString();
  const claimed = prev
    ? db.prepare("UPDATE settings SET value = ? WHERE key = ? AND value = ?").run(at, CURATOR_LAST_RUN, prev).changes === 1
    : db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(CURATOR_LAST_RUN, at).changes === 1;
  if (!claimed) return null;
  return curate(db, { ...o, now, since: prev });
}

/** 마지막 큐레이터 실행 (curator.ran 이벤트) — /memory 머리 표시용 */
export function lastCuratorRun(db: DB): { at: string; payload: Record<string, unknown> } | undefined {
  const r = db.prepare("SELECT created_at, payload FROM events WHERE type = 'curator.ran' ORDER BY id DESC LIMIT 1").get() as { created_at: string; payload: string } | undefined;
  return r && { at: r.created_at, payload: JSON.parse(r.payload) };
}
