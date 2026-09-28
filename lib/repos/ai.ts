import crypto from "node:crypto";
import type { DB } from "@/lib/db";

export const PROVIDERS = ["anthropic", "openai", "gemini", "openrouter", "ollama", "openai_compatible", "command"] as const;
export type Provider = (typeof PROVIDERS)[number];

export type AiProfile = {
  id: number;
  name: string;
  provider: Provider;
  model: string;
  base_url: string;
  api_key_env: string;
  command: string;
  system_prompt: string;
  max_steps: number;
  agent_id: number;
  enabled: number;
  created_at: string;
};

export type ProfileInput = Omit<AiProfile, "id" | "created_at" | "agent_id" | "enabled"> & { enabled?: boolean };

export type SessionStatus = "queued" | "running" | "succeeded" | "failed";

export type TranscriptEntry =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; tool_calls?: { id: string; name: string; args: unknown }[] }
  | { role: "tool"; id: string; name: string; result: string; is_error: boolean }
  | { role: "system"; text: string };

export type AgentSession = {
  id: number;
  profile_id: number;
  trigger_run_id: number | null;
  status: SessionStatus;
  prompt: string;
  transcript: TranscriptEntry[];
  final_text: string;
  steps: number;
  tool_calls: number;
  usage: Record<string, number>;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  /** 세션 시작 때 받은 컨텍스트 팩의 해시 (팩이 비었으면 null) */
  context_hash: string | null;
  /** 팩 항목 ref ("memory:12", "note:1" …) */
  context_refs: string[];
};

type SessionRow = Omit<AgentSession, "transcript" | "usage" | "context_refs"> & { transcript: string; usage: string; context_refs: string };
const parseSession = (r: SessionRow): AgentSession => ({ ...r, transcript: JSON.parse(r.transcript), usage: JSON.parse(r.usage), context_refs: JSON.parse(r.context_refs ?? "[]") });

export function listProfiles(db: DB): (AiProfile & { agent_name: string; agent_status: string; sessions_24h: number })[] {
  return db
    .prepare(
      `SELECT p.*, a.name AS agent_name, a.status AS agent_status,
         (SELECT COUNT(*) FROM agent_sessions s WHERE s.profile_id = p.id AND s.started_at >= ?) AS sessions_24h
       FROM ai_profiles p JOIN agents a ON a.id = p.agent_id ORDER BY p.id`,
    )
    .all(new Date(Date.now() - 86_400_000).toISOString()) as (AiProfile & { agent_name: string; agent_status: string; sessions_24h: number })[];
}

export function getProfile(db: DB, id: number): AiProfile | undefined {
  return db.prepare("SELECT * FROM ai_profiles WHERE id = ?").get(id) as AiProfile | undefined;
}

export function insertProfile(db: DB, p: ProfileInput & { agent_id: number }): number {
  return Number(
    db
      .prepare(
        `INSERT INTO ai_profiles (name, provider, model, base_url, api_key_env, command, system_prompt, max_steps, agent_id, enabled)
         VALUES (@name, @provider, @model, @base_url, @api_key_env, @command, @system_prompt, @max_steps, @agent_id, @enabled)`,
      )
      .run({ ...p, enabled: p.enabled === false ? 0 : 1 }).lastInsertRowid,
  );
}

export function updateProfile(db: DB, id: number, p: ProfileInput) {
  db.prepare(
    `UPDATE ai_profiles SET name=@name, provider=@provider, model=@model, base_url=@base_url, api_key_env=@api_key_env,
       command=@command, system_prompt=@system_prompt, max_steps=@max_steps, enabled=@enabled WHERE id=@id`,
  ).run({ ...p, enabled: p.enabled === false ? 0 : 1, id });
}

export function deleteProfile(db: DB, id: number) {
  db.prepare("DELETE FROM ai_profiles WHERE id = ?").run(id);
}

// ── 세션 ────────────────────────────────────────────

export function createSession(db: DB, profileId: number, prompt: string, triggerRunId: number | null = null): number {
  return Number(
    db
      .prepare("INSERT INTO agent_sessions (profile_id, trigger_run_id, status, prompt) VALUES (?, ?, 'queued', ?)")
      .run(profileId, triggerRunId, prompt).lastInsertRowid,
  );
}

/** queued → running 원자적 전환. 다른 프로세스가 먼저 가져갔으면 false. */
export function claimSession(db: DB, id: number): boolean {
  return db.prepare("UPDATE agent_sessions SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'").run(new Date().toISOString(), id).changes === 1;
}

export function saveSession(db: DB, id: number, s: Partial<Pick<AgentSession, "status" | "transcript" | "final_text" | "steps" | "tool_calls" | "usage" | "error">> & { finished?: boolean }) {
  const cur = getSession(db, id);
  if (!cur) return;
  db.prepare(
    `UPDATE agent_sessions SET status=?, transcript=?, final_text=?, steps=?, tool_calls=?, usage=?, error=?, finished_at=? WHERE id=?`,
  ).run(
    s.status ?? cur.status,
    JSON.stringify(s.transcript ?? cur.transcript),
    s.final_text ?? cur.final_text,
    s.steps ?? cur.steps,
    s.tool_calls ?? cur.tool_calls,
    JSON.stringify(s.usage ?? cur.usage),
    s.error === undefined ? cur.error : s.error,
    s.finished ? new Date().toISOString() : cur.finished_at,
    id,
  );
}

/** 세션이 받은 컨텍스트 팩 (재현용: 해시 + 항목 ref) */
export function saveSessionContext(db: DB, id: number, hash: string | null, refs: string[]) {
  db.prepare("UPDATE agent_sessions SET context_hash = ?, context_refs = ? WHERE id = ?").run(hash, JSON.stringify(refs), id);
}

export function getSession(db: DB, id: number): AgentSession | undefined {
  const r = db.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(id) as SessionRow | undefined;
  return r && parseSession(r);
}

export function listSessions(db: DB, f: { profileId?: number; status?: SessionStatus; limit?: number } = {}) {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (f.profileId) {
    conds.push("s.profile_id = ?");
    params.push(f.profileId);
  }
  if (f.status) {
    conds.push("s.status = ?");
    params.push(f.status);
  }
  return (
    db
      .prepare(
        `SELECT s.*, p.name AS profile_name, p.provider, p.model FROM agent_sessions s JOIN ai_profiles p ON p.id = s.profile_id
         ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""} ORDER BY s.id DESC LIMIT ?`,
      )
      .all(...params, f.limit ?? 50) as (SessionRow & { profile_name: string; provider: Provider; model: string })[]
  ).map((r) => ({ ...parseSession(r), profile_name: r.profile_name, provider: r.provider, model: r.model }));
}

// ── 단기 토큰 (로컬 CLI 에이전트용) ─────────────────────

const hash = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

export function issueSessionToken(db: DB, agentId: number, ttlSec = 3600): string {
  const token = `nows_${crypto.randomBytes(24).toString("base64url")}`;
  db.prepare("INSERT INTO agent_session_tokens (token_hash, agent_id, expires_at) VALUES (?, ?, ?)").run(
    hash(token),
    agentId,
    new Date(Date.now() + ttlSec * 1000).toISOString(),
  );
  return token;
}

export function revokeSessionToken(db: DB, token: string) {
  db.prepare("DELETE FROM agent_session_tokens WHERE token_hash = ?").run(hash(token));
}

export function agentIdForSessionToken(db: DB, token: string): number | undefined {
  db.prepare("DELETE FROM agent_session_tokens WHERE expires_at < ?").run(new Date().toISOString());
  return (db.prepare("SELECT agent_id FROM agent_session_tokens WHERE token_hash = ?").get(hash(token)) as { agent_id: number } | undefined)?.agent_id;
}
