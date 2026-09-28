import Link from "next/link";
import { ActionDrawer, actHref } from "@/components/ActionDrawer";
import { Column, Columns } from "@/components/Columns";
import { Icon } from "@/components/icons";
import { MemoryActions, MemoryKind, MemoryLink, MemoryOrigin, MemoryStatusTag } from "@/components/memory";
import { RunTable } from "@/components/runs";
import { Callout, Empty, ObjectLink, PageHeader, PropertyList, Tag, fmtTime, timeAgo } from "@/components/ui";
import { currentScope } from "@/lib/context";
import { db } from "@/lib/db";
import { recall } from "@/lib/knowledge/recall";
import { MEMORY_KIND, MEMORY_ORIGIN, MEMORY_STATUS, type Tone } from "@/lib/labels";
import { memoryActionsFor } from "@/lib/ontology/actions/memory";
import { nodeInfo } from "@/lib/ontology/graph";
import { displayId } from "@/lib/ontology/ids";
import { type Ref, refKey } from "@/lib/ontology/types";
import { type SearchParams, one } from "@/lib/params";
import {
  LIVE_STATUSES, MEMORY_KINDS, type MemoryRow, type MemoryStatus, creatorName, getMemory, lineage, listMemories, listMemoryUses, memoriesAbout, memoryLinks, memoryStats,
} from "@/lib/repos/memories";
import { listRuns } from "@/lib/repos/runs";

export const metadata = { title: "기억" };

const TABS: { key: string; label: string; statuses: MemoryStatus[] }[] = [
  { key: "review", label: "검토 대기", statuses: ["proposed", "active", "disputed"] },
  { key: "verified", label: "확인됨", statuses: ["verified"] },
  { key: "archive", label: "보관", statuses: ["superseded", "retired"] },
  { key: "all", label: "전체", statuses: ["proposed", "active", "verified", "disputed", "superseded", "retired"] },
];

/** 기억 — 열 기반: 목록 | 기억 상세 | 관련 (대상의 다른 기억 · 비슷한 기억 · 이 기억을 쓴 세션) */
export default async function MemoryPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const scope = await currentScope();
  const d = db();
  const tab = TABS.find((t) => t.key === one(sp.tab)) ?? TABS[0];
  const kindParam = one(sp.kind);
  const kind = (MEMORY_KINDS as readonly string[]).includes(kindParam ?? "") ? kindParam : undefined;
  const q = one(sp.q)?.trim() || undefined;
  const sel = Number(one(sp.sel)) || undefined;

  let rows: MemoryRow[];
  if (q) {
    // 검색은 회상(recall)으로 — 어휘 · 의미 · 관계, 상태 가중
    const r = await recall(d, { query: q, scope, types: ["memory"], k: 50, includeInactive: tab.key === "archive" || tab.key === "all" });
    rows = r.hits.map((h) => getMemory(d, h.ref.id)).filter((m): m is MemoryRow => !!m && tab.statuses.includes(m.status) && (!kind || m.kind === kind));
  } else {
    rows = listMemories(d, scope, { status: tab.statuses, kind });
  }
  const stats = memoryStats(d, scope);
  const count = (t: (typeof TABS)[number]) => t.statuses.reduce((s, x) => s + stats[x], 0);

  const path = "/memory";
  const query = Object.fromEntries(Object.entries({ tab: tab.key, kind, q, sel: sel ? String(sel) : undefined }).filter(([, v]) => v)) as Record<string, string>;
  const href = (patch: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...query, ...patch })) if (v) u.set(k, v);
    return `${path}?${u}`;
  };
  const here = href({});
  const act = one(sp.act);
  // 새 기억을 만드는 액션(기록 · 정정)은 끝나면 새 기억을 연다
  const next = act === "memory.record" || act === "memory.propose" || act === "memory.correct" ? "created" : here;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon="memory"
        eyebrow="온톨로지 · 기억"
        title="기억"
        meta="AI 가 제안하고 사람이 확인하는 사실·선호·교훈. 확인된 기억과 고정 기억은 AI 세션의 컨텍스트 팩에 들어간다 — 데이터이지 지시가 아니다."
        error={one(sp.error)}
        actions={
          <>
            <Link href={`/graph?types=memory,client,task,invoice,note`} className="btn"><Icon name="graph" size={12} /> 그래프</Link>
            <Link href={actHref(path, "memory.record", {}, { business_id: scope ?? undefined })} className="btn-primary"><Icon name="plus" size={12} /> 기억 기록</Link>
          </>
        }
      />
      <div className="flex border-b border-line bg-panel text-[12px]">
        {[
          ["검토 대기", stats.review, stats.review ? "text-warning-fg" : ""],
          ["충돌", stats.disputed, stats.disputed ? "text-danger-fg" : ""],
          ["확인됨", stats.verified, "text-success-fg"],
          ["고정", stats.pinned, ""],
          ["보관", stats.superseded + stats.retired, "text-fg-3"],
        ].map(([label, n, cls]) => (
          <div key={String(label)} className="border-r border-line px-4 py-1.5">
            <span className="label-caps mr-2">{label}</span>
            <span className={`mono font-semibold ${cls}`}>{n}</span>
          </div>
        ))}
      </div>
      <Columns storageKey="memory" defaults={[440, 0, 380]} grow={1}>
        <Column
          title={<>목록 <span className="mono bg-raised px-1.5 text-fg-2">{rows.length}</span></>}
          actions={
            <form action={path} className="flex gap-1">
              <input type="hidden" name="tab" value={tab.key} />
              {kind && <input type="hidden" name="kind" value={kind} />}
              <input name="q" defaultValue={q} placeholder="검색 (회상)" className="field h-6 min-h-0 w-36 py-0 text-[12px]" />
            </form>
          }
        >
          <div className="flex flex-wrap gap-1 border-b border-line-soft px-3 py-1.5">
            {TABS.map((t) => (
              <Link key={t.key} href={href({ tab: t.key, sel: undefined })} className={t.key === tab.key ? "btn-primary btn-sm" : "btn btn-sm"}>
                {t.label} <span className="mono">{count(t)}</span>
              </Link>
            ))}
          </div>
          <div className="flex flex-wrap gap-1 border-b border-line-soft px-3 py-1.5">
            <Link href={href({ kind: undefined })} className={!kind ? "btn-minimal btn-sm text-fg" : "btn-minimal btn-sm"}>모든 종류</Link>
            {MEMORY_KINDS.map((k) => (
              <Link key={k} href={href({ kind: k })} className={kind === k ? "btn btn-sm" : "btn-minimal btn-sm"}>{MEMORY_KIND[k]}</Link>
            ))}
          </div>
          {rows.length === 0 ? (
            <Empty icon="memory">
              {q ? "검색 결과가 없습니다." : tab.key === "review" ? "검토할 기억이 없습니다. 에이전트가 remember 로 제안하면 여기에 쌓입니다." : "기억이 없습니다."}
            </Empty>
          ) : (
            <ul className="divide-y divide-line-soft">
              {rows.map((m) => (
                <li key={m.id} className={m.id === sel ? "bg-primary/15" : "hover:bg-raised/60"}>
                  <Link href={href({ sel: String(m.id) })} className="block px-3 py-2">
                    <div className="line-clamp-2 text-[12.5px] leading-snug">{m.statement}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                      <MemoryStatusTag m={m} />
                      {!!m.pinned && <Tag tone="blue">고정</Tag>}
                      <MemoryKind kind={m.kind} />
                      <span className="text-fg-4">·</span>
                      <MemoryOrigin createdBy={m.created_by} name={creatorName(d, m.created_by)} />
                      <span className="mono ml-auto text-fg-3" title="사용 수 (컨텍스트 포함 · 인용)">{displayId("memory", m.id)} · {m.use_count}회</span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Column>
        <Column title={sel ? `기억 · ${displayId("memory", sel)}` : "기억"} actions={sel && <Link href={href({ sel: undefined })} className="btn-minimal btn-sm" aria-label="닫기"><Icon name="close" size={10} /></Link>}>
          {sel ? <MemoryDetail id={sel} path={path} query={query} here={here} /> : (
            <div className="p-3">
              <Empty icon="arrow">왼쪽 목록에서 기억을 선택하면 문장 · 근거 · 계보 · 충돌 · 감사 이력을 봅니다.</Empty>
              <Callout tone="ai" title="AI 와 사람이 함께 관리하는 기억">
                에이전트가 제안한 기억은 <b>제안됨</b>으로 들어오고, 사람이 확인하면 <b>확인됨</b>이 됩니다. 숫자·날짜가 서로 다른 기억은 <b>충돌</b>로 표시되어 해결을 기다립니다. 정정은 수정이 아니라 대체 — 이전 문장은 계보에 남습니다.
              </Callout>
            </div>
          )}
        </Column>
        <Column title="관련">{sel ? <MemoryRelated id={sel} scope={scope} /> : <Empty icon="graph">기억을 선택하면 대상의 다른 기억, 비슷한 기억, 이 기억을 쓴 AI 세션이 보입니다.</Empty>}</Column>
      </Columns>
      <ActionDrawer sp={sp} path={path} scope={scope} next={next} />
    </div>
  );
}

function RefList({ refs, empty }: { refs: Ref[]; empty: string }) {
  if (!refs.length) return <p className="text-[12px] text-fg-3">{empty}</p>;
  const info = nodeInfo(db(), refs);
  return (
    <ul className="flex flex-col gap-1">
      {refs.map((r) => {
        const n = info.get(refKey(r));
        return (
          <li key={refKey(r)} className="min-w-0">
            {r.type === "memory" ? (
              <MemoryLink id={r.id} statement={n?.title} />
            ) : n ? (
              <ObjectLink type={r.type} id={r.id} title={n.title} />
            ) : (
              <span className="text-[12px] text-fg-4"><span className="mono">{displayId(r.type, r.id)}</span> (대상 없음 — 삭제됨)</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

const Section = ({ title, children, count }: { title: string; children: React.ReactNode; count?: number }) => (
  <>
    <div className="label-caps flex items-center gap-2 border-y border-line-soft px-3 py-1.5">
      {title}
      {count !== undefined && <span className="mono bg-raised px-1.5 text-[10.5px] text-fg-2">{count}</span>}
    </div>
    <div className="px-3 py-2">{children}</div>
  </>
);

function MemoryDetail({ id, path, query, here }: { id: number; path: string; query: Record<string, string>; here: string }) {
  const d = db();
  const m = getMemory(d, id);
  if (!m) return <p className="p-3 text-fg-3">기억을 찾을 수 없습니다.</p>;
  const l = memoryLinks(d, id);
  const chain = lineage(d, id);
  const others = l.contradicts.map((x) => getMemory(d, x)).filter((x): x is MemoryRow => !!x);
  const liveOthers = others.filter((o) => LIVE_STATUSES.includes(o.status)).map((o) => o.id);
  const runs = listRuns(d, { object: { type: "memory", id }, limit: 30 });
  return (
    <div className="flex flex-col">
      <div className="border-b border-line px-3 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mono text-[11px] text-fg-3">{displayId("memory", id)}</span>
          <MemoryStatusTag m={m} />
          {!!m.pinned && <Tag tone="blue">고정</Tag>}
          <Tag tone="none">{MEMORY_KIND[m.kind]}</Tag>
        </div>
        <p className="mt-2 text-[16px] leading-snug font-semibold">{m.statement}</p>
        {m.retired_reason && <p className="mt-1 text-[12px] text-fg-3">{m.retired_reason}</p>}
        <div className="mt-3">
          <MemoryActions m={m} actions={memoryActionsFor(m.status, !!m.pinned)} path={path} query={query} next={here} contradicts={liveOthers} />
        </div>
      </div>
      <div className="px-3">
        <PropertyList
          items={[
            { label: "식별자", value: displayId("memory", id), mono: true },
            { label: "상태", value: MEMORY_STATUS[m.status].label },
            { label: "종류", value: MEMORY_KIND[m.kind] },
            { label: "사업", value: m.business_name ?? "전역" },
            { label: "신뢰도", value: m.confidence.toFixed(2), mono: true },
            { label: "출처", value: <span className="inline-flex items-center gap-1.5">{MEMORY_ORIGIN[m.origin]} · <MemoryOrigin createdBy={m.created_by} name={creatorName(d, m.created_by)} /></span> },
            { label: "생성", value: fmtTime(m.created_at), mono: true },
            // verified_by 는 "human:operator 운영자" (감사용 행위자 키 + 이름) — 화면에는 이름만
            { label: "확인", value: m.verified_at ? `${(m.verified_by ?? "").replace(/^[a-z]+:\S+\s*/, "") || m.verified_by || "—"} · ${fmtTime(m.verified_at)}` : "—" },
            { label: "유효기간", value: m.valid_from || m.valid_to ? `${m.valid_from ?? ""} ~ ${m.valid_to ?? ""}` : "—", mono: true },
            { label: "사용", value: `${m.use_count}회${m.last_used_at ? ` · 최근 ${timeAgo(m.last_used_at)}` : ""}`, mono: true },
            { label: "외부 출처", value: m.tainted ? <span className="text-warning-fg">예 — 비신뢰 입력에서 유래</span> : "아니오" },
          ]}
        />
      </div>
      <Section title="대상" count={l.about.length}><RefList refs={l.about} empty="대상 없음 — 전역 기억이거나 대상 객체가 삭제됨" /></Section>
      <Section title="근거" count={l.evidence.length}><RefList refs={l.evidence} empty="근거 없음" /></Section>
      {l.promotedTo && <Section title="승격됨"><RefList refs={[l.promotedTo]} empty="" /></Section>}
      {others.length > 0 && (
        <Section title="충돌 상대" count={others.length}>
          <ul className="flex flex-col gap-2">
            {others.map((o) => (
              <li key={o.id} className="border-l-2 border-danger pl-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <MemoryLink id={o.id} href={`${path}?${new URLSearchParams({ ...query, sel: String(o.id) })}`} />
                  <MemoryStatusTag m={o} />
                </div>
                <p className="mt-0.5 text-[12.5px]">{o.statement}</p>
                {LIVE_STATUSES.includes(o.status) && LIVE_STATUSES.includes(m.status) && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {(["this", "other", "both"] as const).map((k) => (
                      <Link key={k} href={`${path}?${new URLSearchParams({ ...query, act: "memory.resolve", "p.id": String(id), "d.other_id": String(o.id), "d.keep": k })}`} className="btn btn-sm">
                        {k === "this" ? "이 기억 유지" : k === "other" ? "상대 유지" : "둘 다 맞음"}
                      </Link>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {chain.length > 1 && (
        <Section title="정정 계보" count={chain.length}>
          <ol className="relative ml-1 border-l border-line">
            {chain.map((c) => (
              <li key={c.id} className="relative mb-2 pl-3">
                <span className={`absolute top-1.5 -left-[4px] size-[7px] ${c.id === id ? "bg-primary" : "bg-line-strong"}`} />
                <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  <MemoryLink id={c.id} href={`${path}?${new URLSearchParams({ ...query, sel: String(c.id) })}`} />
                  <MemoryStatusTag m={c} />
                  <span className="mono text-fg-4">{fmtTime(c.created_at)}</span>
                </div>
                <p className={`mt-0.5 text-[12.5px] ${c.id === id ? "text-fg" : "text-fg-3"}`}>{c.statement}</p>
              </li>
            ))}
          </ol>
        </Section>
      )}
      <div className="label-caps border-y border-line-soft px-3 py-1.5">감사 이력 · {runs.length}</div>
      {runs.length ? <RunTable runs={runs} compact showObjects={false} /> : <p className="px-3 py-2 text-fg-3">없음</p>}
    </div>
  );
}

async function MemoryRelated({ id, scope }: { id: number; scope: number | null }) {
  const d = db();
  const m = getMemory(d, id);
  if (!m) return null;
  const l = memoryLinks(d, id);
  const info = nodeInfo(d, l.about);
  const siblings = l.about.map((r) => ({ r, ms: memoriesAbout(d, r, LIVE_STATUSES).filter((x) => x.id !== id) }));
  const similar = (await recall(d, { query: m.statement, scope, types: ["memory"], k: 8 })).hits.filter((h) => h.ref.id !== id).slice(0, 6);
  const uses = listMemoryUses(d, { memoryId: id, limit: 30 });
  return (
    <div className="flex flex-col">
      <Section title="대상의 다른 기억">
        {siblings.length === 0 ? <p className="text-[12px] text-fg-3">대상이 없는 전역 기억입니다.</p> : (
          <div className="flex flex-col gap-3">
            {siblings.map(({ r, ms }) => (
              <div key={refKey(r)}>
                <div className="mb-1"><ObjectLink type={r.type} id={r.id} title={info.get(refKey(r))?.title} /></div>
                {ms.length === 0 ? <p className="text-[12px] text-fg-4">다른 기억 없음</p> : (
                  <ul className="flex flex-col gap-1">
                    {ms.map((x) => (
                      <li key={x.id} className="flex min-w-0 items-center gap-1.5 text-[12px]">
                        <MemoryStatusTag m={x} />
                        <MemoryLink id={x.id} statement={x.statement} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>
      <Section title="비슷한 기억" count={similar.length}>
        {similar.length === 0 ? <p className="text-[12px] text-fg-3">없음</p> : (
          <ul className="flex flex-col gap-1">
            {similar.map((h) => (
              <li key={h.key} className="flex min-w-0 items-center gap-1.5 text-[12px]">
                {h.status && <Tag tone={h.status.tone as Tone}>{h.status.label}</Tag>}
                <MemoryLink id={h.ref.id} statement={h.title} />
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="이 기억을 쓴 세션" count={uses.length}>
        {uses.length === 0 ? <p className="text-[12px] text-fg-3">아직 AI 가 쓰지 않았습니다.</p> : (
          <table className="grid-table">
            <tbody>
              {uses.map((u) => (
                <tr key={u.id}>
                  <td className="mono text-fg-3" title={fmtTime(u.used_at)}>{timeAgo(u.used_at)}</td>
                  <td>{u.session_id ? <Link href={`/ai/sessions/${u.session_id}`} className="link mono">세션 #{u.session_id}</Link> : <span className="mono text-fg-3">{u.actor}</span>}</td>
                  <td><Tag tone={u.how === "cited" ? "ai" : "none"}>{u.how === "cited" ? "인용" : "컨텍스트"}</Tag></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}
