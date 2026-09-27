import Link from "next/link";
import { ActionDrawer, actHref } from "@/components/ActionDrawer";
import { Column, Columns } from "@/components/Columns";
import { GraphCanvas } from "@/components/GraphCanvas";
import { TYPE_COLOR, TYPE_LABEL } from "@/lib/ontology/palette";
import { Icon } from "@/components/icons";
import { ObjectPreview } from "@/components/ObjectPreview";
import { Callout, Empty, PageHeader } from "@/components/ui";
import { currentScope } from "@/lib/context";
import { db } from "@/lib/db";
import { type Graph, neighborhood, nodeInfo, objectExists, overview, parseRef, shortestPath } from "@/lib/ontology/graph";
import { OBJECT_TYPES, type ObjectType, refKey } from "@/lib/ontology/types";
import { type SearchParams, one } from "@/lib/params";

export const metadata = { title: "그래프" };

export default async function GraphPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const scope = await currentScope();
  // 폼 제출은 t=a&t=b, 링크는 types=a,b
  const typesParam = Array.isArray(sp.t) ? sp.t.join(",") : (sp.t ?? one(sp.types));
  const types = (typesParam ? typesParam.split(",") : OBJECT_TYPES.filter((t) => t !== "expense")).filter((t): t is ObjectType => (OBJECT_TYPES as readonly string[]).includes(t));
  const focus = one(sp.focus) ? parseRef(one(sp.focus)!) : undefined;
  const depth = Math.min(4, Math.max(1, Number(one(sp.depth)) || 2));
  const from = one(sp.from) ? parseRef(one(sp.from)!) : undefined;
  const to = one(sp.to) ? parseRef(one(sp.to)!) : undefined;
  const sel = one(sp.sel) ? parseRef(one(sp.sel)!) : undefined;
  const derived = sp.t !== undefined ? sp.derived === "1" : one(sp.derived) !== "0";

  let g: Graph;
  let mode: string;
  let pathMissing = false;
  if (from && to && objectExists(db(), from) && objectExists(db(), to)) {
    const p = shortestPath(db(), from, to);
    pathMissing = !p;
    g = p ?? { nodes: [...nodeInfo(db(), [from, to]).values()], edges: [], truncated: false };
    mode = "경로";
  } else if (focus && objectExists(db(), focus)) {
    g = neighborhood(db(), focus, { depth, limit: 250, includeDerived: derived });
    mode = `이웃 ${depth}단계`;
  } else {
    g = overview(db(), scope, { types, limit: 400, includeDerived: derived });
    mode = "전체";
  }

  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && !["act", "error"].includes(k) && !k.startsWith("p.") && !k.startsWith("d.")) query[k] = v;
  const href = (patch: Record<string, string | undefined>) => {
    const u = new URLSearchParams(query);
    for (const [k, v] of Object.entries(patch)) (v === undefined ? u.delete(k) : u.set(k, v));
    return `/graph?${u}`;
  };
  const refOptions = g.nodes.map((n) => ({ value: n.key, label: `${n.displayId} · ${n.title}` }));
  const bySource = { intrinsic: 0, derived: 0, custom: 0 };
  for (const e of g.edges) bySource[e.source]++;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon="graph"
        eyebrow="온톨로지"
        title="그래프"
        meta={`${mode} · 노드 ${g.nodes.length} · 관계 ${g.edges.length}${g.truncated ? " (상한으로 일부 생략)" : ""} — 노드를 누르면 오른쪽에 상세가 열립니다.`}
        error={one(sp.error)}
        actions={
          <>
            <Link href="/ontology" className="btn"><Icon name="schema" size={12} /> 스키마</Link>
            <Link href={actHref("/graph", "link.create", {}, sel ? { from: refKey(sel) } : {})} className="btn-primary"><Icon name="plus" size={12} /> 링크 연결</Link>
          </>
        }
      />
      <Columns storageKey="graph" defaults={[250, 0, 400]} grow={1}>
        <Column title="탐색">
          <div className="space-y-4 p-3 text-[12.5px]">
            <form action="/graph" className="space-y-2">
              <div className="label-caps">객체 유형</div>
              {OBJECT_TYPES.map((t) => (
                <label key={t} className="flex items-center gap-2">
                  <input type="checkbox" name="t" value={t} defaultChecked={types.includes(t)} className="accent-primary" />
                  <span className="size-2.5" style={{ background: TYPE_COLOR[t] }} />
                  {TYPE_LABEL[t]}
                </label>
              ))}
              <label className="flex items-center gap-2 text-fg-2">
                <input type="checkbox" name="derived" value="1" defaultChecked={derived} className="accent-primary" /> 에이전트 변경 관계 표시
              </label>
              <TypesSubmit />
            </form>

            <div className="space-y-2 border-t border-line pt-3">
              <div className="label-caps">중심 객체</div>
              {focus ? (
                <div className="flex items-center justify-between gap-2">
                  <span className="mono text-primary-fg">{nodeInfo(db(), [focus]).get(refKey(focus))?.displayId}</span>
                  <Link href={href({ focus: undefined })} className="btn btn-sm">전체 보기</Link>
                </div>
              ) : (
                <p className="text-fg-3">노드를 선택한 뒤 “이 객체 중심” 을 누르세요.</p>
              )}
              <div className="flex gap-1">
                {[1, 2, 3].map((d) => (
                  <Link key={d} href={href({ depth: String(d) })} className={depth === d ? "btn-primary btn-sm" : "btn btn-sm"}>{d}단계</Link>
                ))}
              </div>
            </div>

            <form action="/graph" className="space-y-2 border-t border-line pt-3">
              <div className="label-caps">관계 경로 찾기</div>
              <select name="from" defaultValue={from ? refKey(from) : sel ? refKey(sel) : ""} className="field">
                <option value="">출발 …</option>
                {refOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <select name="to" defaultValue={to ? refKey(to) : ""} className="field">
                <option value="">도착 …</option>
                {refOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <div className="flex gap-1">
                <button className="btn btn-sm">경로 찾기</button>
                {from && <Link href="/graph" className="btn-minimal btn-sm">해제</Link>}
              </div>
              {pathMissing && <Callout tone="amber">6단계 안에 연결 경로가 없습니다.</Callout>}
            </form>

            <div className="space-y-1 border-t border-line pt-3 text-fg-2">
              <div className="label-caps">관계 출처</div>
              <div className="flex justify-between"><span>외래키 (구조)</span><span className="mono">{bySource.intrinsic}</span></div>
              <div className="flex justify-between"><span className="text-primary-fg">사용자 링크</span><span className="mono">{bySource.custom}</span></div>
              <div className="flex justify-between"><span className="text-ai-fg">에이전트 변경</span><span className="mono">{bySource.derived}</span></div>
            </div>
          </div>
        </Column>
        <Column title={`그래프 · ${mode}`}>
          {g.nodes.length === 0 ? (
            <Empty icon="graph">표시할 객체가 없습니다.</Empty>
          ) : (
            <GraphCanvas
              nodes={g.nodes.map((n) => ({ key: n.key, type: n.type, displayId: n.displayId, title: n.title, status: n.status?.label }))}
              edges={g.edges.map((e) => ({ key: e.key, from: e.from, to: e.to, label: e.label, source: e.source }))}
              selected={sel ? refKey(sel) : undefined}
              focus={focus ? refKey(focus) : undefined}
            />
          )}
        </Column>
        <Column
          title="선택한 객체"
          actions={sel && (
            <>
              <Link href={href({ focus: refKey(sel), from: undefined, to: undefined })} className="btn btn-sm">이 객체 중심</Link>
              <Link href={href({ sel: undefined })} className="btn-minimal btn-sm" aria-label="닫기"><Icon name="close" size={10} /></Link>
            </>
          )}
        >
          {sel && objectExists(db(), sel) ? <ObjectPreview r={sel} basePath="/graph" query={query} openParam="sel" /> : <Empty icon="graph">그래프에서 노드를 선택하세요.</Empty>}
        </Column>
      </Columns>
      <ActionDrawer sp={sp} path="/graph" scope={scope} next={`/graph?${new URLSearchParams(query)}`} />
    </div>
  );
}

/** 체크박스 → types=a,b 로 합쳐 제출 (JS 없이도 t= 반복으로 동작하도록 서버에서도 처리) */
function TypesSubmit() {
  return <button className="btn btn-sm">적용</button>;
}
