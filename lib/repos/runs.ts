import type { DB } from "@/lib/db";
import type { Actor, ObjectType, Ref, Risk, RunStatus } from "@/lib/ontology/types";
import { emitEvent } from "./events";

export type Run = {
  id: number;
  action: string;
  actor_type: Actor["type"];
  actor_id: string;
  actor_name: string;
  risk: Risk;
  status: RunStatus;
  params: string;
  reason: string;
  result: string | null;
  error: string | null;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  decision_note: string;
  /** 사람이 "이 실행은 문제였다"고 표시 (run.flag) — 신뢰 지표·자율 권한 자동 회수에 쓰인다 */
  flagged_at: string | null;
  flagged_by: string | null;
  flag_note: string | null;
  /** 이 요청이 닿는 사업들 (JSON 배열, NULL = 모름 — 파싱 전에 실패한 요청 · 이전 버전의 run) */
  business_ids: string | null;
};

export type RunResult = { summary: string; refs: Ref[]; data?: unknown };

export type RunView = Omit<Run, "params" | "result" | "business_ids"> & {
  params: Record<string, unknown>;
  result: RunResult | null;
  refs: Ref[];
  business_ids: number[] | null;
};

function parseBusinessIds(s: string | null | undefined): number[] | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) && v.every((x) => typeof x === "number") ? v : null;
  } catch {
    return null;
  }
}

function view(db: DB, r: Run): RunView {
  const refs = db
    .prepare("SELECT object_type AS type, object_id AS id FROM action_run_refs WHERE run_id = ? ORDER BY rowid")
    .all(r.id) as Ref[];
  return { ...r, params: JSON.parse(r.params), result: r.result ? JSON.parse(r.result) : null, refs, business_ids: parseBusinessIds(r.business_ids) };
}

export function insertRun(
  db: DB,
  r: {
    action: string;
    actor: Actor;
    risk: Risk;
    status: RunStatus;
    params: unknown;
    reason?: string;
    result?: RunResult | null;
    error?: string | null;
    refs?: Ref[];
    decided_by?: string | null;
    /** 요청이 닿는 사업들 (policy.businessesOf) — 모르면 생략. 사업 범위 에이전트의 이벤트 필터가 모르는 run 은 가린다 */
    businessIds?: number[] | null;
  },
): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO action_runs (action, actor_type, actor_id, actor_name, risk, status, params, reason, result, error,
           decided_at, decided_by, business_ids)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.action,
        r.actor.type,
        r.actor.id,
        r.actor.name,
        r.risk,
        r.status,
        JSON.stringify(r.params ?? {}),
        r.reason ?? "",
        r.result ? JSON.stringify(r.result) : null,
        r.error ?? null,
        r.decided_by ? new Date().toISOString() : null,
        r.decided_by ?? null,
        r.businessIds ? JSON.stringify(r.businessIds) : null,
      ).lastInsertRowid,
  );
  const refs = [...(r.result?.refs ?? []), ...(r.refs ?? [])];
  addRefs(db, id, refs);
  emitEvent(db, {
    type: `action.${r.status}`,
    actor: r.actor,
    subject: refs[0] ?? null,
    payload: { run_id: id, action: r.action, risk: r.risk, summary: r.result?.summary ?? null, error: r.error ?? null, reason: r.reason ?? "", refs, ...(r.businessIds ? { business_ids: r.businessIds } : {}) },
  });
  return id;
}

export function addRefs(db: DB, runId: number, refs: Ref[]) {
  const ins = db.prepare("INSERT OR IGNORE INTO action_run_refs (run_id, object_type, object_id) VALUES (?, ?, ?)");
  for (const ref of refs) ins.run(runId, ref.type, ref.id);
}

export function completeRun(
  db: DB,
  id: number,
  u: { status: RunStatus; result?: RunResult | null; error?: string | null; decided_by?: string; decision_note?: string },
) {
  db.prepare(
    `UPDATE action_runs SET status = ?, result = COALESCE(?, result), error = ?,
       decided_at = COALESCE(?, decided_at), decided_by = COALESCE(?, decided_by), decision_note = COALESCE(?, decision_note)
     WHERE id = ?`,
  ).run(
    u.status,
    u.result ? JSON.stringify(u.result) : null,
    u.error ?? null,
    u.decided_by ? new Date().toISOString() : null,
    u.decided_by ?? null,
    u.decision_note ?? null,
    id,
  );
  if (u.result?.refs) addRefs(db, id, u.result.refs);
  const run = getRun(db, id);
  if (run) {
    emitEvent(db, {
      type: `action.${u.status}`,
      actor: { type: run.actor_type, id: run.actor_id },
      subject: run.refs[0] ?? null,
      payload: { run_id: id, action: run.action, risk: run.risk, summary: run.result?.summary ?? null, error: run.error, decided_by: run.decided_by, decision_note: run.decision_note, refs: run.refs, ...(run.business_ids ? { business_ids: run.business_ids } : {}) },
    });
  }
}

export function getRun(db: DB, id: number): RunView | undefined {
  const r = db.prepare("SELECT * FROM action_runs WHERE id = ?").get(id) as Run | undefined;
  return r && view(db, r);
}

export type RunFilter = {
  status?: RunStatus;
  actorType?: Actor["type"];
  actorId?: string;
  action?: string;
  object?: { type: ObjectType; id: number };
  since?: string;
  beforeId?: number;
  /** 문제 표시(flag)된 실행만 */
  flagged?: boolean;
  limit?: number;
};

export function listRuns(db: DB, f: RunFilter = {}): RunView[] {
  const conds: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, ...v: unknown[]) => {
    conds.push(sql);
    params.push(...v);
  };
  if (f.status) add("r.status = ?", f.status);
  if (f.actorType) add("r.actor_type = ?", f.actorType);
  if (f.actorId) add("r.actor_id = ?", f.actorId);
  if (f.action) add("r.action = ?", f.action);
  if (f.since) add("r.created_at >= ?", f.since);
  if (f.beforeId) add("r.id < ?", f.beforeId);
  if (f.flagged) add("r.flagged_at IS NOT NULL");
  if (f.object)
    add(
      "r.id IN (SELECT run_id FROM action_run_refs WHERE object_type = ? AND object_id = ?)",
      f.object.type,
      f.object.id,
    );
  const rows = db
    .prepare(
      `SELECT r.* FROM action_runs r ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""}
       ORDER BY r.id DESC LIMIT ?`,
    )
    .all(...params, f.limit ?? 100) as Run[];
  return rows.map((r) => view(db, r));
}

export type RunStats = Record<RunStatus, number> & { total: number; agent: number; human: number };

export function runStats(db: DB, since: string): RunStats {
  const rows = db
    .prepare("SELECT status, actor_type, COUNT(*) AS n FROM action_runs WHERE created_at >= ? GROUP BY 1, 2")
    .all(since) as { status: RunStatus; actor_type: Actor["type"]; n: number }[];
  const s: RunStats = { applied: 0, pending: 0, rejected: 0, failed: 0, denied: 0, cancelled: 0, total: 0, agent: 0, human: 0 };
  for (const r of rows) {
    s[r.status] += r.n;
    s.total += r.n;
    if (r.actor_type === "agent") s.agent += r.n;
    if (r.actor_type === "human") s.human += r.n;
  }
  return s;
}

/** 문제 표시 / 해제 (run.flag · run.unflag 액션 전용). 이벤트는 그 액션의 run 이 낸다 */
export function setRunFlag(db: DB, id: number, flag: { by: string; note: string; at?: string } | null) {
  if (flag) db.prepare("UPDATE action_runs SET flagged_at = ?, flagged_by = ?, flag_note = ? WHERE id = ?").run(flag.at ?? new Date().toISOString(), flag.by, flag.note, id);
  else db.prepare("UPDATE action_runs SET flagged_at = NULL, flagged_by = NULL, flag_note = NULL WHERE id = ?").run(id);
}

/** 자율 권한으로 적용된 에이전트 실행의 권한 id (execute.ts 가 result.data.grant_id 에 남긴다 — 사람의 agent.grant 결과의 grant_id 와 구별) */
export function grantIdOf(r: Pick<RunView, "result" | "actor_type">): number | null {
  if (r.actor_type !== "agent") return null;
  const d = r.result?.data;
  const g = d && typeof d === "object" ? (d as { grant_id?: unknown }).grant_id : undefined;
  return typeof g === "number" ? g : null;
}

export function pendingCount(db: DB): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM action_runs WHERE status = 'pending'").get() as { n: number }).n;
}

/** 시간대별 실행 수 (최근 hours 시간, 1시간 버킷). 모니터링 스파크라인용. */
export function runsPerHour(db: DB, hours: number, now = new Date()): { hour: string; agent: number; human: number; failed: number }[] {
  const start = new Date(now.getTime() - (hours - 1) * 3600_000);
  start.setMinutes(0, 0, 0);
  const rows = db
    .prepare(
      `SELECT substr(created_at, 1, 13) AS hour, actor_type, status, COUNT(*) AS n
       FROM action_runs WHERE created_at >= ? GROUP BY 1, 2, 3`,
    )
    .all(start.toISOString()) as { hour: string; actor_type: string; status: string; n: number }[];
  return Array.from({ length: hours }, (_, i) => {
    const hour = new Date(start.getTime() + i * 3600_000).toISOString().slice(0, 13);
    const inHour = rows.filter((r) => r.hour === hour);
    return {
      hour,
      agent: inHour.filter((r) => r.actor_type === "agent").reduce((s, r) => s + r.n, 0),
      human: inHour.filter((r) => r.actor_type === "human").reduce((s, r) => s + r.n, 0),
      failed: inHour.filter((r) => r.status === "failed" || r.status === "denied").reduce((s, r) => s + r.n, 0),
    };
  });
}
