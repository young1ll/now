import Link from "next/link";
import { ActionDrawer, actHref } from "@/components/ActionDrawer";
import { StackedBars } from "@/components/charts";
import { AutoRefresh } from "@/components/client";
import { Icon } from "@/components/icons";
import { ApprovalCard, RunTable } from "@/components/runs";
import { Actor, Empty, Metric, ObjectLink, PageHeader, Panel, SEVERITY, Tag, timeAgo } from "@/components/ui";
import { currentScope } from "@/lib/context";
import { daysBetween, formatDate } from "@/lib/dates";
import { db } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { getAction } from "@/lib/ontology/execute";
import { opsOverview } from "@/lib/ontology/ops";
import { AI_MODE_LABEL } from "@/lib/ontology/actions/system";
import type { SearchParams } from "@/lib/params";
import { listBusinesses } from "@/lib/repos/businesses";
import { runsPerHour } from "@/lib/repos/runs";
import { Onboarding } from "./onboarding";

export const metadata = { title: "오퍼레이션" };

export default async function OperationsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  if (listBusinesses(db(), { includeArchived: true }).length === 0) return <Onboarding sp={sp} />;

  const scope = await currentScope();
  const o = opsOverview(db(), scope);
  const hours = runsPerHour(db(), 24);
  const crit = o.signals.filter((s) => s.severity === "critical").length;
  const warn = o.signals.filter((s) => s.severity === "warning").length;
  const money = (rows: { currency: string; amount: number }[]) => (rows.length ? rows.map((r) => formatMoney(r.amount, r.currency)).join(" · ") : "—");

  return (
    <>
      <AutoRefresh seconds={10} />
      <PageHeader
        icon="ops"
        eyebrow="운영 · 실시간"
        title="오퍼레이션"
        meta={`${formatDate(o.on)} · AI 운영 모드: ${AI_MODE_LABEL[o.aiMode]}`}
        live
        error={typeof sp.error === "string" ? sp.error : undefined}
        actions={
          <>
            <Link href="/inbox" className="btn"><Icon name="inbox" size={12} /> 승인함</Link>
            <Link href="/activity" className="btn"><Icon name="activity" size={12} /> 활동 로그</Link>
          </>
        }
      />

      {/* 상태 스트립 */}
      <div className="grid grid-cols-2 border-b border-line bg-panel sm:grid-cols-4 xl:grid-cols-8">
        <Metric label="신호" value={`${crit} / ${warn}`} sub={`심각 / 주의 · 전체 ${o.signals.length}`} tone={crit ? "danger" : warn ? "warning" : undefined} href="#signals" />
        <Metric label="승인 대기" value={o.pending.count} sub="사람의 결정 필요" tone={o.pending.count ? "warning" : undefined} href="/inbox" />
        <Metric label="에이전트" value={`${o.agents.active}/${o.agents.total}`} sub="활성 / 등록" tone="ai" href="/agents" />
        <Metric label="24h 실행" value={o.runs24h.total} sub={`AI ${o.runs24h.agent} · 사람 ${o.runs24h.human}`} href="/activity" />
        <Metric label="24h 실패·거부" value={o.runs24h.failed + o.runs24h.denied} sub="정책·검증" tone={o.runs24h.failed + o.runs24h.denied ? "danger" : undefined} href="/activity?status=failed" />
        <Metric label="열린 업무" value={o.tasks.open} sub={`지연 ${o.tasks.overdue} · 7일 ${o.tasks.due_week}`} tone={o.tasks.overdue ? "danger" : undefined} href="/schedule" />
        <Metric label="미수금" value={<span className="text-[14px]">{money(o.receivables.totals)}</span>} sub={`${o.receivables.count}건 · 경과 ${o.receivables.overdue}`} tone={o.receivables.overdue ? "warning" : undefined} href="/finance" />
        <Metric
          label="인프라 (IaC)"
          value={o.iac ? { in_sync: "일치", drift: "드리프트", error: "오류" }[o.iac.status] : "미감사"}
          sub={o.iac ? `${o.iac.resource_count} 리소스 · ${timeAgo(o.iac.captured_at)}` : "npm run iac:audit"}
          tone={!o.iac ? undefined : o.iac.status === "in_sync" ? "success" : "danger"}
          href="/system"
        />
      </div>

      <div className="grid gap-px bg-void p-px xl:grid-cols-12">
        {/* 신호 큐 */}
        <div id="signals" className="xl:col-span-8">
          <Panel title="신호 — 주의가 필요한 상태" count={o.signals.length} flush className="h-full">
            {o.signals.length === 0 ? (
              <Empty>모든 것이 정상입니다.</Empty>
            ) : (
              <div className="max-h-[460px] overflow-y-auto">
                <table className="grid-table">
                  <thead>
                    <tr><th className="w-[70px]">심각도</th><th>신호</th><th>객체</th><th className="w-[70px]">경과</th><th>제안 액션</th></tr>
                  </thead>
                  <tbody>
                    {o.signals.map((s) => {
                      const sev = SEVERITY[s.severity];
                      return (
                        <tr key={s.key}>
                          <td><Tag tone={sev.tone}>{sev.label}</Tag></td>
                          <td className="max-w-[340px]">
                            <div className="truncate">{s.title}</div>
                            <div className="truncate text-[11.5px] text-fg-3">{s.detail}</div>
                          </td>
                          <td>{s.ref ? <ObjectLink type={s.ref.type} id={s.ref.id} compact /> : <span className="mono text-fg-4">{s.kind}</span>}</td>
                          <td className="mono text-fg-3">{s.since ? `${daysBetween(s.since, o.on)}d` : "—"}</td>
                          <td>
                            <div className="flex flex-wrap gap-1">
                              {s.suggested.map((a) => {
                                const def = getAction(a.action);
                                const tp = def?.target?.param;
                                const fixed = tp ? { [tp]: a.params[tp] } : {};
                                const soft = Object.fromEntries(Object.entries(a.params).filter(([k]) => k !== tp));
                                return (
                                  <Link key={a.action} href={actHref("/", a.action, fixed, soft)} className="btn btn-sm">
                                    {a.label}
                                  </Link>
                                );
                              })}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>

        {/* 승인 큐 + 에이전트 */}
        <div className="flex flex-col gap-px xl:col-span-4">
          <Panel title="승인 대기" count={o.pending.count} action={<Link href="/inbox" className="btn-minimal btn-sm">전체 <Icon name="arrow" size={10} /></Link>}>
            {o.pending.runs.length === 0 ? (
              <Empty>결정할 요청이 없습니다.</Empty>
            ) : (
              <div className="flex max-h-[300px] flex-col gap-2 overflow-y-auto">
                {o.pending.runs.slice(0, 3).map((r) => <ApprovalCard key={r.id} run={r} dense />)}
              </div>
            )}
          </Panel>
          <Panel title="에이전트" count={o.agents.total} action={<Link href="/agents" className="btn-minimal btn-sm">관리 <Icon name="arrow" size={10} /></Link>} flush className="flex-1">
            {o.agents.list.filter((a) => a.status !== "revoked").length === 0 ? (
              <Empty icon="agent">등록된 에이전트가 없습니다. <Link href="/agents" className="link">에이전트 연결</Link></Empty>
            ) : (
              <table className="grid-table">
                <tbody>
                  {o.agents.list.filter((a) => a.status !== "revoked").map((a) => (
                    <tr key={a.id}>
                      <td><Actor type="agent" name={a.name} /></td>
                      <td><Tag tone={a.status === "active" ? "green" : "amber"}>{a.status === "active" ? "활성" : "정지"}</Tag></td>
                      <td className="mono text-right text-fg-3">{a.runs_24h}회 · {timeAgo(a.last_run_at ?? a.last_seen_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>

        {/* 활동 피드 */}
        <div className="xl:col-span-8">
          <Panel title="활동 피드 — 최근 실행" action={<Link href="/activity" className="btn-minimal btn-sm">활동 로그 <Icon name="arrow" size={10} /></Link>} flush className="h-full">
            {o.recentRuns.length === 0 ? <Empty icon="activity">아직 실행 기록이 없습니다.</Empty> : <div className="max-h-[420px] overflow-y-auto"><RunTable runs={o.recentRuns.slice(0, 15)} /></div>}
          </Panel>
        </div>

        <div className="flex flex-col gap-px xl:col-span-4">
          <Panel title="실행 추이 · 24시간">
            <StackedBars
              aLabel="AI 에이전트"
              bLabel="사람"
              data={hours.map((h) => {
                const label = `${String(new Date(`${h.hour}:00:00Z`).getHours()).padStart(2, "0")}시`;
                return { label, a: h.agent, b: h.human, title: `${label} · AI ${h.agent} · 사람 ${h.human} · 실패/거부 ${h.failed}` };
              })}
            />
          </Panel>
          <Panel title="7일 내 마감" count={o.agenda.length} action={<Link href="/schedule" className="btn-minimal btn-sm">일정 <Icon name="arrow" size={10} /></Link>} flush>
            {o.agenda.length === 0 ? (
              <Empty>7일 안에 마감되는 업무가 없습니다.</Empty>
            ) : (
              <table className="grid-table">
                <tbody>
                  {o.agenda.slice(0, 8).map((t) => {
                    const d = daysBetween(o.on, t.due_date!);
                    return (
                      <tr key={t.id}>
                        <td className="mono w-[64px]">
                          <span className={d < 0 ? "text-danger-fg" : d <= 1 ? "text-warning-fg" : "text-fg-3"}>{d < 0 ? `${d}d` : d === 0 ? "오늘" : `D-${d}`}</span>
                        </td>
                        <td className="max-w-[240px] truncate"><Link href={`/o/task/${t.id}`} className="hover:underline">{t.title}</Link></td>
                        <td className="text-right text-[11px] text-fg-3">{t.business_name}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Panel>
          <Panel title="이번 달 현금흐름">
            {o.cash.length === 0 ? (
              <p className="text-fg-3">이번 달 입금·지출 없음</p>
            ) : (
              <table className="grid-table">
                <thead><tr><th>통화</th><th className="num">입금</th><th className="num">지출</th><th className="num">순</th></tr></thead>
                <tbody>
                  {o.cash.map((c) => (
                    <tr key={c.currency}>
                      <td className="mono">{c.currency}</td>
                      <td className="num">{formatMoney(c.income, c.currency)}</td>
                      <td className="num">{formatMoney(c.expense, c.currency)}</td>
                      <td className={`num ${c.net < 0 ? "text-danger-fg" : "text-success-fg"}`}>{formatMoney(c.net, c.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>
      </div>
      <ActionDrawer sp={sp} path="/" scope={scope} next="/" />
    </>
  );
}
