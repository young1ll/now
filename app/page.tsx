import Link from "next/link";
import { createBusinessAction } from "@/app/actions/businesses";
import { setTaskStatusAction } from "@/app/actions/tasks";
import { Badge, BizTag, Card, Empty, Field, PageHeader, Stat } from "@/components/ui";
import { currentScope } from "@/lib/context";
import { daysBetween, formatDate, today } from "@/lib/dates";
import { db } from "@/lib/db";
import { CHECK_STATUS, CURRENCIES, INTERACTION_KIND } from "@/lib/labels";
import { formatMoney } from "@/lib/money";
import { PROVIDER_INFO } from "@/lib/infra/providers";
import { listBusinesses } from "@/lib/repos/businesses";
import { dashboard } from "@/lib/repos/dashboard";

export default async function DashboardPage() {
  if (listBusinesses(db()).length === 0) return <Onboarding />;

  const scope = await currentScope();
  const on = today();
  const d = dashboard(db(), scope, on);

  const moneyList = (rows: { currency: string; amount: number }[]) =>
    rows.length ? rows.map((r) => formatMoney(r.amount, r.currency)).join(" · ") : "—";
  const moneyLines = (rows: { currency: string; amount: number }[]) =>
    rows.length ? (
      <span className="block space-y-0.5 text-lg leading-tight">
        {rows.map((r) => (
          <span key={r.currency} className={`block ${r.amount < 0 ? "text-red-600 dark:text-red-400" : ""}`}>{formatMoney(r.amount, r.currency)}</span>
        ))}
      </span>
    ) : "—";

  return (
    <>
      <PageHeader title="대시보드" description={`${formatDate(on)} 기준`} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="이번 달 순이익 (현금 기준)"
          value={moneyLines(d.thisMonth.map((p) => ({ currency: p.currency, amount: p.net })))}
          hint={d.thisMonth.length ? `입금 ${moneyList(d.thisMonth.map((p) => ({ currency: p.currency, amount: p.income })))}` : "이번 달 입금·지출 없음"}
          href="/finance"
        />
        <Stat
          label="미수금"
          value={moneyLines(d.receivables.totals)}
          hint={`${d.receivables.items.length}건 · 기한 경과 ${d.receivables.overdue}건`}
          tone={d.receivables.overdue ? "amber" : undefined}
          href="/finance"
        />
        <Stat
          label="열린 업무"
          value={d.tasks.open}
          hint={`지연 ${d.tasks.overdue} · 7일 내 마감 ${d.tasks.due_week}`}
          tone={d.tasks.overdue ? "red" : d.tasks.due_week ? "amber" : undefined}
          href="/tasks"
        />
        <Stat
          label="인프라"
          value={`${d.infra.counts.ok}/${d.infra.connections.length}`}
          hint={`이상 ${d.infra.counts.issues} · 미확인 ${d.infra.counts.unchecked} · 예산 초과 ${d.infra.overBudget.length}`}
          tone={d.infra.counts.issues || d.infra.overBudget.length ? "red" : undefined}
          href="/infra"
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card title="이번 주 마감 · 지연 업무" action={<Link href="/tasks" className="link">전체</Link>} className="lg:col-span-2" flush>
          {d.upcoming.length === 0 ? (
            <Empty>7일 안에 마감되는 업무가 없습니다.</Empty>
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {d.upcoming.map((t) => {
                const days = daysBetween(on, t.due_date!);
                return (
                  <li key={t.id} className="flex items-center gap-3 px-4 py-2.5">
                    <form action={setTaskStatusAction}>
                      <input type="hidden" name="id" value={t.id} />
                      <input type="hidden" name="status" value="done" />
                      <button className="size-4 rounded border border-zinc-400 hover:border-indigo-500 hover:bg-indigo-50" title="완료" />
                    </form>
                    <div className="min-w-0 flex-1">
                      <Link href={`/tasks/${t.id}`} className="block truncate text-sm hover:underline">
                        {t.title}
                      </Link>
                      <div className="flex gap-2">
                        <BizTag name={t.business_name} color={t.business_color} />
                        {t.client_name && <span className="muted text-xs">· {t.client_name}</span>}
                      </div>
                    </div>
                    <Badge tone={days < 0 ? "red" : days <= 2 ? "amber" : "slate"}>
                      {days < 0 ? `${-days}일 지남` : days === 0 ? "오늘" : `D-${days}`}
                    </Badge>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title="고객" action={<Link href="/clients" className="link">전체</Link>}>
          <div className="flex gap-6">
            <div>
              <div className="text-2xl font-semibold tabular-nums">{d.clients.active}</div>
              <div className="muted text-xs">진행 고객</div>
            </div>
            <div>
              <div className="text-2xl font-semibold tabular-nums">{d.clients.leads}</div>
              <div className="muted text-xs">잠재 고객</div>
            </div>
          </div>
          <h3 className="muted mt-4 mb-2 text-xs font-medium">최근 접촉</h3>
          {d.recent.length === 0 ? (
            <p className="muted text-sm">기록 없음</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {d.recent.map((r) => (
                <li key={r.id} className="flex gap-2">
                  <span className="muted w-20 shrink-0 text-xs">{formatDate(r.occurred_at)}</span>
                  <Link href={`/clients/${r.client_id}`} className="truncate hover:underline">
                    <span className="font-medium">{r.client_name}</span>{" "}
                    <span className="muted">{INTERACTION_KIND[r.kind]} · {r.summary}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="미수금" action={<Link href="/finance" className="link">매출 · 정산</Link>} className="lg:col-span-2" flush>
          {d.receivables.items.length === 0 ? (
            <Empty>받을 돈이 없습니다.</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr><th>청구서</th><th>고객</th><th>지급기한</th><th className="text-right">잔액</th></tr>
              </thead>
              <tbody>
                {d.receivables.items.slice(0, 8).map((i) => (
                  <tr key={i.id}>
                    <td><Link href={`/finance/invoices/${i.id}`} className="link">{i.number}</Link></td>
                    <td>{i.client_name ?? "—"}</td>
                    <td>
                      {formatDate(i.due_date)} {i.overdue && <Badge tone="red">기한 경과</Badge>}
                    </td>
                    <td className="text-right tabular-nums">{formatMoney(i.balance, i.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="인프라 상태" action={<Link href="/infra" className="link">전체</Link>} flush>
          {d.infra.connections.length === 0 ? (
            <Empty>등록된 연결이 없습니다.</Empty>
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {d.infra.connections.map((c) => {
                const st = CHECK_STATUS[c.last_status ?? "unknown"];
                const over = c.monthly_budget != null && c.month_cost != null && c.month_cost > c.monthly_budget;
                return (
                  <li key={c.id} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                    <Link href={`/infra/${c.id}`} className="min-w-0 truncate hover:underline">
                      <span className="muted text-xs">{PROVIDER_INFO[c.provider].label}</span> {c.name}
                    </Link>
                    <span className="flex gap-1">
                      {over && <Badge tone="red">예산 초과</Badge>}
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {d.infra.cost.length > 0 && (
            <p className="muted border-t border-zinc-100 px-4 py-2 text-xs dark:border-zinc-800">
              {d.month} 비용 {moneyList(d.infra.cost)}
            </p>
          )}
        </Card>
      </div>
    </>
  );
}

function Onboarding() {
  return (
    <div className="mx-auto max-w-lg py-12">
      <h1 className="text-2xl font-semibold">Now에 오신 것을 환영합니다</h1>
      <p className="muted mt-2 text-sm">
        먼저 운영 중인 사업을 하나 등록하세요. 고객·업무·매출·문서·인프라는 모두 사업 단위로 묶이며, 사업은 나중에 더 추가할 수 있습니다.
      </p>
      <Card className="mt-6">
        <form action={createBusinessAction} className="grid gap-3">
          <input type="hidden" name="next" value="/" />
          <Field label="사업 이름"><input name="name" className="input" required placeholder="예: 한결 세무사무소" /></Field>
          <Field label="업종 · 설명"><input name="kind" className="input" placeholder="예: 세무 대행" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="기본 통화">
              <select name="currency" className="input" defaultValue="KRW">
                {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="색상"><input type="color" name="color" defaultValue="#6366f1" className="input h-9 p-1" /></Field>
          </div>
          <button className="btn-primary mt-2">시작하기</button>
        </form>
      </Card>
      <p className="muted mt-4 text-xs">
        예시 데이터로 둘러보려면 터미널에서 <code>npm run db:seed</code> 를 실행하세요.
      </p>
    </div>
  );
}
