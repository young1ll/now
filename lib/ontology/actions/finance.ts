import { addDays, today } from "@/lib/dates";
import { EXPENSE_CATEGORIES } from "@/lib/labels";
import { formatMoney, toMajor } from "@/lib/money";
import { getBusiness } from "@/lib/repos/businesses";
import {
  addExpense, addPayment, createInvoice, deleteExpense, deleteInvoice, deletePayment, getInvoice,
  setInvoiceStatus, updateInvoice,
} from "@/lib/repos/finance";
import type { DB } from "@/lib/db";
import { defineAction } from "../action";
import { f } from "../fields";
import { deleteLinksFor } from "../graph";
import { displayId } from "../ids";
import { ActionError } from "../types";
import { checkClient, must, toMinor } from "./util";

const CATS = EXPENSE_CATEGORIES as unknown as readonly [string, ...string[]];
const catLabels = Object.fromEntries(EXPENSE_CATEGORIES.map((c) => [c, c])) as Record<string, string>;

type Items = { description: string; quantity: number; unit_price: number | string }[];
const itemsToMinor = (items: Items, currency: string) =>
  items.map((it) => ({ description: it.description, quantity: it.quantity, unit_price: toMinor(it.unit_price, currency, `'${it.description}' 단가`) }));

function invoiceLabel(db: DB, id: number) {
  const inv = getInvoice(db, id)?.invoice;
  return inv ? `청구서 ${inv.number}${inv.client_name ? ` (${inv.client_name})` : ""} ${formatMoney(inv.total, inv.currency)}` : `청구서 ${id}`;
}

const invoiceFields = {
  client_id: f.ref("고객", "client", { nullable: true }),
  issue_date: f.date("발행일"),
  due_date: f.date("지급기한", { nullable: true }),
  tax_rate: f.number("부가세율 %", { min: 0, max: 100, help: "한국 과세 사업자는 보통 10" }),
  memo: f.textarea("메모", { help: "청구서 하단에 표시 (입금 계좌 등)" }),
};

export const financeActions = [
  defineAction({
    name: "invoice.create",
    title: "청구서 작성",
    description: "작성 중(draft) 청구서를 만든다. 외부로 나가지 않으며, 발행은 invoice.issue 로 따로 한다. 통화는 사업 기본 통화.",
    objectType: "invoice",
    risk: "low",
    fields: {
      business_id: f.ref("사업", "business", { required: true }),
      ...invoiceFields,
      items: f.items("품목"),
    },
    run({ db }, i) {
      const b = must(getBusiness(db, i.business_id), "사업");
      checkClient(db, i.client_id, b.id);
      const issue = i.issue_date ?? today();
      const id = createInvoice(db, {
        business_id: b.id,
        client_id: i.client_id ?? null,
        issue_date: issue,
        due_date: i.due_date === undefined ? addDays(issue, 14) : i.due_date,
        currency: b.currency,
        tax_rate: i.tax_rate ?? (b.currency === "KRW" ? 10 : 0),
        memo: i.memo ?? "",
        items: itemsToMinor(i.items, b.currency),
      });
      const refs = [{ type: "invoice" as const, id }, ...(i.client_id ? [{ type: "client" as const, id: i.client_id }] : [])];
      return { summary: `${invoiceLabel(db, id)} 작성`, refs };
    },
  }),
  defineAction({
    name: "invoice.update",
    title: "청구서 수정",
    description: "청구서 내용을 수정한다. 작성 중(draft)이면 저위험, 발행된 청구서의 금액 변경은 고위험.",
    objectType: "invoice",
    risk: (db, i) => (getInvoice(db, i.id)?.invoice.status === "draft" ? "low" : "high"),
    target: { type: "invoice", param: "id" },
    fields: { id: f.ref("청구서", "invoice", { required: true }), ...invoiceFields, items: f.items("품목") },
    prefill: (db, id) => {
      const d = getInvoice(db, id);
      if (!d) return undefined;
      const { invoice: inv, items } = d;
      return { ...inv, items: items.map((it) => ({ ...it, unit_price: toMajor(it.unit_price, inv.currency) })) };
    },
    preview: (db, i) => `${invoiceLabel(db, i.id)} 수정`,
    run({ db }, i) {
      const { invoice: inv } = must(getInvoice(db, i.id), "청구서");
      if (inv.status === "void") throw new ActionError("취소된 청구서는 수정할 수 없습니다");
      checkClient(db, i.client_id, inv.business_id);
      updateInvoice(db, i.id, {
        business_id: inv.business_id,
        client_id: i.client_id === undefined ? inv.client_id : i.client_id,
        issue_date: i.issue_date ?? inv.issue_date,
        due_date: i.due_date === undefined ? inv.due_date : i.due_date,
        currency: inv.currency,
        tax_rate: i.tax_rate ?? inv.tax_rate,
        memo: i.memo ?? inv.memo,
        items: itemsToMinor(i.items, inv.currency),
      });
      return { summary: `${invoiceLabel(db, i.id)} 수정`, refs: [{ type: "invoice", id: i.id }] };
    },
  }),
  defineAction({
    name: "invoice.issue",
    title: "청구서 발행",
    description: "작성 중 청구서를 발행(sent) 상태로 바꾼다. 고객에게 청구가 확정되는 외부 행동이다.",
    objectType: "invoice",
    risk: "high",
    target: { type: "invoice", param: "id" },
    fields: { id: f.ref("청구서", "invoice", { required: true }) },
    preview: (db, i) => `${invoiceLabel(db, i.id)} 발행`,
    run({ db }, i) {
      const { invoice: inv, items } = must(getInvoice(db, i.id), "청구서");
      if (inv.status !== "draft") throw new ActionError(`작성 중인 청구서만 발행할 수 있습니다 (현재: ${inv.status})`);
      if (items.length === 0 || inv.total <= 0) throw new ActionError("금액이 0 인 청구서는 발행할 수 없습니다");
      setInvoiceStatus(db, i.id, "sent");
      return { summary: `${invoiceLabel(db, i.id)} 발행`, refs: [{ type: "invoice", id: i.id }] };
    },
  }),
  defineAction({
    name: "invoice.void",
    title: "청구서 취소",
    description: "청구서를 취소(void)한다. 입금 기록이 있으면 먼저 삭제해야 한다.",
    objectType: "invoice",
    risk: "high",
    target: { type: "invoice", param: "id" },
    fields: { id: f.ref("청구서", "invoice", { required: true }) },
    preview: (db, i) => `${invoiceLabel(db, i.id)} 취소`,
    run({ db }, i) {
      const { invoice: inv, payments } = must(getInvoice(db, i.id), "청구서");
      if (inv.status === "void") throw new ActionError("이미 취소된 청구서입니다");
      if (payments.length) throw new ActionError("입금 기록이 있는 청구서는 취소할 수 없습니다");
      setInvoiceStatus(db, i.id, "void");
      return { summary: `${invoiceLabel(db, i.id)} 취소`, refs: [{ type: "invoice", id: i.id }] };
    },
  }),
  defineAction({
    name: "invoice.delete",
    title: "청구서 삭제",
    description: "청구서와 입금 기록을 삭제한다. 되돌릴 수 없다.",
    objectType: "invoice",
    risk: "high",
    target: { type: "invoice", param: "id" },
    fields: { id: f.ref("청구서", "invoice", { required: true }) },
    preview: (db, i) => `${invoiceLabel(db, i.id)} 삭제`,
    run({ db }, i) {
      const d = must(getInvoice(db, i.id), "청구서");
      const label = invoiceLabel(db, i.id);
      deleteInvoice(db, i.id);
      deleteLinksFor(db, { type: "invoice", id: i.id });
      return { summary: `${label} 삭제`, refs: [], data: { deleted: d } };
    },
  }),
  defineAction({
    name: "payment.record",
    title: "입금 기록",
    description: "발행된 청구서에 입금을 기록한다. 잔액이 0 이 되면 자동으로 paid. amount 생략 시 잔액 전액.",
    objectType: "invoice",
    risk: "high",
    target: { type: "invoice", param: "invoice_id" },
    fields: {
      invoice_id: f.ref("청구서", "invoice", { required: true }),
      amount: f.money("입금액"),
      paid_at: f.date("입금일"),
      method: f.text("수단", { placeholder: "계좌이체" }),
    },
    preview: (db, i) => {
      const inv = getInvoice(db, i.invoice_id)?.invoice;
      const amt = inv ? (i.amount !== undefined ? formatMoney(toMinor(i.amount, inv.currency), inv.currency) : formatMoney(inv.balance, inv.currency)) : "";
      return `${invoiceLabel(db, i.invoice_id)} 에 ${amt} 입금 기록`;
    },
    run({ db }, i) {
      const { invoice: inv } = must(getInvoice(db, i.invoice_id), "청구서");
      if (inv.status !== "sent") throw new ActionError(`발행(sent) 상태의 청구서에만 입금을 기록할 수 있습니다 (현재: ${inv.status})`);
      const amount = i.amount === undefined ? inv.balance : toMinor(i.amount, inv.currency, "입금액");
      if (amount <= 0) throw new ActionError("입금액은 0 보다 커야 합니다");
      if (amount > inv.balance) throw new ActionError(`입금액이 잔액(${formatMoney(inv.balance, inv.currency)})보다 큽니다`);
      const id = addPayment(db, { invoice_id: inv.id, amount, paid_at: i.paid_at ?? today(), method: i.method ?? "" });
      return { summary: `${inv.number} 입금 ${formatMoney(amount, inv.currency)}`, refs: [{ type: "invoice", id: inv.id }], data: { payment_id: id } };
    },
  }),
  defineAction({
    name: "payment.delete",
    title: "입금 기록 삭제",
    description: "잘못 기록한 입금을 삭제한다. 청구서 상태가 다시 계산된다.",
    objectType: "invoice",
    risk: "high",
    fields: { payment_id: f.number("입금 id", { required: true, int: true, min: 1 }) },
    preview: (db, i) => {
      const p = db.prepare("SELECT invoice_id, amount FROM payments WHERE id = ?").get(i.payment_id) as { invoice_id: number; amount: number } | undefined;
      return p ? `${invoiceLabel(db, p.invoice_id)} 입금 기록 삭제` : `입금 ${i.payment_id} 삭제`;
    },
    run({ db }, i) {
      const p = must(db.prepare("SELECT * FROM payments WHERE id = ?").get(i.payment_id) as { invoice_id: number; amount: number } | undefined, "입금 기록");
      deletePayment(db, i.payment_id);
      const inv = getInvoice(db, p.invoice_id)!.invoice;
      return { summary: `${inv.number} 입금 ${formatMoney(p.amount, inv.currency)} 삭제`, refs: [{ type: "invoice", id: p.invoice_id }] };
    },
  }),
  defineAction({
    name: "expense.record",
    title: "지출 기록",
    description: "사업의 지출을 기록한다 (사업 기본 통화).",
    objectType: "expense",
    risk: "high",
    fields: {
      business_id: f.ref("사업", "business", { required: true }),
      spent_at: f.date("지출일"),
      category: f.enum("분류", CATS, catLabels),
      description: f.text("내용", { required: true }),
      amount: f.money("금액", { required: true }),
    },
    preview: (db, i) => {
      const b = getBusiness(db, i.business_id);
      return `${b?.name ?? "?"} 지출 ${b ? formatMoney(toMinor(i.amount, b.currency), b.currency) : i.amount} · ${i.description}`;
    },
    run({ db }, i) {
      const b = must(getBusiness(db, i.business_id), "사업");
      const amount = toMinor(i.amount, b.currency);
      if (amount <= 0) throw new ActionError("지출 금액은 0 보다 커야 합니다");
      const id = addExpense(db, { business_id: b.id, category: i.category ?? "기타", description: i.description, amount, spent_at: i.spent_at ?? today() });
      return { summary: `지출 ${displayId("expense", id)} ${formatMoney(amount, b.currency)} · ${i.description}`, refs: [{ type: "expense", id }] };
    },
  }),
  defineAction({
    name: "expense.delete",
    title: "지출 삭제",
    description: "지출 기록을 삭제한다.",
    objectType: "expense",
    risk: "high",
    target: { type: "expense", param: "id" },
    fields: { id: f.ref("지출", "expense", { required: true }) },
    preview: (db, i) => {
      const e = db.prepare("SELECT description FROM expenses WHERE id = ?").get(i.id) as { description: string } | undefined;
      return `지출 '${e?.description ?? i.id}' 삭제`;
    },
    run({ db }, i) {
      const e = must(db.prepare("SELECT * FROM expenses WHERE id = ?").get(i.id) as { description: string } | undefined, "지출");
      deleteExpense(db, i.id);
      deleteLinksFor(db, { type: "expense", id: i.id });
      return { summary: `지출 ${displayId("expense", i.id)} '${e.description}' 삭제`, refs: [], data: { deleted: e } };
    },
  }),
];
