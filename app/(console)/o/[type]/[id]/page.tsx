import Link from "next/link";
import { notFound } from "next/navigation";
import { runActionForm } from "@/app/actions/console";
import { ActionDrawer, actHref } from "@/components/ActionDrawer";
import { ActionForm } from "@/components/ActionForm";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Icon } from "@/components/icons";
import { Markdown } from "@/components/Markdown";
import { RunTable } from "@/components/runs";
import { Empty, OBJECT_ICON, ObjectLink, PageHeader, Panel, PropertyList, Tag } from "@/components/ui";
import { currentScope } from "@/lib/context";
import { formatDate } from "@/lib/dates";
import { db } from "@/lib/db";
import { INTERACTION_KIND } from "@/lib/labels";
import { formatMoney } from "@/lib/money";
import type { AnyAction } from "@/lib/ontology/action";
import { getAction } from "@/lib/ontology/execute";
import { type ObjectDetail, objectDef } from "@/lib/ontology/objects";
import type { ObjectType } from "@/lib/ontology/types";
import { type SearchParams, idParam, one } from "@/lib/params";
import type { Interaction } from "@/lib/repos/clients";
import type { getInvoice } from "@/lib/repos/finance";
import type { Note } from "@/lib/repos/notes";
import { listRuns } from "@/lib/repos/runs";

/** 이 객체에서 액션을 열 때 고정할 파라미터 */
function contextParams(a: AnyAction, type: ObjectType, obj: ObjectDetail) {
  const fixed: Record<string, unknown> = {};
  const soft: Record<string, unknown> = {};
  if (a.target?.type === type) fixed[a.target.param] = obj.ref.id;
  else {
    for (const [k, f] of Object.entries(a.fields)) {
      if (f.spec.kind === "ref" && f.spec.ref === type) fixed[k] = obj.ref.id;
    }
    if (a.fields.business_id && fixed.business_id === undefined && obj.businessId) soft.business_id = obj.businessId;
  }
  return { fixed, soft };
}

export default async function ObjectPage({ params, searchParams }: { params: Promise<{ type: string; id: string }>; searchParams: SearchParams }) {
  const p = await params;
  const def = objectDef(p.type);
  const id = idParam(p.id);
  if (!def || !id) notFound();
  const obj = def.get(db(), id);
  if (!obj) notFound();
  const sp = await searchParams;
  const scope = await currentScope();
  const path = `/o/${def.type}/${id}`;
  const history = listRuns(db(), { object: { type: def.type, id }, limit: 50 });
  const pending = history.filter((r) => r.status === "pending");
  const actions = (def.actionsFor?.(obj.raw) ?? def.actions).map((n) => getAction(n)).filter((a): a is AnyAction => !!a);
  const linkGroups = Object.entries(Object.groupBy(obj.links, (l) => l.relation.split(" · ")[0]));

  return (
    <>
      <PageHeader
        icon={OBJECT_ICON[def.type]}
        eyebrow={<><Link href={`/o/${def.type}`} className="hover:text-fg">{def.plural}</Link> <span>/</span> <span className="mono normal-case">{obj.displayId}</span></>}
        title={<span className="flex items-center gap-2">{obj.title} {obj.status && <Tag tone={obj.status.tone}>{obj.status.label}</Tag>}</span>}
        meta={obj.subtitle}
        error={one(sp.error)}
        actions={
          <>
            {def.type === "invoice" && <Link href={`/print/invoice/${id}`} target="_blank" className="btn"><Icon name="print" size={12} /> 인쇄 · PDF</Link>}
            {actions.slice(0, 2).map((a) => {
              const { fixed, soft } = contextParams(a, def.type, obj);
              return <Link key={a.name} href={actHref(path, a.name, fixed, soft)} className={a === actions[0] ? "btn-primary" : "btn"}>{a.title}</Link>;
            })}
          </>
        }
      />
      {pending.length > 0 && (
        <Link href="/inbox" className="flex items-center gap-2 border-b border-warning/50 bg-warning/10 px-5 py-2 text-[12.5px] text-warning-fg hover:bg-warning/20">
          <Icon name="inbox" size={12} /> 이 객체에 대한 승인 대기 요청 {pending.length}건 — {pending.map((r) => r.result?.summary).join(" · ")}
        </Link>
      )}
      <div className="grid gap-px bg-void p-px xl:grid-cols-12">
        <div className="flex flex-col gap-px xl:col-span-8">
          <TypePanel type={def.type} obj={obj} path={path} />
          <Panel title="변경 이력 · 감사" count={history.length} flush>
            {history.length === 0 ? <Empty icon="activity">이 객체에 대한 액션 기록이 없습니다.</Empty> : <RunTable runs={history} showObjects={false} />}
          </Panel>
        </div>
        <div className="flex flex-col gap-px xl:col-span-4">
          <Panel title="속성">
            <PropertyList items={[{ label: "ID", value: obj.displayId, mono: true }, ...obj.properties.map((pp) => ({ label: pp.label, value: pp.value }))]} />
          </Panel>
          <Panel title="액션" count={actions.length}>
            <div className="flex flex-col gap-1">
              {actions.map((a) => {
                const { fixed, soft } = contextParams(a, def.type, obj);
                return (
                  <Link key={a.name} href={actHref(path, a.name, fixed, soft)} className="flex items-center justify-between gap-2 border border-line bg-raised px-2.5 py-1.5 hover:border-line-strong hover:bg-hover">
                    <span className="flex items-center gap-2"><Icon name="bolt" size={12} className="text-primary-fg" />{a.title}</span>
                    <span className="mono text-[10.5px] text-fg-4">{a.risk === "high" ? "HIGH" : typeof a.risk === "function" ? "DYN" : "LOW"}</span>
                  </Link>
                );
              })}
            </div>
          </Panel>
          <Panel title="연결된 객체" count={obj.links.length}>
            {obj.links.length === 0 ? <p className="text-fg-3">없음</p> : (
              <div className="flex flex-col gap-3">
                {linkGroups.map(([g, links]) => (
                  <div key={g}>
                    <div className="label-caps mb-1">{g}</div>
                    <div className="flex flex-col gap-1">
                      {links!.map((l) => (
                        <div key={`${l.ref.type}${l.ref.id}`} className="flex items-center justify-between gap-2">
                          <ObjectLink type={l.ref.type} id={l.ref.id} title={l.title} />
                          {l.relation.includes(" · ") && <span className="shrink-0 text-[11px] text-fg-3">{l.relation.split(" · ")[1]}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>
      </div>
      <ActionDrawer sp={sp} path={path} scope={scope} next={path} />
    </>
  );
}

/** 유형별 본문 패널 */
function TypePanel({ type, obj, path }: { type: ObjectType; obj: ObjectDetail; path: string }) {
  const raw = obj.raw;
  if (type === "client") {
    const interactions = (raw.interactions as Interaction[]) ?? [];
    return (
      <Panel title="접촉 이력" count={interactions.length}>
        <details className="mb-3 border border-line bg-inset">
          <summary className="cursor-pointer px-3 py-2 text-[12.5px] text-primary-fg">+ 접촉 기록</summary>
          <div className="border-t border-line p-3">
            <ActionForm def={getAction("client.log_interaction")!} db={db()} scope={null} values={{ client_id: obj.ref.id, kind: "call" }} locked={["client_id"]} next={path} />
          </div>
        </details>
        {interactions.length === 0 ? <Empty>접촉 이력이 없습니다.</Empty> : (
          <ol className="relative ml-2 border-l border-line">
            {interactions.map((i) => (
              <li key={i.id} className="relative mb-3 pl-4">
                <span className="absolute top-1.5 -left-[4px] size-[7px] bg-line-strong" />
                <div className="flex items-center gap-2 text-[11.5px] text-fg-3">
                  <span className="mono">{formatDate(i.occurred_at)}</span>
                  <Tag tone="none">{INTERACTION_KIND[i.kind]}</Tag>
                </div>
                <p className="mt-0.5 whitespace-pre-wrap">{i.summary}</p>
              </li>
            ))}
          </ol>
        )}
      </Panel>
    );
  }
  if (type === "invoice") {
    const d = raw as unknown as NonNullable<ReturnType<typeof getInvoice>>;
    const cur = d.invoice.currency;
    return (
      <Panel title="청구 내역" flush>
        <table className="grid-table">
          <thead><tr><th>품목</th><th className="text-right">수량</th><th className="text-right">단가</th><th className="text-right">금액</th></tr></thead>
          <tbody>
            {d.items.map((it) => (
              <tr key={it.id}>
                <td>{it.description}</td>
                <td className="num">{it.quantity}</td>
                <td className="num">{formatMoney(it.unit_price, cur)}</td>
                <td className="num">{formatMoney(Math.round(it.quantity * it.unit_price), cur)}</td>
              </tr>
            ))}
            <tr><td colSpan={3} className="text-right text-fg-3">공급가액</td><td className="num">{formatMoney(d.invoice.subtotal, cur)}</td></tr>
            {d.invoice.tax_rate > 0 && <tr><td colSpan={3} className="text-right text-fg-3">부가세 {d.invoice.tax_rate}%</td><td className="num">{formatMoney(d.invoice.tax, cur)}</td></tr>}
            <tr><td colSpan={3} className="text-right font-semibold">합계</td><td className="num font-semibold">{formatMoney(d.invoice.total, cur)}</td></tr>
          </tbody>
        </table>
        <div className="label-caps border-y border-line bg-panel px-3 py-2">입금 · {d.payments.length}건 · 잔액 {formatMoney(d.invoice.balance, cur)}</div>
        {d.payments.length === 0 ? <p className="px-3 py-3 text-fg-3">입금 기록 없음</p> : (
          <table className="grid-table">
            <tbody>
              {d.payments.map((pm) => (
                <tr key={pm.id}>
                  <td className="mono">{formatDate(pm.paid_at)}</td>
                  <td>{pm.method || "—"}</td>
                  <td className="num">{formatMoney(pm.amount, cur)}</td>
                  <td className="w-[60px] text-right">
                    <form action={runActionForm}>
                      <input type="hidden" name="__action" value="payment.delete" />
                      <input type="hidden" name="payment_id" value={pm.id} />
                      <ConfirmButton message="이 입금 기록을 삭제할까요?" className="btn-minimal btn-sm">삭제</ConfirmButton>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {d.invoice.memo && <p className="border-t border-line px-3 py-2 whitespace-pre-wrap text-fg-2">{d.invoice.memo}</p>}
      </Panel>
    );
  }
  if (type === "note") {
    const n = raw as unknown as Note;
    return <Panel title="본문">{n.body.trim() ? <Markdown source={n.body} /> : <p className="text-fg-3">본문이 비어 있습니다.</p>}</Panel>;
  }
  if (type === "task") {
    const detail = String(raw.detail ?? "");
    return <Panel title="상세">{detail ? <p className="whitespace-pre-wrap">{detail}</p> : <p className="text-fg-3">상세 내용 없음</p>}</Panel>;
  }
  if (type === "agent") {
    const runs = listRuns(db(), { actorType: "agent", actorId: String(obj.ref.id), limit: 30 });
    return (
      <Panel title="이 에이전트의 실행" count={runs.length} flush action={<Link href={`/activity?actor=agent:${obj.ref.id}`} className="btn-minimal btn-sm">전체</Link>}>
        {runs.length === 0 ? <Empty icon="agent">아직 실행 기록이 없습니다.</Empty> : <RunTable runs={runs} compact />}
      </Panel>
    );
  }
  if (type === "business") {
    return (
      <Panel title="바로가기">
        <div className="flex flex-wrap gap-1.5">
          {(["client", "task", "invoice", "expense", "note"] as const).map((t) => (
            <Link key={t} href={actHref(path, `${t === "expense" ? "expense.record" : `${t}.create`}`, {}, { business_id: obj.ref.id })} className="btn">
              <Icon name="plus" size={12} /> {objectDef(t)!.label}
            </Link>
          ))}
        </div>
      </Panel>
    );
  }
  return null;
}
