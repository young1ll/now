import Link from "next/link";
import { ActionDrawer, actHref } from "@/components/ActionDrawer";
import { PairBar } from "@/components/charts";
import { Icon } from "@/components/icons";
import { Empty, ObjectLink, PageHeader, Panel, Tag } from "@/components/ui";
import { currentScope } from "@/lib/context";
import { daysBetween, formatDate, monthOf, today } from "@/lib/dates";
import { db } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { lastMonths } from "@/lib/ontology/ops";
import type { SearchParams } from "@/lib/params";
import { listExpenses, monthlyPnl, receivables } from "@/lib/repos/finance";

export const metadata = { title: "재무 · 정산" };

export default async function FinancePage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const scope = await currentScope();
  const on = today();
  const pnl = monthlyPnl(db(), scope, lastMonths(12, on));
  const currencies = [...new Set(pnl.map((p) => p.currency))];
  const ar = receivables(db(), scope, on);
  const buckets = [
    { label: "기한 전", test: (d: number) => d <= 0 },
    { label: "1–30일", test: (d: number) => d > 0 && d <= 30 },
    { label: "31–60일", test: (d: number) => d > 30 && d <= 60 },
    { label: "60일+", test: (d: number) => d > 60 },
  ];
  const expenses = listExpenses(db(), scope, monthOf(on));

  return (
    <>
      <PageHeader
        icon="finance"
        eyebrow="분석"
        title="재무 · 정산"
        meta="현금주의: 수입 = 입금, 지출 = 지출일. 통화가 다르면 합산하지 않습니다."
        actions={
          <>
            <Link href={actHref("/finance", "invoice.create", {}, { business_id: scope ?? undefined })} className="btn-primary"><Icon name="plus" size={12} /> 청구서</Link>
            <Link href={actHref("/finance", "expense.record", {}, { business_id: scope ?? undefined })} className="btn"><Icon name="plus" size={12} /> 지출</Link>
          </>
        }
      />
      <div className="grid grid-cols-1 gap-px bg-void p-px xl:grid-cols-12">
        <div className="flex flex-col gap-px xl:col-span-7">
          {currencies.length === 0 && <Panel><Empty icon="finance">입금·지출 기록이 없습니다.</Empty></Panel>}
          {currencies.map((cur) => {
            const all = pnl.filter((p) => p.currency === cur);
            const first = all.findIndex((p) => p.income || p.expense);
            const rows = all.slice(Math.max(first, 0)).reverse();
            const max = Math.max(1, ...rows.map((r) => Math.max(r.income, r.expense)));
            const sum = (k: "income" | "expense" | "net") => rows.reduce((s, r) => s + r[k], 0);
            return (
              <Panel
                key={cur}
                title={`월별 손익 · ${cur}`}
                flush
                action={<span className="flex items-center gap-3 text-[11px] text-fg-2"><span className="flex items-center gap-1"><span className="size-2 bg-series-1" />수입</span><span className="flex items-center gap-1"><span className="size-2 bg-series-2" />지출</span></span>}
              >
                <table className="grid-table">
                  <thead><tr><th>월</th><th className="text-right">수입</th><th className="text-right">지출</th><th className="text-right">순이익</th><th className="w-[30%]" /></tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.month}>
                        <td className="mono">{r.month}</td>
                        <td className="num">{r.income ? formatMoney(r.income, cur) : "—"}</td>
                        <td className="num">{r.expense ? formatMoney(r.expense, cur) : "—"}</td>
                        <td className={`num font-medium ${r.net < 0 ? "text-danger-fg" : ""}`}>{formatMoney(r.net, cur)}</td>
                        <td><PairBar a={r.income} b={r.expense} max={max} title={`${r.month} 수입 ${formatMoney(r.income, cur)} · 지출 ${formatMoney(r.expense, cur)}`} /></td>
                      </tr>
                    ))}
                    <tr className="bg-raised/50 font-semibold">
                      <td>합계</td>
                      <td className="num">{formatMoney(sum("income"), cur)}</td>
                      <td className="num">{formatMoney(sum("expense"), cur)}</td>
                      <td className={`num ${sum("net") < 0 ? "text-danger-fg" : "text-success-fg"}`}>{formatMoney(sum("net"), cur)}</td>
                      <td />
                    </tr>
                  </tbody>
                </table>
              </Panel>
            );
          })}
        </div>
        <div className="flex flex-col gap-px xl:col-span-5">
          <Panel title="미수금 에이징" count={ar.length} flush>
            {ar.length === 0 ? <Empty>받을 돈이 없습니다.</Empty> : (
              <>
                <div className="grid grid-cols-4 border-b border-line">
                  {buckets.map((b) => {
                    const items = ar.filter((i) => b.test(i.due_date ? daysBetween(i.due_date, on) : 0));
                    const by = new Map<string, number>();
                    for (const i of items) by.set(i.currency, (by.get(i.currency) ?? 0) + i.balance);
                    return (
                      <div key={b.label} className="border-r border-line px-3 py-2 last:border-r-0">
                        <div className="label-caps">{b.label}</div>
                        <div className="mono mt-1 text-[12px]">{items.length}건</div>
                        {[...by].map(([c, a]) => <div key={c} className="mono text-[11px] text-fg-2">{formatMoney(a, c)}</div>)}
                      </div>
                    );
                  })}
                </div>
                <table className="grid-table">
                  <thead><tr><th>청구서</th><th>고객</th><th>기한</th><th className="text-right">잔액</th></tr></thead>
                  <tbody>
                    {ar.map((i) => (
                      <tr key={i.id}>
                        <td><ObjectLink type="invoice" id={i.id} compact /></td>
                        <td className="max-w-[140px] truncate">{i.client_name ?? "—"}</td>
                        <td className="mono">{formatDate(i.due_date)} {i.overdue && <Tag tone="red">경과</Tag>}</td>
                        <td className="num">{formatMoney(i.balance, i.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </Panel>
          <Panel title={`이번 달 지출 · ${monthOf(on)}`} count={expenses.length} flush>
            {expenses.length === 0 ? <Empty>이번 달 지출 없음</Empty> : (
              <table className="grid-table">
                <tbody>
                  {expenses.map((e) => (
                    <tr key={e.id}>
                      <td className="mono w-[80px]">{formatDate(e.spent_at).slice(5)}</td>
                      <td><Tag tone="none">{e.category}</Tag></td>
                      <td className="max-w-[160px] truncate"><Link href={`/o/expense/${e.id}`} className="hover:underline">{e.description}</Link></td>
                      <td className="num">{formatMoney(e.amount, e.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>
      </div>
      <ActionDrawer sp={sp} path="/finance" scope={scope} />
    </>
  );
}
