import Link from "next/link";
import { notFound } from "next/navigation";
import {
  addPaymentAction, deleteInvoiceAction, deletePaymentAction, setInvoiceStatusAction, updateInvoiceAction,
} from "@/app/actions/finance";
import { ConfirmButton } from "@/components/ConfirmButton";
import { InvoiceForm } from "@/components/InvoiceForm";
import { Badge, Card, Field, PageHeader } from "@/components/ui";
import { formatDate, today } from "@/lib/dates";
import { db } from "@/lib/db";
import { INVOICE_STATUS } from "@/lib/labels";
import { formatMoney, toMajor } from "@/lib/money";
import { type SearchParams, idParam, one } from "@/lib/params";
import { getBusiness, listBusinesses } from "@/lib/repos/businesses";
import { clientOptions, getClient } from "@/lib/repos/clients";
import { getInvoice } from "@/lib/repos/finance";

export default async function InvoicePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const id = idParam((await params).id);
  const data = id ? getInvoice(db(), id) : undefined;
  if (!data) notFound();
  const sp = await searchParams;
  const { invoice: inv, items, payments } = data;
  const business = getBusiness(db(), inv.business_id)!;
  const client = inv.client_id ? getClient(db(), inv.client_id) : undefined;
  const m = (n: number) => formatMoney(n, inv.currency);
  const st = INVOICE_STATUS[inv.status];

  if (one(sp.edit)) {
    return (
      <>
        <PageHeader title={`청구서 ${inv.number} 수정`} error={one(sp.error)} actions={<Link href={`/finance/invoices/${inv.id}`} className="btn">취소</Link>} />
        <Card>
          <InvoiceForm
            action={updateInvoiceAction}
            businesses={listBusinesses(db(), { includeArchived: true })}
            clients={clientOptions(db(), null)}
            invoice={inv}
            items={items}
          />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={<span className="flex items-center gap-2">청구서 {inv.number} <Badge tone={st.tone}>{st.label}</Badge></span>}
        error={one(sp.error)}
        actions={
          <>
            <Link href="/finance?tab=invoices" className="btn">← 목록</Link>
            <Link href={`/finance/invoices/${inv.id}?edit=1`} className="btn">수정</Link>
            {inv.status === "draft" && <StatusButton id={inv.id} status="sent" label="발행 처리" primary />}
            {inv.status !== "void" && inv.status !== "paid" && <StatusButton id={inv.id} status="void" label="취소" />}
            {inv.status === "void" && <StatusButton id={inv.id} status="draft" label="작성 중으로 되돌리기" />}
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        {/* 인쇄 영역: Ctrl/Cmd+P 로 PDF 저장 */}
        <Card className="lg:col-span-2">
          <article className="p-2 sm:p-4">
            <div className="flex flex-wrap justify-between gap-4">
              <div>
                <div className="text-2xl font-bold tracking-tight">청구서</div>
                <div className="muted text-sm">No. {inv.number}</div>
              </div>
              <div className="text-right text-sm">
                <div className="font-semibold">{business.name}</div>
                <div className="muted">발행일 {formatDate(inv.issue_date)}</div>
                {inv.due_date && <div className="muted">지급기한 {formatDate(inv.due_date)}</div>}
              </div>
            </div>
            <div className="mt-6 text-sm">
              <div className="muted text-xs">청구 대상</div>
              <div className="font-medium">{client?.name ?? "—"}</div>
              {client?.email && <div className="muted">{client.email}</div>}
            </div>
            <table className="table mt-6">
              <thead><tr><th>품목</th><th className="text-right">수량</th><th className="text-right">단가</th><th className="text-right">금액</th></tr></thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.id}>
                    <td>{it.description}</td>
                    <td className="text-right tabular-nums">{it.quantity}</td>
                    <td className="text-right tabular-nums">{m(it.unit_price)}</td>
                    <td className="text-right tabular-nums">{m(Math.round(it.quantity * it.unit_price))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <dl className="mt-4 ml-auto grid max-w-xs grid-cols-2 gap-y-1 text-sm tabular-nums">
              <dt className="muted">공급가액</dt><dd className="text-right">{m(inv.subtotal)}</dd>
              {inv.tax_rate > 0 && (<><dt className="muted">부가세 ({inv.tax_rate}%)</dt><dd className="text-right">{m(inv.tax)}</dd></>)}
              <dt className="border-t border-zinc-200 pt-1 font-semibold dark:border-zinc-700">합계</dt>
              <dd className="border-t border-zinc-200 pt-1 text-right font-semibold dark:border-zinc-700">{m(inv.total)}</dd>
            </dl>
            {inv.memo && <p className="mt-6 whitespace-pre-wrap border-t border-zinc-100 pt-4 text-sm dark:border-zinc-800">{inv.memo}</p>}
          </article>
        </Card>

        <div className="no-print space-y-4">
          <Card title="입금">
            <dl className="mb-4 grid grid-cols-2 gap-y-1 text-sm tabular-nums">
              <dt className="muted">받은 금액</dt><dd className="text-right">{m(inv.paid)}</dd>
              <dt className="muted">잔액</dt><dd className={`text-right font-semibold ${inv.balance > 0 && inv.status === "sent" ? "text-red-600" : ""}`}>{m(inv.balance)}</dd>
            </dl>
            {payments.length > 0 && (
              <ul className="mb-4 space-y-1 text-sm">
                {payments.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2">
                    <span className="muted tabular-nums">{formatDate(p.paid_at)}</span>
                    <span className="flex-1 truncate text-xs">{p.method}</span>
                    <span className="tabular-nums">{m(p.amount)}</span>
                    <form action={deletePaymentAction}>
                      <input type="hidden" name="id" value={p.id} />
                      <ConfirmButton message="이 입금 기록을 삭제할까요?" className="btn btn-sm">×</ConfirmButton>
                    </form>
                  </li>
                ))}
              </ul>
            )}
            {inv.status === "draft" ? (
              <p className="muted text-xs">발행 처리 후 입금을 기록하면 잔액이 0 이 될 때 자동으로 &lsquo;입금 완료&rsquo;가 됩니다.</p>
            ) : inv.status !== "void" && inv.balance > 0 ? (
              <form action={addPaymentAction} className="grid gap-2">
                <input type="hidden" name="invoice_id" value={inv.id} />
                <div className="grid grid-cols-2 gap-2">
                  <Field label="입금일"><input type="date" name="paid_at" defaultValue={today()} className="input" required /></Field>
                  <Field label={`금액 (${inv.currency})`}><input name="amount" inputMode="decimal" defaultValue={toMajor(inv.balance, inv.currency)} className="input text-right" required /></Field>
                </div>
                <Field label="수단"><input name="method" className="input" placeholder="계좌이체" /></Field>
                <button className="btn-primary">입금 기록</button>
              </form>
            ) : null}
          </Card>
          <p className="muted text-xs">Ctrl/Cmd + P 로 청구서를 PDF 로 저장할 수 있습니다.</p>
          <form action={deleteInvoiceAction}>
            <input type="hidden" name="id" value={inv.id} />
            <ConfirmButton message="청구서와 입금 기록을 모두 삭제합니다.">청구서 삭제</ConfirmButton>
          </form>
        </div>
      </div>
    </>
  );
}

function StatusButton({ id, status, label, primary }: { id: number; status: string; label: string; primary?: boolean }) {
  return (
    <form action={setInvoiceStatusAction}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="status" value={status} />
      <button className={primary ? "btn-primary" : "btn"}>{label}</button>
    </form>
  );
}
