import Link from "next/link";
import { Tag, fmtTime, timeAgo } from "@/components/ui";
import type { Tone } from "@/lib/labels";

export const TRUN_STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: "대기", tone: "slate" },
  running: { label: "실행 중", tone: "blue" },
  succeeded: { label: "성공", tone: "green" },
  failed: { label: "실패", tone: "red" },
  skipped: { label: "건너뜀", tone: "zinc" },
};

export const SESSION_STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: "대기", tone: "slate" },
  running: { label: "실행 중", tone: "blue" },
  succeeded: { label: "완료", tone: "green" },
  failed: { label: "실패", tone: "red" },
};

type RunRow = { id: number; trigger_id: number; trigger_name: string; target: string; event_type: string | null; status: string; attempts: number; session_id: number | null; output: string; error: string | null; created_at: string; finished_at: string | null };

export function TriggerRunTable({ runs, showTrigger = true }: { runs: RunRow[]; showTrigger?: boolean }) {
  return (
    <table className="grid-table">
      <thead>
        <tr>
          <th className="w-[92px]">시각</th>
          {showTrigger && <th>트리거</th>}
          <th>이벤트</th>
          <th>결과</th>
          <th className="w-[80px]">상태</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => {
          const st = TRUN_STATUS[r.status];
          return (
            <tr key={r.id}>
              <td className="mono text-fg-3" title={fmtTime(r.created_at)}>{timeAgo(r.created_at)}</td>
              {showTrigger && <td><Link href={`/automations/${r.trigger_id}`} className="hover:underline">{r.trigger_name}</Link> <span className="text-[11px] text-fg-4">{r.target === "agent" ? "AI" : "웹훅"}</span></td>}
              <td className="mono text-[11.5px] text-fg-2">{r.event_type ?? "—"}</td>
              <td className="max-w-[340px]">
                {r.session_id && <Link href={`/ai/sessions/${r.session_id}`} className="link mr-2 text-[11.5px]">세션 #{r.session_id}</Link>}
                <span className={`text-[12px] ${r.error ? "text-danger-fg" : "text-fg-2"}`}>{(r.error ?? r.output).split("\n")[0].slice(0, 140)}</span>
                {r.attempts > 1 && <span className="ml-1 text-[11px] text-fg-4">시도 {r.attempts}</span>}
              </td>
              <td><Tag tone={st.tone}>{st.label}</Tag></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
