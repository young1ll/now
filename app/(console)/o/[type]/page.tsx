import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionDrawer, actHref } from "@/components/ActionDrawer";
import { Icon } from "@/components/icons";
import { Empty, OBJECT_ICON, PageHeader, Panel, Tag } from "@/components/ui";
import { currentScope } from "@/lib/context";
import { db } from "@/lib/db";
import { getAction } from "@/lib/ontology/execute";
import { objectDef } from "@/lib/ontology/objects";
import { type SearchParams, one } from "@/lib/params";

export default async function ExplorerPage({ params, searchParams }: { params: Promise<{ type: string }>; searchParams: SearchParams }) {
  const { type } = await params;
  const def = objectDef(type);
  if (!def) notFound();
  const sp = await searchParams;
  const scope = await currentScope();
  const q = one(sp.q)?.trim() || undefined;
  const status = one(sp.status) || undefined;
  const all = def.list(db(), scope, q);
  const statuses = [...new Map(all.filter((r) => r.status).map((r) => [r.status!.label, r.status!])).values()];
  const rows = status ? all.filter((r) => r.status?.label === status) : all;
  const path = `/o/${type}`;
  const create = def.createAction ? getAction(def.createAction) : undefined;
  const qs = (patch: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ q, status, ...patch })) if (v) u.set(k, v);
    return `${path}${u.size ? `?${u}` : ""}`;
  };

  return (
    <>
      <PageHeader
        icon={OBJECT_ICON[def.type]}
        eyebrow="온톨로지 · 객체 탐색"
        title={def.plural}
        meta={def.description}
        error={one(sp.error)}
        actions={
          create && (
            <Link href={actHref(path, create.name, {}, { business_id: def.type !== "business" && scope ? scope : undefined })} className="btn-primary">
              <Icon name="plus" size={12} /> {create.title}
            </Link>
          )
        }
      />
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-5 py-2">
        <form action={path} className="flex gap-1.5">
          {status && <input type="hidden" name="status" value={status} />}
          <input name="q" defaultValue={q} placeholder={`${def.label} 검색`} className="field h-7 min-h-0 w-64" />
          <button className="btn">검색</button>
        </form>
        <div className="flex flex-wrap gap-1">
          <Link href={qs({ status: undefined })} className={!status ? "btn-primary btn-sm" : "btn btn-sm"}>전체 {all.length}</Link>
          {statuses.map((s) => (
            <Link key={s.label} href={qs({ status: s.label })} className={status === s.label ? "btn-primary btn-sm" : "btn btn-sm"}>
              {s.label} {all.filter((r) => r.status?.label === s.label).length}
            </Link>
          ))}
        </div>
      </div>
      <div className="p-px">
        <Panel flush>
          {rows.length === 0 ? (
            <Empty icon={OBJECT_ICON[def.type]}>{q ? "검색 결과가 없습니다." : `${def.label}이(가) 없습니다.`}</Empty>
          ) : (
            <table className="grid-table">
              <thead>
                <tr>
                  <th className="w-[96px]">ID</th>
                  <th>{def.label}</th>
                  <th className="w-[90px]">상태</th>
                  {def.columns.map((c) => <th key={c.key} className={c.num ? "text-right" : ""}>{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.displayId}>
                    <td><Link href={`${path}/${r.ref.id}`} className="mono text-primary-fg hover:underline">{r.displayId}</Link></td>
                    <td className="max-w-[360px]">
                      <Link href={`${path}/${r.ref.id}`} className="block truncate font-medium hover:underline">{r.title}</Link>
                      {r.subtitle && <div className="truncate text-[11.5px] text-fg-3">{r.subtitle}</div>}
                    </td>
                    <td>{r.status ? <Tag tone={r.status.tone}>{r.status.label}</Tag> : <span className="text-fg-4">—</span>}</td>
                    {def.columns.map((c) => (
                      <td key={c.key} className={`${c.num ? "num" : ""} ${c.mono ? "mono" : ""} max-w-[220px] truncate`}>{r.props[c.key]}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
      <ActionDrawer sp={sp} path={path} scope={scope} />
    </>
  );
}
