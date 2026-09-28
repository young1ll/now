import Link from "next/link";
import { runActionForm } from "@/app/actions/console";
import { ActionDrawer, actHref } from "@/components/ActionDrawer";
import { TRUN_STATUS, TriggerRunTable } from "@/components/automation";
import { AutoRefresh } from "@/components/client";
import { Icon } from "@/components/icons";
import { Callout, Empty, PageHeader, Panel, Tag, timeAgo } from "@/components/ui";
import { currentScope } from "@/lib/context";
import { db } from "@/lib/db";
import { workerStatus } from "@/lib/events/worker";
import { type SearchParams, one } from "@/lib/params";
import { listTriggerRuns, listTriggers } from "@/lib/repos/triggers";

export const metadata = { title: "트리거" };

export default async function AutomationsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const scope = await currentScope();
  const triggers = listTriggers(db());
  const runs = listTriggerRuns(db(), { limit: 40 });
  const w = workerStatus();
  return (
    <>
      <AutoRefresh seconds={10} />
      <PageHeader
        icon="trigger"
        eyebrow="자동화"
        title="트리거"
        meta="이벤트(신호 발생·승인 요청·액션 적용 …)나 스케줄에 반응해 AI 에이전트를 깨우거나 웹훅을 호출합니다."
        live
        error={one(sp.error)}
        actions={<Link href={actHref("/automations", "trigger.create", {}, { kind: "event", target: "agent", event_pattern: "signal.raised", enabled: "true" })} className="btn-primary"><Icon name="plus" size={12} /> 트리거</Link>}
      />
      {!w.running && (
        <div className="border-b border-warning/50 bg-warning/10 px-5 py-2 text-[12.5px] text-warning-fg">
          이 프로세스에서 워커가 돌고 있지 않습니다 (NOW_WORKER=off). 별도로 <code className="mono">npm run worker</code> 를 실행하세요.
        </div>
      )}
      <div className="grid grid-cols-1 gap-px bg-void p-px xl:grid-cols-12">
        <div className="flex flex-col gap-px xl:col-span-7">
          <Panel title="트리거" count={triggers.length} flush>
            {triggers.length === 0 ? (
              <Empty icon="trigger">트리거가 없습니다. 예: “심각 신호가 뜨면 운영 AI 를 깨운다”, “평일 08:00 아침 브리핑”.</Empty>
            ) : (
              <table className="grid-table">
                <thead><tr><th>트리거</th><th>조건</th><th>대상</th><th className="text-right">24h</th><th>최근</th><th /></tr></thead>
                <tbody>
                  {triggers.map((t) => (
                    <tr key={t.id} className={t.enabled ? "" : "opacity-50"}>
                      <td><Link href={`/automations/${t.id}`} className="font-medium hover:underline">{t.name}</Link>{!t.enabled && <Tag tone="zinc">꺼짐</Tag>}</td>
                      <td className="mono text-[11.5px] text-fg-2">{t.kind === "event" ? t.event_pattern : `⏱ ${t.schedule}`}{t.filter !== "{}" && <span className="text-fg-4"> +필터</span>}</td>
                      <td className="text-[12px]">{t.target === "agent" ? <span className="text-ai-fg">AI · {t.profile_name ?? "(없음)"}</span> : <span className="text-fg-2">웹훅</span>}</td>
                      <td className="num">{t.runs_24h}{t.failed_24h ? <span className="text-danger-fg"> ({t.failed_24h})</span> : ""}</td>
                      <td>{t.last_status ? <Tag tone={TRUN_STATUS[t.last_status].tone}>{TRUN_STATUS[t.last_status].label}</Tag> : <span className="text-fg-4">—</span>} <span className="mono text-[11px] text-fg-4">{timeAgo(t.last_fired_at)}</span></td>
                      <td className="text-right">
                        <form action={runActionForm} className="inline">
                          <input type="hidden" name="__action" value="trigger.fire" />
                          <input type="hidden" name="id" value={t.id} />
                          <button className="btn btn-sm" title="지금 한 번 실행"><Icon name="play" size={10} /></button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
          <Panel title="최근 실행" count={runs.length} flush>
            {runs.length === 0 ? <Empty icon="event">실행 기록이 없습니다.</Empty> : <TriggerRunTable runs={runs} />}
          </Panel>
        </div>
        <div className="flex flex-col gap-px xl:col-span-5">
          <Panel title="워커">
            <div className="grid grid-cols-2 gap-y-1 text-[12.5px]">
              <span className="text-fg-3">상태</span><span>{w.running ? <Tag tone="green">실행 중</Tag> : <Tag tone="amber">꺼짐</Tag>}</span>
              {w.running && <><span className="text-fg-3">마지막 틱</span><span className="mono">{timeAgo(w.lastTick ?? null)}</span></>}
              {w.running && w.lastError && <><span className="text-fg-3">오류</span><span className="text-danger-fg">{w.lastError}</span></>}
            </div>
          </Panel>
          <Panel title="이벤트 유형">
            <table className="grid-table">
              <tbody>
                {[
                  ["signal.raised", "신호 발생 (지연·미수·무응대·백업·드리프트)"],
                  ["signal.escalated", "신호가 심각으로 격상"],
                  ["signal.resolved", "신호 해소"],
                  ["action.pending", "에이전트가 승인 요청"],
                  ["action.applied", "액션 적용 (사람·AI)"],
                  ["action.rejected · failed · denied", "거절 · 실패 · 정책 거부"],
                  ["schedule.fired · manual.fired", "스케줄 · 수동 실행"],
                ].map(([t, d]) => (
                  <tr key={t}><td className="mono text-[11.5px] text-primary-fg">{t}</td><td className="text-fg-2">{d}</td></tr>
                ))}
              </tbody>
            </table>
          </Panel>
          <Panel title="필터 예시">
            <div className="space-y-2">
              <Callout tone="blue">
                <code className="mono text-[11.5px]">{`{"payload.severity": "critical"}`}</code> — 심각 신호만<br />
                <code className="mono text-[11.5px]">{`{"payload.kind": ["invoice.overdue", "client.lead_idle"]}`}</code> — 미수·무응대 리드<br />
                <code className="mono text-[11.5px]">{`{"payload.action": "invoice.issue", "actor_type": "agent"}`}</code> — AI 의 발행 요청
              </Callout>
              <p className="text-[11.5px] text-fg-3">루프 방지: AI 트리거는 자기 에이전트가 만든 이벤트에 반응하지 않고, 트리거당 시간당 30회로 제한됩니다. 웹훅은 실패 시 최대 3회 재시도하며 <code className="mono">X-Now-Signature</code> 로 서명됩니다.</p>
            </div>
          </Panel>
        </div>
      </div>
      <ActionDrawer sp={sp} path="/automations" scope={scope} next="/automations" />
    </>
  );
}
