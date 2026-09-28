import type { DB } from "@/lib/db";
import { addDays, addMonths, today } from "@/lib/dates";
import { type Scope, scopeWhere } from "./scope";

export const TASK_STATUSES = ["todo", "doing", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const RECURRENCES = ["none", "weekly", "monthly", "quarterly", "yearly"] as const;
export type Recurrence = (typeof RECURRENCES)[number];

export type Task = {
  id: number;
  business_id: number;
  client_id: number | null;
  title: string;
  detail: string;
  status: TaskStatus;
  priority: 1 | 2 | 3;
  due_date: string | null;
  recurrence: Recurrence;
  completed_at: string | null;
  created_at: string;
};

export type TaskRow = Task & {
  business_name: string;
  business_color: string;
  client_name: string | null;
};

export type TaskInput = Pick<
  Task,
  "business_id" | "client_id" | "title" | "detail" | "priority" | "due_date" | "recurrence"
>;

/** 반복 업무의 다음 마감일. 반복이 없거나 마감일이 없으면 null. */
export function nextDueDate(due: string | null, recurrence: Recurrence): string | null {
  if (!due) return null;
  switch (recurrence) {
    case "weekly":
      return addDays(due, 7);
    case "monthly":
      return addMonths(due, 1);
    case "quarterly":
      return addMonths(due, 3);
    case "yearly":
      return addMonths(due, 12);
    default:
      return null;
  }
}

const SELECT = `
  SELECT t.*, b.name AS business_name, b.color AS business_color, c.name AS client_name
  FROM tasks t
  JOIN businesses b ON b.id = t.business_id
  LEFT JOIN clients c ON c.id = t.client_id`;

const ORDER = `
  ORDER BY (t.due_date IS NULL), t.due_date, t.priority, t.id`;

export function listTasks(
  db: DB,
  scope: Scope,
  filter: { view?: "open" | "done" | "all"; clientId?: number; /** 한 업무만 (객체 상세) */ id?: number } = {},
): TaskRow[] {
  const [where, params] = scopeWhere(scope, "t.business_id");
  const conds = [where];
  if (filter.id !== undefined) {
    conds.push("t.id = ?");
    params.push(filter.id);
  }
  const view = filter.view ?? "open";
  if (view === "open") conds.push("t.status != 'done'");
  if (view === "done") conds.push("t.status = 'done'");
  if (filter.clientId) {
    conds.push("t.client_id = ?");
    params.push(filter.clientId);
  }
  const order = view === "done" ? "ORDER BY t.completed_at DESC" : ORDER;
  return db.prepare(`${SELECT} WHERE ${conds.join(" AND ")} ${order}`).all(...params) as TaskRow[];
}

/** 마감일이 `until` 이전(포함)인 미완료 업무. 지난 마감 포함. */
export function dueTasks(db: DB, scope: Scope, until: string): TaskRow[] {
  const [where, params] = scopeWhere(scope, "t.business_id");
  return db
    .prepare(`${SELECT} WHERE ${where} AND t.status != 'done' AND t.due_date <= ? ${ORDER}`)
    .all(...params, until) as TaskRow[];
}

export function getTask(db: DB, id: number): Task | undefined {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Task | undefined;
}

export function createTask(db: DB, input: TaskInput): number {
  const r = db
    .prepare(
      `INSERT INTO tasks (business_id, client_id, title, detail, priority, due_date, recurrence)
       VALUES (@business_id, @client_id, @title, @detail, @priority, @due_date, @recurrence)`,
    )
    .run(input);
  return Number(r.lastInsertRowid);
}

export function updateTask(db: DB, id: number, input: TaskInput) {
  db.prepare(
    `UPDATE tasks SET business_id=@business_id, client_id=@client_id, title=@title, detail=@detail,
       priority=@priority, due_date=@due_date, recurrence=@recurrence
     WHERE id=@id`,
  ).run({ ...input, id });
}

/**
 * 상태 변경. 반복 업무를 완료하면 다음 회차를 새 업무로 만든다.
 * @returns 새로 생성된 다음 회차 업무 id (없으면 null)
 */
export function setTaskStatus(db: DB, id: number, status: TaskStatus): number | null {
  return db.transaction(() => {
    const task = getTask(db, id);
    if (!task || task.status === status) return null;
    db.prepare("UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?").run(
      status,
      status === "done" ? new Date().toISOString() : null,
      id,
    );
    if (status !== "done") return null;
    const next = nextDueDate(task.due_date, task.recurrence);
    if (!next) return null;
    return createTask(db, { ...task, due_date: next });
  })();
}

export function deleteTask(db: DB, id: number) {
  db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
}

export function taskCounts(db: DB, scope: Scope, on = today()) {
  const [where, params] = scopeWhere(scope);
  return db
    .prepare(
      `SELECT
         COUNT(*) FILTER (WHERE status != 'done') AS open,
         COUNT(*) FILTER (WHERE status != 'done' AND due_date < ?) AS overdue,
         COUNT(*) FILTER (WHERE status != 'done' AND due_date BETWEEN ? AND ?) AS due_week
       FROM tasks WHERE ${where}`,
    )
    .get(on, on, addDays(on, 7), ...params) as { open: number; overdue: number; due_week: number };
}
