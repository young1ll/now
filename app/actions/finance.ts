"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { FormError, date, int, money, oneOf, optDate, optInt, required, str } from "@/lib/form";
import { parseMoney } from "@/lib/money";
import { getBusiness } from "@/lib/repos/businesses";
import {
  INVOICE_STATUSES, type InvoiceInput, addExpense, addPayment, createInvoice, deleteExpense,
  deleteInvoice, deletePayment, getInvoice, setInvoiceStatus, updateInvoice,
} from "@/lib/repos/finance";
import { formAction } from "./util";

function businessCurrency(businessId: number): string {
  const b = getBusiness(db(), businessId);
  if (!b) throw new FormError("사업을 선택하세요");
  return b.currency;
}

function parseInvoice(fd: FormData): InvoiceInput {
  const business_id = int(fd, "business_id");
  const currency = businessCurrency(business_id);
  const items: InvoiceInput["items"] = [];
  for (let i = 0; fd.has(`item_desc_${i}`); i++) {
    const description = str(fd, `item_desc_${i}`);
    if (!description) continue;
    const unit_price = parseMoney(str(fd, `item_price_${i}`), currency);
    if (unit_price === null) throw new FormError(`'${description}' 단가가 올바르지 않습니다`);
    const quantity = Number(str(fd, `item_qty_${i}`) || "1");
    if (!(quantity > 0)) throw new FormError(`'${description}' 수량이 올바르지 않습니다`);
    items.push({ description, quantity, unit_price });
  }
  if (items.length === 0) throw new FormError("품목을 한 개 이상 입력하세요");
  const taxRate = Number(str(fd, "tax_rate") || "0");
  return {
    business_id,
    client_id: optInt(fd, "client_id"),
    issue_date: date(fd, "issue_date", "발행일"),
    due_date: optDate(fd, "due_date"),
    currency,
    tax_rate: Number.isFinite(taxRate) && taxRate >= 0 ? taxRate : 0,
    memo: str(fd, "memo"),
    items,
  };
}

function refresh() {
  revalidatePath("/", "layout");
}

export const createInvoiceAction = formAction(async (fd) => {
  const id = createInvoice(db(), parseInvoice(fd));
  refresh();
  redirect(`/finance/invoices/${id}`);
});

export const updateInvoiceAction = formAction(async (fd) => {
  const id = int(fd, "id");
  updateInvoice(db(), id, parseInvoice(fd));
  refresh();
  redirect(`/finance/invoices/${id}`);
});

export const setInvoiceStatusAction = formAction(async (fd) => {
  setInvoiceStatus(db(), int(fd, "id"), oneOf(fd, "status", INVOICE_STATUSES, "draft"));
  refresh();
});

export const deleteInvoiceAction = formAction(async (fd) => {
  deleteInvoice(db(), int(fd, "id"));
  refresh();
  redirect("/finance");
});

export const addPaymentAction = formAction(async (fd) => {
  const invoiceId = int(fd, "invoice_id");
  const inv = getInvoice(db(), invoiceId)?.invoice;
  if (!inv) throw new FormError("청구서를 찾을 수 없습니다");
  addPayment(db(), {
    invoice_id: invoiceId,
    amount: money(fd, "amount", inv.currency, "입금"),
    paid_at: date(fd, "paid_at", "입금일"),
    method: str(fd, "method"),
  });
  refresh();
});

export const deletePaymentAction = formAction(async (fd) => {
  deletePayment(db(), int(fd, "id"));
  refresh();
});

export const addExpenseAction = formAction(async (fd) => {
  const business_id = int(fd, "business_id");
  addExpense(db(), {
    business_id,
    category: str(fd, "category") || "기타",
    description: required(fd, "description", "내용"),
    amount: money(fd, "amount", businessCurrency(business_id), "지출"),
    spent_at: date(fd, "spent_at", "지출일"),
  });
  refresh();
});

export const deleteExpenseAction = formAction(async (fd) => {
  deleteExpense(db(), int(fd, "id"));
  refresh();
});
