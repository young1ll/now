import type { DB } from "@/lib/db";
import { type Scope, scopeWhere } from "./scope";

export const CLIENT_STATUSES = ["lead", "active", "paused", "closed"] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];
export const INTERACTION_KINDS = ["call", "meeting", "email", "memo"] as const;
export type InteractionKind = (typeof INTERACTION_KINDS)[number];

export type Client = {
  id: number;
  business_id: number;
  name: string;
  kind: "company" | "person";
  status: ClientStatus;
  email: string;
  phone: string;
  tags: string;
  memo: string;
  created_at: string;
  updated_at: string;
};

export type ClientRow = Client & {
  business_name: string;
  business_color: string;
  last_contact: string | null;
  open_tasks: number;
};

export type ClientInput = Pick<
  Client,
  "business_id" | "name" | "kind" | "status" | "email" | "phone" | "tags" | "memo"
>;

export type Interaction = {
  id: number;
  client_id: number;
  kind: InteractionKind;
  summary: string;
  occurred_at: string;
};

export function listClients(
  db: DB,
  scope: Scope,
  filter: { status?: ClientStatus; q?: string; /** 한 고객만 (객체 상세 — 목록 전체를 만들지 않는다) */ id?: number } = {},
): ClientRow[] {
  const [where, params] = scopeWhere(scope, "c.business_id");
  const conds = [where];
  if (filter.id !== undefined) {
    conds.push("c.id = ?");
    params.push(filter.id);
  }
  if (filter.status) {
    conds.push("c.status = ?");
    params.push(filter.status);
  }
  if (filter.q) {
    conds.push("(c.name LIKE ? OR c.email LIKE ? OR c.tags LIKE ? OR c.memo LIKE ?)");
    const like = `%${filter.q}%`;
    params.push(like, like, like, like);
  }
  return db
    .prepare(
      `SELECT c.*, b.name AS business_name, b.color AS business_color,
              (SELECT MAX(occurred_at) FROM interactions i WHERE i.client_id = c.id) AS last_contact,
              (SELECT COUNT(*) FROM tasks t WHERE t.client_id = c.id AND t.status != 'done') AS open_tasks
       FROM clients c JOIN businesses b ON b.id = c.business_id
       WHERE ${conds.join(" AND ")}
       ORDER BY CASE c.status WHEN 'active' THEN 0 WHEN 'lead' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END, c.name`,
    )
    .all(...params) as ClientRow[];
}

export function getClient(db: DB, id: number): Client | undefined {
  return db.prepare("SELECT * FROM clients WHERE id = ?").get(id) as Client | undefined;
}

export function clientOptions(db: DB, scope: Scope): { id: number; name: string; business_id: number }[] {
  const [where, params] = scopeWhere(scope);
  return db
    .prepare(`SELECT id, name, business_id FROM clients WHERE ${where} AND status != 'closed' ORDER BY name`)
    .all(...params) as { id: number; name: string; business_id: number }[];
}

export function createClient(db: DB, input: ClientInput): number {
  const r = db
    .prepare(
      `INSERT INTO clients (business_id, name, kind, status, email, phone, tags, memo)
       VALUES (@business_id, @name, @kind, @status, @email, @phone, @tags, @memo)`,
    )
    .run(input);
  return Number(r.lastInsertRowid);
}

export function updateClient(db: DB, id: number, input: ClientInput) {
  db.prepare(
    `UPDATE clients SET business_id=@business_id, name=@name, kind=@kind, status=@status, email=@email,
       phone=@phone, tags=@tags, memo=@memo, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id=@id`,
  ).run({ ...input, id });
}

export function deleteClient(db: DB, id: number) {
  db.prepare("DELETE FROM clients WHERE id = ?").run(id);
}

export function listInteractions(db: DB, clientId: number): Interaction[] {
  return db
    .prepare("SELECT * FROM interactions WHERE client_id = ? ORDER BY occurred_at DESC, id DESC")
    .all(clientId) as Interaction[];
}

export function addInteraction(
  db: DB,
  input: Pick<Interaction, "client_id" | "kind" | "summary" | "occurred_at">,
): number {
  const r = db
    .prepare(
      `INSERT INTO interactions (client_id, kind, summary, occurred_at)
       VALUES (@client_id, @kind, @summary, @occurred_at)`,
    )
    .run(input);
  return Number(r.lastInsertRowid);
}

export function deleteInteraction(db: DB, id: number) {
  db.prepare("DELETE FROM interactions WHERE id = ?").run(id);
}

export type RecentInteraction = Interaction & { client_name: string };

export function recentInteractions(db: DB, scope: Scope, limit = 5): RecentInteraction[] {
  const [where, params] = scopeWhere(scope, "c.business_id");
  return db
    .prepare(
      `SELECT i.*, c.name AS client_name FROM interactions i JOIN clients c ON c.id = i.client_id
       WHERE ${where} ORDER BY i.occurred_at DESC, i.id DESC LIMIT ?`,
    )
    .all(...params, limit) as RecentInteraction[];
}
