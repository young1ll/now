// 이벤트 워커: 신호 변화 감지 · 스케줄 · 이벤트→트리거 매칭 · 실행(웹훅 / AI 세션).
// Next 서버 안(instrumentation)에서 돌거나 `npm run worker` 로 따로 돈다. 여러 프로세스가 돌아도
// 커서 전진·실행 점유는 SQLite 트랜잭션/조건부 UPDATE 로 한 번만 일어난다.
import crypto from "node:crypto";
import type { DB } from "@/lib/db";
import { executeSession } from "@/lib/ai/runtime";
import { today } from "@/lib/dates";
import { computeSignals } from "@/lib/ontology/signals";
import { createSession, getProfile, listSessions } from "@/lib/repos/ai";
import { type NowEvent, emitEvent, getEvent, lastEventId, listEvents, matchesPattern } from "@/lib/repos/events";
import { getSetting, setSetting } from "@/lib/repos/settings";
import {
  type Trigger, claimRun, enqueueRun, finishRun, getTrigger, getTriggerRun,
} from "@/lib/repos/triggers";
import { cronMatches } from "./cron";

export type WorkerOpts = { fetchImpl?: typeof fetch; env?: Record<string, string | undefined>; now?: Date; publicUrl?: string };

const MAX_RUNS_PER_HOUR = 30;
const RETRIES = 3;

// ── 1. 신호 변화 → signal.raised / signal.resolved ────────────

export function detectSignals(db: DB, now = new Date()): { raised: number; resolved: number } {
  const sigs = computeSignals(db, null, today());
  const iso = now.toISOString();
  let raised = 0;
  let resolved = 0;
  db.transaction(() => {
    const current = new Map((db.prepare("SELECT key, severity FROM signal_state").all() as { key: string; severity: string }[]).map((r) => [r.key, r.severity]));
    for (const s of sigs) {
      const prev = current.get(s.key);
      current.delete(s.key);
      const payload = { key: s.key, kind: s.kind, severity: s.severity, title: s.title, detail: s.detail, since: s.since ?? null, suggested: s.suggested, business_id: s.businessId };
      if (prev === undefined) {
        db.prepare("INSERT INTO signal_state (key, kind, severity, title, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)").run(s.key, s.kind, s.severity, s.title, iso, iso);
        emitEvent(db, { type: "signal.raised", subject: s.ref ?? null, payload });
        raised++;
      } else {
        db.prepare("UPDATE signal_state SET severity = ?, title = ?, last_seen = ? WHERE key = ?").run(s.severity, s.title, iso, s.key);
        if (prev !== s.severity && s.severity === "critical") emitEvent(db, { type: "signal.escalated", subject: s.ref ?? null, payload: { ...payload, previous: prev } });
      }
    }
    for (const [key] of current) {
      const row = db.prepare("SELECT * FROM signal_state WHERE key = ?").get(key) as { kind: string; title: string; severity: string };
      db.prepare("DELETE FROM signal_state WHERE key = ?").run(key);
      emitEvent(db, { type: "signal.resolved", payload: { key, kind: row.kind, title: row.title, severity: row.severity } });
      resolved++;
    }
  })();
  return { raised, resolved };
}

// ── 2. 스케줄 트리거 ────────────────────────────────────

export function runSchedules(db: DB, now = new Date()): number {
  const minute = new Date(now);
  minute.setSeconds(0, 0);
  const key = minute.toISOString();
  let fired = 0;
  const triggers = db.prepare("SELECT * FROM triggers WHERE enabled = 1 AND kind = 'schedule'").all() as Trigger[];
  for (const t of triggers) {
    try {
      if (!cronMatches(t.schedule, now)) continue;
    } catch {
      continue;
    }
    db.transaction(() => {
      // 같은 분에 두 번 발화하지 않도록 last_fired_at 으로 점유
      const ok = db.prepare("UPDATE triggers SET last_fired_at = ? WHERE id = ? AND (last_fired_at IS NULL OR last_fired_at < ?)").run(key, t.id, key).changes;
      if (!ok) return;
      const eventId = emitEvent(db, { type: "schedule.fired", payload: { trigger_id: t.id, trigger: t.name, schedule: t.schedule, at: key } });
      enqueueRun(db, t.id, eventId);
      fired++;
    })();
  }
  return fired;
}

// ── 3. 이벤트 → 트리거 매칭 ─────────────────────────────

function flatten(e: NowEvent): Record<string, unknown> {
  const out: Record<string, unknown> = { type: e.type, actor_type: e.actor_type, actor_id: e.actor_id, subject_type: e.subject_type, subject_id: e.subject_id };
  const walk = (o: unknown, prefix: string) => {
    if (o && typeof o === "object" && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) walk(v, `${prefix}${k}.`);
    else out[prefix.slice(0, -1)] = o;
  };
  walk(e.payload, "payload.");
  return out;
}

/** filter: {"payload.severity": ["critical","warning"], "subject_type": "invoice"} — 모든 키가 맞아야 통과 */
export function filterMatches(filter: Record<string, unknown>, e: NowEvent): boolean {
  const flat = flatten(e);
  return Object.entries(filter).every(([k, want]) => {
    const got = flat[k];
    const wants = Array.isArray(want) ? want : [want];
    return wants.some((w) => String(w) === String(got));
  });
}

export function matchEvents(db: DB, now = new Date()): number {
  let queued = 0;
  db.transaction(() => {
    const cursorRaw = getSetting(db, "events_cursor");
    // 처음 켜질 때는 과거 이벤트를 재생하지 않는다
    if (cursorRaw === undefined) {
      setSetting(db, "events_cursor", String(lastEventId(db)));
      return;
    }
    const events = listEvents(db, { afterId: Number(cursorRaw), limit: 500 });
    if (!events.length) return;
    const triggers = db.prepare("SELECT * FROM triggers WHERE enabled = 1 AND kind = 'event'").all() as Trigger[];
    const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
    for (const e of events) {
      for (const t of triggers) {
        if (!matchesPattern(t.event_pattern || "*", e.type)) continue;
        let filter: Record<string, unknown> = {};
        try {
          filter = JSON.parse(t.filter || "{}");
        } catch {
          /* 잘못된 필터는 비어 있는 것으로 */
        }
        if (!filterMatches(filter, e)) continue;
        // 루프 방지: 이 트리거가 부른 에이전트 자신의 행동에는 반응하지 않는다
        if (t.target === "agent" && t.profile_id && e.actor_type === "agent") {
          const p = getProfile(db, t.profile_id);
          if (p && String(p.agent_id) === e.actor_id) continue;
        }
        if (t.cooldown_sec > 0 && t.last_fired_at && now.getTime() - Date.parse(t.last_fired_at) < t.cooldown_sec * 1000) {
          enqueueRun(db, t.id, e.id, "skipped", `쿨다운 ${t.cooldown_sec}초`);
          continue;
        }
        const recent = (db.prepare("SELECT COUNT(*) AS n FROM trigger_runs WHERE trigger_id = ? AND created_at >= ? AND status != 'skipped'").get(t.id, hourAgo) as { n: number }).n;
        if (recent >= MAX_RUNS_PER_HOUR) {
          enqueueRun(db, t.id, e.id, "skipped", `시간당 한도 ${MAX_RUNS_PER_HOUR}회 초과`);
          continue;
        }
        enqueueRun(db, t.id, e.id);
        t.last_fired_at = now.toISOString();
        db.prepare("UPDATE triggers SET last_fired_at = ? WHERE id = ?").run(t.last_fired_at, t.id);
        queued++;
      }
    }
    setSetting(db, "events_cursor", String(events[events.length - 1].id));
  })();
  return queued;
}

// ── 4. 실행 ─────────────────────────────────────────

export const DEFAULT_PROMPT = `다음 이벤트가 발생했다. 운영 에이전트로서 필요한 조치를 판단하고, 필요하면 도구로 처리하라.
처리하지 않는 것이 맞다면 이유를 한 줄로 남겨라.

이벤트: {{event.type}}
{{event_json}}`;

export function renderPrompt(template: string, e: NowEvent | undefined, t: Trigger): string {
  const ctx: Record<string, unknown> = { event: e ?? {}, trigger: { id: t.id, name: t.name } };
  return (template.trim() || DEFAULT_PROMPT)
    .replace(/\{\{\s*event_json\s*\}\}/g, JSON.stringify(e ?? {}, null, 2))
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
      const v = path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), ctx);
      return v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    });
}

export function signPayload(secret: string, body: string) {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function runWebhook(db: DB, runId: number, t: Trigger, e: NowEvent | undefined, opts: WorkerOpts) {
  const body = JSON.stringify({ trigger: { id: t.id, name: t.name }, run_id: runId, event: e ?? null });
  const env = opts.env ?? process.env;
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "now-business-os", "x-now-event": e?.type ?? "manual", "x-now-delivery": String(runId) };
  if (t.secret_env) {
    const secret = env[t.secret_env];
    if (!secret) {
      finishRun(db, runId, { status: "failed", error: `서명 비밀 환경변수 ${t.secret_env} 미설정` });
      return;
    }
    headers["x-now-signature"] = signPayload(secret, body);
  }
  const run = getTriggerRun(db, runId)!;
  try {
    const res = await (opts.fetchImpl ?? fetch)(t.webhook_url, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
    const text = (await res.text()).slice(0, 2000);
    if (res.ok) return finishRun(db, runId, { status: "succeeded", output: `HTTP ${res.status}\n${text}` });
    throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (run.attempts < RETRIES) {
      const next = new Date(Date.now() + 30_000 * 2 ** (run.attempts - 1)).toISOString();
      finishRun(db, runId, { status: "queued", error: `${msg} — ${run.attempts}/${RETRIES}회 실패, 재시도 예정`, next_attempt_at: next });
    } else finishRun(db, runId, { status: "failed", error: `${msg} — ${RETRIES}회 실패` });
  }
}

async function runAgent(db: DB, runId: number, t: Trigger, e: NowEvent | undefined, opts: WorkerOpts) {
  if (!t.profile_id || !getProfile(db, t.profile_id)) return finishRun(db, runId, { status: "failed", error: "AI 프로필이 없습니다" });
  const sessionId = createSession(db, t.profile_id, renderPrompt(t.prompt_template, e, t), runId);
  finishRun(db, runId, { status: "running", session_id: sessionId });
  await executeSession(db, sessionId, opts);
  const s = listSessions(db, { limit: 1, profileId: t.profile_id }).find((x) => x.id === sessionId) ?? null;
  finishRun(db, runId, {
    status: s?.status === "succeeded" ? "succeeded" : "failed",
    output: s?.final_text ?? "",
    error: s?.status === "succeeded" ? null : (s?.error ?? "세션 실패"),
    session_id: sessionId,
  });
}

export async function executeRun(db: DB, runId: number, opts: WorkerOpts = {}) {
  if (!claimRun(db, runId)) return;
  const run = getTriggerRun(db, runId)!;
  const t = getTrigger(db, run.trigger_id);
  if (!t) return finishRun(db, runId, { status: "failed", error: "트리거가 삭제되었습니다" });
  const e = run.event_id ? getEvent(db, run.event_id) : undefined;
  if (t.target === "webhook") await runWebhook(db, runId, t, e, opts);
  else await runAgent(db, runId, t, e, opts);
}

export async function executeQueued(db: DB, opts: WorkerOpts = {}, max = 4) {
  const now = (opts.now ?? new Date()).toISOString();
  const runs = db
    .prepare("SELECT id FROM trigger_runs WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY id LIMIT ?")
    .all(now, max) as { id: number }[];
  const sessions = db.prepare("SELECT id FROM agent_sessions WHERE status = 'queued' AND trigger_run_id IS NULL ORDER BY id LIMIT ?").all(max) as { id: number }[];
  await Promise.all([...runs.map((r) => executeRun(db, r.id, opts)), ...sessions.map((s) => executeSession(db, s.id, opts))]);
  return runs.length + sessions.length;
}

/** 한 번의 틱: 매칭은 매번, 신호·스케줄은 분 단위 */
export async function tick(db: DB, opts: WorkerOpts & { signals?: boolean; schedules?: boolean } = {}) {
  const now = opts.now ?? new Date();
  const out = { signals: { raised: 0, resolved: 0 }, scheduled: 0, queued: 0, executed: 0 };
  // 커서를 먼저 확정해야 이번 틱에 새로 생긴 신호가 트리거에 전달된다
  out.queued = matchEvents(db, now);
  if (opts.signals !== false) out.signals = detectSignals(db, now);
  if (opts.schedules !== false) out.scheduled = runSchedules(db, now);
  out.queued += matchEvents(db, now);
  out.executed = await executeQueued(db, opts);
  // 매칭 직후 생긴 실행분도 바로 처리 (세션 결과로 생긴 이벤트는 다음 틱)
  return out;
}

// ── 상주 루프 ───────────────────────────────────────

type WorkerState = { stop: () => void; startedAt: string; lastTick?: string; lastError?: string };
const g = globalThis as unknown as { __nowWorker?: WorkerState };

export function workerStatus() {
  return g.__nowWorker ? { running: true, startedAt: g.__nowWorker.startedAt, lastTick: g.__nowWorker.lastTick ?? null, lastError: g.__nowWorker.lastError ?? null } : { running: false };
}

export function startWorker(getDb: () => DB, intervalMs = Number(process.env.NOW_WORKER_INTERVAL_MS ?? 5000)) {
  if (g.__nowWorker) return g.__nowWorker;
  let busy = false;
  let lastMinute = -1;
  const state: WorkerState = { stop: () => clearInterval(timer), startedAt: new Date().toISOString() };
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const now = new Date();
      const minute = Math.floor(now.getTime() / 60_000);
      const everyMinute = minute !== lastMinute;
      lastMinute = minute;
      await tick(getDb(), { now, signals: everyMinute, schedules: everyMinute });
      state.lastTick = now.toISOString();
      state.lastError = undefined;
    } catch (e) {
      state.lastError = e instanceof Error ? e.message : String(e);
      console.error("[now-worker]", e);
    } finally {
      busy = false;
    }
  }, intervalMs);
  timer.unref?.();
  g.__nowWorker = state;
  return state;
}
