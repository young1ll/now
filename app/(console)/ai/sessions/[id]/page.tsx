import Link from "next/link";
import { notFound } from "next/navigation";
import { SESSION_STATUS } from "@/components/automation";
import { AutoRefresh } from "@/components/client";
import { Icon } from "@/components/icons";
import { Markdown } from "@/components/Markdown";
import { MemoryLink, MemoryStatusTag } from "@/components/memory";
import { Actor, ObjectLink, PageHeader, Panel, PropertyList, Tag, fmtTime } from "@/components/ui";
import { PROVIDER_INFO } from "@/lib/ai/providers";
import { promptHeadline } from "@/lib/events/prompt";
import { db } from "@/lib/db";
import { idParam } from "@/lib/params";
import { getProfile, getSession } from "@/lib/repos/ai";
import { getAgent } from "@/lib/repos/agents";
import { nodeInfo, parseRef } from "@/lib/ontology/graph";
import { displayId } from "@/lib/ontology/ids";
import { type Ref, refKey } from "@/lib/ontology/types";
import { type MemoryRow, getMemory, listMemoryUses } from "@/lib/repos/memories";
import { episodeUri, findNoteBySource } from "@/lib/repos/notes";
import { getSetting } from "@/lib/repos/settings";

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const id = idParam((await params).id);
  const s = id ? getSession(db(), id) : undefined;
  if (!s) notFound();
  const p = getProfile(db(), s.profile_id);
  const agent = p ? getAgent(db(), p.agent_id) : undefined;
  const st = SESSION_STATUS[s.status];
  // 워커가 끝난 세션마다 만드는 요약 문서
  const episode = findNoteBySource(db(), episodeUri(s.id), "episode");
  const episodesOff = getSetting(db(), "episodes") === "off";
  // why-탐색기 1판: 세션이 받은 컨텍스트 팩(해시 + 항목)과 AI 가 인용한 기억
  const seen = s.context_refs.map((k) => parseRef(k)).filter((r): r is Ref => !!r);
  const info = nodeInfo(db(), seen);
  const cited = [...new Set(listMemoryUses(db(), { sessionId: s.id, how: "cited", limit: 200 }).map((u) => u.memory_id))]
    .map((mid) => getMemory(db(), mid))
    .filter((m): m is MemoryRow => !!m);
  return (
    <>
      {(s.status === "queued" || s.status === "running") && <AutoRefresh seconds={3} />}
      <PageHeader
        icon="ai"
        eyebrow={<Link href="/ai" className="hover:text-fg">AI 세션</Link>}
        title={<span className="flex items-center gap-2">세션 #{s.id} <Tag tone={st.tone}>{st.label}</Tag></span>}
        meta={promptHeadline(s.prompt, s.trigger_run_id ? `트리거 실행 #${s.trigger_run_id}` : undefined).slice(0, 160)}
        live={s.status === "running"}
        actions={episode && <Link href={`/o/note/${episode.id}`} className="btn"><Icon name="note" size={12} /> 에피소드 {displayId("note", episode.id)}</Link>}
      />
      <div className="grid grid-cols-1 gap-px bg-void p-px xl:grid-cols-12">
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
                {
                  label: "에피소드",
                  value: episode ? (
                    <span className="inline-flex items-center gap-1.5"><ObjectLink type="note" id={episode.id} title={episode.title} />{!!episode.tainted && <Tag tone="amber">외부 출처</Tag>}</span>
                  ) : s.status !== "succeeded" && s.status !== "failed" ? (
                    "—"
                  ) : s.episode_recorded_at ? (
                    <span className="text-fg-3">삭제됨 — 워커가 다시 만들지 않음 (<Link href={`/o/note?act=document.record_episode&p.session_id=${s.id}`} className="link">다시 기록</Link>)</span>
                  ) : episodesOff ? (
                    <span className="text-fg-3">기록 꺼짐 (설정 episodes=off)</span>
                  ) : (
                    "기록 대기 (워커)"
                  ),
                },
              ]}
            />
            {agent && <Link href={`/activity?actor=agent:${agent.id}`} className="link mt-3 inline-block text-[12px]">이 에이전트의 액션 기록 →</Link>}
          </Panel>
          <Panel title="이 세션이 본 기억·문서" count={seen.length}>
            <div className="mb-2 text-[11.5px] text-fg-3">
              컨텍스트 팩 해시 <span className="mono text-fg-2">{s.context_hash ?? "— (팩 없음)"}</span>
            </div>
            {seen.length === 0 ? (
              <p className="text-[12px] text-fg-3">세션 시작 때 넣은 기억·문서가 없습니다.</p>
            ) : (
              <ol className="flex flex-col gap-1">
                {seen.map((r) => {
                  const m = r.type === "memory" ? getMemory(db(), r.id) : undefined;
                  return (
                    <li key={refKey(r)} className="flex min-w-0 items-center gap-1.5 text-[12px]">
                      {m ? (
                        <>
                          <MemoryStatusTag m={m} />
                          <MemoryLink id={m.id} statement={m.statement} />
                        </>
                      ) : info.get(refKey(r)) ? (
                        <ObjectLink type={r.type} id={r.id} title={info.get(refKey(r))!.title} />
                      ) : (
                        <span className="mono text-fg-4">{displayId(r.type, r.id)} (삭제됨)</span>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </Panel>
          <Panel title="인용한 기억" count={cited.length}>
            {cited.length === 0 ? (
              <p className="text-[12px] text-fg-3">AI 가 [mem:N] 으로 인용하거나 cite 로 기록한 기억이 없습니다.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {cited.map((m) => (
                  <li key={m.id} className="flex min-w-0 items-center gap-1.5 text-[12px]">
                    <Tag tone="ai">인용</Tag>
                    <MemoryLink id={m.id} statement={m.statement} />
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
