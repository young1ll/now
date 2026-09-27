import Link from "next/link";
import { notFound } from "next/navigation";
import { SESSION_STATUS } from "@/components/automation";
import { AutoRefresh } from "@/components/client";
import { Markdown } from "@/components/Markdown";
import { Actor, PageHeader, Panel, PropertyList, Tag, fmtTime } from "@/components/ui";
import { PROVIDER_INFO } from "@/lib/ai/providers";
import { db } from "@/lib/db";
import { idParam } from "@/lib/params";
import { getProfile, getSession } from "@/lib/repos/ai";
import { getAgent } from "@/lib/repos/agents";

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const id = idParam((await params).id);
  const s = id ? getSession(db(), id) : undefined;
  if (!s) notFound();
  const p = getProfile(db(), s.profile_id);
  const agent = p ? getAgent(db(), p.agent_id) : undefined;
  const st = SESSION_STATUS[s.status];
  return (
    <>
      {(s.status === "queued" || s.status === "running") && <AutoRefresh seconds={3} />}
      <PageHeader
        icon="ai"
        eyebrow={<Link href="/ai" className="hover:text-fg">AI 세션</Link>}
        title={<span className="flex items-center gap-2">세션 #{s.id} <Tag tone={st.tone}>{st.label}</Tag></span>}
        meta={s.prompt.split("\n")[0].slice(0, 160)}
        live={s.status === "running"}
      />
      <div className="grid gap-px bg-void p-px xl:grid-cols-12">
        <div className="xl:col-span-8">
          <Panel title="대화 기록" count={s.transcript.length}>
            <ol className="space-y-3">
              {s.transcript.map((t, i) => (
                <li key={i} className={`border-l-2 pl-3 ${t.role === "user" ? "border-primary" : t.role === "assistant" ? "border-ai" : t.role === "tool" ? (t.is_error ? "border-danger" : "border-line-strong") : "border-line"}`}>
                  <div className="label-caps mb-1">
                    {t.role === "user" ? "지시" : t.role === "assistant" ? "AI" : t.role === "tool" ? `도구 결과 · ${t.name}` : "시스템"}
                  </div>
                  {t.role === "assistant" && (
                    <>
                      {t.text && <Markdown source={t.text} />}
                      {t.tool_calls?.map((c) => (
                        <pre key={c.id} className="mono mt-1 overflow-x-auto bg-inset p-2 text-[11.5px] text-ai-fg">{`→ ${c.name}(${JSON.stringify(c.args)})`}</pre>
                      ))}
                    </>
                  )}
                  {t.role === "tool" && <pre className={`mono max-h-56 overflow-auto bg-inset p-2 text-[11px] whitespace-pre-wrap ${t.is_error ? "text-danger-fg" : "text-fg-3"}`}>{t.result}</pre>}
                  {(t.role === "user" || t.role === "system") && <pre className="mono overflow-x-auto text-[12px] whitespace-pre-wrap text-fg-2">{t.text}</pre>}
                </li>
              ))}
            </ol>
          </Panel>
        </div>
        <div className="flex flex-col gap-px xl:col-span-4">
          <Panel title="세션">
            <PropertyList
              items={[
                { label: "프로필", value: p?.name ?? "(삭제됨)" },
                { label: "공급자", value: p ? PROVIDER_INFO[p.provider].label : "—" },
                { label: "모델", value: p?.model || (p ? PROVIDER_INFO[p.provider].defaultModel : "—"), mono: true },
                { label: "에이전트", value: agent ? <Actor type="agent" name={agent.name} /> : "—" },
                { label: "단계", value: String(s.steps), mono: true },
                { label: "도구 호출", value: String(s.tool_calls), mono: true },
                { label: "토큰", value: s.usage.input || s.usage.output ? `입력 ${s.usage.input ?? 0} · 출력 ${s.usage.output ?? 0}` : "—", mono: true },
                { label: "시작", value: fmtTime(s.started_at), mono: true },
                { label: "종료", value: fmtTime(s.finished_at), mono: true },
                { label: "오류", value: s.error ? <span className="text-danger-fg">{s.error}</span> : "—" },
              ]}
            />
            {agent && <Link href={`/activity?actor=agent:${agent.id}`} className="link mt-3 inline-block text-[12px]">이 에이전트의 액션 기록 →</Link>}
          </Panel>
        </div>
      </div>
    </>
  );
}
