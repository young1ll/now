import Link from "next/link";
import { decideRun } from "@/app/actions/console";
import { Icon } from "@/components/icons";
import { Actor, ObjectLink, RUN_STATUS, Tag, fmtTime, timeAgo } from "@/components/ui";
import { db } from "@/lib/db";
import { getAction, isStale } from "@/lib/ontology/execute";
import type { FieldSpec } from "@/lib/ontology/fields";
import { displayId, runId } from "@/lib/ontology/ids";
import { approvalHistory } from "@/lib/ontology/trust";
import { type RunView, grantIdOf } from "@/lib/repos/runs";

const EXTRA_TITLES: Record<string, string> = { "iac.record_snapshot": "IaC 감사 기록" };

export function actionTitle(name: string) {
  return getAction(name)?.title ?? EXTRA_TITLES[name] ?? name;
}

/** 필드 명세에 맞춰 사람이 읽을 값으로: ref → CLT-0003, enum → 라벨 */
function fmtField(spec: FieldSpec | undefined, v: unknown): string {
  if (spec?.kind === "ref" && spec.ref && typeof v === "number") return displayId(spec.ref, v);
  if (spec?.kind === "enum" && typeof v === "string") return spec.options?.find((o) => o.value === v)?.label ?? v;
  if (spec?.kind === "boolean") return v ? "예" : "아니오";
  if (spec?.kind === "money" && (typeof v === "number" || typeof v === "string")) return Number(String(v).replace(/,/g, "")).toLocaleString("ko-KR");
  return fmtVal(v);
}

function fmtVal(v: unknown): string {
  if (v === null) return "(비움)";
  if (v === undefined) return "—";
  if (Array.isArray(v)) return v.map((x) => (typeof x === "object" ? Object.values(x as object).join(" × ") : String(x))).join(" / ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** 활동 표 — 감사 로그의 기본 보기 */
export function RunTable({ runs, compact = false, showObjects = true }: { runs: RunView[]; compact?: boolean; showObjects?: boolean }) {
  return (
    <table className="grid-table">
      <thead>
        <tr>
          <th className="w-[92px]">시각</th>
          <th>행위자</th>
          <th>액션 · 내용</th>
          {showObjects && !compact && <th>객체</th>}
          <th className="w-[96px]">상태</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => {
          const st = RUN_STATUS[r.status];
          return (
            <tr key={r.id}>
              <td className="mono text-fg-3" title={fmtTime(r.created_at)}>{timeAgo(r.created_at)}</td>
              <td className="whitespace-nowrap"><Actor type={r.actor_type} name={r.actor_name} /></td>
              <td className="max-w-[420px]">
                <Link href={`/activity/${r.id}`} className="group block min-w-0">
                  <span className="mono mr-1.5 text-[11px] text-fg-4 group-hover:text-primary-fg">{runId(r.id)}</span>
                  <span className="text-fg-2">{actionTitle(r.action)}</span>
                  {r.risk === "high" && <Icon name="warning" size={11} className="ml-1 inline text-warning-fg" />}
                  <div className="truncate text-fg group-hover:underline">{r.result?.summary ?? r.error ?? ""}</div>
                  {r.reason && !compact && <div className="truncate text-[11.5px] text-ai-fg/80">↳ {r.reason}</div>}
                </Link>
              </td>
              {showObjects && !compact && (
                <td className="whitespace-nowrap">
                  <div className="flex flex-col gap-0.5">
                    {r.refs.slice(0, 2).map((x) => <ObjectLink key={`${x.type}${x.id}`} type={x.type} id={x.id} compact />)}
                  </div>
                </td>
              )}
              <td>
                <div className="flex flex-wrap gap-1">
                  <Tag tone={st.tone}>{st.label}</Tag>
                  {grantIdOf(r) !== null && <Tag tone="ai" title={`자율 권한 #${grantIdOf(r)} 으로 승인 없이 실행`}>자율</Tag>}
                  {r.flagged_at && <Tag tone="red" title={`${r.flagged_by ?? ""}: ${r.flag_note ?? ""}`}>문제</Tag>}
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** 승인 대기 요청 카드 — 근거, 변경 내용(현재 → 제안), 결정 버튼 */
export function ApprovalCard({ run, dense = false }: { run: RunView; dense?: boolean }) {
  const def = getAction(run.action);
  const params = run.params;
  const targetId = def?.target ? Number(params[def.target.param]) : NaN;
  const current = def?.prefill && targetId ? (def.prefill(db(), targetId) as Record<string, unknown> | undefined) : undefined;
  const rows = Object.entries(params)
    .filter(([k]) => k !== def?.target?.param)
    .map(([k, v]) => ({ key: k, spec: def?.fields[k]?.spec, label: def?.fields[k]?.spec.label ?? k, before: current ? current[k] : undefined, after: v }));

  return (
    <article className="border border-warning/50 bg-panel">
      <header className="flex items-center justify-between gap-2 border-b border-line bg-warning/10 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Tag tone="amber">승인 대기</Tag>
          <span className="truncate font-semibold">{def?.title ?? run.action}</span>
          <span className="mono text-[11px] text-fg-4">{runId(run.id)}</span>
        </div>
        <span className="mono shrink-0 text-[11px] text-fg-3">{timeAgo(run.created_at)}</span>
      </header>
      <div className="space-y-2 p-3">
        <div className="text-[13px]">{run.result?.summary}</div>
        {isStale(db(), run) && (
          <div className="border-l-2 border-danger bg-danger/10 px-2.5 py-1.5 text-[12px] text-danger-fg">
            요청 이후 대상 객체가 변경되었습니다{def?.preview ? ` — 지금 기준: ${def.preview(db(), run.params as never)}` : ""}. 승인해도 실행되지 않으니 거절하고 에이전트에게 다시 요청하게 하세요.
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
          <Actor type={run.actor_type} name={run.actor_name} />
          {run.refs.map((x) => <ObjectLink key={`${x.type}${x.id}`} type={x.type} id={x.id} />)}
        </div>
        {run.actor_type === "agent" && <ApprovalTrack run={run} />}
        {run.reason && (
          <div className="border-l-2 border-ai bg-ai/10 px-2.5 py-1.5 text-[12px] text-fg-2">
            <span className="label-caps mr-2 text-ai-fg">근거</span>{run.reason}
          </div>
        )}
        {!dense && rows.length > 0 && (
          <table className="grid-table border border-line-soft">
            <thead><tr><th>필드</th>{current && <th>현재</th>}<th>제안</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const changed = current && fmtField(r.spec, r.before) !== fmtField(r.spec, r.after);
                return (
                  <tr key={r.key}>
                    <td className="text-fg-3">{r.label}</td>
                    {current && <td className="mono text-fg-3">{fmtField(r.spec, r.before)}</td>}
                    <td className={`mono ${changed ? "bg-warning/10 text-warning-fg" : ""}`}>{fmtField(r.spec, r.after)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <form action={decideRun} className="flex flex-wrap items-center gap-1.5 pt-1">
          <input type="hidden" name="run_id" value={run.id} />
          {!dense && <input name="note" placeholder="결정 메모 (선택)" className="field h-7 min-h-0 min-w-40 flex-1" />}
          <button name="decision" value="approve" className="btn-success"><Icon name="check" size={12} /> 승인·실행</button>
          <button name="decision" value="reject" className="btn-danger"><Icon name="x" size={12} /> 거절</button>
        </form>
      </div>
    </article>
  );
}

/** 승인 카드의 한 줄: 이 에이전트의 이 액션 — 최근 30일 승인·거절 이력 (자율 권한 판단 도움) */
function ApprovalTrack({ run }: { run: RunView }) {
  const h = approvalHistory(db(), Number(run.actor_id), run.action);
  return (
    <div className="text-[11.5px] text-fg-3">
      이 에이전트의 이 액션 (30일): 승인 이력 <span className="mono text-fg-2">{h.approved}</span>건 · 거절 <span className={`mono ${h.rejected ? "text-warning-fg" : "text-fg-2"}`}>{h.rejected}</span>건
      {h.flagged > 0 && <> · 문제 표시 <span className="mono text-danger-fg">{h.flagged}</span>건</>}
    </div>
  );
}
