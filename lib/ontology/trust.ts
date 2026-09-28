// 신뢰 사다리 (docs/MEMORY.md §6.3 · §15) — 에이전트의 권한은 좁게 시작해 증거로 넓힌다.
// 모든 지표는 감사 로그(action_runs)에서 계산한다: 별도의 점수 저장소를 믿지 않는다.
//  - agentTrust: 액션별 실행 결과(바로 적용 · 승인 후 적용 · 거절 · 실패 · 거부 · 철회 · 문제 표시 · 자율 권한 적용)와 기억 정밀도
//  - trustSuggestions: 넓힐 후보 → 신호 (자율 권한 후보 · 기억 등급 후보). 넓히는 결정은 항상 사람이 한다
//  - enforceTrust: 좁히기는 자동으로 (문제 표시된 자율 실행 → 권한 회수 · 활성 착지 기억이 거절·정정되면 강등) — SYSTEM 액션
import type { DB } from "@/lib/db";
import { type Agent, listGrants } from "@/lib/repos/agents";
import { emitEvent } from "@/lib/repos/events";
import { getSetting } from "@/lib/repos/settings";
import { executeAction, getAction } from "./execute";
import { displayId, runId } from "./ids";
import type { Signal } from "./signals";
import { actionAllowed } from "./policy";
import { SYSTEM } from "./types";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** 자율 권한 후보: 최근 30일 사람 승인 이 이상 · 거절 0 · 문제 표시 0 */
export const GRANT_MIN_APPROVALS = 10;
export const GRANT_WINDOW_DAYS = 30;
export const GRANT_DEFAULT_DAYS = 30;
/** 기억 등급 후보: 최근 30일 결정된 기억 이 이상 · 정밀도 0.9 이상 */
export const MEMORY_MIN_DECIDED = 20;
export const MEMORY_MIN_PRECISION = 0.9;
/** 자동 강등: 최근 14일 활성 착지 기억 중 사람이 거절·정정한 것 이 이상 */
export const DEMOTE_WINDOW_DAYS = 14;
export const DEMOTE_MIN_BAD = 2;
export const TRUST_LAST_RUN = "trust_last_run";

// ── 실행 지표 ───────────────────────────────────────────

export type RunCounts = {
  /** 바로 적용 (정책이 즉시 실행 — 저위험 · 자율 모드) */
  direct: number;
  /** 승인 대기 → 사람이 승인해 적용 */
  approved: number;
  rejected: number;
  failed: number;
  denied: number;
  cancelled: number;
  pending: number;
  /** 사람이 문제 표시한 실행 (다른 분류와 겹친다) */
  flagged: number;
  /** 가드 모드의 고위험 액션이 자율 권한으로 적용 */
  granted: number;
  total: number;
};

export type ActionTrust = RunCounts & { action: string; high: boolean; approvalRate: number | null };

const zero = (): RunCounts => ({ direct: 0, approved: 0, rejected: 0, failed: 0, denied: 0, cancelled: 0, pending: 0, flagged: 0, granted: 0, total: 0 });

/** 승인률 = 승인 / (승인 + 거절). 결정이 없으면 null */
export const approvalRate = (c: Pick<RunCounts, "approved" | "rejected">) => (c.approved + c.rejected ? c.approved / (c.approved + c.rejected) : null);

type RunGroup = { action: string; status: string; high: number; decided: number; granted: number; flagged: number; n: number };

function addGroup(c: RunCounts, g: RunGroup) {
  c.total += g.n;
  if (g.flagged) c.flagged += g.n;
  switch (g.status) {
    case "applied":
      if (g.granted) c.granted += g.n;
      else if (g.decided) c.approved += g.n;
      else c.direct += g.n;
      break;
    case "rejected":
    case "failed":
    case "denied":
    case "cancelled":
    case "pending":
      c[g.status] += g.n;
      break;
  }
}

/** 에이전트 실행을 (액션, 상태, 결정 여부, 자율 권한, 문제 표시)로 묶어 센다 */
function runGroups(db: DB, agentId: number | null, since: string, until: string): (RunGroup & { actor_id: string })[] {
  return db
    .prepare(
      `SELECT actor_id, action, status, MAX(risk = 'high') AS high, decided_by IS NOT NULL AS decided,
         json_extract(result, '$.data.grant_id') IS NOT NULL AS granted, flagged_at IS NOT NULL AS flagged, COUNT(*) AS n
       FROM action_runs WHERE actor_type = 'agent' ${agentId === null ? "" : "AND actor_id = ?"} AND created_at >= ? AND created_at <= ?
       GROUP BY actor_id, action, status, decided, granted, flagged`,
    )
    .all(...(agentId === null ? [] : [String(agentId)]), since, until) as (RunGroup & { actor_id: string })[];
}

// ── 기억 지표 ───────────────────────────────────────────

export type MemoryOutcome = {
  memoryId: number;
  /** 처음 착지한 상태 (proposed · active …) */
  landing: string;
  createdAt: string;
  /** 사람의 마지막 결정 */
  outcome?: "confirmed" | "rejected" | "corrected";
  decidedAt?: string;
};

type Json = Record<string, unknown>;
const parse = (s: string | null): Json => {
  try {
    return s ? (JSON.parse(s) as Json) : {};
  } catch {
    return {};
  }
};

export type MemoryDecision = { memoryId: number; outcome: NonNullable<MemoryOutcome["outcome"]>; at: string };

/**
 * since 이후 사람이 기억에 내린 결정 (적용 순서대로):
 * confirmed = memory.confirm · 사람의 같은 문장 기록(중복 → 확인) · memory.resolve 에서 남김 /
 * rejected = memory.reject · memory.resolve 에서 버림 / corrected = 사람의 memory.correct (대체 기억 작성자가 사람).
 * 에이전트와 무관하다 — 여러 에이전트를 볼 때(trustSuggestions) 한 번 읽어 memoryOutcomes 에 넘긴다.
 */
export function humanMemoryDecisions(db: DB, since: string): MemoryDecision[] {
  const rows = db
    .prepare(
      `SELECT action, params, result, created_at FROM action_runs WHERE actor_type = 'human' AND status = 'applied'
       AND action IN ('memory.confirm','memory.reject','memory.correct','memory.resolve','memory.record','memory.propose') AND created_at >= ? ORDER BY id`,
    )
    .all(since) as { action: string; params: string; result: string | null; created_at: string }[];
  const out: MemoryDecision[] = [];
  const add = (id: unknown, outcome: MemoryDecision["outcome"], at: string) => {
    if (typeof id === "number") out.push({ memoryId: id, outcome, at });
  };
  for (const d of rows) {
    const p = parse(d.params);
    if (d.action === "memory.confirm") add(p.id, "confirmed", d.created_at);
    else if (d.action === "memory.reject") add(p.id, "rejected", d.created_at);
    else if (d.action === "memory.correct") add(p.id, "corrected", d.created_at);
    else if (d.action === "memory.resolve") {
      if (p.keep === "both") {
        add(p.id, "confirmed", d.created_at);
        add(p.other_id, "confirmed", d.created_at);
      } else {
        const [keep, drop] = p.keep === "this" ? [p.id, p.other_id] : [p.other_id, p.id];
        add(keep, "confirmed", d.created_at);
        add(drop, "rejected", d.created_at);
      }
    } else {
      // 사람이 같은 문장을 말하면 기존 기억의 확인이다 (중복 보강 → verified)
      const data = (parse(d.result).data ?? {}) as Json;
      if (data.deduped) add(data.memory_id, "confirmed", d.created_at);
    }
  }
  return out;
}

/**
 * 에이전트가 since 이후 새로 만든 기억(memory.propose 적용 · 중복 보강 제외)과 그 기억에 대한 사람의 마지막 결정 (humanMemoryDecisions).
 * decisions 는 since 이전부터 읽은 목록이어도 된다 — 이 에이전트의 기억 id 에만 맞춰 쓴다. 생략하면 since 부터 읽는다.
 */
export function memoryOutcomes(db: DB, agentId: number, since: string, until: string, decisions?: () => MemoryDecision[]): MemoryOutcome[] {
  const rows = db
    .prepare(
      `SELECT result, created_at FROM action_runs WHERE actor_type = 'agent' AND actor_id = ? AND action = 'memory.propose' AND status = 'applied'
       AND created_at >= ? AND created_at <= ? ORDER BY id`,
    )
    .all(String(agentId), since, until) as { result: string | null; created_at: string }[];
  const out = new Map<number, MemoryOutcome>();
  for (const r of rows) {
    const d = (parse(r.result).data ?? {}) as Json;
    if (typeof d.memory_id !== "number" || d.deduped) continue;
    out.set(d.memory_id, { memoryId: d.memory_id, landing: String(d.landing ?? d.status ?? "proposed"), createdAt: r.created_at });
  }
  if (!out.size) return [];
  for (const d of decisions ? decisions() : humanMemoryDecisions(db, since)) {
    const m = out.get(d.memoryId);
    if (m) Object.assign(m, { outcome: d.outcome, decidedAt: d.at });
  }
  return [...out.values()];
}

export type MemoryTrustStats = {
  /** 새로 제안한 기억 (착지 상태 무관) */
  proposed: number;
  confirmed: number;
  rejected: number;
  corrected: number;
  /** 활성으로 착지한 기억 */
  autoActive: number;
  /** 결정된 기억 = 확인 + 거절 + 정정 */
  decided: number;
  /** 정밀도 = 확인 / 결정. 결정이 없으면 null */
  precision: number | null;
};

export function memoryStatsOf(outcomes: MemoryOutcome[]): MemoryTrustStats {
  const s = { proposed: outcomes.length, confirmed: 0, rejected: 0, corrected: 0, autoActive: 0, decided: 0, precision: null as number | null };
  for (const o of outcomes) {
    if (o.landing === "active") s.autoActive++;
    if (o.outcome) s[o.outcome]++;
  }
  s.decided = s.confirmed + s.rejected + s.corrected;
  s.precision = s.decided ? s.confirmed / s.decided : null;
  return s;
}

// ── 에이전트 신뢰 지표 ─────────────────────────────────────

export type AgentTrust = {
  agentId: number;
  days: number;
  since: string;
  runs: { byAction: ActionTrust[]; total: RunCounts; approvalRate: number | null };
  memory: MemoryTrustStats;
};

export function agentTrust(db: DB, agentId: number, o: { days?: number; now?: Date } = {}): AgentTrust {
  const days = o.days ?? 30;
  const now = o.now ?? new Date();
  const since = new Date(now.getTime() - days * DAY_MS).toISOString();
  const until = now.toISOString();
  const by = new Map<string, ActionTrust>();
  const total = zero();
  for (const g of runGroups(db, agentId, since, until)) {
    const a = by.get(g.action) ?? { ...zero(), action: g.action, high: false, approvalRate: null };
    a.high ||= !!g.high;
    addGroup(a, g);
    addGroup(total, g);
    by.set(g.action, a);
  }
  const byAction = [...by.values()].map((a) => ({ ...a, approvalRate: approvalRate(a) })).sort((a, b) => b.total - a.total || a.action.localeCompare(b.action));
  return { agentId, days, since, runs: { byAction, total, approvalRate: approvalRate(total) }, memory: memoryStatsOf(memoryOutcomes(db, agentId, since, until)) };
}

/** 승인함 카드용: 이 에이전트의 이 액션 — 최근 30일 사람 승인·거절 수 */
export function approvalHistory(db: DB, agentId: number, action: string, now = new Date()): { approved: number; rejected: number; flagged: number } {
  const since = new Date(now.getTime() - GRANT_WINDOW_DAYS * DAY_MS).toISOString();
  return db
    .prepare(
      `SELECT COALESCE(SUM(status = 'applied' AND decided_by IS NOT NULL), 0) AS approved, COALESCE(SUM(status = 'rejected'), 0) AS rejected,
         COALESCE(SUM(flagged_at IS NOT NULL), 0) AS flagged
       FROM action_runs WHERE actor_type = 'agent' AND actor_id = ? AND action = ? AND created_at >= ?`,
    )
    .get(String(agentId), action, since) as { approved: number; rejected: number; flagged: number };
}

export type Autonomy = { total: number; direct: number; granted: number; approved: number; rejected: number };

/** 오퍼레이션 "자율도": since 이후 에이전트 쓰기 중 바로 적용 · 자율 권한 적용 · 승인 후 적용 · 거절 (실패·거부·대기·철회는 빼고 센다) */
export function autonomyStats(db: DB, since: string, now = new Date()): Autonomy {
  const c = zero();
  for (const g of runGroups(db, null, since, now.toISOString())) addGroup(c, g);
  return { direct: c.direct, granted: c.granted, approved: c.approved, rejected: c.rejected, total: c.direct + c.granted + c.approved + c.rejected };
}

// ── 넓힐 후보 → 신호 ────────────────────────────────────

/** 자율 권한을 줄 수 있는 액션인가: 알려진 액션 · 사람 전용 아님 · 위험도가 high 이거나 함수형 */
export function grantable(action: string): boolean {
  const def = getAction(action);
  return !!def && !def.humanOnly && def.risk !== "low";
}

const activeAgents = (db: DB) => db.prepare("SELECT * FROM agents WHERE status = 'active' ORDER BY id").all() as Agent[];

/**
 * 넓힐 후보 (계산형 신호 — 저장하지 않는다):
 *  - trust.grant_candidate:<agent>:<action> — 고위험 액션 X 가 최근 30일 사람 승인 ≥ 10 · 거절 0 · 문제 표시 0 이고 유효 권한 없음 · 지금 허용 범위 안
 *  - trust.memory_candidate:<agent> — 기억 등급 propose · 최근 30일 결정된 기억 ≥ 20 · 정밀도 ≥ 0.9
 */
export function trustSuggestions(db: DB, now = new Date()): Signal[] {
  const out: Signal[] = [];
  const agents = activeAgents(db);
  if (!agents.length) return out;
  const since = new Date(now.getTime() - GRANT_WINDOW_DAYS * DAY_MS).toISOString();
  const rows = db
    .prepare(
      `SELECT actor_id, action, SUM(status = 'applied' AND decided_by IS NOT NULL) AS approved, SUM(status = 'rejected') AS rejected,
         SUM(flagged_at IS NOT NULL) AS flagged, MIN(created_at) AS first
       FROM action_runs WHERE actor_type = 'agent' AND risk = 'high' AND created_at >= ?
       GROUP BY actor_id, action HAVING approved >= ? AND rejected = 0 AND flagged = 0 ORDER BY actor_id, action`,
    )
    .all(since, GRANT_MIN_APPROVALS) as { actor_id: string; action: string; approved: number; first: string }[];
  const byId = new Map(agents.map((a) => [String(a.id), a]));
  const granted = new Set(listGrants(db, { active: true, now, limit: 10_000 }).map((g) => `${g.agent_id}:${g.action}`));
  for (const r of rows) {
    const a = byId.get(r.actor_id);
    // 허용 범위 밖이면 agent.grant 가 거부한다 — 실행할 수 없는 제안은 띄우지 않는다
    if (!a || !grantable(r.action) || !actionAllowed(a.allowed_actions, r.action) || granted.has(`${a.id}:${r.action}`)) continue;
    const def = getAction(r.action)!;
    out.push({
      key: `trust.grant_candidate:${a.id}:${r.action}`,
      kind: "trust.grant_candidate",
      severity: "info",
      title: `자율 권한 후보 · ${a.name} · ${def.title} (${r.action})`,
      detail: `최근 ${GRANT_WINDOW_DAYS}일 사람 승인 ${r.approved}건 · 거절 0 · 문제 표시 0 — 부여하면 가드 모드에서 승인 없이 실행합니다 (${GRANT_DEFAULT_DAYS}일 뒤 만료, 문제 표시되면 자동 회수)`,
      ref: { type: "agent", id: a.id },
      displayId: displayId("agent", a.id),
      businessId: null,
      since: r.first.slice(0, 10),
      suggested: [{ action: "agent.grant", label: `자율 권한 부여 (${GRANT_DEFAULT_DAYS}일)`, params: { agent_id: a.id, action: r.action, days: GRANT_DEFAULT_DAYS } }],
    });
  }
  // 기억 후보는 제안이 충분한 에이전트만 결정까지 따라간다 (신호는 분마다·화면마다 계산된다)
  const proposals = new Map(
    (db
      .prepare(
        `SELECT actor_id, COUNT(*) AS n FROM action_runs WHERE actor_type = 'agent' AND action = 'memory.propose' AND status = 'applied' AND created_at >= ?
         GROUP BY actor_id HAVING n >= ?`,
      )
      .all(since, MEMORY_MIN_DECIDED) as { actor_id: string; n: number }[]).map((r) => [r.actor_id, r.n]),
  );
  // 사람의 결정은 에이전트와 무관하다 — 필요할 때 한 번만 읽어 모든 에이전트가 나눠 쓴다
  let decided: MemoryDecision[] | undefined;
  const decisions = () => (decided ??= humanMemoryDecisions(db, since));
  for (const a of agents) {
    if (a.memory_trust !== "propose" || !proposals.has(String(a.id))) continue;
    const m = memoryStatsOf(memoryOutcomes(db, a.id, since, now.toISOString(), decisions));
    if (m.decided < MEMORY_MIN_DECIDED || (m.precision ?? 0) < MEMORY_MIN_PRECISION) continue;
    out.push({
      key: `trust.memory_candidate:${a.id}`,
      kind: "trust.memory_candidate",
      severity: "info",
      title: `기억 등급 후보 · ${a.name} — 정밀도 ${m.precision!.toFixed(2)}`,
      detail: `최근 ${GRANT_WINDOW_DAYS}일 결정된 기억 ${m.decided}건 (확인 ${m.confirmed} · 거절 ${m.rejected} · 정정 ${m.corrected}) — 올리면 근거 2개 이상·외부 출처 아닌 제안이 활성으로 착지합니다`,
      ref: { type: "agent", id: a.id },
      displayId: displayId("agent", a.id),
      businessId: null,
      suggested: [{ action: "agent.set_memory_trust", label: "기억 등급 올리기 (활성 착지)", params: { agent_id: a.id, level: "active" } }],
    });
  }
  return out;
}

// ── 좁히기 (자동) ───────────────────────────────────────

export type EnforceResult = {
  at: string;
  /** 회수한 권한과 원인 실행 */
  revoked: { grant_id: number; agent_id: number; action: string; run_id: number }[];
  /** 기억 등급을 내린 에이전트 */
  demoted: { agent_id: number; bad: number }[];
  runs: number[];
  errors: string[];
};

function act(db: DB, out: EnforceResult, action: string, params: Record<string, unknown>, reason: string): boolean {
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

/** 이 에이전트의 기억 등급이 마지막으로 active 로 올라간 시각 (사람의 agent.set_memory_trust) — 그 이전의 거절은 강등 근거가 아니다 */
function promotedAt(db: DB, agentId: number): string | null {
  return (
    (db
      .prepare(
        `SELECT MAX(created_at) FROM action_runs WHERE action = 'agent.set_memory_trust' AND status = 'applied'
         AND json_extract(params, '$.agent_id') = ? AND json_extract(params, '$.level') = 'active'`,
      )
      .pluck()
      .get(agentId) as string | null) ?? null
  );
}

/**
 * 자동 강등 (워커 시간당 1회 — maybeEnforceTrust). 넓히기는 하지 않는다.
 *  - 유효 권한의 액션에서 권한 부여 이후 문제 표시된 실행이 있으면 → agent.revoke_grant (SYSTEM)
 *  - memory_trust = active 인데 최근 14일(마지막 승급 이후) 활성 착지 기억 중 사람이 거절·정정한 것 ≥ 2 → agent.set_memory_trust propose (SYSTEM)
 *  - 만료된 권한은 판단에서 자연히 빠진다 (행 갱신 없음)
 * 뭔가 했으면 trust.enforced 이벤트.
 */
export function enforceTrust(db: DB, now = new Date()): EnforceResult {
  const out: EnforceResult = { at: now.toISOString(), revoked: [], demoted: [], runs: [], errors: [] };
  for (const g of listGrants(db, { active: true, now, limit: 10_000 })) {
    const flagged = db
      .prepare(
        `SELECT id FROM action_runs WHERE actor_type = 'agent' AND actor_id = ? AND action = ? AND flagged_at IS NOT NULL AND flagged_at >= ?
         ORDER BY flagged_at, id LIMIT 1`,
      )
      .pluck()
      .get(String(g.agent_id), g.action, g.granted_at) as number | undefined;
    if (!flagged) continue;
    const ok = act(db, out, "agent.revoke_grant", { grant_id: g.id, reason: `문제 표시된 실행 ${runId(flagged)} — 자동 회수` }, "신뢰 사다리: 자율 권한으로 실행할 수 있는 액션의 실행이 문제 표시됨");
    if (ok) out.revoked.push({ grant_id: g.id, agent_id: g.agent_id, action: g.action, run_id: flagged });
  }
  const windowStart = new Date(now.getTime() - DEMOTE_WINDOW_DAYS * DAY_MS).toISOString();
  for (const a of activeAgents(db)) {
    if (a.memory_trust !== "active") continue;
    const promoted = promotedAt(db, a.id);
    const since = promoted && promoted > windowStart ? promoted : windowStart;
    const bad = memoryOutcomes(db, a.id, since, now.toISOString()).filter(
      (o) => o.landing === "active" && (o.outcome === "rejected" || o.outcome === "corrected") && (o.decidedAt ?? "") >= since,
    ).length;
    if (bad < DEMOTE_MIN_BAD) continue;
    const ok = act(
      db,
      out,
      "agent.set_memory_trust",
      { agent_id: a.id, level: "propose", note: `사람이 거절·정정한 활성 착지 기억 ${bad}건 (최근 ${DEMOTE_WINDOW_DAYS}일) — 자동 강등` },
      "신뢰 사다리: 활성 착지 기억의 정밀도 하락",
    );
    if (ok) out.demoted.push({ agent_id: a.id, bad });
  }
  if (out.revoked.length || out.demoted.length) {
    emitEvent(db, { type: "trust.enforced", actor: SYSTEM, payload: { revoked: out.revoked, demoted: out.demoted, runs: out.runs } });
  }
  return out;
}

/** 워커용: 시간당 1회 (settings.trust_last_run 조건부 갱신으로 점유 — 여러 프로세스가 돌아도 한 번). settings.trust = 'off' 면 끈다 */
export function maybeEnforceTrust(db: DB, now = new Date()): EnforceResult | null {
  if (getSetting(db, "trust") === "off") return null;
  const prev = getSetting(db, TRUST_LAST_RUN) ?? null;
  if (prev && now.getTime() - Date.parse(prev) < HOUR_MS) return null;
  const at = now.toISOString();
  const claimed = prev
    ? db.prepare("UPDATE settings SET value = ? WHERE key = ? AND value = ?").run(at, TRUST_LAST_RUN, prev).changes === 1
    : db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(TRUST_LAST_RUN, at).changes === 1;
  if (!claimed) return null;
  return enforceTrust(db, now);
}
