import type { DB } from "@/lib/db";
import { today } from "@/lib/dates";
import { type Scope, scopeWhere } from "./scope";

export const INVOICE_STATUSES = ["draft", "sent", "paid", "void"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export type Invoice = {
  id: number;
  business_id: number;
  client_id: number | null;
  number: string;
  issue_date: string;
  due_date: string | null;
  status: InvoiceStatus;
  currency: string;
  tax_rate: number;
  memo: string;
  created_at: string;
};

export type InvoiceRow = Invoice & {
  business_name: string;
  business_color: string;
  client_name: string | null;
  subtotal: number;
  tax: number;
  total: number;
  paid: number;
  balance: number;
};

export type InvoiceItem = {
  id: number;
  invoice_id: number;
  description: string;
  quantity: number;
  unit_price: number;
};

export type Payment = { id: number; invoice_id: number; amount: number; paid_at: string; method: string };

export type Expense = {
  id: number;
  business_id: number;
  category: string;
  description: string;
  amount: number;
  spent_at: string;
};

export type InvoiceInput = Pick<
  Invoice,
  "business_id" | "client_id" | "issue_date" | "due_date" | "currency" | "tax_rate" | "memo"
> & { items: Pick<InvoiceItem, "description" | "quantity" | "unit_price">[] };

// 소계 = Σ round(수량 × 단가), 세액 = round(소계 × 세율%)
const TOTALS = `
  WITH sums AS (
    SELECT i.id,
      COALESCE((SELECT SUM(ROUND(quantity * unit_price)) FROM invoice_items WHERE invoice_id = i.id), 0) AS subtotal,
      COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id = i.id), 0) AS paid
    FROM invoices i
  )
  SELECT i.*, b.name AS business_name, b.color AS business_color, c.name AS client_name,
    CAST(s.subtotal AS INTEGER) AS subtotal,
    CAST(ROUND(s.subtotal * i.tax_rate / 100.0) AS INTEGER) AS tax,
    CAST(s.subtotal + ROUND(s.subtotal * i.tax_rate / 100.0) AS INTEGER) AS total,
    s.paid AS paid,
    CAST(s.subtotal + ROUND(s.subtotal * i.tax_rate / 100.0) - s.paid AS INTEGER) AS balance
  FROM invoices i
  JOIN sums s ON s.id = i.id
  JOIN businesses b ON b.id = i.business_id
  LEFT JOIN clients c ON c.id = i.client_id`;

export function listInvoices(
  db: DB,
  scope: Scope,
  filter: { status?: InvoiceStatus; clientId?: number } = {},
): InvoiceRow[] {
  const [where, params] = scopeWhere(scope, "i.business_id");
  const conds = [where];
  if (filter.status) {
    conds.push("i.status = ?");
    params.push(filter.status);
  }
  if (filter.clientId) {
    conds.push("i.client_id = ?");
    params.push(filter.clientId);
  }
  return db
    .prepare(`${TOTALS} WHERE ${conds.join(" AND ")} ORDER BY i.issue_date DESC, i.id DESC`)
    .all(...params) as InvoiceRow[];
}

/** 발행(sent) 상태이면서 잔액이 남은 청구서. overdue = 지급기한 경과. */
export function receivables(db: DB, scope: Scope, on = today()) {
  return listInvoices(db, scope, { status: "sent" })
    .filter((i) => i.balance > 0)
    .map((i) => ({ ...i, overdue: !!i.due_date && i.due_date < on }));
}

export function getInvoice(db: DB, id: number) {
  const invoice = db.prepare(`${TOTALS} WHERE i.id = ?`).get(id) as InvoiceRow | undefined;
  if (!invoice) return undefined;
  const items = db
    .prepare("SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id")
    .all(id) as InvoiceItem[];
  const payments = db
    .prepare("SELECT * FROM payments WHERE invoice_id = ? ORDER BY paid_at, id")
    .all(id) as Payment[];
  return { invoice, items, payments };
}

/** 사업별·연도별 일련번호: 2026-001, 2026-002 … */
export function nextInvoiceNumber(db: DB, businessId: number, issueDate: string): string {
  const year = issueDate.slice(0, 4);
  const rows = db
    .prepare("SELECT number FROM invoices WHERE business_id = ? AND number LIKE ?")
    .all(businessId, `${year}-%`) as { number: string }[];
  const max = rows.reduce((m, r) => Math.max(m, Number(r.number.split("-")[1]) || 0), 0);
  return `${year}-${String(max + 1).padStart(3, "0")}`;
}

export function createInvoice(db: DB, input: InvoiceInput): number {
  return db.transaction(() => {
    const { items, ...inv } = input;
    const r = db
      .prepare(
        `INSERT INTO invoices (business_id, client_id, number, issue_date, due_date, currency, tax_rate, memo)
         VALUES (@business_id, @client_id, @number, @issue_date, @due_date, @currency, @tax_rate, @memo)`,
      )
      .run({ ...inv, number: nextInvoiceNumber(db, inv.business_id, inv.issue_date) });
    const id = Number(r.lastInsertRowid);
    replaceItems(db, id, items);
    return id;
  })();
}

export function updateInvoice(db: DB, id: number, input: InvoiceInput) {
  db.transaction(() => {
    const { items, ...inv } = input;
    db.prepare(
      `UPDATE invoices SET business_id=@business_id, client_id=@client_id, issue_date=@issue_date,
         due_date=@due_date, currency=@currency, tax_rate=@tax_rate, memo=@memo WHERE id=@id`,
    ).run({ ...inv, id });
    replaceItems(db, id, items);
    syncPaidStatus(db, id);
  })();
}

function replaceItems(db: DB, invoiceId: number, items: InvoiceInput["items"]) {
  db.prepare("DELETE FROM invoice_items WHERE invoice_id = ?").run(invoiceId);
  const ins = db.prepare(
    "INSERT INTO invoice_items (invoice_id, description, quantity, unit_price) VALUES (?, ?, ?, ?)",
  );
  for (const it of items) ins.run(invoiceId, it.description, it.quantity, it.unit_price);
}

/** 상태 변경. 발행(sent)으로 바꾸면 이미 받은 입금을 반영해 paid 로 넘길 수 있다. */
export function setInvoiceStatus(db: DB, id: number, status: InvoiceStatus) {
  db.transaction(() => {
    writeStatus(db, id, status);
    if (status === "sent") syncPaidStatus(db, id);
  })();
}

function writeStatus(db: DB, id: number, status: InvoiceStatus) {
  db.prepare("UPDATE invoices SET status = ? WHERE id = ?").run(status, id);
}

export function deleteInvoice(db: DB, id: number) {
  db.prepare("DELETE FROM invoices WHERE id = ?").run(id);
}

/** 입금 기록. 잔액이 0 이하가 되면 자동으로 paid 처리. */
export function addPayment(db: DB, input: Omit<Payment, "id">): number {
  return db.transaction(() => {
    const r = db
      .prepare("INSERT INTO payments (invoice_id, amount, paid_at, method) VALUES (@invoice_id, @amount, @paid_at, @method)")
      .run(input);
    syncPaidStatus(db, input.invoice_id);
    return Number(r.lastInsertRowid);
  })();
}

export function deletePayment(db: DB, id: number) {
  db.transaction(() => {
    const p = db.prepare("SELECT invoice_id FROM payments WHERE id = ?").get(id) as
      | { invoice_id: number }
      | undefined;
    db.prepare("DELETE FROM payments WHERE id = ?").run(id);
    if (p) syncPaidStatus(db, p.invoice_id);
  })();
}

function syncPaidStatus(db: DB, invoiceId: number) {
  const inv = getInvoice(db, invoiceId)?.invoice;
  if (!inv || inv.status === "void" || inv.status === "draft") return;
  const status = inv.total > 0 && inv.balance <= 0 ? "paid" : "sent";
  if (status !== inv.status) writeStatus(db, invoiceId, status);
}

// ── 지출 ───────────────────────────────────────────────

export function listExpenses(db: DB, scope: Scope, month?: string, id?: number): (Expense & { business_name: string; currency: string })[] {
  const [where, params] = scopeWhere(scope, "e.business_id");
  const conds = [where];
  if (id !== undefined) {
    conds.push("e.id = ?");
    params.push(id);
  }
  if (month) {
    conds.push("substr(e.spent_at, 1, 7) = ?");
    params.push(month);
  }
  return db
    .prepare(
      `SELECT e.*, b.name AS business_name, b.currency FROM expenses e JOIN businesses b ON b.id = e.business_id
       WHERE ${conds.join(" AND ")} ORDER BY e.spent_at DESC, e.id DESC`,
    )
    .all(...params) as (Expense & { business_name: string; currency: string })[];
}

export function addExpense(db: DB, input: Omit<Expense, "id">): number {
  const r = db
    .prepare(
      `INSERT INTO expenses (business_id, category, description, amount, spent_at)
       VALUES (@business_id, @category, @description, @amount, @spent_at)`,
    )
    .run(input);
  return Number(r.lastInsertRowid);
}

export function deleteExpense(db: DB, id: number) {
  db.prepare("DELETE FROM expenses WHERE id = ?").run(id);
}

// ── 정산 (월별 손익) ────────────────────────────────────

export type MonthlyPnl = { month: string; currency: string; income: number; expense: number; net: number };

/**
 * 월별 현금 기준 손익. 수입 = 입금(payments), 지출 = expenses.
 * 통화가 다른 사업은 합산하지 않고 통화별로 따로 낸다.
 */
export function monthlyPnl(db: DB, scope: Scope, months: string[]): MonthlyPnl[] {
  const [w1, p1] = scopeWhere(scope, "i.business_id");
  const [w2, p2] = scopeWhere(scope, "e.business_id");
  const income = db
    .prepare(
      `SELECT substr(p.paid_at, 1, 7) AS month, i.currency, SUM(p.amount) AS amount
       FROM payments p JOIN invoices i ON i.id = p.invoice_id
       WHERE ${w1} GROUP BY 1, 2`,
    )
    .all(...p1) as { month: string; currency: string; amount: number }[];
  const expense = db
    .prepare(
      `SELECT substr(e.spent_at, 1, 7) AS month, b.currency, SUM(e.amount) AS amount
       FROM expenses e JOIN businesses b ON b.id = e.business_id
       WHERE ${w2} GROUP BY 1, 2`,
    )
    .all(...p2) as { month: string; currency: string; amount: number }[];

  const currencies = [...new Set([...income, ...expense].map((r) => r.currency))].sort();
  const find = (rows: typeof income, m: string, c: string) =>
    rows.find((r) => r.month === m && r.currency === c)?.amount ?? 0;
  return currencies.flatMap((currency) =>
    months.map((month) => {
      const inc = find(income, month, currency);
      const exp = find(expense, month, currency);
      return { month, currency, income: inc, expense: exp, net: inc - exp };
    }),
  );
}
