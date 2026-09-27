import type { DB } from "@/lib/db";

export type Business = {
  id: number;
  name: string;
  kind: string;
  color: string;
  currency: string;
  archived: number;
  created_at: string;
};

export type BusinessInput = Pick<Business, "name" | "kind" | "color" | "currency">;

export function listBusinesses(db: DB, { includeArchived = false } = {}): Business[] {
  return db
    .prepare(`SELECT * FROM businesses ${includeArchived ? "" : "WHERE archived = 0"} ORDER BY id`)
    .all() as Business[];
}

export function getBusiness(db: DB, id: number): Business | undefined {
  return db.prepare("SELECT * FROM businesses WHERE id = ?").get(id) as Business | undefined;
}

export function createBusiness(db: DB, input: BusinessInput): number {
  const r = db
    .prepare("INSERT INTO businesses (name, kind, color, currency) VALUES (@name, @kind, @color, @currency)")
    .run(input);
  return Number(r.lastInsertRowid);
}

export function updateBusiness(db: DB, id: number, input: BusinessInput & { archived: boolean }) {
  db.prepare(
    `UPDATE businesses SET name=@name, kind=@kind, color=@color, currency=@currency, archived=@archived
     WHERE id=@id`,
  ).run({ ...input, archived: input.archived ? 1 : 0, id });
}
