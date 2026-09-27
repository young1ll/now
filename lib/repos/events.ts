import type { DB } from "@/lib/db";
import type { Actor, Ref } from "@/lib/ontology/types";

export type EventRow = {
  id: number;
  type: string;
  actor_type: string | null;
  actor_id: string | null;
  subject_type: string | null;
  subject_id: number | null;
  payload: string;
  created_at: string;
};

export type NowEvent = Omit<EventRow, "payload"> & { payload: Record<string, unknown> };

const parse = (r: EventRow): NowEvent => ({ ...r, payload: JSON.parse(r.payload) });

/**
 * 이벤트 발행 (outbox). 호출한 트랜잭션과 함께 커밋되고, 워커가 id 순서대로 소비한다.
 * 이벤트 유형 규약: <영역>.<동사> — action.applied · action.pending · action.rejected · signal.raised · signal.resolved · schedule.tick …
 */
export function emitEvent(
  db: DB,
  e: { type: string; actor?: Pick<Actor, "type" | "id"> | null; subject?: Ref | null; payload?: Record<string, unknown> },
): number {
  return Number(
    db
      .prepare("INSERT INTO events (type, actor_type, actor_id, subject_type, subject_id, payload) VALUES (?, ?, ?, ?, ?, ?)")
      .run(e.type, e.actor?.type ?? null, e.actor?.id ?? null, e.subject?.type ?? null, e.subject?.id ?? null, JSON.stringify(e.payload ?? {}))
      .lastInsertRowid,
  );
}

export function listEvents(db: DB, f: { afterId?: number; beforeId?: number; type?: string; limit?: number } = {}): NowEvent[] {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (f.afterId !== undefined) {
    conds.push("id > ?");
    params.push(f.afterId);
  }
  if (f.beforeId !== undefined) {
    conds.push("id < ?");
    params.push(f.beforeId);
  }
  if (f.type) {
    // 접두사 패턴: "action." → action.* 전체
    conds.push(f.type.endsWith(".") || f.type.endsWith("*") ? "type LIKE ?" : "type = ?");
    params.push(f.type.endsWith("*") ? `${f.type.slice(0, -1)}%` : f.type.endsWith(".") ? `${f.type}%` : f.type);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  // afterId 는 오래된 순(스트림 소비), 그 외는 최신 순(조회)
  const order = f.afterId !== undefined ? "ASC" : "DESC";
  return (db.prepare(`SELECT * FROM events ${where} ORDER BY id ${order} LIMIT ?`).all(...params, f.limit ?? 100) as EventRow[]).map(parse);
}

export function getEvent(db: DB, id: number): NowEvent | undefined {
  const r = db.prepare("SELECT * FROM events WHERE id = ?").get(id) as EventRow | undefined;
  return r && parse(r);
}

export function lastEventId(db: DB): number {
  return (db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM events").get() as { n: number }).n;
}

/** glob 패턴: "*" 전체, "action.*", "signal.raised", 쉼표로 여러 개 */
export function matchesPattern(pattern: string, type: string): boolean {
  return pattern
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .some((p) => {
      const re = new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
      return re.test(type);
    });
}
