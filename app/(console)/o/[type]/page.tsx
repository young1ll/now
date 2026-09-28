import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ActionDrawer, actHref } from "@/components/ActionDrawer";
import { Column, Columns } from "@/components/Columns";
import { Icon } from "@/components/icons";
import { ObjectPreview } from "@/components/ObjectPreview";
import { Empty, OBJECT_ICON, PageHeader, Tag } from "@/components/ui";
import { currentScope } from "@/lib/context";
import { db } from "@/lib/db";
import { getAction } from "@/lib/ontology/execute";
import { parseRef } from "@/lib/ontology/graph";
import { objectDef } from "@/lib/ontology/objects";
import { type SearchParams, one } from "@/lib/params";

/** 객체 탐색기 — 열 기반: 목록 | 선택한 객체 | 연결된 객체. 경계를 끌어 너비 조정. */
export default async function ExplorerPage({ params, searchParams }: { params: Promise<{ type: string }>; searchParams: SearchParams }) {
  const { type } = await params;
  const def = objectDef(type);
  if (!def) notFound();
  const sp = await searchParams;
  // 기억은 전용 열 기반 화면 (검토 대기 · 확인됨 · 보관 탭)
  if (def.type === "memory") redirect(`/memory${one(sp.sel) ? `?tab=all&sel=${one(sp.sel)}` : ""}`);
  const scope = await currentScope();
  const q = one(sp.q)?.trim() || undefined;
  const status = one(sp.status) || undefined;
  // 분류 탭 (문서 종류 등) — facet 이 있는 유형만
  const facetParam = one(sp.facet) || undefined;
  const facet = def.facet?.options.some((o) => o.value === facetParam) ? facetParam : undefined;
  const sel = Number(one(sp.sel)) || undefined;
  const sub = one(sp.sub) ? parseRef(one(sp.sub)!) : undefined;
  // 분류 탭: 개수를 따로 세는 유형(문서)은 선택한 종류만 SQL 로 읽는다
  const counts = def.facetCounts?.(db(), scope, q);
  const listed = def.list(db(), scope, q, counts ? { facet } : undefined);
  const all = facet && def.facet && !counts ? listed.filter((r) => r.props[def.facet!.key] === facet) : listed;
  const facetCount = (v?: string) =>
    counts ? (v ? (counts[v] ?? 0) : Object.values(counts).reduce((a, b) => a + b, 0)) : v ? listed.filter((r) => r.props[def.facet!.key] === v).length : listed.length;
  const statuses = [...new Map(all.filter((r) => r.status).map((r) => [r.status!.label, r.status!])).values()];
  const rows = status ? all.filter((r) => r.status?.label === status) : all;
  const path = `/o/${type}`;
  const create = def.createAction ? getAction(def.createAction) : undefined;
  const keep = (patch: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ q, facet, status, sel: sel ? String(sel) : undefined, sub: one(sp.sub), ...patch })) if (v) u.set(k, v);
    return u;
  };
  const href = (patch: Record<string, string | undefined>) => `${path}?${keep(patch)}`;
  const baseQuery = Object.fromEntries(keep({}));

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={OBJECT_ICON[def.type]}
        eyebrow="온톨로지 · 객체 탐색"
        title={def.plural}
        meta={def.description}
        error={one(sp.error)}
        actions={
          <>
            <Link href={`/graph?types=${def.type}`} className="btn"><Icon name="graph" size={12} /> 그래프</Link>
            {def.type === "note" && (
              <Link href={actHref(path, "document.import", {}, { business_id: scope ?? undefined, tainted: true })} className="btn"><Icon name="plus" size={12} /> 외부 자료 가져오기</Link>
            )}
            {create && (
              <Link href={actHref(path, create.name, {}, { business_id: def.type !== "business" && scope ? scope : undefined, kind: def.type === "note" && facet && facet !== "episode" ? facet : undefined, tainted: def.type === "note" && facet === "source" ? true : undefined })} className="btn-primary">
                <Icon name="plus" size={12} /> {create.title}
              </Link>
            )}
          </>
        }
      />
      <Columns storageKey={`explorer-${type}`} defaults={[520, 0, 460]} grow={1}>
        <Column
          title={<>{def.label} <span className="mono bg-raised px-1.5 text-fg-2">{rows.length}</span></>}
          actions={
            <form action={path} className="flex gap-1">
              {facet && <input type="hidden" name="facet" value={facet} />}
              {status && <input type="hidden" name="status" value={status} />}
              <input name="q" defaultValue={q} placeholder="검색" className="field h-6 min-h-0 w-40 py-0 text-[12px]" />
            </form>
          }
        >
          {def.facet && (
            <div className="flex flex-wrap items-center gap-1 border-b border-line-soft px-3 py-1.5">
              <span className="label-caps mr-1">{def.facet.label}</span>
              <Link href={href({ facet: undefined, status: undefined, sel: undefined })} className={!facet ? "btn btn-sm" : "btn-minimal btn-sm"}>전체 <span className="mono">{facetCount()}</span></Link>
              {def.facet.options.map((o) => {
                const n = facetCount(o.value);
                return (
                  <Link key={o.value} href={href({ facet: o.value, status: undefined, sel: undefined })} className={facet === o.value ? "btn btn-sm" : "btn-minimal btn-sm"}>
                    {o.label} <span className="mono">{n}</span>
                  </Link>
                );
              })}
            </div>
          )}
          <div className="flex flex-wrap gap-1 border-b border-line-soft px-3 py-1.5">
            <Link href={href({ status: undefined })} className={!status ? "btn-primary btn-sm" : "btn btn-sm"}>전체 {all.length}</Link>
            {statuses.map((s) => (
              <Link key={s.label} href={href({ status: s.label })} className={status === s.label ? "btn-primary btn-sm" : "btn btn-sm"}>
                {s.label} {all.filter((r) => r.status?.label === s.label).length}
              </Link>
            ))}
          </div>
          {rows.length === 0 ? (
            <Empty icon={OBJECT_ICON[def.type]}>{q ? "검색 결과가 없습니다." : `${def.label}이(가) 없습니다.`}</Empty>
          ) : (
            <table className="grid-table">
              <thead>
                <tr>
                  <th className="w-[84px]">ID</th>
                  <th>{def.label}</th>
                  <th className="w-[80px]">상태</th>
                  {def.columns.slice(0, sel ? 1 : 4).map((c) => <th key={c.key} className={c.num ? "text-right" : ""}>{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const active = r.ref.id === sel;
                  return (
                    <tr key={r.displayId} className={active ? "[&>td]:bg-primary/15" : ""}>
                      <td><Link href={href({ sel: String(r.ref.id), sub: undefined })} className="mono text-primary-fg hover:underline">{r.displayId}</Link></td>
                      <td className="max-w-[260px]">
                        <Link href={href({ sel: String(r.ref.id), sub: undefined })} className="block truncate font-medium hover:underline">{r.title}</Link>
                        {r.subtitle && <div className="truncate text-[11.5px] text-fg-3">{r.subtitle}</div>}
                      </td>
                      <td>{r.status ? <Tag tone={r.status.tone}>{r.status.label}</Tag> : <span className="text-fg-4">—</span>}</td>
                      {def.columns.slice(0, sel ? 1 : 4).map((c) => (
                        <td key={c.key} className={`${c.num ? "num" : ""} ${c.mono ? "mono" : ""} max-w-[180px] truncate`}>{r.props[c.key]}</td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Column>
        <Column title={sel ? "선택한 객체" : "미리보기"} actions={sel && <Link href={href({ sel: undefined, sub: undefined })} className="btn-minimal btn-sm" aria-label="닫기"><Icon name="close" size={10} /></Link>}>
          {sel ? (
            <ObjectPreview r={{ type: def.type, id: sel }} basePath={path} query={baseQuery} openParam="sub" />
          ) : (
            <Empty icon="arrow">왼쪽 목록에서 객체를 선택하면 속성·관계·액션을 여기서 봅니다.</Empty>
          )}
        </Column>
        {sub && (
          <Column title="연결된 객체" actions={<Link href={href({ sub: undefined })} className="btn-minimal btn-sm" aria-label="닫기"><Icon name="close" size={10} /></Link>}>
            <ObjectPreview r={sub} basePath={path} query={baseQuery} openParam="sub" />
          </Column>
        )}
      </Columns>
      <ActionDrawer sp={sp} path={path} scope={scope} />
    </div>
  );
}
