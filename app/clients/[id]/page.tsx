import Link from "next/link";
import { notFound } from "next/navigation";
import {
  addInteractionAction, deleteClientAction, deleteInteractionAction, updateClientAction,
} from "@/app/actions/clients";
import { createTaskAction } from "@/app/actions/tasks";
import { ConfirmButton } from "@/components/ConfirmButton";
import { BusinessSelect, EnumSelect } from "@/components/selects";
import { Badge, Card, Empty, Field, PageHeader } from "@/components/ui";
import { formatDate, today } from "@/lib/dates";
import { db } from "@/lib/db";
import { CLIENT_KIND, CLIENT_STATUS, INTERACTION_KIND, INVOICE_STATUS, PRIORITY, TASK_STATUS } from "@/lib/labels";
import { formatMoney } from "@/lib/money";
import { type SearchParams, idParam, one } from "@/lib/params";
import { listBusinesses } from "@/lib/repos/businesses";
import { getClient, listInteractions } from "@/lib/repos/clients";
import { listInvoices } from "@/lib/repos/finance";
import { listNotes } from "@/lib/repos/notes";
import { listTasks } from "@/lib/repos/tasks";

export default async function ClientPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const id = idParam((await params).id);
  const client = id ? getClient(db(), id) : undefined;
  if (!client) notFound();
  const sp = await searchParams;

  const interactions = listInteractions(db(), client.id);
  const tasks = listTasks(db(), null, { view: "all", clientId: client.id });
  const invoices = listInvoices(db(), null, { clientId: client.id });
  const notes = listNotes(db(), null, { clientId: client.id });
  const businesses = listBusinesses(db(), { includeArchived: true });
  const st = CLIENT_STATUS[client.status];

  return (
    <>
      <PageHeader
        title={<span className="flex items-center gap-2">{client.name} <Badge tone={st.tone}>{st.label}</Badge></span>}
        description={[CLIENT_KIND[client.kind], client.email, client.phone].filter(Boolean).join(" · ")}
        error={one(sp.error)}
        actions={<Link href="/clients" className="btn">← 목록</Link>}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title="접촉 이력">
            <form action={addInteractionAction} className="mb-4 grid gap-2 sm:grid-cols-[7rem_8.5rem_1fr_auto]">
              <input type="hidden" name="client_id" value={client.id} />
              <EnumSelect name="kind" options={INTERACTION_KIND} defaultValue="call" />
              <input type="date" name="occurred_at" defaultValue={today()} className="input" required />
              <input name="summary" placeholder="무슨 이야기를 했나요?" className="input" required />
              <button className="btn-primary">기록</button>
            </form>
            {interactions.length === 0 ? (
              <Empty>접촉 이력이 없습니다.</Empty>
            ) : (
              <ol className="space-y-3">
                {interactions.map((i) => (
                  <li key={i.id} className="group flex gap-3 text-sm">
                    <span className="muted w-20 shrink-0 tabular-nums">{formatDate(i.occurred_at)}</span>
                    <Badge>{INTERACTION_KIND[i.kind]}</Badge>
                    <p className="flex-1 whitespace-pre-wrap">{i.summary}</p>
                    <form action={deleteInteractionAction} className="opacity-0 group-hover:opacity-100">
                      <input type="hidden" name="id" value={i.id} />
                      <input type="hidden" name="client_id" value={client.id} />
                      <ConfirmButton message="이 기록을 삭제할까요?" className="btn btn-sm">삭제</ConfirmButton>
                    </form>
                  </li>
                ))}
              </ol>
            )}
          </Card>

          <Card title="업무">
            <form action={createTaskAction} className="mb-4 flex gap-2">
              <input type="hidden" name="business_id" value={client.business_id} />
              <input type="hidden" name="client_id" value={client.id} />
              <input name="title" placeholder="이 고객 관련 업무 추가" className="input" required />
              <input type="date" name="due_date" className="input w-40" />
              <button className="btn-primary">추가</button>
            </form>
            {tasks.length === 0 ? (
              <Empty>업무가 없습니다.</Empty>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {tasks.map((t) => (
                  <li key={t.id} className="flex items-center gap-2">
                    <Badge tone={TASK_STATUS[t.status].tone}>{TASK_STATUS[t.status].label}</Badge>
                    <Link href={`/tasks/${t.id}`} className={`flex-1 hover:underline ${t.status === "done" ? "muted line-through" : ""}`}>
                      {t.title}
                    </Link>
                    <span className="muted text-xs">{PRIORITY[t.priority]}</span>
                    <span className="muted w-20 text-right text-xs tabular-nums">{formatDate(t.due_date)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="청구서" action={<Link href={`/finance/invoices/new?client=${client.id}`} className="link">+ 새 청구서</Link>} flush>
            {invoices.length === 0 ? (
              <Empty>청구서가 없습니다.</Empty>
            ) : (
              <table className="table">
                <thead><tr><th>번호</th><th>발행일</th><th>상태</th><th className="text-right">합계</th><th className="text-right">잔액</th></tr></thead>
                <tbody>
                  {invoices.map((i) => (
                    <tr key={i.id}>
                      <td><Link href={`/finance/invoices/${i.id}`} className="link">{i.number}</Link></td>
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

          <Card title="관련 문서" action={<Link href={`/knowledge/new?client=${client.id}`} className="link">+ 새 문서</Link>}>
            {notes.length === 0 ? (
              <Empty>관련 문서가 없습니다.</Empty>
            ) : (
              <ul className="space-y-1 text-sm">
                {notes.map((n) => (
                  <li key={n.id}><Link href={`/knowledge/${n.id}`} className="link">{n.title}</Link> <span className="muted text-xs">{formatDate(n.updated_at)}</span></li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="정보 수정">
            <form action={updateClientAction} className="grid gap-3">
              <input type="hidden" name="id" value={client.id} />
              <Field label="이름"><input name="name" defaultValue={client.name} className="input" required /></Field>
              <Field label="사업"><BusinessSelect businesses={businesses} defaultValue={client.business_id} /></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="구분"><EnumSelect name="kind" options={CLIENT_KIND} defaultValue={client.kind} /></Field>
                <Field label="상태"><EnumSelect name="status" options={CLIENT_STATUS} defaultValue={client.status} /></Field>
              </div>
              <Field label="이메일"><input name="email" type="email" defaultValue={client.email} className="input" /></Field>
              <Field label="전화"><input name="phone" defaultValue={client.phone} className="input" /></Field>
              <Field label="태그"><input name="tags" defaultValue={client.tags} className="input" /></Field>
              <Field label="메모"><textarea name="memo" rows={5} defaultValue={client.memo} className="input" /></Field>
              <button className="btn-primary">저장</button>
            </form>
          </Card>
          <form action={deleteClientAction}>
            <input type="hidden" name="id" value={client.id} />
            <ConfirmButton message="고객과 접촉 이력을 삭제합니다. 업무·청구서는 남고 고객 연결만 해제됩니다.">고객 삭제</ConfirmButton>
          </form>
        </div>
      </div>
    </>
  );
}
