import Link from "next/link";
import { runActionForm } from "@/app/actions/console";
import { actHref } from "@/components/ActionDrawer";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Icon } from "@/components/icons";
import { RunTable } from "@/components/runs";
import { OBJECT_ICON, ObjectLink, PropertyList, Tag } from "@/components/ui";
import { db } from "@/lib/db";
import type { AnyAction } from "@/lib/ontology/action";
import { getAction } from "@/lib/ontology/execute";
import { edgesOf, nodeInfo } from "@/lib/ontology/graph";
import { objectDef } from "@/lib/ontology/objects";
import { type Ref, refKey } from "@/lib/ontology/types";
import { listRuns } from "@/lib/repos/runs";

/** 액션을 이 객체 문맥으로 열 때 고정할 파라미터 */
export function contextParams(a: AnyAction, r: Ref, businessId: number | null) {
  const fixed: Record<string, unknown> = {};
  const soft: Record<string, unknown> = {};
  if (a.target?.type === r.type) fixed[a.target.param] = r.id;
  else {
    for (const [k, f] of Object.entries(a.fields)) {
      if (f.spec.kind === "ref" && f.spec.ref === r.type) fixed[k] = r.id;
    }
    if (a.name === "link.create") fixed.from = refKey(r);
    if (a.fields.business_id && fixed.business_id === undefined && businessId) soft.business_id = businessId;
  }
  return { fixed, soft };
}

/**
 * 열(column) 안에 들어가는 객체 요약 — 속성 · 연결(외래키·사용자 링크·에이전트) · 가능한 액션 · 최근 이력.
 * basePath: 액션 드로어를 열 경로 (현재 화면 유지), selectParam: 연결 객체를 여는 쿼리 키.
 */
export function ObjectPreview({ r, basePath, query, openParam = "sub" }: { r: Ref; basePath: string; query: Record<string, string>; openParam?: string }) {
  const def = objectDef(r.type);
  const obj = def?.get(db(), r.id);
  if (!def || !obj) return <p className="p-3 text-fg-3">객체를 찾을 수 없습니다.</p>;
  const actions = [...(def.actionsFor?.(obj.raw) ?? def.actions), "link.create"].map((n) => getAction(n)).filter((a): a is AnyAction => !!a);
  const edges = edgesOf(db(), r);
  const custom = edges.filter((e) => e.source === "custom");
  const infos = nodeInfo(db(), edges.flatMap((e) => [e.from, e.to]));
  const history = listRuns(db(), { object: r, limit: 8 });
  const openHref = (o: Ref) => `${basePath}?${new URLSearchParams({ ...query, [openParam]: refKey(o) })}`;
  const here = `${basePath}?${new URLSearchParams(query)}`;

  return (
    <div className="flex flex-col">
      <div className="border-b border-line px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Icon name={OBJECT_ICON[r.type]} className="text-fg-3" />
          <span className="mono text-[11px] text-fg-3">{obj.displayId}</span>
          {obj.status && <Tag tone={obj.status.tone}>{obj.status.label}</Tag>}
          <Link href={`/o/${r.type}/${r.id}`} className="btn-minimal btn-sm ml-auto">전체 화면 <Icon name="external" size={10} /></Link>
        </div>
        <div className="mt-1 text-[14.5px] font-semibold">{obj.title}</div>
        {obj.subtitle && <div className="truncate text-[12px] text-fg-3">{obj.subtitle}</div>}
      </div>

      <div className="label-caps border-b border-line-soft px-3 py-1.5">액션</div>
      <div className="flex flex-wrap gap-1 px-3 py-2">
        {actions.map((a) => {
          const { fixed, soft } = contextParams(a, r, obj.businessId);
          const q = new URLSearchParams({ ...query, act: a.name });
          for (const [k, v] of Object.entries(fixed)) q.set(`p.${k}`, String(v));
          for (const [k, v] of Object.entries(soft)) q.set(`d.${k}`, String(v));
          return (
            <Link key={a.name} href={`${basePath}?${q}`} className="btn btn-sm">
              {a.title}
            </Link>
          );
        })}
      </div>

      <div className="label-caps border-y border-line-soft px-3 py-1.5">속성</div>
      <div className="px-3">
        <PropertyList items={obj.properties.map((p) => ({ label: p.label, value: p.value }))} />
      </div>

      <div className="label-caps border-y border-line-soft px-3 py-1.5">관계 · {edges.length}</div>
      <ul className="divide-y divide-line-soft">
        {edges.slice(0, 40).map((e) => {
          const out = refKey(e.from) === refKey(r);
          const other = out ? e.to : e.from;
          return (
            <li key={`${e.linkType}${refKey(e.from)}${refKey(e.to)}`} className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
              <span className={`w-20 shrink-0 truncate text-[11px] ${e.source === "custom" ? "text-primary-fg" : e.source === "derived" ? "text-ai-fg" : "text-fg-3"}`} title={e.linkType}>
                {out ? "→" : "←"} {e.label}
              </span>
              <Link href={openHref(other)} className="min-w-0 flex-1 truncate hover:underline">
                <RefLabel r={other} info={infos.get(refKey(other))} />
              </Link>
              {e.linkId && (
                <form action={runActionForm}>
                  <input type="hidden" name="__action" value="link.delete" />
                  <input type="hidden" name="__next" value={here} />
                  <input type="hidden" name="link_id" value={e.linkId} />
                  <ConfirmButton message="이 링크를 해제할까요?" className="btn-minimal btn-sm">×</ConfirmButton>
                </form>
              )}
            </li>
          );
        })}
        {edges.length === 0 && <li className="px-3 py-2 text-fg-3">연결 없음</li>}
      </ul>
      {custom.length === 0 && (
        <p className="px-3 py-1.5 text-[11px] text-fg-4">
          사용자 정의 링크(소개자·선행 업무·근거 문서 …)는 <Link href={actHref(basePath, "link.create", { from: refKey(r) }, {})} className="link">링크 연결</Link>로 추가합니다.
        </p>
      )}

      <div className="label-caps border-y border-line-soft px-3 py-1.5">최근 이력</div>
      {history.length ? <RunTable runs={history} compact showObjects={false} /> : <p className="px-3 py-2 text-fg-3">없음</p>}
    </div>
  );
}

function RefLabel({ r, info }: { r: Ref; info?: { displayId: string; title: string } }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Icon name={OBJECT_ICON[r.type]} size={11} className="shrink-0 text-fg-4" />
      <span className="mono shrink-0 text-[11px] text-primary-fg">{info?.displayId ?? `${r.type}:${r.id}`}</span>
      <span className="truncate">{info?.title ?? "(삭제됨)"}</span>
    </span>
  );
}

export { ObjectLink };
