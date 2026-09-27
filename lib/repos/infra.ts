import type { DB } from "@/lib/db";
import type { Scope } from "./scope";

export const PROVIDERS = ["aws", "gcp", "azure", "palantir", "http", "other"] as const;
export type Provider = (typeof PROVIDERS)[number];
export const CHECK_STATUSES = ["ok", "degraded", "down", "unknown"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export type Connection = {
  id: number;
  business_id: number | null;
  provider: Provider;
  name: string;
  account_ref: string;
  region: string;
  console_url: string;
  health_url: string;
  credential_env: string;
  monthly_budget: number | null;
  currency: string;
  memo: string;
  created_at: string;
};

export type ConnectionInput = Omit<Connection, "id" | "created_at">;

export type Check = {
  id: number;
  connection_id: number;
  status: CheckStatus;
  latency_ms: number | null;
  message: string;
  checked_at: string;
};

export type ConnectionRow = Connection & {
  business_name: string | null;
  business_color: string | null;
  last_status: CheckStatus | null;
  last_checked_at: string | null;
  last_message: string | null;
  last_latency_ms: number | null;
  month_cost: number | null;
};

export function listConnections(db: DB, scope: Scope, month: string): ConnectionRow[] {
  const conds: string[] = [];
  const params: unknown[] = [month];
  if (scope !== null) {
    conds.push("(x.business_id = ? OR x.business_id IS NULL)");
    params.push(scope);
  }
  return db
    .prepare(
      `SELECT x.*, b.name AS business_name, b.color AS business_color,
         lc.status AS last_status, lc.checked_at AS last_checked_at, lc.message AS last_message,
         lc.latency_ms AS last_latency_ms, cost.amount AS month_cost
       FROM infra_connections x
       LEFT JOIN businesses b ON b.id = x.business_id
       LEFT JOIN infra_checks lc ON lc.id = (
         SELECT id FROM infra_checks WHERE connection_id = x.id ORDER BY checked_at DESC, id DESC LIMIT 1)
       LEFT JOIN infra_costs cost ON cost.connection_id = x.id AND cost.month = ?
       ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""}
       ORDER BY x.provider, x.name`,
    )
    .all(...params) as ConnectionRow[];
}

export function getConnection(db: DB, id: number): Connection | undefined {
  return db.prepare("SELECT * FROM infra_connections WHERE id = ?").get(id) as Connection | undefined;
}

export function createConnection(db: DB, input: ConnectionInput): number {
  const r = db
    .prepare(
      `INSERT INTO infra_connections (business_id, provider, name, account_ref, region, console_url, health_url,
         credential_env, monthly_budget, currency, memo)
       VALUES (@business_id, @provider, @name, @account_ref, @region, @console_url, @health_url,
         @credential_env, @monthly_budget, @currency, @memo)`,
    )
    .run(input);
  return Number(r.lastInsertRowid);
}

export function updateConnection(db: DB, id: number, input: ConnectionInput) {
  db.prepare(
    `UPDATE infra_connections SET business_id=@business_id, provider=@provider, name=@name,
       account_ref=@account_ref, region=@region, console_url=@console_url, health_url=@health_url,
       credential_env=@credential_env, monthly_budget=@monthly_budget, currency=@currency, memo=@memo
     WHERE id=@id`,
  ).run({ ...input, id });
}

export function deleteConnection(db: DB, id: number) {
  db.prepare("DELETE FROM infra_connections WHERE id = ?").run(id);
}

export function recordCheck(db: DB, input: Omit<Check, "id">): number {
  const r = db
    .prepare(
      `INSERT INTO infra_checks (connection_id, status, latency_ms, message, checked_at)
       VALUES (@connection_id, @status, @latency_ms, @message, @checked_at)`,
    )
    .run(input);
  // 연결당 최근 200건만 보관
  db.prepare(
    `DELETE FROM infra_checks WHERE connection_id = ? AND id NOT IN (
       SELECT id FROM infra_checks WHERE connection_id = ? ORDER BY checked_at DESC, id DESC LIMIT 200)`,
  ).run(input.connection_id, input.connection_id);
  return Number(r.lastInsertRowid);
}

export function listChecks(db: DB, connectionId: number, limit = 30): Check[] {
  return db
    .prepare("SELECT * FROM infra_checks WHERE connection_id = ? ORDER BY checked_at DESC, id DESC LIMIT ?")
    .all(connectionId, limit) as Check[];
}

/** 월 비용 기록 (같은 달이면 덮어씀). */
export function upsertCost(db: DB, connectionId: number, month: string, amount: number, source = "manual") {
  db.prepare(
    `INSERT INTO infra_costs (connection_id, month, amount, source) VALUES (?, ?, ?, ?)
     ON CONFLICT (connection_id, month) DO UPDATE SET amount = excluded.amount, source = excluded.source`,
  ).run(connectionId, month, amount, source);
}

export function listCosts(db: DB, connectionId: number): { month: string; amount: number; source: string }[] {
  return db
    .prepare("SELECT month, amount, source FROM infra_costs WHERE connection_id = ? ORDER BY month DESC LIMIT 12")
    .all(connectionId) as { month: string; amount: number; source: string }[];
}
