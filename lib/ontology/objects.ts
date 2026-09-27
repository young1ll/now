// 온톨로지: 사업의 객체 유형과 그 속성·연결. 콘솔·REST·MCP 가 모두 이 정의로 객체를 읽는다.
import type { DB } from "@/lib/db";
import { daysBetween, formatDate, today } from "@/lib/dates";
import {
  CLIENT_KIND, CLIENT_STATUS, INVOICE_STATUS, PRIORITY, RECURRENCE, TASK_STATUS, type Tone,
} from "@/lib/labels";
import { formatMoney } from "@/lib/money";
import { type AgentRow, getAgent, listAgents } from "@/lib/repos/agents";
import { getBusiness, listBusinesses } from "@/lib/repos/businesses";
import { getClient, listClients, listInteractions } from "@/lib/repos/clients";
import { getInvoice, listExpenses, listInvoices } from "@/lib/repos/finance";
import { getNote, listNotes } from "@/lib/repos/notes";
import type { Scope } from "@/lib/repos/scope";
import { getTask, listTasks } from "@/lib/repos/tasks";
import { displayId } from "./ids";
import type { ObjectType, Ref } from "./types";

export type Status = { label: string; tone: Tone };

export type ObjectRecord = {
  ref: Ref;
  displayId: string;
  title: string;
  subtitle: string;
  businessId: number | null;
  status?: Status;
  /** 열 키 → 표시 문자열 */
  props: Record<string, string>;
};

export type Link = { ref: Ref; displayId: string; title: string; relation: string };

export type ObjectDetail = ObjectRecord & {
  properties: { key: string; label: string; value: string }[];
  links: Link[];
  /** 원본 레코드 (API/MCP 용) */
  raw: Record<string, unknown>;
};

export type Column = { key: string; label: string; num?: boolean; mono?: boolean };

export type ObjectTypeDef = {
  type: ObjectType;
  label: string;
  plural: string;
  description: string;
  /** 새 객체를 만드는 액션 */
  createAction?: string;
  /** 객체 화면에서 이 객체를 대상으로 실행할 수 있는 액션 (전체 목록) */
  actions: string[];
  /** 현재 상태에서 의미 있는 액션만 (없으면 actions 전체) */
  actionsFor?: (raw: Record<string, unknown>) => string[];
  columns: Column[];
  list: (db: DB, scope: Scope, q?: string) => ObjectRecord[];
  get: (db: DB, id: number) => ObjectDetail | undefined;
};

const match = (q: string | undefined, ...fields: (string | null | undefined)[]) =>
  !q || fields.some((v) => v?.toLowerCase().includes(q.toLowerCase()));

const ref = <T extends ObjectType>(type: T, id: number) => ({ type, id });

function link(type: ObjectType, id: number, title: string, relation: string): Link {
  return { ref: { type, id }, displayId: displayId(type, id), title, relation };
}

function detail(rec: ObjectRecord, labels: Record<string, string>, links: Link[], raw: object): ObjectDetail {
  return {
    ...rec,
    properties: Object.entries(labels).map(([key, label]) => ({ key, label, value: rec.props[key] ?? "—" })),
    links,
    raw: raw as Record<string, unknown>,
  };
}

// ── business ─────────────────────────────────────────────

function businessRecord(db: DB, b: ReturnType<typeof listBusinesses>[number]): ObjectRecord {
  const c = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM clients WHERE business_id = ? AND status IN ('active','lead')) AS clients,
              (SELECT COUNT(*) FROM tasks WHERE business_id = ? AND status != 'done') AS tasks`,
    )
    .get(b.id, b.id) as { clients: number; tasks: number };
  return {
    ref: ref("business", b.id),
    displayId: displayId("business", b.id),
    title: b.name,
    subtitle: b.kind,
    businessId: b.id,
    status: b.archived ? { label: "보관", tone: "zinc" } : { label: "운영", tone: "green" },
    props: { kind: b.kind || "—", currency: b.currency, clients: String(c.clients), tasks: String(c.tasks), created: formatDate(b.created_at) },
  };
}

const business: ObjectTypeDef = {
  type: "business",
  label: "사업",
  plural: "사업",
  description: "운영 중인 사업 단위. 모든 고객·업무·재무 기록의 소속.",
  createAction: "business.create",
  actions: ["business.update", "client.create", "task.create", "invoice.create", "expense.record", "note.create"],
  columns: [
    { key: "kind", label: "업종" },
    { key: "currency", label: "통화", mono: true },
    { key: "clients", label: "고객", num: true },
    { key: "tasks", label: "열린 업무", num: true },
  ],
  list: (db, scope, q) =>
    listBusinesses(db, { includeArchived: true })
      .filter((b) => (scope === null || b.id === scope) && match(q, b.name, b.kind))
      .map((b) => businessRecord(db, b)),
  get(db, id) {
    const b = getBusiness(db, id);
    if (!b) return undefined;
    return detail(businessRecord(db, b), { kind: "업종", currency: "기본 통화", clients: "고객(진행·잠재)", tasks: "열린 업무", created: "등록일" }, [], b);
  },
};

// ── client ───────────────────────────────────────────────

const client: ObjectTypeDef = {
  type: "client",
  label: "고객",
  plural: "고객 · 거래처",
  description: "고객(거래처). status: lead/active/paused/closed. 접촉 이력(interactions)을 가진다.",
  createAction: "client.create",
  actions: ["client.log_interaction", "client.update", "task.create", "invoice.create", "note.create", "client.delete"],
  columns: [
    { key: "business", label: "사업" },
    { key: "kind", label: "구분" },
    { key: "last_contact", label: "최근 접촉", mono: true },
    { key: "open_tasks", label: "열린 업무", num: true },
    { key: "tags", label: "태그" },
  ],
  list: (db, scope, q) =>
    listClients(db, scope, { q }).map((c) => ({
      ref: ref("client", c.id),
      displayId: displayId("client", c.id),
      title: c.name,
      subtitle: [c.email, c.phone].filter(Boolean).join(" · "),
      businessId: c.business_id,
      status: CLIENT_STATUS[c.status],
      props: {
        business: c.business_name,
        kind: CLIENT_KIND[c.kind],
        last_contact: formatDate(c.last_contact),
        open_tasks: String(c.open_tasks),
        tags: c.tags || "—",
        email: c.email || "—",
        phone: c.phone || "—",
      },
    })),
  get(db, id) {
    const c = getClient(db, id);
    if (!c) return undefined;
    const rec = client.list(db, c.business_id).find((r) => r.ref.id === id)!;
    const tasks = listTasks(db, null, { view: "all", clientId: id });
    const invoices = listInvoices(db, null, { clientId: id });
    const notes = listNotes(db, null, { clientId: id });
    const b = getBusiness(db, c.business_id);
    return detail(
      rec,
      { business: "사업", kind: "구분", email: "이메일", phone: "전화", tags: "태그", last_contact: "최근 접촉", open_tasks: "열린 업무" },
      [
        ...(b ? [link("business", b.id, b.name, "소속 사업")] : []),
        ...tasks.map((t) => link("task", t.id, t.title, `업무 · ${TASK_STATUS[t.status].label}`)),
        ...invoices.map((i) => link("invoice", i.id, `${i.number} ${formatMoney(i.total, i.currency)}`, `청구서 · ${INVOICE_STATUS[i.status].label}`)),
        ...notes.map((n) => link("note", n.id, n.title, "문서")),
      ],
      { ...c, interactions: listInteractions(db, id) },
    );
  },
};

// ── task ─────────────────────────────────────────────────

function dueLabel(due: string | null, status: string) {
  if (!due) return "—";
  if (status === "done") return formatDate(due);
  const d = daysBetween(today(), due);
  return `${formatDate(due)} (${d < 0 ? `${-d}일 지남` : d === 0 ? "오늘" : `D-${d}`})`;
}

const task: ObjectTypeDef = {
  type: "task",
  label: "업무",
  plural: "업무",
  description: "업무. status: todo/doing/done, priority 1(높음)~3(낮음), due_date, recurrence(반복).",
  createAction: "task.create",
  actions: ["task.set_status", "task.update", "task.delete"],
  actionsFor: (raw) => (raw.status === "done" ? ["task.set_status", "task.delete"] : ["task.set_status", "task.update", "task.delete"]),
  columns: [
    { key: "due", label: "마감", mono: true },
    { key: "priority", label: "우선순위" },
    { key: "client", label: "고객" },
    { key: "business", label: "사업" },
    { key: "recurrence", label: "반복" },
  ],
  list: (db, scope, q) =>
    listTasks(db, scope, { view: "all" })
      .filter((t) => match(q, t.title, t.detail, t.client_name))
      .map((t) => ({
        ref: ref("task", t.id),
        displayId: displayId("task", t.id),
        title: t.title,
        subtitle: t.detail.slice(0, 80),
        businessId: t.business_id,
        status: TASK_STATUS[t.status],
        props: {
          due: dueLabel(t.due_date, t.status),
          priority: PRIORITY[t.priority],
          client: t.client_name ?? "—",
          business: t.business_name,
          recurrence: t.recurrence === "none" ? "—" : RECURRENCE[t.recurrence],
          completed: formatDate(t.completed_at),
          created: formatDate(t.created_at),
        },
      })),
  get(db, id) {
    const t = getTask(db, id);
    if (!t) return undefined;
    const rec = task.list(db, t.business_id).find((r) => r.ref.id === id)!;
    const b = getBusiness(db, t.business_id);
    const c = t.client_id ? getClient(db, t.client_id) : undefined;
    return detail(
      rec,
      { due: "마감", priority: "우선순위", recurrence: "반복", client: "고객", business: "사업", completed: "완료일", created: "등록일" },
      [...(b ? [link("business", b.id, b.name, "소속 사업")] : []), ...(c ? [link("client", c.id, c.name, "고객")] : [])],
      t,
    );
  },
};

// ── invoice ──────────────────────────────────────────────

const invoice: ObjectTypeDef = {
  type: "invoice",
  label: "청구서",
  plural: "청구서",
  description: "청구서. status: draft(작성)/sent(발행)/paid(완납)/void(취소). 금액은 통화 최소 단위 정수(raw) 와 표시 문자열(props).",
  createAction: "invoice.create",
  actions: ["invoice.issue", "payment.record", "invoice.update", "invoice.void", "invoice.delete"],
  actionsFor: (raw) => {
    const inv = (raw as { invoice: { status: string; balance: number } }).invoice;
    switch (inv.status) {
      case "draft":
        return ["invoice.issue", "invoice.update", "invoice.delete"];
      case "sent":
        return inv.balance > 0 ? ["payment.record", "invoice.update", "invoice.void"] : ["invoice.update", "invoice.void"];
      case "paid":
        return ["invoice.update"];
      default:
        return ["invoice.delete"];
    }
  },
  columns: [
    { key: "number", label: "번호", mono: true },
    { key: "client", label: "고객" },
    { key: "issue_date", label: "발행일", mono: true },
    { key: "due_date", label: "지급기한", mono: true },
    { key: "total", label: "합계", num: true },
    { key: "balance", label: "잔액", num: true },
  ],
  list: (db, scope, q) =>
    listInvoices(db, scope)
      .filter((i) => match(q, i.number, i.client_name, i.memo))
      .map((i) => {
        const overdue = i.status === "sent" && i.balance > 0 && !!i.due_date && i.due_date < today();
        return {
          ref: ref("invoice", i.id),
          displayId: displayId("invoice", i.id),
          title: `${i.number} · ${i.client_name ?? "고객 없음"}`,
          subtitle: i.business_name,
          businessId: i.business_id,
          status: overdue ? { label: "기한 경과", tone: "red" as Tone } : INVOICE_STATUS[i.status],
          props: {
            number: i.number,
            client: i.client_name ?? "—",
            business: i.business_name,
            issue_date: formatDate(i.issue_date),
            due_date: formatDate(i.due_date),
            subtotal: formatMoney(i.subtotal, i.currency),
            tax: `${formatMoney(i.tax, i.currency)} (${i.tax_rate}%)`,
            total: formatMoney(i.total, i.currency),
            paid: formatMoney(i.paid, i.currency),
            balance: i.status === "void" ? "—" : formatMoney(i.balance, i.currency),
            currency: i.currency,
          },
        };
      }),
  get(db, id) {
    const d = getInvoice(db, id);
    if (!d) return undefined;
    const rec = invoice.list(db, d.invoice.business_id).find((r) => r.ref.id === id)!;
    const c = d.invoice.client_id ? getClient(db, d.invoice.client_id) : undefined;
    return detail(
      rec,
      { number: "번호", client: "고객", business: "사업", issue_date: "발행일", due_date: "지급기한", subtotal: "공급가액", tax: "부가세", total: "합계", paid: "입금", balance: "잔액" },
      [link("business", d.invoice.business_id, d.invoice.business_name, "소속 사업"), ...(c ? [link("client", c.id, c.name, "청구 대상")] : [])],
      d,
    );
  },
};

// ── expense ──────────────────────────────────────────────

const expense: ObjectTypeDef = {
  type: "expense",
  label: "지출",
  plural: "지출",
  description: "사업 지출 기록 (사업 기본 통화).",
  createAction: "expense.record",
  actions: ["expense.delete"],
  columns: [
    { key: "spent_at", label: "일자", mono: true },
    { key: "category", label: "분류" },
    { key: "business", label: "사업" },
    { key: "amount", label: "금액", num: true },
  ],
  list: (db, scope, q) =>
    listExpenses(db, scope)
      .filter((e) => match(q, e.description, e.category))
      .map((e) => ({
        ref: ref("expense", e.id),
        displayId: displayId("expense", e.id),
        title: e.description,
        subtitle: e.category,
        businessId: e.business_id,
        props: { spent_at: formatDate(e.spent_at), category: e.category, business: e.business_name, amount: formatMoney(e.amount, e.currency) },
      })),
  get(db, id) {
    const rec = expense.list(db, null).find((r) => r.ref.id === id);
    if (!rec) return undefined;
    const raw = db.prepare("SELECT * FROM expenses WHERE id = ?").get(id) as Record<string, unknown>;
    return detail(rec, { spent_at: "일자", category: "분류", business: "사업", amount: "금액" }, [link("business", rec.businessId!, rec.props.business, "소속 사업")], raw);
  },
};

// ── note ─────────────────────────────────────────────────

const note: ObjectTypeDef = {
  type: "note",
  label: "문서",
  plural: "지식 · 문서",
  description: "지식 베이스 문서 (마크다운). SOP·체크리스트·템플릿·리서치. business_id 가 없으면 공용.",
  createAction: "note.create",
  actions: ["note.update", "note.delete"],
  columns: [
    { key: "tags", label: "태그" },
    { key: "business", label: "사업" },
    { key: "client", label: "고객" },
    { key: "updated", label: "수정", mono: true },
  ],
  list: (db, scope, q) =>
    listNotes(db, scope, { q }).map((n) => ({
      ref: ref("note", n.id),
      displayId: displayId("note", n.id),
      title: n.title,
      subtitle: n.body.replace(/[#*`>\[\]]/g, "").slice(0, 100),
      businessId: n.business_id,
      status: n.pinned ? { label: "고정", tone: "blue" as Tone } : undefined,
      props: { tags: n.tags || "—", business: n.business_name ?? "공용", client: n.client_name ?? "—", updated: formatDate(n.updated_at) },
    })),
  get(db, id) {
    const n = getNote(db, id);
    if (!n) return undefined;
    const rec = note.list(db, null).find((r) => r.ref.id === id)!;
    const links = [
      ...(n.business_id ? [link("business", n.business_id, rec.props.business, "소속 사업")] : []),
      ...(n.client_id ? [link("client", n.client_id, rec.props.client, "관련 고객")] : []),
    ];
    return detail(rec, { tags: "태그", business: "사업", client: "고객", updated: "수정일" }, links, n);
  },
};

// ── agent ────────────────────────────────────────────────

const AGENT_STATUS: Record<string, Status> = {
  active: { label: "활성", tone: "green" },
  suspended: { label: "정지", tone: "amber" },
  revoked: { label: "폐기", tone: "zinc" },
};

function agentRecord(a: AgentRow): ObjectRecord {
  return {
    ref: ref("agent", a.id),
    displayId: displayId("agent", a.id),
    title: a.name,
    subtitle: a.description,
    businessId: null,
    status: AGENT_STATUS[a.status],
    props: {
      token: `${a.token_prefix}…`,
      last_seen: a.last_seen_at ? a.last_seen_at.replace("T", " ").slice(0, 16) : "—",
      runs_24h: String(a.runs_24h),
      pending: String(a.pending),
      failed_24h: String(a.failed_24h),
    },
  };
}

const agent: ObjectTypeDef = {
  type: "agent",
  label: "에이전트",
  plural: "에이전트",
  description: "이 운영 체제에 접속하는 AI 에이전트.",
  createAction: "agent.register",
  actions: ["agent.set_status"],
  actionsFor: (raw) => (raw.status === "revoked" ? [] : ["agent.set_status"]),
  columns: [
    { key: "token", label: "토큰", mono: true },
    { key: "last_seen", label: "최근 접속", mono: true },
    { key: "runs_24h", label: "24h 실행", num: true },
    { key: "pending", label: "승인 대기", num: true },
    { key: "failed_24h", label: "24h 실패", num: true },
  ],
  list: (db, _scope, q) =>
    listAgents(db, new Date(Date.now() - 86_400_000).toISOString())
      .filter((a) => match(q, a.name, a.description))
      .map(agentRecord),
  get(db, id) {
    const a = getAgent(db, id);
    if (!a) return undefined;
    const rec = agent.list(db, null).find((r) => r.ref.id === id)!;
    const { token_hash: _omit, ...raw } = a;
    return detail(rec, { token: "토큰 접두사", last_seen: "최근 접속", runs_24h: "24시간 실행", pending: "승인 대기", failed_24h: "24시간 실패·거부" }, [], raw);
  },
};

export const OBJECTS: Record<ObjectType, ObjectTypeDef> = { business, client, task, invoice, expense, note, agent };

export function objectDef(type: string): ObjectTypeDef | undefined {
  return Object.hasOwn(OBJECTS, type) ? OBJECTS[type as ObjectType] : undefined;
}

export function getObject(db: DB, r: Ref): ObjectDetail | undefined {
  return OBJECTS[r.type].get(db, r.id);
}

/** 여러 유형을 가로지르는 검색. */
export function searchObjects(db: DB, scope: Scope, q: string, limitPerType = 8): ObjectRecord[] {
  const types: ObjectType[] = ["client", "task", "invoice", "note", "expense", "business"];
  return types.flatMap((t) => OBJECTS[t].list(db, scope, q).slice(0, limitPerType));
}
