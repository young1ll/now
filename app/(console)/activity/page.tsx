import Link from "next/link";
import { AutoRefresh } from "@/components/client";
import { RunTable } from "@/components/runs";
import { Empty, PageHeader, Panel, RUN_STATUS } from "@/components/ui";
import { db } from "@/lib/db";
import { ACTION_LIST } from "@/lib/ontology/actions";
import type { RunStatus } from "@/lib/ontology/types";
import { type SearchParams, one } from "@/lib/params";
import { listAgents } from "@/lib/repos/agents";
import { type RunFilter, listRuns, runStats } from "@/lib/repos/runs";

export const metadata = { title: "활동 로그" };

export default async function ActivityPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const actor = one(sp.actor) ?? "";
  const status = one(sp.status) as RunStatus | undefined;
  const action = one(sp.action) || undefined;
  const before = Number(one(sp.before)) || undefined;
  const f: RunFilter = { status: status && RUN_STATUS[status] ? status : undefined, action, beforeId: before, limit: 100 };
  if (actor === "human" || actor === "system") f.actorType = actor;
  else if (actor.startsWith("agent:")) Object.assign(f, { actorType: "agent", actorId: actor.slice(6) });
  else if (actor === "agent") f.actorType = "agent";
  const runs = listRuns(db(), f);
  const stats = runStats(db(), new Date(Date.now() - 7 * 86_400_000).toISOString());
  const agents = listAgents(db(), new Date().toISOString());
  const q = (patch: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    const cur = { actor, status: status ?? "", action: action ?? "", ...patch };
    for (const [k, v] of Object.entries(cur)) if (v) u.set(k, v);
    return `/activity${u.size ? `?${u}` : ""}`;
  };

  return (
    <>
      <AutoRefresh seconds={15} />
      <PageHeader
        icon="activity"
        eyebrow="감사"
        title="활동 로그"
        meta={`모든 변경은 액션 실행으로 기록됩니다 · 7일: 적용 ${stats.applied} · 대기 ${stats.pending} · 실패 ${stats.failed} · 거부 ${stats.denied} · 거절 ${stats.rejected}`}
        live
      />
      <form action="/activity" className="flex flex-wrap items-end gap-2 border-b border-line bg-panel px-5 py-2.5">
        <label>
          <span className="label-caps mb-1 block">행위자</span>
          <select name="actor" defaultValue={actor} className="field w-48">
            <option value="">전체</option>
            <option value="agent">모든 에이전트</option>
            {agents.map((a) => <option key={a.id} value={`agent:${a.id}`}>에이전트 · {a.name}</option>)}
            <option value="human">사람</option>
            <option value="system">시스템</option>
          </select>
        </label>
        <label>
          <span className="label-caps mb-1 block">상태</span>
          <select name="status" defaultValue={status ?? ""} className="field w-32">
            <option value="">전체</option>
            {Object.entries(RUN_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>
        <label>
          <span className="label-caps mb-1 block">액션</span>
          <select name="action" defaultValue={action ?? ""} className="field w-56">
            <option value="">전체</option>
            {ACTION_LIST.map((a) => <option key={a.name} value={a.name}>{a.title} · {a.name}</option>)}
          </select>
        </label>
        <button className="btn-primary">적용</button>
        {(actor || status || action) && <Link href="/activity" className="btn-minimal">초기화</Link>}
      </form>
      <div className="p-px">
        <Panel title="실행 기록" count={runs.length} flush>
          {runs.length === 0 ? <Empty icon="activity">조건에 맞는 기록이 없습니다.</Empty> : <RunTable runs={runs} />}
        </Panel>
        {runs.length === 100 && (
          <div className="p-3 text-center">
            <Link href={q({ before: String(runs[runs.length - 1].id) })} className="btn">이전 기록 더 보기</Link>
          </div>
        )}
      </div>
    </>
  );
}
