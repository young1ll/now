import crypto from "node:crypto";
import type { DB } from "@/lib/db";
import { agentIdForSessionToken } from "./ai";

export const AGENT_STATUSES = ["active", "suspended", "revoked"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];
/** 역할 — 권한이 아니라 표시·기본값 (권한은 allowed_actions · business_scope 가 정한다) */
export const AGENT_ROLES = ["operator", "curator", "researcher", "custom"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];
/** 기억 등급: propose = 제안은 항상 proposed · active = 근거 2개 이상·비오염 제안은 active 로 착지 */
export const MEMORY_TRUST_LEVELS = ["propose", "active"] as const;
export type MemoryTrust = (typeof MEMORY_TRUST_LEVELS)[number];

export type Agent = {
  id: number;
  name: string;
  description: string;
  token_hash: string;
  token_prefix: string;
  status: AgentStatus;
  created_at: string;
  last_seen_at: string | null;
  role: AgentRole;
  /** 쉼표 구분 glob ("*" = 전부, "memory.*,note.create") */
  allowed_actions: string;
  /** NULL = 전체 사업 */
  business_scope: number | null;
  memory_trust: MemoryTrust;
};

export type AgentRow = Omit<Agent, "token_hash"> & {
  business_scope_name: string | null;
  runs_24h: number;
  pending: number;
  failed_24h: number;
  last_run_at: string | null;
};

const hash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

/** 새 에이전트 등록. 평문 토큰은 반환값으로 한 번만 나간다. */
export function createAgent(
  db: DB,
  input: { name: string; description?: string; role?: AgentRole; allowed_actions?: string; business_scope?: number | null },
): { id: number; token: string } {
  const token = `now_${crypto.randomBytes(24).toString("base64url")}`;
  const id = Number(
    db
      .prepare("INSERT INTO agents (name, description, token_hash, token_prefix, role, allowed_actions, business_scope) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(input.name, input.description ?? "", hash(token), token.slice(0, 10), input.role ?? "operator", input.allowed_actions ?? "*", input.business_scope ?? null).lastInsertRowid,
  );
  return { id, token };
}

/** 토큰으로 활성 에이전트를 찾고 last_seen 을 갱신한다. 정지·폐기된 에이전트는 undefined. */
export function authenticateAgent(db: DB, token: string | null | undefined): Agent | undefined {
  if (!token) return undefined;
  let a = db.prepare("SELECT * FROM agents WHERE token_hash = ?").get(hash(token)) as Agent | undefined;
  if (!a && token.startsWith("nows_")) {
    // AI 런타임이 로컬 CLI 에이전트에 발급한 단기 토큰
    const id = agentIdForSessionToken(db, token);
    a = id ? getAgent(db, id) : undefined;
  }
  if (!a) return undefined;
  db.prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?").run(new Date().toISOString(), a.id);
  return a;
}

export function getAgent(db: DB, id: number): Agent | undefined {
  return db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Agent | undefined;
}

export function listAgents(db: DB, since: string, id?: number): AgentRow[] {
  return db
    .prepare(
      `SELECT a.id, a.name, a.description, a.token_prefix, a.status, a.created_at, a.last_seen_at,
         a.role, a.allowed_actions, a.business_scope, a.memory_trust, b.name AS business_scope_name,
         (SELECT COUNT(*) FROM action_runs r WHERE r.actor_type = 'agent' AND r.actor_id = CAST(a.id AS TEXT) AND r.created_at >= ?) AS runs_24h,
         (SELECT COUNT(*) FROM action_runs r WHERE r.actor_type = 'agent' AND r.actor_id = CAST(a.id AS TEXT) AND r.status = 'pending') AS pending,
         (SELECT COUNT(*) FROM action_runs r WHERE r.actor_type = 'agent' AND r.actor_id = CAST(a.id AS TEXT) AND r.status IN ('failed','denied') AND r.created_at >= ?) AS failed_24h,
         (SELECT MAX(created_at) FROM action_runs r WHERE r.actor_type = 'agent' AND r.actor_id = CAST(a.id AS TEXT)) AS last_run_at
       FROM agents a LEFT JOIN businesses b ON b.id = a.business_scope ${id !== undefined ? "WHERE a.id = ?" : ""} ORDER BY a.status = 'revoked', a.id`,
    )
    .all(since, since, ...(id !== undefined ? [id] : [])) as AgentRow[];
}

export function setAgentStatus(db: DB, id: number, status: AgentStatus) {
  db.prepare("UPDATE agents SET status = ? WHERE id = ?").run(status, id);
}

// ── 역할 · 범위 · 기억 등급 (쓰기는 agent.* 액션에서만) ─────────────

export function configureAgent(db: DB, id: number, p: Partial<Pick<Agent, "role" | "allowed_actions" | "business_scope" | "memory_trust">>) {
  const keys = Object.keys(p).filter((k) => p[k as keyof typeof p] !== undefined);
  if (!keys.length) return;
  db.prepare(`UPDATE agents SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => p[k as keyof typeof p]), id);
}

// ── 자율 권한 (agent_grants) ─────────────────────────────

export type Grant = {
  id: number;
  agent_id: number;
  action: string;
  granted_by: string;
  granted_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
  revoked_reason: string | null;
};

/** 권한의 상태 — 만료는 행을 갱신하지 않고 시각으로 판단한다 */
export function grantState(g: Grant, now = new Date()): "active" | "expired" | "revoked" {
  if (g.revoked_at) return "revoked";
  return g.expires_at > now.toISOString() ? "active" : "expired";
}

export function getGrant(db: DB, id: number): Grant | undefined {
  return db.prepare("SELECT * FROM agent_grants WHERE id = ?").get(id) as Grant | undefined;
}

/** (에이전트, 액션)의 유효한 권한 — 회수되지 않았고 만료 전. 여럿이면 가장 늦게 끝나는 것 */
export function activeGrant(db: DB, agentId: number, action: string, now = new Date()): Grant | undefined {
  return db
    .prepare("SELECT * FROM agent_grants WHERE agent_id = ? AND action = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY expires_at DESC LIMIT 1")
    .get(agentId, action, now.toISOString()) as Grant | undefined;
}

/** 에이전트의 권한 목록 (최신 순). active=true 면 유효한 것만 */
export function listGrants(db: DB, f: { agentId?: number; active?: boolean; now?: Date; limit?: number } = {}): Grant[] {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (f.agentId !== undefined) {
    conds.push("agent_id = ?");
    params.push(f.agentId);
  }
  if (f.active) {
    conds.push("revoked_at IS NULL AND expires_at > ?");
    params.push((f.now ?? new Date()).toISOString());
  }
  return db.prepare(`SELECT * FROM agent_grants ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`).all(...params, f.limit ?? 200) as Grant[];
}

/**
 * 화면용: 유효 권한은 전부(먼저, 새 것부터) + 회수·만료 이력은 최근 history 개.
 * 연장은 기존 행의 만료일만 바꾸므로(id 가 오래됨) id 순 LIMIT 으로는 오래 연장한 유효 권한이 이력에 밀려 가려진다.
 */
export function grantsOverview(db: DB, agentId: number, o: { history?: number; now?: Date } = {}): Grant[] {
  const now = o.now ?? new Date();
  const active = listGrants(db, { agentId, active: true, now, limit: 10_000 });
  const past = db
    .prepare("SELECT * FROM agent_grants WHERE agent_id = ? AND NOT (revoked_at IS NULL AND expires_at > ?) ORDER BY id DESC LIMIT ?")
    .all(agentId, now.toISOString(), o.history ?? 6) as Grant[];
  return [...active, ...past];
}

export function insertGrant(db: DB, g: { agent_id: number; action: string; granted_by: string; expires_at: string; granted_at?: string }): number {
  return Number(
    db
      .prepare("INSERT INTO agent_grants (agent_id, action, granted_by, granted_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(g.agent_id, g.action, g.granted_by, g.granted_at ?? new Date().toISOString(), g.expires_at).lastInsertRowid,
  );
}

export function extendGrant(db: DB, id: number, expiresAt: string) {
  db.prepare("UPDATE agent_grants SET expires_at = ? WHERE id = ?").run(expiresAt, id);
}

export function revokeGrant(db: DB, id: number, by: string, reason: string, at = new Date()) {
  db.prepare("UPDATE agent_grants SET revoked_at = ?, revoked_by = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL").run(at.toISOString(), by, reason, id);
}
