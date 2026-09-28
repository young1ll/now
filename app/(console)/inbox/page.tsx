import Link from "next/link";
import { AutoRefresh } from "@/components/client";
import { Icon } from "@/components/icons";
import { ApprovalCard, RunTable } from "@/components/runs";
import { Callout, Empty, PageHeader, Panel } from "@/components/ui";
import { db } from "@/lib/db";
import { AI_MODE_LABEL } from "@/lib/ontology/actions/system";
import { type SearchParams, one } from "@/lib/params";
import { listRuns } from "@/lib/repos/runs";
import { getAiMode } from "@/lib/repos/settings";
import { memoryStats } from "@/lib/repos/memories";

export const metadata = { title: "승인함" };

export default async function InboxPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const pending = listRuns(db(), { status: "pending", limit: 200 }).reverse(); // 오래된 요청부터
  const decided = listRuns(db(), { limit: 200 }).filter((r) => r.decided_by && r.status !== "pending").slice(0, 30);
  const mem = memoryStats(db(), null);
  return (
    <>
      <AutoRefresh seconds={10} />
      <PageHeader
        icon="inbox"
        eyebrow="개입"
        title="승인함"
        meta={`AI 운영 모드: ${AI_MODE_LABEL[getAiMode(db())]} · 승인하면 그 시점의 데이터로 다시 검증한 뒤 실행됩니다.`}
        live
        error={one(sp.error)}
      />
      <div className="grid gap-px bg-void p-px xl:grid-cols-12">
        <div className="xl:col-span-7">
          <Panel title="결정 대기" count={pending.length} className="h-full">
            {pending.length === 0 ? (
              <Empty>결정할 요청이 없습니다. 에이전트의 고위험 요청이 여기에 쌓입니다.</Empty>
            ) : (
              <div className="flex flex-col gap-3">{pending.map((r) => <ApprovalCard key={r.id} run={r} />)}</div>
            )}
          </Panel>
        </div>
        <div className="flex flex-col gap-px xl:col-span-5">
          <Panel title="기억 검토" count={mem.review} action={<Link href="/memory?tab=review" className="btn-minimal btn-sm">열기 <Icon name="arrow" size={10} /></Link>}>
            {mem.review === 0 ? (
              <p className="text-[12.5px] text-fg-3">검토할 기억이 없습니다.</p>
            ) : (
              <Link href="/memory?tab=review" className="flex items-center justify-between gap-2 border border-warning/50 bg-warning/10 px-3 py-2 text-[12.5px] text-warning-fg hover:bg-warning/20">
                <span>AI 가 제안한 기억 {mem.proposed + mem.active}건{mem.disputed ? ` · 충돌 ${mem.disputed}건` : ""} — 확인·거절·충돌 해결</span>
                <Icon name="arrow" size={12} />
              </Link>
            )}
          </Panel>
          <Panel title="안내">
            <Callout tone="ai" title="에이전트는 요청하고, 사람은 결정합니다">
              외부로 나가는 행동(청구서 발행), 삭제, 금액 기록은 가드 모드에서 승인이 필요합니다. 거절 메모는 에이전트가 get_run 으로 읽을 수 있습니다.
            </Callout>
          </Panel>
          <Panel title="최근 결정" count={decided.length} flush className="flex-1">
            {decided.length === 0 ? <Empty>결정 이력이 없습니다.</Empty> : <RunTable runs={decided} compact />}
          </Panel>
        </div>
      </div>
    </>
  );
}
