import type { DB } from "@/lib/db";
import type { Actor, ObjectType, Ref, Risk, RunStatus } from "@/lib/ontology/types";

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
};

export type RunResult = { summary: string; refs: Ref[]; data?: unknown };

export type RunView = Omit<Run, "params" | "result"> & {
  params: Record<string, unknown>;
  result: RunResult | null;
  refs: Ref[];
};

function view(db: DB, r: Run): RunView {
  const refs = db
    .prepare("SELECT object_type AS type, object_id AS id FROM action_run_refs WHERE run_id = ? ORDER BY rowid")
    .all(r.id) as Ref[];
  return { ...r, params: JSON.parse(r.params), result: r.result ? JSON.parse(r.result) : null, refs };
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
  },
): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO action_runs (action, actor_type, actor_id, actor_name, risk, status, params, reason, result, error,
           decided_at, decided_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      ).lastInsertRowid,
  );
  addRefs(db, id, [...(r.refs ?? []), ...(r.result?.refs ?? [])]);
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
