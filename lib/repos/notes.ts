import type { DB } from "@/lib/db";
import type { Scope } from "./scope";

export type Note = {
  id: number;
  business_id: number | null;
  client_id: number | null;
  title: string;
  body: string;
  tags: string;
  pinned: number;
  created_at: string;
  updated_at: string;
};

export type NoteRow = Note & { business_name: string | null; business_color: string | null; client_name: string | null };

export type NoteInput = Pick<Note, "business_id" | "client_id" | "title" | "body" | "tags"> & {
  pinned: boolean;
};

/** FTS5(trigram) 는 3글자 이상에서만 동작한다. 짧은 검색어는 LIKE 로 대체. */
function searchClause(q: string): [string, unknown[]] {
  const term = q.trim();
  if ([...term].length >= 3) {
    return ["n.id IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?)", [`"${term.replaceAll('"', '""')}"`]];
  }
  const like = `%${term}%`;
  return ["(n.title LIKE ? OR n.body LIKE ? OR n.tags LIKE ?)", [like, like, like]];
}

/** 사업 범위가 지정되면 해당 사업 + 공용(business_id NULL) 노트를 함께 보여준다. */
export function listNotes(
  db: DB,
  scope: Scope,
  filter: { q?: string; tag?: string; clientId?: number } = {},
): NoteRow[] {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (scope !== null) {
    conds.push("(n.business_id = ? OR n.business_id IS NULL)");
    params.push(scope);
  }
  if (filter.q?.trim()) {
    const [c, p] = searchClause(filter.q);
    conds.push(c);
    params.push(...p);
  }
  if (filter.tag) {
    conds.push("(',' || REPLACE(n.tags, ' ', '') || ',') LIKE ?");
    params.push(`%,${filter.tag},%`);
  }
  if (filter.clientId) {
    conds.push("n.client_id = ?");
    params.push(filter.clientId);
  }
  return db
    .prepare(
      `SELECT n.*, b.name AS business_name, b.color AS business_color, c.name AS client_name
       FROM notes n LEFT JOIN businesses b ON b.id = n.business_id LEFT JOIN clients c ON c.id = n.client_id
       ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""}
       ORDER BY n.pinned DESC, n.updated_at DESC`,
    )
    .all(...params) as NoteRow[];
}

export function noteTags(db: DB, scope: Scope): string[] {
  const rows = listNotes(db, scope);
  const tags = new Set<string>();
  for (const r of rows) for (const t of splitTags(r.tags)) tags.add(t);
  return [...tags].sort();
}

export function splitTags(tags: string): string[] {
  return tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

export function getNote(db: DB, id: number): Note | undefined {
  return db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as Note | undefined;
}

export function createNote(db: DB, input: NoteInput): number {
  const r = db
    .prepare(
      `INSERT INTO notes (business_id, client_id, title, body, tags, pinned)
       VALUES (@business_id, @client_id, @title, @body, @tags, @pinned)`,
    )
    .run({ ...input, pinned: input.pinned ? 1 : 0 });
  return Number(r.lastInsertRowid);
}

export function updateNote(db: DB, id: number, input: NoteInput) {
  db.prepare(
    `UPDATE notes SET business_id=@business_id, client_id=@client_id, title=@title, body=@body, tags=@tags,
       pinned=@pinned, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id=@id`,
  ).run({ ...input, pinned: input.pinned ? 1 : 0, id });
}

export function deleteNote(db: DB, id: number) {
  db.prepare("DELETE FROM notes WHERE id = ?").run(id);
}
