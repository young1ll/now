// 신뢰 사다리 화면 조각 — 에이전트 화면(/agents)과 에이전트 객체 화면이 함께 쓴다 (서버 컴포넌트).
import Link from "next/link";
import { runActionForm } from "@/app/actions/console";
import { actHref } from "@/components/ActionDrawer";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Icon } from "@/components/icons";
import { Actor, ObjectLink, Panel, Tag, fmtTime } from "@/components/ui";
import { db } from "@/lib/db";
import { AGENT_ROLE, MEMORY_TRUST } from "@/lib/labels";
import { getAction } from "@/lib/ontology/execute";
import { actionAllowed } from "@/lib/ontology/policy";
import type { Signal } from "@/lib/ontology/signals";
import { type AgentTrust, type Autonomy, agentTrust } from "@/lib/ontology/trust";
import { type Agent, grantState, grantsOverview } from "@/lib/repos/agents";
import { getBusiness } from "@/lib/repos/businesses";

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);

/** 허용 액션 칩 ("*" 는 전부) */
export function AllowedChips({ allowed }: { allowed: string }) {
  if (allowed === "*") return <Tag tone="none">전부 (*)</Tag>;
  return (
    <span className="flex flex-wrap gap-1">
      {allowed.split(",").map((p) => <span key={p} className="mono inline-flex h-5 items-center border border-line bg-inset px-1.5 text-[11px] text-fg-2">{p}</span>)}
    </span>
  );
}

function Num({ n, tone, title }: { n: number; tone?: "danger" | "warning" | "ai" | "success"; title?: string }) {
  const color = n ? { danger: "text-danger-fg", warning: "text-warning-fg", ai: "text-ai-fg", success: "text-success-fg" }[tone ?? "success"] : "text-fg-4";
  return <td title={title} className={`num ${tone ? color : n ? "" : "text-fg-4"}`}>{n}</td>;
}

/** 30일 실행 지표 표 (액션별 + 합계) */
function RunsTable({ t }: { t: AgentTrust }) {
  const rows = t.runs.byAction;
  if (!rows.length) return <p className="px-3 py-2 text-[12px] text-fg-3">최근 {t.days}일 실행 기록이 없습니다.</p>;
  const tot = t.runs.total;
  return (
    <table className="grid-table">
      <thead>
        <tr>
          <th>액션</th>
          <th className="text-right" title="정책이 바로 실행">적용</th>
          <th className="text-right" title="자율 권한으로 적용">자율</th>
          <th className="text-right" title="승인 대기 → 사람 승인">승인</th>
          <th className="text-right">거절</th>
          <th className="text-right" title="실패 · 정책 거부">실패·거부</th>
          <th className="text-right" title="사람이 문제로 표시">문제</th>
          <th className="text-right">승인률</th>
        </tr>
      </thead>
      <tbody>
        {rows.slice(0, 12).map((a) => (
          <tr key={a.action}>
            <td className="mono text-[11.5px]">{a.action}{a.high && <Icon name="warning" size={10} className="ml-1 inline text-warning-fg" />}</td>
            <Num n={a.direct} />
            <Num n={a.granted} tone="ai" />
            <Num n={a.approved} />
            <Num n={a.rejected} tone="warning" />
            <Num n={a.failed + a.denied} tone="danger" />
            <Num n={a.flagged} tone="danger" />
            <td className="num mono">{pct(a.approvalRate)}</td>
          </tr>
        ))}
        <tr className="font-semibold">
          <td>합계{rows.length > 12 ? ` (${rows.length}개 액션)` : ""}</td>
          <Num n={tot.direct} />
          <Num n={tot.granted} tone="ai" />
          <Num n={tot.approved} />
          <Num n={tot.rejected} tone="warning" />
          <Num n={tot.failed + tot.denied} tone="danger" />
          <Num n={tot.flagged} tone="danger" />
          <td className="num mono">{pct(t.runs.approvalRate)}</td>
        </tr>
      </tbody>
    </table>
  );
}

/**
 * 에이전트 한 명의 신뢰 패널: 역할·범위·허용 액션·기억 등급, 30일 지표, 자율 권한(회수), 후보 제안(원클릭 부여), 설정 드로어.
 * suggestions = 이 에이전트의 trust.* 신호 (computeSignals 에서 — 화면이 이미 계산한 것을 넘긴다)
 */
type TrustAgent = Pick<Agent, "id" | "name" | "status" | "role" | "allowed_actions" | "business_scope" | "memory_trust">;

export function TrustPanel({ agent, path, suggestions, title }: { agent: TrustAgent; path: string; suggestions: Signal[]; title?: boolean }) {
  const t = agentTrust(db(), agent.id);
  const now = new Date();
  // 유효 권한은 전부, 회수·만료 이력만 최근 6개 — 오래 연장한 유효 권한이 이력에 밀려 가려지지 않게
  const grants = grantsOverview(db(), agent.id, { history: 6, now });
  const scopeName = agent.business_scope === null ? null : (getBusiness(db(), agent.business_scope)?.name ?? `사업 ${agent.business_scope}`);
  const mt = MEMORY_TRUST[agent.memory_trust];
  const m = t.memory;
  const live = agent.status !== "revoked";
  return (
    <Panel
      title={title ? <span className="flex items-center gap-2 normal-case"><Actor type="agent" name={agent.name} /><span className="mono text-fg-4">AGT-{String(agent.id).padStart(4, "0")}</span></span> : "신뢰 사다리"}
      action={
        live ? (
          <>
            <Link href={actHref(path, "agent.configure", { id: agent.id })} className="btn btn-sm"><Icon name="shield" size={10} /> 설정</Link>
            <Link href={actHref(path, "agent.grant", { agent_id: agent.id }, { days: 30 })} className="btn btn-sm">자율 권한</Link>
            <Link href={actHref(path, "agent.set_memory_trust", { agent_id: agent.id }, { level: agent.memory_trust === "active" ? "propose" : "active" })} className="btn btn-sm">기억 등급</Link>
          </>
        ) : undefined
      }
      flush
    >
      <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-1.5 border-b border-line px-3 py-2.5 text-[12.5px]">
        <dt className="text-fg-3">역할</dt>
        <dd>{AGENT_ROLE[agent.role]} <span className="mono text-[11px] text-fg-4">{agent.role}</span></dd>
        <dt className="text-fg-3">사업 범위</dt>
        <dd>{agent.business_scope === null ? <span className="text-fg-2">전체</span> : <ObjectLink type="business" id={agent.business_scope} title={scopeName ?? ""} />}</dd>
        <dt className="text-fg-3">허용 액션</dt>
        <dd><AllowedChips allowed={agent.allowed_actions} /></dd>
        <dt className="text-fg-3">기억 등급</dt>
        <dd className="flex flex-wrap items-center gap-2"><Tag tone={mt.tone}>{mt.label}</Tag><span className="text-[11.5px] text-fg-3">{mt.help}</span></dd>
      </dl>

      <div className="grid grid-cols-3 border-b border-line sm:grid-cols-6">
        {[
          ["30일 실행", t.runs.total.total, ""],
          ["바로 적용", t.runs.total.direct, ""],
          ["자율 적용", t.runs.total.granted, "text-ai-fg"],
          ["승인률", pct(t.runs.approvalRate), ""],
          ["문제 표시", t.runs.total.flagged, t.runs.total.flagged ? "text-danger-fg" : ""],
          ["기억 정밀도", pct(m.precision), ""],
        ].map(([label, v, cls]) => (
          <div key={String(label)} className="border-r border-line px-3 py-2 last:border-r-0">
            <div className="label-caps">{label}</div>
            <div className={`mono mt-0.5 text-[15px] font-semibold ${cls}`}>{v}</div>
          </div>
        ))}
      </div>
      <div className="border-b border-line px-3 py-1.5 text-[11.5px] text-fg-3">
        기억 (30일): 제안 <span className="mono text-fg-2">{m.proposed}</span> · 활성 착지 <span className="mono text-fg-2">{m.autoActive}</span> · 확인 <span className="mono text-fg-2">{m.confirmed}</span> · 거절 <span className="mono text-fg-2">{m.rejected}</span> · 정정 <span className="mono text-fg-2">{m.corrected}</span>
      </div>

      {suggestions.length > 0 && live && (
        <div className="flex flex-col gap-1.5 border-b border-line bg-primary/5 px-3 py-2">
          {suggestions.map((s) => (
            <div key={s.key} className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
              <span className="min-w-0 flex-1"><Tag tone="blue">후보</Tag> <span className="text-fg-2">{s.detail}</span></span>
              {s.suggested.map((a) => (
                <form key={a.action} action={runActionForm}>
                  <input type="hidden" name="__action" value={a.action} />
                  {Object.entries(a.params).map(([k, v]) => <input key={k} type="hidden" name={k} value={String(v)} />)}
                  <button className="btn-primary btn-sm">{a.label}</button>
                </form>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="border-b border-line">
        <div className="label-caps px-3 pt-2">자율 권한</div>
        {grants.length === 0 ? (
          <p className="px-3 pt-1 pb-2 text-[12px] text-fg-3">없음 — 가드 모드에서 고위험 액션은 모두 승인 대기가 됩니다.</p>
        ) : (
          <table className="grid-table">
            <tbody>
              {grants.map((g) => {
                const st = grantState(g, now);
                // 허용 범위를 좁힌 뒤 남은 권한: 행은 유효하지만 정책이 허용 범위를 먼저 보므로 쓰이지 않는다
                const outside = st === "active" && !actionAllowed(agent.allowed_actions, g.action);
                return (
                  <tr key={g.id} className={st === "active" && !outside ? "" : "opacity-60"}>
                    <td className="mono text-[11.5px]">{g.action}</td>
                    <td className="text-[11.5px] text-fg-3">{getAction(g.action)?.title ?? ""}</td>
                    <td className="mono text-[11.5px] text-fg-3" title={`부여 ${fmtTime(g.granted_at)} · ${g.granted_by}`}>~{g.expires_at.slice(0, 10)}</td>
                    <td>
                      {outside ? (
                        <Tag tone="amber" title="허용 액션 밖이라 쓰이지 않습니다 — 허용 범위를 다시 넓히면 살아나니 필요 없으면 회수하세요">허용 범위 밖</Tag>
                      ) : st === "active" ? <Tag tone="ai">유효</Tag> : st === "expired" ? <Tag tone="zinc">만료</Tag> : <Tag tone="zinc" title={`${g.revoked_by ?? ""} · ${g.revoked_reason ?? ""}`}>회수</Tag>}
                      {st === "revoked" && g.revoked_reason && <div className="max-w-[220px] truncate text-[11px] text-fg-4">{g.revoked_reason}</div>}
                    </td>
                    <td className="text-right">
                      {st === "active" && (
                        <form action={runActionForm}>
                          <input type="hidden" name="__action" value="agent.revoke_grant" />
                          <input type="hidden" name="grant_id" value={g.id} />
                          <input type="hidden" name="reason" value="운영자가 콘솔에서 회수" />
                          <ConfirmButton message={`${g.action} 자율 권한을 회수합니다.`} className="btn-danger btn-sm">회수</ConfirmButton>
                        </form>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <RunsTable t={t} />
    </Panel>
  );
}

/** 오퍼레이션 "자율도" 한 줄 — 최근 7일 에이전트 쓰기의 착지 비율 */
export function AutonomyLine({ a }: { a: Autonomy }) {
  const share = (n: number) => (a.total ? `${Math.round((n / a.total) * 100)}%` : "—");
  const parts: [string, number, string][] = [
    ["바로 적용", a.direct, "text-fg"],
    ["자율 권한", a.granted, "text-ai-fg"],
    ["승인 후 적용", a.approved, "text-fg"],
    ["거절", a.rejected, a.rejected ? "text-warning-fg" : "text-fg"],
  ];
  return (
    <Link href="/agents" className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-panel px-5 py-1.5 text-[12px] hover:bg-raised">
      <span className="label-caps">자율도 · 7일</span>
      <span className="mono text-fg-3">에이전트 쓰기 {a.total}</span>
      {parts.map(([label, n, cls]) => (
        <span key={label} className="text-fg-3">
          {label} <span className={`mono font-semibold ${cls}`}>{share(n)}</span> <span className="mono text-fg-4">({n})</span>
        </span>
      ))}
    </Link>
  );
}
