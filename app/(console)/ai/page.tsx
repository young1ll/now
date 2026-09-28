import { headers } from "next/headers";
import Link from "next/link";
import { ActionDrawer, actHref } from "@/components/ActionDrawer";
import { ActionForm } from "@/components/ActionForm";
import { SESSION_STATUS } from "@/components/automation";
import { AutoRefresh, CopyButton } from "@/components/client";
import { Icon } from "@/components/icons";
import { Callout, Empty, PageHeader, Panel, Tabs, Tag, timeAgo } from "@/components/ui";
import { PROVIDER_INFO } from "@/lib/ai/providers";
import { promptHeadline } from "@/lib/events/prompt";
import { currentScope } from "@/lib/context";
import { db } from "@/lib/db";
import { getAction } from "@/lib/ontology/execute";
import { type SearchParams, one } from "@/lib/params";
import { PROVIDERS, listProfiles, listSessions } from "@/lib/repos/ai";

export const metadata = { title: "AI 연결" };

function Snippet({ title, code }: { title: string; code: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="label-caps">{title}</span>
        <CopyButton text={code} />
      </div>
      <pre className="mono overflow-x-auto border border-line bg-inset p-2 text-[11.5px] leading-relaxed text-fg-2">{code}</pre>
    </div>
  );
}

export default async function AiPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const scope = await currentScope();
  const tab = (["runtime", "connect"] as const).find((t) => t === one(sp.tab)) ?? "runtime";
  const profiles = listProfiles(db());
  const sessions = listSessions(db(), { limit: 30 });
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "127.0.0.1:3000"}`;
  const envState = (name: string) => (name ? (process.env[name] ? "설정됨" : "미설정") : "—");

  return (
    <>
      <AutoRefresh seconds={8} />
      <PageHeader
        icon="ai"
        eyebrow="자동화"
        title="AI 연결"
        meta="이 OS 를 조작하는 AI 는 두 방식입니다 — ① 내장 런타임: 공급자 API/로컬 모델/로컬 CLI 로 OS 가 직접 실행 ② 외부 접속: 사용 중인 AI 도구가 MCP·CLI·REST·OpenAPI 로 접속."
        error={one(sp.error)}
        actions={<Link href={actHref("/ai", "ai_profile.create", {}, { provider: "anthropic", max_steps: 12 })} className="btn-primary"><Icon name="plus" size={12} /> AI 프로필</Link>}
      />
      <Tabs current={tab} items={[{ key: "runtime", label: "내장 런타임", href: "/ai" }, { key: "connect", label: "외부 AI 접속 가이드", href: "/ai?tab=connect" }]} />

      {tab === "runtime" ? (
        <div className="grid grid-cols-1 gap-px bg-void p-px xl:grid-cols-12">
          <div className="flex flex-col gap-px xl:col-span-7">
            <Panel title="AI 프로필" count={profiles.length} flush>
              {profiles.length === 0 ? (
                <Empty icon="ai">프로필이 없습니다. Claude · OpenAI · Gemini · OpenRouter · Ollama · 로컬 CLI 중에서 만드세요.</Empty>
              ) : (
                <table className="grid-table">
                  <thead><tr><th>프로필</th><th>공급자 · 모델</th><th>키</th><th>에이전트 신원</th><th className="text-right">24h</th></tr></thead>
                  <tbody>
                    {profiles.map((p) => {
                      const info = PROVIDER_INFO[p.provider];
                      const keyEnv = p.api_key_env || info.keyEnv;
                      return (
                        <tr key={p.id} className={p.enabled ? "" : "opacity-50"}>
                          <td className="font-medium">{p.name}</td>
                          <td className="text-[12px]">{info.label}<div className="mono text-[11px] text-fg-3">{p.provider === "command" ? p.command.slice(0, 40) : p.model || info.defaultModel}</div></td>
                          <td className="mono text-[11px]">{keyEnv ? <span className={process.env[keyEnv] ? "text-success-fg" : "text-warning-fg"}>{keyEnv} · {envState(keyEnv)}</span> : <span className="text-fg-4">불필요</span>}</td>
                          <td><Link href={`/o/agent/${p.agent_id}`} className="text-ai-fg hover:underline">{p.agent_name}</Link></td>
                          <td className="num">{p.sessions_24h}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </Panel>
            <Panel title="세션" count={sessions.length} flush>
              {sessions.length === 0 ? <Empty icon="ai">아직 실행된 세션이 없습니다.</Empty> : (
                <table className="grid-table">
                  <thead><tr><th className="w-[70px]">#</th><th>프로필</th><th>지시 · 결과</th><th className="text-right">도구</th><th>상태</th></tr></thead>
                  <tbody>
                    {sessions.map((s) => (
                      <tr key={s.id}>
                        <td><Link href={`/ai/sessions/${s.id}`} className="mono text-primary-fg hover:underline">#{s.id}</Link><div className="mono text-[10.5px] text-fg-4">{timeAgo(s.started_at)}</div></td>
                        <td className="text-[12px]">{s.profile_name}{s.trigger_run_id && <div className="text-[10.5px] text-fg-4">트리거</div>}</td>
                        <td className="max-w-[360px]">
                          <div className="truncate text-fg-2">{promptHeadline(s.prompt, s.trigger_run_id ? `트리거 실행 #${s.trigger_run_id}` : undefined)}</div>
                          <div className={`truncate text-[11.5px] ${s.error ? "text-danger-fg" : "text-fg"}`}>{s.error ?? s.final_text.split("\n")[0]}</div>
                        </td>
                        <td className="num">{s.tool_calls}</td>
                        <td><Tag tone={SESSION_STATUS[s.status].tone}>{SESSION_STATUS[s.status].label}</Tag></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>
          </div>
          <div className="flex flex-col gap-px xl:col-span-5">
            <Panel title="AI 에게 지시">
              {profiles.length ? (
                <ActionForm def={getAction("ai.run")!} db={db()} scope={scope} values={{ profile_id: profiles[0].id, prompt: "get_overview 로 현황을 보고, 심각 신호부터 처리해 줘. 고객에게 나가는 건 승인 요청으로." }} next="/ai" />
              ) : (
                <p className="text-fg-3">먼저 AI 프로필을 만드세요.</p>
              )}
            </Panel>
            <Panel title="공급자" flush>
              <table className="grid-table">
                <tbody>
                  {PROVIDERS.map((p) => {
                    const i = PROVIDER_INFO[p];
                    return (
                      <tr key={p}>
                        <td className="whitespace-nowrap">{i.label}{i.local && <Tag tone="green">로컬</Tag>}</td>
                        <td className="text-[11.5px] text-fg-3">{i.note}<div className="mono text-fg-4">{i.defaultModel}{i.keyEnv ? ` · ${i.keyEnv} ${envState(i.keyEnv)}` : ""}</div></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Panel>
            <Callout tone="ai" title="모든 AI 는 같은 관문을 지납니다">
              프로필마다 전용 에이전트 신원이 생기고, 도구 호출은 AI 운영 모드·위험도 정책·승인·감사를 그대로 거칩니다. API 키는 DB 에 저장하지 않고 환경변수 이름만 기록합니다.
            </Callout>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-px bg-void p-px xl:grid-cols-2">
          <Panel title="Claude Code · Claude Desktop (MCP)">
            <div className="space-y-3">
              <Snippet title="Claude Code — HTTP" code={`claude mcp add --transport http now ${origin}/api/mcp \\\n  --header "Authorization: Bearer $NOW_AGENT_TOKEN"`} />
              <Snippet title="Claude Code — stdio (서버 없이)" code={`claude mcp add --env NOW_AGENT_TOKEN=now_… now -- npx tsx scripts/mcp-stdio.ts`} />
              <Snippet title="Claude Desktop — claude_desktop_config.json" code={JSON.stringify({ mcpServers: { now: { command: "npx", args: ["tsx", "/경로/now/scripts/mcp-stdio.ts"], env: { NOW_AGENT_TOKEN: "now_…", NOW_DB_PATH: "/경로/now/data/now.db" } } } }, null, 2)} />
            </div>
          </Panel>
          <Panel title="OpenAI Codex CLI · Gemini CLI (MCP)">
            <div className="space-y-3">
              <Snippet title="Codex — ~/.codex/config.toml" code={`[mcp_servers.now]\ncommand = "npx"\nargs = ["tsx", "/경로/now/scripts/mcp-stdio.ts"]\nenv = { NOW_AGENT_TOKEN = "now_…", NOW_DB_PATH = "/경로/now/data/now.db" }`} />
              <Snippet title="Gemini CLI — ~/.gemini/settings.json" code={JSON.stringify({ mcpServers: { now: { httpUrl: `${origin}/api/mcp`, headers: { Authorization: "Bearer now_…" } } } }, null, 2)} />
              <Snippet title="Cursor · Windsurf · LM Studio 등 — mcp.json" code={JSON.stringify({ mcpServers: { now: { url: `${origin}/api/mcp`, headers: { Authorization: "Bearer now_…" } } } }, null, 2)} />
            </div>
          </Panel>
          <Panel title="셸을 쓰는 모든 AI — now CLI">
            <div className="space-y-3">
              <Snippet title="설정" code={`export NOW_URL=${origin}\nexport NOW_AGENT_TOKEN=now_…\nnode bin/now.mjs --help      # 또는 npm link 후 now --help`} />
              <Snippet title="예시" code={`now overview\nnow signals --severity critical --text\nnow traverse CLT-0001 --depth 2\nnow run task.create '{"business_id":1,"title":"원천세 신고"}' --reason "월간 반복"\nnow events --follow --type signal.`} />
              <p className="text-[12px] text-fg-3">aider · Open Interpreter · 로컬 LLM 에이전트처럼 MCP 가 없는 도구도 셸 명령으로 조작할 수 있습니다. 종료 코드: 0 적용 · 10 승인 대기 · 11 실패 · 12 거부.</p>
            </div>
          </Panel>
          <Panel title="REST · OpenAPI · 이벤트 구독">
            <div className="space-y-3">
              <Snippet title="OpenAPI 3.1 (GPT Actions · LangChain · 기타)" code={`${origin}/api/v1/openapi.json`} />
              <Snippet title="범용 도구 호출" code={`curl -X POST ${origin}/api/v1/tools/list_signals \\\n  -H "Authorization: Bearer now_…" -H "content-type: application/json" -d '{}'`} />
              <Snippet title="실시간 이벤트 (SSE)" code={`curl -N -H "Authorization: Bearer now_…" "${origin}/api/v1/events/stream?type=signal."`} />
              <p className="text-[12px] text-fg-3">토큰은 <Link href="/agents" className="link">에이전트</Link> 화면에서 발급합니다. 내장 런타임의 로컬 CLI 프로필은 실행마다 단기 토큰(NOW_AGENT_TOKEN)을 자동으로 넣어 줍니다.</p>
            </div>
          </Panel>
        </div>
      )}
      <ActionDrawer sp={sp} path="/ai" scope={scope} next="/ai" />
    </>
  );
}
