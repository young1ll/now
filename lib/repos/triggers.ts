import type { DB } from "@/lib/db";

export type Trigger = {
  id: number;
  name: string;
  enabled: number;
  kind: "event" | "schedule";
  event_pattern: string;
  filter: string;
  schedule: string;
  target: "webhook" | "agent";
  webhook_url: string;
  secret_env: string;
  profile_id: number | null;
  prompt_template: string;
  cooldown_sec: number;
  last_fired_at: string | null;
  created_at: string;
};

export type TriggerInput = Omit<Trigger, "id" | "last_fired_at" | "created_at" | "enabled"> & { enabled: boolean };

export type TriggerRunStatus = "queued" | "running" | "succeeded" | "failed" | "skipped";

export type TriggerRun = {
  id: number;
  trigger_id: number;
  event_id: number | null;
  status: TriggerRunStatus;
  attempts: number;
  next_attempt_at: string | null;
  session_id: number | null;
  output: string;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export function listTriggers(db: DB): (Trigger & { runs_24h: number; failed_24h: number; last_status: TriggerRunStatus | null; profile_name: string | null })[] {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  return db
    .prepare(
      `SELECT t.*, p.name AS profile_name,
         (SELECT COUNT(*) FROM trigger_runs r WHERE r.trigger_id = t.id AND r.created_at >= ?) AS runs_24h,
         (SELECT COUNT(*) FROM trigger_runs r WHERE r.trigger_id = t.id AND r.created_at >= ? AND r.status = 'failed') AS failed_24h,
         (SELECT status FROM trigger_runs r WHERE r.trigger_id = t.id ORDER BY r.id DESC LIMIT 1) AS last_status
       FROM triggers t LEFT JOIN ai_profiles p ON p.id = t.profile_id ORDER BY t.id`,
    )
    .all(since, since) as (Trigger & { runs_24h: number; failed_24h: number; last_status: TriggerRunStatus | null; profile_name: string | null })[];
}

export function getTrigger(db: DB, id: number): Trigger | undefined {
  return db.prepare("SELECT * FROM triggers WHERE id = ?").get(id) as Trigger | undefined;
}

export function insertTrigger(db: DB, t: TriggerInput): number {
  return Number(
    db
      .prepare(
        `INSERT INTO triggers (name, enabled, kind, event_pattern, filter, schedule, target, webhook_url, secret_env, profile_id, prompt_template, cooldown_sec)
         VALUES (@name, @enabled, @kind, @event_pattern, @filter, @schedule, @target, @webhook_url, @secret_env, @profile_id, @prompt_template, @cooldown_sec)`,
      )
      .run({ ...t, enabled: t.enabled ? 1 : 0 }).lastInsertRowid,
  );
}

export function updateTrigger(db: DB, id: number, t: TriggerInput) {
  db.prepare(
    `UPDATE triggers SET name=@name, enabled=@enabled, kind=@kind, event_pattern=@event_pattern, filter=@filter, schedule=@schedule,
       target=@target, webhook_url=@webhook_url, secret_env=@secret_env, profile_id=@profile_id, prompt_template=@prompt_template,
       cooldown_sec=@cooldown_sec WHERE id=@id`,
  ).run({ ...t, enabled: t.enabled ? 1 : 0, id });
}

export function deleteTrigger(db: DB, id: number) {
  db.prepare("DELETE FROM triggers WHERE id = ?").run(id);
}

export function enqueueRun(db: DB, triggerId: number, eventId: number | null, status: TriggerRunStatus = "queued", error: string | null = null): number {
  return Number(
    db.prepare("INSERT INTO trigger_runs (trigger_id, event_id, status, error) VALUES (?, ?, ?, ?)").run(triggerId, eventId, status, error).lastInsertRowid,
  );
}

export function getTriggerRun(db: DB, id: number): TriggerRun | undefined {
  return db.prepare("SELECT * FROM trigger_runs WHERE id = ?").get(id) as TriggerRun | undefined;
}

export function listTriggerRuns(db: DB, f: { triggerId?: number; limit?: number } = {}) {
  return db
    .prepare(
      `SELECT r.*, t.name AS trigger_name, t.target, e.type AS event_type FROM trigger_runs r
       JOIN triggers t ON t.id = r.trigger_id LEFT JOIN events e ON e.id = r.event_id
       ${f.triggerId ? "WHERE r.trigger_id = ?" : ""} ORDER BY r.id DESC LIMIT ?`,
    )
    .all(...(f.triggerId ? [f.triggerId] : []), f.limit ?? 50) as (TriggerRun & { trigger_name: string; target: string; event_type: string | null })[];
}

export function claimRun(db: DB, id: number): boolean {
  return db.prepare("UPDATE trigger_runs SET status = 'running', started_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'queued'").run(new Date().toISOString(), id).changes === 1;
}

export function finishRun(db: DB, id: number, u: { status: TriggerRunStatus; output?: string; error?: string | null; next_attempt_at?: string | null; session_id?: number | null }) {
  db.prepare(
    "UPDATE trigger_runs SET status = ?, output = COALESCE(?, output), error = ?, next_attempt_at = ?, session_id = COALESCE(?, session_id), finished_at = ? WHERE id = ?",
  ).run(u.status, u.output ?? null, u.error ?? null, u.next_attempt_at ?? null, u.session_id ?? null, u.status === "queued" || u.status === "running" ? null : new Date().toISOString(), id);
}
