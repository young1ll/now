import type { DB } from "@/lib/db";
import type { Scope } from "./scope";

export const NOTE_KINDS = ["note", "playbook", "episode", "brief", "source"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
/** 사람·에이전트가 직접 만들 수 있는 종류 — 에피소드는 워커(document.record_episode)만 */
export const AUTHORED_NOTE_KINDS = ["note", "playbook", "brief", "source"] as const;

export type Note = {
  id: number;
  business_id: number | null;
  client_id: number | null;
  title: string;
  body: string;
  tags: string;
  pinned: number;
  kind: NoteKind;
  /** 외부 원본·유래 ('session:12' · 'https://…' · 'file:…') */
  source_uri: string;
  /** 외부 비신뢰 입력에서 유래 */
  tainted: number;
  version: number;
  created_at: string;
  updated_at: string;
};

export type NoteRow = Note & { business_name: string | null; business_color: string | null; client_name: string | null };

export type NoteInput = Pick<Note, "business_id" | "client_id" | "title" | "body" | "tags"> & {
  pinned: boolean;
  kind?: NoteKind;
  source_uri?: string;
  tainted?: boolean;
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
  filter: {
    q?: string;
    tag?: string;
    clientId?: number;
    kind?: NoteKind;
    /** 본문을 앞 N자만 읽는다 (목록·선택지 — 에피소드가 세션마다 쌓여도 전체 본문을 적재하지 않게) */
    excerpt?: number;
    limit?: number;
  } = {},
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
  if (filter.kind) {
    conds.push("n.kind = ?");
    params.push(filter.kind);
  }
  const body = filter.excerpt ? `substr(n.body, 1, ${Math.max(1, Math.floor(filter.excerpt))}) AS body` : "n.body";
  return db
    .prepare(
      `SELECT n.id, n.business_id, n.client_id, n.title, ${body}, n.tags, n.pinned, n.kind, n.source_uri, n.tainted, n.version, n.created_at, n.updated_at,
              b.name AS business_name, b.color AS business_color, c.name AS client_name
       FROM notes n LEFT JOIN businesses b ON b.id = n.business_id LEFT JOIN clients c ON c.id = n.client_id
       ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""}
       ORDER BY n.pinned DESC, n.updated_at DESC${filter.limit ? " LIMIT ?" : ""}`,
    )
    .all(...params, ...(filter.limit ? [filter.limit] : [])) as NoteRow[];
}

/** 종류별 문서 수 (목록 화면의 종류 탭 — 목록 전체를 읽지 않고 센다) */
export function countNotesByKind(db: DB, scope: Scope, q?: string): Record<string, number> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (scope !== null) {
    conds.push("(n.business_id = ? OR n.business_id IS NULL)");
    params.push(scope);
  }
  if (q?.trim()) {
    const [c, p] = searchClause(q);
    conds.push(c);
    params.push(...p);
  }
  const rows = db.prepare(`SELECT n.kind, COUNT(*) AS n FROM notes n ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""} GROUP BY n.kind`).all(...params) as { kind: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
}

export function noteTags(db: DB, scope: Scope): string[] {
  const rows = listNotes(db, scope, { excerpt: 1 });
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

/** 한 문서 + 사업·고객 이름 (객체 화면용 — 목록 전체를 읽지 않는다) */
export function getNoteRow(db: DB, id: number): NoteRow | undefined {
  return db
    .prepare(
      `SELECT n.*, b.name AS business_name, b.color AS business_color, c.name AS client_name
       FROM notes n LEFT JOIN businesses b ON b.id = n.business_id LEFT JOIN clients c ON c.id = n.client_id WHERE n.id = ?`,
    )
    .get(id) as NoteRow | undefined;
}

export function getNote(db: DB, id: number): Note | undefined {
  return db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as Note | undefined;
}

export function createNote(db: DB, input: NoteInput): number {
  const r = db
    .prepare(
      `INSERT INTO notes (business_id, client_id, title, body, tags, pinned, kind, source_uri, tainted)
       VALUES (@business_id, @client_id, @title, @body, @tags, @pinned, @kind, @source_uri, @tainted)`,
    )
    .run({ ...input, pinned: input.pinned ? 1 : 0, kind: input.kind ?? "note", source_uri: input.source_uri ?? "", tainted: input.tainted ? 1 : 0 });
  return Number(r.lastInsertRowid);
}

/**
 * 부분 수정. 제목·본문이 바뀌면 이전 내용을 note_versions 에 넣고 version + 1 (changedBy = 바꾼 행위자 'human:operator').
 * 종류·출처·오염은 넘긴 경우에만 바꾼다.
 */
export function updateNote(db: DB, id: number, input: NoteInput, changedBy = "system:system") {
  const cur = getNote(db, id);
  if (!cur) return;
  const changed = cur.title !== input.title || cur.body !== input.body;
  if (changed) {
    db.prepare("INSERT INTO note_versions (note_id, version, title, body, changed_by) VALUES (?, ?, ?, ?, ?)").run(id, cur.version, cur.title, cur.body, changedBy);
  }
  db.prepare(
    `UPDATE notes SET business_id=@business_id, client_id=@client_id, title=@title, body=@body, tags=@tags,
       pinned=@pinned, kind=@kind, source_uri=@source_uri, tainted=@tainted, version=@version, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id=@id`,
  ).run({
    ...input,
    pinned: input.pinned ? 1 : 0,
    kind: input.kind ?? cur.kind,
    source_uri: input.source_uri ?? cur.source_uri,
    tainted: input.tainted === undefined ? cur.tainted : input.tainted ? 1 : 0,
    version: changed ? cur.version + 1 : cur.version,
    id,
  });
}

export function deleteNote(db: DB, id: number) {
  db.prepare("DELETE FROM notes WHERE id = ?").run(id);
}

// ── 버전 ─────────────────────────────────────────────

export type NoteVersion = { note_id: number; version: number; title: string; body: string; changed_by: string; changed_at: string };

/** 이전 버전들 (새 것 → 오래된 것). 지금 내용은 notes 행 (version) */
export function listNoteVersions(db: DB, noteId: number): NoteVersion[] {
  return db.prepare("SELECT * FROM note_versions WHERE note_id = ? ORDER BY version DESC").all(noteId) as NoteVersion[];
}

export function getNoteVersion(db: DB, noteId: number, version: number): NoteVersion | undefined {
  return db.prepare("SELECT * FROM note_versions WHERE note_id = ? AND version = ?").get(noteId, version) as NoteVersion | undefined;
}

// ── 에피소드 · 플레이북 ─────────────────────────────────

/** 출처 URI 로 문서 찾기 (에피소드 멱등: 'session:12') */
export function findNoteBySource(db: DB, uri: string, kind?: NoteKind): Note | undefined {
  return db.prepare(`SELECT * FROM notes WHERE source_uri = ?${kind ? " AND kind = ?" : ""} ORDER BY id LIMIT 1`).get(...(kind ? [uri, kind] : [uri])) as Note | undefined;
}

export const episodeUri = (sessionId: number) => `session:${sessionId}`;

/** 세션 id ← 에피소드의 source_uri */
export function episodeSessionId(n: Pick<Note, "kind" | "source_uri">): number | null {
  const m = n.kind === "episode" ? n.source_uri.match(/^session:(\d+)$/) : null;
  return m ? Number(m[1]) : null;
}

/** 최근 에피소드 (새 것 먼저). since 는 created_at 기준 (그 시각 이후) */
export function listEpisodes(db: DB, f: { since?: string; limit?: number; includeTainted?: boolean; scope?: Scope } = {}): Note[] {
  const conds = ["kind = 'episode'"];
  const params: unknown[] = [];
  if (f.since) {
    conds.push("created_at > ?");
    params.push(f.since);
  }
  if (f.includeTainted === false) conds.push("tainted = 0");
  if (f.scope !== undefined && f.scope !== null) {
    conds.push("(business_id = ? OR business_id IS NULL)");
    params.push(f.scope);
  }
  return db.prepare(`SELECT * FROM notes WHERE ${conds.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...params, f.limit ?? 20) as Note[];
}

/** 이 문서(플레이북)가 컨텍스트 팩에 들어간 세션 수 · 그중 성공 수 (agent_sessions.context_refs 에 "note:<id>") */
export function packSessionStats(db: DB, noteId: number): { sessions: number; succeeded: number; failed: number } {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS sessions, COALESCE(SUM(status = 'succeeded'), 0) AS succeeded, COALESCE(SUM(status = 'failed'), 0) AS failed
       FROM agent_sessions WHERE context_refs LIKE ?`,
    )
    .get(`%"note:${noteId}"%`) as { sessions: number; succeeded: number; failed: number };
  return r;
}
