import Link from "next/link";
import { createClientAction } from "@/app/actions/clients";
import { BusinessSelect, EnumSelect } from "@/components/selects";
import { Badge, BizTag, Card, Empty, Field, PageHeader, Tabs } from "@/components/ui";
import { currentScope } from "@/lib/context";
import { formatDate } from "@/lib/dates";
import { db } from "@/lib/db";
import { CLIENT_KIND, CLIENT_STATUS } from "@/lib/labels";
import { type SearchParams, one } from "@/lib/params";
import { listBusinesses } from "@/lib/repos/businesses";
import { CLIENT_STATUSES, type ClientStatus, listClients } from "@/lib/repos/clients";

export const metadata = { title: "고객 · 거래처" };

export default async function ClientsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const scope = await currentScope();
  const status = CLIENT_STATUSES.find((s) => s === one(sp.status)) as ClientStatus | undefined;
  const q = one(sp.q)?.trim() || undefined;
  const clients = listClients(db(), scope, { status, q });
  const businesses = listBusinesses(db());

  const tabHref = (s?: string) => `/clients?${new URLSearchParams({ ...(s && { status: s }), ...(q && { q }) })}`;

  return (
    <>
      <PageHeader title="고객 · 거래처" description="모든 사업의 고객과 접촉 이력을 관리합니다." error={one(sp.error)} />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <form className="mb-3 flex gap-2" action="/clients">
            {status && <input type="hidden" name="status" value={status} />}
            <input name="q" defaultValue={q} placeholder="이름·이메일·태그·메모 검색" className="input" />
            <button className="btn">검색</button>
          </form>
          <Tabs
            current={status ?? "all"}
            items={[
              { key: "all", label: "전체", href: tabHref() },
              ...CLIENT_STATUSES.map((s) => ({ key: s, label: CLIENT_STATUS[s].label, href: tabHref(s) })),
            ]}
          />
          <Card flush>
            {clients.length === 0 ? (
              <Empty>고객이 없습니다.</Empty>
            ) : (
              <table className="table">
                <thead>
                  <tr><th>이름</th><th>사업</th><th>상태</th><th>최근 접촉</th><th className="text-right">열린 업무</th></tr>
                </thead>
                <tbody>
                  {clients.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <Link href={`/clients/${c.id}`} className="font-medium hover:underline">{c.name}</Link>
                        <div className="muted text-xs">
                          {CLIENT_KIND[c.kind]}
                          {c.tags && ` · ${c.tags}`}
                        </div>
                      </td>
                      <td><BizTag name={c.business_name} color={c.business_color} /></td>
                      <td><Badge tone={CLIENT_STATUS[c.status].tone}>{CLIENT_STATUS[c.status].label}</Badge></td>
                      <td className="tabular-nums">{formatDate(c.last_contact)}</td>
                      <td className="text-right tabular-nums">{c.open_tasks || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>

        <Card title="새 고객">
          <form action={createClientAction} className="grid gap-3">
            <Field label="이름"><input name="name" className="input" required /></Field>
            <Field label="사업"><BusinessSelect businesses={businesses} defaultValue={scope ?? businesses[0]?.id} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="구분"><EnumSelect name="kind" options={CLIENT_KIND} defaultValue="company" /></Field>
              <Field label="상태"><EnumSelect name="status" options={CLIENT_STATUS} defaultValue="lead" /></Field>
            </div>
            <Field label="이메일"><input name="email" type="email" className="input" /></Field>
            <Field label="전화"><input name="phone" className="input" /></Field>
            <Field label="태그 (쉼표 구분)"><input name="tags" className="input" placeholder="법인, 기장" /></Field>
            <Field label="메모"><textarea name="memo" rows={3} className="input" /></Field>
            <button className="btn-primary">추가</button>
          </form>
        </Card>
      </div>
    </>
  );
}
