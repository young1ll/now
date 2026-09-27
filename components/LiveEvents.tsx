"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Ev = { id: number; type: string; created_at: string; actor_type: string | null; subject_type: string | null; subject_id: number | null; payload: Record<string, unknown> };

const TONE: Record<string, string> = {
  "action.applied": "text-success-fg",
  "action.pending": "text-warning-fg",
  "action.failed": "text-danger-fg",
  "action.denied": "text-danger-fg",
  "signal.raised": "text-warning-fg",
  "signal.escalated": "text-danger-fg",
  "signal.resolved": "text-success-fg",
};

/** SSE 로 받는 실시간 이벤트 피드 (콘솔 전용 스트림) */
export function LiveEvents({ initial, max = 60 }: { initial: Ev[]; max?: number }) {
  const [events, setEvents] = useState<Ev[]>(initial);
  const [live, setLive] = useState(false);
  useEffect(() => {
    const after = initial[0]?.id ?? 0;
    const es = new EventSource(`/api/console/events?after=${after}`);
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    const onAny = (m: MessageEvent) => {
      const e = JSON.parse(m.data) as Ev;
      setEvents((cur) => (cur.some((x) => x.id === e.id) ? cur : [e, ...cur].slice(0, max)));
    };
    for (const t of ["action.applied", "action.pending", "action.rejected", "action.failed", "action.denied", "action.cancelled", "signal.raised", "signal.resolved", "signal.escalated", "schedule.fired", "manual.fired"]) es.addEventListener(t, onAny);
    es.onmessage = onAny;
    return () => es.close();
  }, [initial, max]);
  return (
    <div>
      <div className={`flex items-center gap-1.5 border-b border-line px-3 py-1 text-[11px] ${live ? "text-success-fg" : "text-fg-4"}`}>
        <span className={`size-1.5 ${live ? "animate-pulse bg-success-fg" : "bg-fg-4"}`} /> {live ? "실시간 수신 중" : "연결 중…"}
      </div>
      <ol className="divide-y divide-line-soft">
        {events.map((e) => {
          const p = e.payload;
          const text = String(p.summary ?? p.title ?? p.trigger ?? p.error ?? "");
          return (
            <li key={e.id} className="px-3 py-1.5 text-[12px]">
              <div className="flex items-center gap-2">
                <span className="mono text-[10.5px] text-fg-4">#{e.id}</span>
                <span className={`mono text-[11px] ${TONE[e.type] ?? "text-fg-2"}`}>{e.type}</span>
                {e.actor_type === "agent" && <span className="text-[10.5px] text-ai-fg">AI</span>}
                <span className="mono ml-auto text-[10.5px] text-fg-4">{e.created_at.slice(11, 19)}</span>
              </div>
              {text && (
                <div className="truncate text-fg-2">
                  {typeof p.run_id === "number" ? <Link href={`/activity/${p.run_id}`} className="hover:underline">{text}</Link> : text}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
