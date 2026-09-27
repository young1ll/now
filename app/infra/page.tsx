import Link from "next/link";
import { checkAllAction, createConnectionAction } from "@/app/actions/infra";
import { ConnectionForm } from "@/components/ConnectionForm";
import { Badge, BizTag, Card, Empty, PageHeader } from "@/components/ui";
import { currentScope } from "@/lib/context";
import { monthOf, today } from "@/lib/dates";
import { db } from "@/lib/db";
import { CHECK_STATUS } from "@/lib/labels";
import { formatMoney } from "@/lib/money";
import { type SearchParams, one } from "@/lib/params";
import { PROVIDER_INFO } from "@/lib/infra/providers";
import { listBusinesses } from "@/lib/repos/businesses";
import { listConnections } from "@/lib/repos/infra";

export const metadata = { title: "인프라" };

function ago(iso: string | null) {
  if (!iso) return "점검 안 함";
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  if (min < 1440) return `${Math.round(min / 60)}시간 전`;
  return `${Math.round(min / 1440)}일 전`;
}

export default async function InfraPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const scope = await currentScope();
  const month = monthOf(today());
  const conns = listConnections(db(), scope, month);
  const businesses = listBusinesses(db());

  return (
    <>
      <PageHeader
        title="인프라 연동 · 가시성"
        description="AWS · GCP · Azure · Palantir 등 운영 중인 인프라의 상태와 월 비용을 한눈에 봅니다. 비밀값은 저장하지 않습니다."
        error={one(sp.error)}
        actions={
          conns.length > 0 && (
            <form action={checkAllAction}><button className="btn">↻ 전체 점검</button></form>
          )
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card flush>
            {conns.length === 0 ? (
              <Empty>연결이 없습니다. 오른쪽에서 첫 연결을 추가하세요.</Empty>
            ) : (
              <table className="table">
                <thead>
                  <tr><th>연결</th><th>상태</th><th className="text-right">{month} 비용 / 예산</th><th /></tr>
                </thead>
                <tbody>
                  {conns.map((c) => {
                    const st = CHECK_STATUS[c.last_status ?? "unknown"];
                    const over = c.monthly_budget != null && c.month_cost != null && c.month_cost > c.monthly_budget;
                    const pct = c.monthly_budget && c.month_cost != null ? Math.round((c.month_cost / c.monthly_budget) * 100) : null;
                    return (
                      <tr key={c.id}>
                        <td>
                          <Link href={`/infra/${c.id}`} className="font-medium hover:underline">{c.name}</Link>
                          <div className="muted text-xs">
                            {PROVIDER_INFO[c.provider].label}
                            {c.account_ref && ` · ${c.account_ref}`}
                            {c.region && ` · ${c.region}`}
                          </div>
                          <BizTag name={c.business_name} color={c.business_color} />
                        </td>
                        <td>
                          <Badge tone={st.tone}>{st.label}</Badge>
                          <div className="muted mt-0.5 text-xs">
                            {ago(c.last_checked_at)}
                            {c.last_latency_ms != null && ` · ${c.last_latency_ms}ms`}
                          </div>
                          {c.last_message && <div className="muted max-w-56 truncate text-xs" title={c.last_message}>{c.last_message}</div>}
                        </td>
                        <td className="text-right tabular-nums">
                          {c.month_cost != null ? formatMoney(c.month_cost, c.currency) : "—"}
                          {c.monthly_budget != null && <div className="muted text-xs">/ {formatMoney(c.monthly_budget, c.currency)}</div>}
                          {pct != null && <div className={`text-xs ${over ? "font-medium text-red-600" : "muted"}`}>{pct}%</div>}
                        </td>
                        <td className="text-right">
                          {c.console_url && <a href={c.console_url} target="_blank" rel="noreferrer" className="link text-xs whitespace-nowrap">콘솔 ↗</a>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>
          <p className="muted mt-3 text-xs">
            판정 기준: 헬스체크 URL 응답(2xx·3xx 정상, 4xx 주의, 5xx·무응답 장애) + 자격증명 환경변수 존재 여부.
            공급자 API 로 비용·리소스를 자동 수집하는 기능은 로드맵에 있습니다 (docs/ROADMAP.md).
          </p>
        </div>
        <Card title="새 연결">
          <ConnectionForm action={createConnectionAction} businesses={businesses} defaultBusinessId={scope} />
        </Card>
      </div>
    </>
  );
}
