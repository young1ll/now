import { TriggerRunTable } from "@/components/automation";
import { LiveEvents } from "@/components/LiveEvents";
import { Empty, PageHeader, Panel } from "@/components/ui";
import { db } from "@/lib/db";
import { listEvents } from "@/lib/repos/events";
import { listTriggerRuns } from "@/lib/repos/triggers";

export const metadata = { title: "이벤트" };

export default function EventsPage() {
  const events = listEvents(db(), { limit: 60 });
  const counts = db()
    .prepare("SELECT type, COUNT(*) AS n FROM events WHERE created_at >= ? GROUP BY type ORDER BY n DESC")
    .all(new Date(Date.now() - 86_400_000).toISOString()) as { type: string; n: number }[];
  const signals = db().prepare("SELECT * FROM signal_state ORDER BY first_seen DESC").all() as { key: string; kind: string; severity: string; title: string; first_seen: string }[];
  const runs = listTriggerRuns(db(), { limit: 20 });
  return (
    <>
      <PageHeader icon="event" eyebrow="자동화" title="이벤트" meta="모든 변화가 흐르는 이벤트 버스. 에이전트는 list_events · SSE(/api/v1/events/stream) · now events --follow 로 구독합니다." live />
      <div className="grid gap-px bg-void p-px xl:grid-cols-12">
        <div className="xl:col-span-6">
          <Panel title="실시간 이벤트" flush className="h-full">
            <LiveEvents initial={events} />
          </Panel>
        </div>
        <div className="flex flex-col gap-px xl:col-span-6">
          <Panel title="24시간 이벤트" count={counts.reduce((s, c) => s + c.n, 0)} flush>
            {counts.length === 0 ? <Empty icon="event">없음</Empty> : (
              <table className="grid-table">
                <tbody>{counts.map((c) => <tr key={c.type}><td className="mono text-[12px]">{c.type}</td><td className="num">{c.n}</td></tr>)}</tbody>
              </table>
            )}
          </Panel>
          <Panel title="현재 열린 신호 (워커 추적)" count={signals.length} flush>
            {signals.length === 0 ? <Empty>없음 — 워커가 아직 돌지 않았거나 모든 신호가 해소됨</Empty> : (
              <table className="grid-table">
                <tbody>{signals.map((s) => <tr key={s.key}><td className="mono text-[11px] text-fg-3">{s.severity}</td><td>{s.title}</td><td className="mono text-right text-[11px] text-fg-4">{s.first_seen.slice(0, 16).replace("T", " ")}</td></tr>)}</tbody>
              </table>
            )}
          </Panel>
          <Panel title="최근 트리거 실행" count={runs.length} flush>
            {runs.length === 0 ? <Empty icon="trigger">없음</Empty> : <TriggerRunTable runs={runs} />}
          </Panel>
        </div>
      </div>
    </>
  );
}
