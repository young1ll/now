import crypto from "node:crypto";
import type { DB } from "@/lib/db";
import { agentIdForSessionToken } from "./ai";

export const AGENT_STATUSES = ["active", "suspended", "revoked"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export type Agent = {
  id: number;
  name: string;
  description: string;
  token_hash: string;
  token_prefix: string;
  status: AgentStatus;
  created_at: string;
  last_seen_at: string | null;
};

export type AgentRow = Omit<Agent, "token_hash"> & {
  runs_24h: number;
  pending: number;
  failed_24h: number;
  last_run_at: string | null;
};

const hash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

/** 새 에이전트 등록. 평문 토큰은 반환값으로 한 번만 나간다. */
export function createAgent(db: DB, input: { name: string; description?: string }): { id: number; token: string } {
  const token = `now_${crypto.randomBytes(24).toString("base64url")}`;
  const id = Number(
    db
      .prepare("INSERT INTO agents (name, description, token_hash, token_prefix) VALUES (?, ?, ?, ?)")
      .run(input.name, input.description ?? "", hash(token), token.slice(0, 10)).lastInsertRowid,
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

export function listAgents(db: DB, since: string): AgentRow[] {
  return db
    .prepare(
      `SELECT a.id, a.name, a.description, a.token_prefix, a.status, a.created_at, a.last_seen_at,
         (SELECT COUNT(*) FROM action_runs r WHERE r.actor_type = 'agent' AND r.actor_id = CAST(a.id AS TEXT) AND r.created_at >= ?) AS runs_24h,
         (SELECT COUNT(*) FROM action_runs r WHERE r.actor_type = 'agent' AND r.actor_id = CAST(a.id AS TEXT) AND r.status = 'pending') AS pending,
         (SELECT COUNT(*) FROM action_runs r WHERE r.actor_type = 'agent' AND r.actor_id = CAST(a.id AS TEXT) AND r.status IN ('failed','denied') AND r.created_at >= ?) AS failed_24h,
         (SELECT MAX(created_at) FROM action_runs r WHERE r.actor_type = 'agent' AND r.actor_id = CAST(a.id AS TEXT)) AS last_run_at
       FROM agents a ORDER BY a.status = 'revoked', a.id`,
    )
    .all(since, since) as AgentRow[];
}

export function setAgentStatus(db: DB, id: number, status: AgentStatus) {
  db.prepare("UPDATE agents SET status = ? WHERE id = ?").run(status, id);
}
