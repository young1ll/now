import type { DB } from "@/lib/db";

export type IacResource = {
  address: string;
  type: string;
  name: string;
  provider: string;
  /** 감사에 필요한 핵심 속성만 (비밀값 제외) */
  attributes: Record<string, string>;
};

export type IacChange = {
  address: string;
  type: string;
  actions: string[];
};

export type Snapshot = {
  id: number;
  captured_at: string;
  tool: string;
  status: "in_sync" | "drift" | "error";
  resource_count: number;
  change_count: number;
  resources: IacResource[];
  changes: IacChange[];
  message: string;
};

type Row = Omit<Snapshot, "resources" | "changes"> & { resources: string; changes: string };

const parse = (r: Row): Snapshot => ({ ...r, resources: JSON.parse(r.resources), changes: JSON.parse(r.changes) });

export function insertSnapshot(db: DB, s: Omit<Snapshot, "id" | "resource_count" | "change_count">): number {
  return Number(
    db
      .prepare(
        `INSERT INTO infra_snapshots (captured_at, tool, status, resource_count, change_count, resources, changes, message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.captured_at,
        s.tool,
        s.status,
        s.resources.length,
        s.changes.length,
        JSON.stringify(s.resources),
        JSON.stringify(s.changes),
        s.message,
      ).lastInsertRowid,
  );
}

export function latestSnapshot(db: DB): Snapshot | undefined {
  const r = db.prepare("SELECT * FROM infra_snapshots ORDER BY id DESC LIMIT 1").get() as Row | undefined;
  return r && parse(r);
}

export function listSnapshots(db: DB, limit = 20): Omit<Snapshot, "resources" | "changes">[] {
  return db
    .prepare(
      `SELECT id, captured_at, tool, status, resource_count, change_count, message
       FROM infra_snapshots ORDER BY id DESC LIMIT ?`,
    )
    .all(limit) as Omit<Snapshot, "resources" | "changes">[];
}
