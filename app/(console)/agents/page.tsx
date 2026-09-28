import { cookies, headers } from "next/headers";
import Link from "next/link";
import { dismissToken, runActionForm } from "@/app/actions/console";
import { TOKEN_COOKIE } from "@/lib/context";
import { ActionDrawer } from "@/components/ActionDrawer";
import { ActionForm } from "@/components/ActionForm";
import { AllowedChips, TrustPanel } from "@/components/trust";
import { CopyButton } from "@/components/client";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Icon } from "@/components/icons";
import { Actor, Callout, Empty, PageHeader, Panel, Tag, timeAgo } from "@/components/ui";
import { db } from "@/lib/db";
import { AI_MODE_LABEL } from "@/lib/ontology/actions/system";
import { computeSignals } from "@/lib/ontology/signals";
import { AGENT_ROLE, MEMORY_TRUST } from "@/lib/labels";
import { getAction } from "@/lib/ontology/execute";
import { type SearchParams, one } from "@/lib/params";
import { listAgents } from "@/lib/repos/agents";
import { AI_MODES, getAiMode } from "@/lib/repos/settings";

export const metadata = { title: "에이전트" };

const MODE_DETAIL = {
  autonomous: "모든 액션을 즉시 실행. 사람은 활동 로그로만 확인합니다.",
  guarded: "저위험(생성·수정·기록)은 즉시, 고위험(발행·삭제·금액)은 승인 대기.",
  supervised: "에이전트의 모든 쓰기를 승인 대기로. 도입 초기·민감한 기간에.",
  frozen: "에이전트 쓰기 전면 차단 (읽기만). 비상 정지.",
};

const TRUST_KINDS = ["trust.grant_candidate", "trust.memory_candidate"];

export default async function AgentsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const mode = getAiMode(db());
  const agents = listAgents(db(), new Date(Date.now() - 86_400_000).toISOString());
  const flash = (await cookies()).get(TOKEN_COOKIE)?.value;
  const [newId, newToken] = flash ? [flash.split(":")[0], flash.slice(flash.indexOf(":") + 1)] : [];
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost:3000"}`;
  const token = newToken ?? "<토큰>";
  // 넓힐 후보 (자율 권한 · 기억 등급) — 신호에서
  const candidates = computeSignals(db(), null).filter((s) => TRUST_KINDS.includes(s.kind));
  const live = agents.filter((a) => a.status !== "revoked");

  return (
    <>
      <PageHeader icon="agent" eyebrow="자동화 · 거버넌스" title="에이전트" meta="이 운영 체제를 조작하는 AI 에이전트와, 사람이 개입하는 수준을 관리합니다." error={one(sp.error)} />

      {newToken && (
        <div className="border-b border-success bg-success/10 px-5 py-3">
          <div className="label-caps text-success-fg">새 토큰 · AGT-{(newId ?? "").padStart(4, "0")} — 지금만 표시됩니다</div>
          <div className="mt-2 flex items-center gap-2">
            <code className="mono flex-1 overflow-x-auto border border-line bg-inset px-2 py-1.5 text-fg">{newToken}</code>
            <CopyButton text={newToken} />
            <form action={dismissToken}><button className="btn">저장했음 · 닫기</button></form>
          </div>
        </div>
      )}

      <div className="grid gap-px bg-void p-px xl:grid-cols-12">
        <div className="flex flex-col gap-px xl:col-span-7">
          <Panel title="AI 운영 모드 — 개입 수준">
            <div className="grid gap-px bg-line sm:grid-cols-2">
              {AI_MODES.map((m) => (
                <form key={m} action={runActionForm} className="bg-panel">
                  <input type="hidden" name="__action" value="system.set_ai_mode" />
                  <input type="hidden" name="mode" value={m} />
                  <button disabled={m === mode} className={`flex h-full w-full cursor-pointer flex-col items-start gap-1 border-l-2 p-3 text-left hover:bg-raised disabled:cursor-default ${m === mode ? "border-primary-hi bg-primary/10" : "border-transparent"}`}>
                    <span className="flex items-center gap-2 font-semibold">
                      {AI_MODE_LABEL[m].split(" — ")[0]}
                      {m === mode && <Tag tone="blue">현재</Tag>}
                      {m === "frozen" && <Icon name="pause" size={12} className="text-danger-fg" />}
                    </span>
                    <span className="text-[12px] text-fg-3">{MODE_DETAIL[m]}</span>
                  </button>
                </form>
              ))}
            </div>
          </Panel>

          <Panel title="등록된 에이전트" count={agents.length} flush>
            {agents.length === 0 ? <Empty icon="agent">등록된 에이전트가 없습니다.</Empty> : (
              <table className="grid-table">
                <thead><tr><th>에이전트</th><th>상태</th><th>역할 · 범위</th><th>토큰</th><th>최근 접속</th><th className="text-right">24h</th><th className="text-right">대기</th><th className="text-right">실패</th><th /></tr></thead>
                <tbody>
                  {agents.map((a) => (
                    <tr key={a.id} className={a.status === "revoked" ? "opacity-50" : ""}>
                      <td>
                        <Link href={`/o/agent/${a.id}`} className="hover:underline"><Actor type="agent" name={a.name} /></Link>
                        {a.description && <div className="max-w-[220px] truncate text-[11px] text-fg-3">{a.description}</div>}
                      </td>
                      <td><Tag tone={a.status === "active" ? "green" : a.status === "suspended" ? "amber" : "zinc"}>{{ active: "활성", suspended: "정지", revoked: "폐기" }[a.status]}</Tag></td>
                      <td className="max-w-[220px]">
                        <div className="flex flex-wrap items-center gap-1 text-[11.5px]">
                          <span className="text-fg-2">{AGENT_ROLE[a.role]}</span>
                          <span className="text-fg-4">·</span>
                          <span className="text-fg-2">{a.business_scope_name ?? "전체"}</span>
                          {a.memory_trust === "active" && <Tag tone={MEMORY_TRUST.active.tone}>{MEMORY_TRUST.active.label}</Tag>}
                        </div>
                        <div className="mt-0.5"><AllowedChips allowed={a.allowed_actions} /></div>
                      </td>
                      <td className="mono text-fg-3">{a.token_prefix}…</td>
                      <td className="mono text-fg-3">{timeAgo(a.last_seen_at)}</td>
                      <td className="num">{a.runs_24h}</td>
                      <td className={`num ${a.pending ? "text-warning-fg" : ""}`}>{a.pending}</td>
                      <td className={`num ${a.failed_24h ? "text-danger-fg" : ""}`}>{a.failed_24h}</td>
                      <td className="text-right">
                        {a.status !== "revoked" && (
                          <form action={runActionForm} className="flex justify-end gap-1">
                            <input type="hidden" name="__action" value="agent.set_status" />
                            <input type="hidden" name="id" value={a.id} />
                            {a.status === "active" ? (
                              <button name="status" value="suspended" className="btn btn-sm"><Icon name="pause" size={10} /> 정지</button>
                            ) : (
                              <button name="status" value="active" className="btn btn-sm"><Icon name="play" size={10} /> 재개</button>
                            )}
                            <ConfirmButton name="status" value="revoked" message="토큰을 영구 폐기합니다." className="btn-danger btn-sm">폐기</ConfirmButton>
                          </form>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>

        <div className="flex flex-col gap-px xl:col-span-5">
          <Panel title="신뢰 사다리 — 권한은 좁게 시작해 증거로 넓힌다">
            <p className="text-[12.5px] text-fg-2">
              넓히는 것(자율 권한 · 기억 등급 · 범위 확대)은 사람이, 좁히는 것은 워커도 합니다 — 자율 권한으로 실행한 결과를 &quot;문제 표시&quot;하면 권한이 회수되고,
              활성 착지 기억을 14일에 2건 거절·정정하면 기억 등급이 내려갑니다. 모든 지표는 활동 로그에서 계산합니다.
            </p>
            {candidates.length > 0 && (
              <p className="mt-2 text-[12px] text-primary-fg">넓힐 후보 {candidates.length}건 — 아래 에이전트 카드에서 원클릭으로 부여할 수 있습니다.</p>
            )}
          </Panel>
          <Panel title="에이전트 등록">
            <ActionForm def={getAction("agent.register")!} db={db()} scope={null} values={{}} next="/agents" />
          </Panel>
          <Panel title="연결 방법">
            <div className="space-y-3 text-[12.5px]">
              <Callout tone="ai" title="MCP (권장)">Claude Code · Claude Desktop 등 MCP 클라이언트가 도구로 이 OS 를 조작합니다.</Callout>
              <div>
                <div className="label-caps mb-1">Claude Code — HTTP</div>
                <pre className="mono overflow-x-auto border border-line bg-inset p-2 text-[11.5px] text-fg-2">{`claude mcp add --transport http now ${origin}/api/mcp \\
  --header "Authorization: Bearer ${token}"`}</pre>
              </div>
              <div>
                <div className="label-caps mb-1">Claude Code — stdio (서버 없이 DB 직접)</div>
                <pre className="mono overflow-x-auto border border-line bg-inset p-2 text-[11.5px] text-fg-2">{`claude mcp add --env NOW_AGENT_TOKEN=${token} now \\
  -- npx tsx scripts/mcp-stdio.ts`}</pre>
              </div>
              <div>
                <div className="label-caps mb-1">REST</div>
                <pre className="mono overflow-x-auto border border-line bg-inset p-2 text-[11.5px] text-fg-2">{`curl -H "Authorization: Bearer ${token}" ${origin}/api/v1/signals
curl -X POST -H "Authorization: Bearer ${token}" \\
  -d '{"params":{"business_id":1,"title":"…"},"reason":"…"}' \\
  ${origin}/api/v1/actions/task.create`}</pre>
              </div>
              <p className="text-fg-3">도구: whoami · get_overview · list_signals · search_objects · get_object · list_actions · run_action · get_run · list_my_runs · cancel_run. 자세한 내용은 docs/AGENTS.md.</p>
            </div>
          </Panel>
        </div>
      </div>

      <div className="grid gap-px bg-void p-px xl:grid-cols-2">
        {live.map((a) => (
          <TrustPanel key={a.id} agent={a} path="/agents" title suggestions={candidates.filter((s) => s.ref?.type === "agent" && s.ref.id === a.id)} />
        ))}
      </div>
      <ActionDrawer sp={sp} path="/agents" scope={null} next="/agents" />
    </>
  );
}
