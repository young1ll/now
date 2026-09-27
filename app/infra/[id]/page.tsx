import Link from "next/link";
import { notFound } from "next/navigation";
import { checkConnectionAction, deleteConnectionAction, recordCostAction, updateConnectionAction } from "@/app/actions/infra";
import { ConfirmButton } from "@/components/ConfirmButton";
import { ConnectionForm } from "@/components/ConnectionForm";
import { Badge, Card, Empty, Field, PageHeader } from "@/components/ui";
import { monthOf, today } from "@/lib/dates";
import { db } from "@/lib/db";
import { CHECK_STATUS } from "@/lib/labels";
import { formatMoney } from "@/lib/money";
import { type SearchParams, idParam, one } from "@/lib/params";
import { PROVIDER_INFO } from "@/lib/infra/providers";
import { listBusinesses } from "@/lib/repos/businesses";
import { getConnection, listChecks, listCosts } from "@/lib/repos/infra";

export default async function ConnectionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const id = idParam((await params).id);
  const conn = id ? getConnection(db(), id) : undefined;
  if (!conn) notFound();
  const sp = await searchParams;
  const checks = listChecks(db(), conn.id);
  const costs = listCosts(db(), conn.id);
  const info = PROVIDER_INFO[conn.provider];
  const credSet = conn.credential_env ? Boolean(process.env[conn.credential_env]) : null;
  const m = (n: number) => formatMoney(n, conn.currency);

  return (
    <>
      <PageHeader
        title={conn.name}
        description={[info.label, conn.account_ref && `${info.accountLabel} ${conn.account_ref}`, conn.region].filter(Boolean).join(" · ")}
        error={one(sp.error)}
        actions={
          <>
            <Link href="/infra" className="btn">← 목록</Link>
            {conn.console_url && <a href={conn.console_url} target="_blank" rel="noreferrer" className="btn">콘솔 ↗</a>}
            {info.statusPage && <a href={info.statusPage} target="_blank" rel="noreferrer" className="btn">{info.label} 상태 페이지 ↗</a>}
            <form action={checkConnectionAction}>
              <input type="hidden" name="id" value={conn.id} />
              <button className="btn-primary">↻ 지금 점검</button>
            </form>
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title="점검 이력 (최근 30회)" flush>
            {checks.length === 0 ? (
              <Empty>점검 기록이 없습니다.</Empty>
            ) : (
              <>
                <div className="flex gap-0.5 px-4 pt-4" aria-label="점검 타임라인">
                  {[...checks].reverse().map((c) => (
                    <span
                      key={c.id}
                      title={`${c.checked_at} · ${CHECK_STATUS[c.status].label}`}
                      className={`h-6 flex-1 rounded-sm ${{ ok: "bg-emerald-500", degraded: "bg-amber-400", down: "bg-red-500", unknown: "bg-zinc-300 dark:bg-zinc-700" }[c.status]}`}
                    />
                  ))}
                </div>
                <table className="table mt-2">
                  <thead><tr><th>시각</th><th>상태</th><th className="text-right">응답</th><th>메시지</th></tr></thead>
                  <tbody>
                    {checks.slice(0, 10).map((c) => (
                      <tr key={c.id}>
                        <td className="text-xs whitespace-nowrap tabular-nums">{new Date(c.checked_at).toLocaleString("ko-KR")}</td>
                        <td><Badge tone={CHECK_STATUS[c.status].tone}>{CHECK_STATUS[c.status].label}</Badge></td>
                        <td className="text-right tabular-nums">{c.latency_ms != null ? `${c.latency_ms}ms` : "—"}</td>
                        <td className="text-xs">{c.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </Card>

          <Card title="월별 비용">
            <form action={recordCostAction} className="mb-4 flex flex-wrap items-end gap-2">
              <input type="hidden" name="id" value={conn.id} />
              <Field label="월"><input type="month" name="month" defaultValue={monthOf(today())} className="input" required /></Field>
              <Field label={`금액 (${conn.currency})`}><input name="amount" inputMode="decimal" className="input w-36 text-right" required /></Field>
              <button className="btn-primary">기록</button>
              <span className="muted text-xs">같은 달을 다시 기록하면 덮어씁니다.</span>
            </form>
            {costs.length === 0 ? (
              <Empty>비용 기록이 없습니다.</Empty>
            ) : (
              <table className="table">
                <thead><tr><th>월</th><th className="text-right">비용</th><th className="text-right">예산 대비</th><th>출처</th></tr></thead>
                <tbody>
                  {costs.map((c) => {
                    const pct = conn.monthly_budget ? Math.round((c.amount / conn.monthly_budget) * 100) : null;
                    return (
                      <tr key={c.month}>
                        <td className="tabular-nums">{c.month}</td>
                        <td className="text-right tabular-nums">{m(c.amount)}</td>
                        <td className={`text-right tabular-nums ${pct != null && pct > 100 ? "font-medium text-red-600" : ""}`}>{pct != null ? `${pct}%` : "—"}</td>
                        <td className="muted text-xs">{c.source === "manual" ? "수동" : c.source}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="자격증명">
            {credSet === null ? (
              <p className="muted text-sm">지정하지 않음</p>
            ) : (
              <p className="text-sm">
                <code className="font-mono">{conn.credential_env}</code>{" "}
                {credSet ? <Badge tone="green">설정됨</Badge> : <Badge tone="amber">미설정</Badge>}
              </p>
            )}
            <p className="muted mt-2 text-xs">값은 DB 에 저장하지 않고 <code>.env.local</code> 에서만 읽습니다. 변경 후 서버를 재시작하세요.</p>
          </Card>
          <Card title="설정">
            <ConnectionForm action={updateConnectionAction} businesses={listBusinesses(db(), { includeArchived: true })} conn={conn} />
          </Card>
          <form action={deleteConnectionAction}>
            <input type="hidden" name="id" value={conn.id} />
            <ConfirmButton message="연결과 점검·비용 기록을 모두 삭제합니다.">연결 삭제</ConfirmButton>
          </form>
        </div>
      </div>
    </>
  );
}
