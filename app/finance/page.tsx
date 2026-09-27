import Link from "next/link";
import { addExpenseAction, deleteExpenseAction } from "@/app/actions/finance";
import { ConfirmButton } from "@/components/ConfirmButton";
import { BusinessSelect } from "@/components/selects";
import { Badge, BizTag, Card, Empty, Field, PageHeader, Tabs } from "@/components/ui";
import { currentScope } from "@/lib/context";
import { formatDate, monthOf, today } from "@/lib/dates";
import { db } from "@/lib/db";
import { EXPENSE_CATEGORIES, INVOICE_STATUS } from "@/lib/labels";
import { formatMoney } from "@/lib/money";
import { type SearchParams, one } from "@/lib/params";
import { listBusinesses } from "@/lib/repos/businesses";
import { lastMonths } from "@/lib/repos/dashboard";
import { INVOICE_STATUSES, type InvoiceStatus, listExpenses, listInvoices, monthlyPnl, receivables } from "@/lib/repos/finance";

export const metadata = { title: "매출 · 정산" };

export default async function FinancePage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const tab = (["overview", "invoices", "expenses"] as const).find((t) => t === one(sp.tab)) ?? "overview";
  const scope = await currentScope();

  return (
    <>
      <PageHeader
        title="매출 · 청구 · 정산"
        description="수입은 입금 기준, 지출은 지출일 기준으로 집계합니다 (현금주의). 통화가 다르면 따로 합산합니다."
        error={one(sp.error)}
        actions={<Link href="/finance/invoices/new" className="btn-primary">+ 새 청구서</Link>}
      />
      <Tabs
        current={tab}
        items={[
          { key: "overview", label: "정산 개요", href: "/finance" },
          { key: "invoices", label: "청구서", href: "/finance?tab=invoices" },
          { key: "expenses", label: "지출", href: "/finance?tab=expenses" },
        ]}
      />
      {tab === "overview" && <Overview scope={scope} />}
      {tab === "invoices" && <Invoices scope={scope} status={INVOICE_STATUSES.find((s) => s === one(sp.status))} />}
      {tab === "expenses" && <Expenses scope={scope} month={/^\d{4}-\d{2}$/.test(one(sp.month) ?? "") ? one(sp.month)! : monthOf(today())} />}
    </>
  );
}

function Overview({ scope }: { scope: number | null }) {
  const months = lastMonths(12);
  const pnl = monthlyPnl(db(), scope, months);
  const currencies = [...new Set(pnl.map((p) => p.currency))];
  const ar = receivables(db(), scope);

  return (
    <div className="space-y-6">
      {currencies.length === 0 && <Card><Empty>아직 입금이나 지출 기록이 없습니다.</Empty></Card>}
      {currencies.map((cur) => {
        const all = pnl.filter((p) => p.currency === cur);
        const first = all.findIndex((p) => p.income || p.expense);
        const rows = all.slice(Math.max(first, 0)).reverse();
        const sum = (k: "income" | "expense" | "net") => rows.reduce((s, r) => s + r[k], 0);
        const max = Math.max(1, ...rows.map((r) => Math.max(r.income, r.expense)));
        return (
          <Card key={cur} title={`월별 손익 · ${cur}`} flush>
            <table className="table">
              <thead>
                <tr><th>월</th><th className="text-right">수입</th><th className="text-right">지출</th><th className="text-right">순이익</th><th className="w-1/3"></th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.month}>
                    <td className="tabular-nums">{r.month}</td>
                    <td className="text-right tabular-nums">{r.income ? formatMoney(r.income, cur) : "—"}</td>
                    <td className="text-right tabular-nums">{r.expense ? formatMoney(r.expense, cur) : "—"}</td>
                    <td className={`text-right font-medium tabular-nums ${r.net < 0 ? "text-red-600" : ""}`}>{formatMoney(r.net, cur)}</td>
                    <td>
                      <div className="flex flex-col gap-0.5 pt-1" aria-hidden>
                        <div className="h-1.5 rounded-full bg-emerald-500" style={{ width: `${(r.income / max) * 100}%` }} />
                        <div className="h-1.5 rounded-full bg-rose-400" style={{ width: `${(r.expense / max) * 100}%` }} />
                      </div>
                    </td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td>합계</td>
                  <td className="text-right tabular-nums">{formatMoney(sum("income"), cur)}</td>
                  <td className="text-right tabular-nums">{formatMoney(sum("expense"), cur)}</td>
                  <td className={`text-right tabular-nums ${sum("net") < 0 ? "text-red-600" : ""}`}>{formatMoney(sum("net"), cur)}</td>
                  <td className="muted text-xs font-normal"><span className="text-emerald-600">■</span> 수입 <span className="text-rose-400">■</span> 지출</td>
                </tr>
              </tbody>
            </table>
          </Card>
        );
      })}

      <Card title="미수금" flush>
        {ar.length === 0 ? (
          <Empty>받을 돈이 없습니다.</Empty>
        ) : (
          <table className="table">
            <thead><tr><th>청구서</th><th>사업</th><th>고객</th><th>지급기한</th><th className="text-right">잔액</th></tr></thead>
            <tbody>
              {ar.map((i) => (
                <tr key={i.id}>
                  <td><Link href={`/finance/invoices/${i.id}`} className="link">{i.number}</Link></td>
                  <td><BizTag name={i.business_name} color={i.business_color} /></td>
                  <td>{i.client_name ?? "—"}</td>
                  <td className="tabular-nums">{formatDate(i.due_date)} {i.overdue && <Badge tone="red">기한 경과</Badge>}</td>
                  <td className="text-right tabular-nums">{formatMoney(i.balance, i.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function Invoices({ scope, status }: { scope: number | null; status?: InvoiceStatus }) {
  const invoices = listInvoices(db(), scope, { status });
  return (
    <>
      <div className="mb-3 flex flex-wrap gap-2 text-sm">
        <Link href="/finance?tab=invoices" className={!status ? "btn-primary btn-sm" : "btn btn-sm"}>전체</Link>
        {INVOICE_STATUSES.map((s) => (
          <Link key={s} href={`/finance?tab=invoices&status=${s}`} className={status === s ? "btn-primary btn-sm" : "btn btn-sm"}>
            {INVOICE_STATUS[s].label}
          </Link>
        ))}
      </div>
      <Card flush>
        {invoices.length === 0 ? (
          <Empty>청구서가 없습니다.</Empty>
        ) : (
          <table className="table">
            <thead><tr><th>번호</th><th>사업</th><th>고객</th><th>발행일</th><th>상태</th><th className="text-right">합계</th><th className="text-right">잔액</th></tr></thead>
            <tbody>
              {invoices.map((i) => (
                <tr key={i.id}>
                  <td><Link href={`/finance/invoices/${i.id}`} className="link">{i.number}</Link></td>
                  <td><BizTag name={i.business_name} color={i.business_color} /></td>
                  <td>{i.client_name ?? "—"}</td>
                  <td className="tabular-nums">{formatDate(i.issue_date)}</td>
                  <td><Badge tone={INVOICE_STATUS[i.status].tone}>{INVOICE_STATUS[i.status].label}</Badge></td>
                  <td className="text-right tabular-nums">{formatMoney(i.total, i.currency)}</td>
                  <td className="text-right tabular-nums">{i.status === "void" ? "—" : formatMoney(i.balance, i.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

function Expenses({ scope, month }: { scope: number | null; month: string }) {
  const expenses = listExpenses(db(), scope, month);
  const businesses = listBusinesses(db());
  const totals = new Map<string, number>();
  for (const e of expenses) totals.set(e.currency, (totals.get(e.currency) ?? 0) + e.amount);

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <form className="mb-3 flex items-center gap-2" action="/finance">
          <input type="hidden" name="tab" value="expenses" />
          <input type="month" name="month" defaultValue={month} className="input w-44" />
          <button className="btn">보기</button>
          <span className="muted ml-auto text-sm">
            합계 {[...totals].map(([c, a]) => formatMoney(a, c)).join(" · ") || "—"}
          </span>
        </form>
        <Card flush>
          {expenses.length === 0 ? (
            <Empty>{month} 지출이 없습니다.</Empty>
          ) : (
            <table className="table">
              <thead><tr><th>일자</th><th>사업</th><th>분류</th><th>내용</th><th className="text-right">금액</th><th /></tr></thead>
              <tbody>
                {expenses.map((e) => (
                  <tr key={e.id}>
                    <td className="tabular-nums">{formatDate(e.spent_at)}</td>
                    <td className="text-xs">{e.business_name}</td>
                    <td><Badge>{e.category}</Badge></td>
                    <td>{e.description}</td>
                    <td className="text-right tabular-nums">{formatMoney(e.amount, e.currency)}</td>
                    <td className="text-right">
                      <form action={deleteExpenseAction}>
                        <input type="hidden" name="id" value={e.id} />
                        <ConfirmButton message="이 지출을 삭제할까요?" className="btn btn-sm">×</ConfirmButton>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
      <Card title="지출 기록">
        <form action={addExpenseAction} className="grid gap-3">
          <Field label="사업 (사업 기본 통화로 기록)"><BusinessSelect businesses={businesses} defaultValue={scope ?? businesses[0]?.id} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="일자"><input type="date" name="spent_at" defaultValue={today()} className="input" required /></Field>
            <Field label="분류">
              <select name="category" className="input">{EXPENSE_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
            </Field>
          </div>
          <Field label="내용"><input name="description" className="input" required /></Field>
          <Field label="금액"><input name="amount" inputMode="decimal" className="input text-right" required /></Field>
          <button className="btn-primary">기록</button>
        </form>
      </Card>
    </div>
  );
}
