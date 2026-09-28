// 에피소드 — 끝난 AI 세션 하나를 결정적으로(LLM 없이) 요약한 문서 (docs/MEMORY.md §4, §14).
// 세션 원문(대화 기록)은 청크화하지 않고 이것만 색인한다 — 원문은 잡음·주입 경로·토큰 낭비다 (§1 "대화 로그 ≠ 기억").
// 같은 세션 → 같은 본문. 쓰기는 document.record_episode 액션이 한다 (워커는 SYSTEM 행위자로 부른다).
import type { DB } from "@/lib/db";
import { PROVIDER_INFO } from "@/lib/ai/providers";
import { toYmd } from "@/lib/dates";
import { stripUntrusted } from "@/lib/events/prompt";
import { nodeInfo, parseRef } from "@/lib/ontology/graph";
import { displayId, runId } from "@/lib/ontology/ids";
import { OBJECT_TYPES, type Ref, refKey } from "@/lib/ontology/types";
import { type AgentSession, getProfile } from "@/lib/repos/ai";
import { getEvent } from "@/lib/repos/events";
import { getMemory, listMemoryUses } from "@/lib/repos/memories";
import { getNote } from "@/lib/repos/notes";
import { type RunView, getRun } from "@/lib/repos/runs";
import { getTrigger, getTriggerRun } from "@/lib/repos/triggers";
import { redactSecrets } from "./redact";

const REQUEST_CHARS = 800;
const RESULT_CHARS = 1500;
const MAX_LINES = 50;

const RUN_LABEL: Record<string, string> = { applied: "적용", pending: "승인 대기", rejected: "거절", failed: "실패", denied: "거부", cancelled: "철회" };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();
const pad = (n: number) => String(n).padStart(2, "0");
/** 로컬 시각 'YYYY-MM-DD HH:MM' */
const when = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${toYmd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export type EpisodeDraft = {
  title: string;
  body: string;
  tainted: boolean;
  /** tainted 판정 이유 (감사 결과 data 에 남긴다) */
  taintReason: string;
  businessId: number | null;
  /** 세션이 실행한 액션 run 들의 refs — 에피소드에서 mentions 링크 */
  mentions: Ref[];
  runIds: number[];
};

/** 세션 → 트리거 실행 → 트리거 · 이벤트 */
function origin(db: DB, s: AgentSession) {
  const run = s.trigger_run_id ? getTriggerRun(db, s.trigger_run_id) : undefined;
  const trigger = run ? getTrigger(db, run.trigger_id) : undefined;
  const event = run?.event_id ? getEvent(db, run.event_id) : undefined;
  return { run, trigger, event };
}

/** 이벤트 페이로드·대상이 가리키는 기억·문서 중 오염된 것이 있는가 */
function eventTouchesTainted(db: DB, e: NonNullable<ReturnType<typeof getEvent>>): boolean {
  const refs: Ref[] = [];
  if (e.subject_type && e.subject_id && (OBJECT_TYPES as readonly string[]).includes(e.subject_type)) refs.push({ type: e.subject_type as Ref["type"], id: e.subject_id });
  const p = e.payload as Record<string, unknown>;
  for (const r of Array.isArray(p.refs) ? p.refs : []) {
    const x = r as Ref;
    if (x && typeof x.id === "number" && (OBJECT_TYPES as readonly string[]).includes(x.type)) refs.push(x);
  }
  for (const k of ["memory_id", "other_id"]) if (typeof p[k] === "number") refs.push({ type: "memory", id: p[k] as number });
  if (typeof p.note_id === "number") refs.push({ type: "note", id: p.note_id });
  return refs.some((r) => (r.type === "memory" ? !!getMemory(db, r.id)?.tainted : r.type === "note" ? !!getNote(db, r.id)?.tainted : false));
}

/** 이벤트 대상 객체를 (이벤트 시점까지) 마지막으로 바꾼 적용 run 의 행위자가 에이전트인가 */
function lastWriterIsAgent(db: DB, e: NonNullable<ReturnType<typeof getEvent>>): boolean {
  if (!e.subject_type || !e.subject_id || !(OBJECT_TYPES as readonly string[]).includes(e.subject_type)) return false;
  const actor = db
    .prepare(
      `SELECT r.actor_type FROM action_run_refs f JOIN action_runs r ON r.id = f.run_id
       WHERE f.object_type = ? AND f.object_id = ? AND r.status = 'applied' AND r.created_at <= ? ORDER BY r.id DESC LIMIT 1`,
    )
    .pluck()
    .get(e.subject_type, e.subject_id, e.created_at) as string | undefined;
  return actor === "agent";
}

/**
 * 에피소드 오염(tainted) 규칙 — 세션이 무엇으로 시작됐나:
 *  - 사람이 직접 지시(ai.run, 트리거 없음) → 0
 *  - 스케줄(schedule.fired) · 사람의 수동 트리거 실행(manual.fired) · 신호 같은 시스템 이벤트 → 0
 *    (단 시스템 이벤트의 대상 객체를 마지막으로 쓴 행위자가 에이전트면 → 1: 신호 제목에 그 에이전트가 쓴 텍스트가 담긴다)
 *  - 이벤트 트리거인데 그 이벤트의 행위자가 에이전트 → 1 (다른 에이전트가 쓴 내용이 프롬프트로 들어왔다)
 *  - 이벤트 페이로드·대상이 외부 유래(tainted) 문서·기억을 가리킴 → 1
 *  - 그 밖의 사람 행동 이벤트 → 0
 * 세션 도중 도구로 읽은 내용은 보지 않는다 — 결과 문장에 섞일 수 있지만, 판정은 "누가 이 세션을 시작시켰나"로 한정한다.
 */
export function episodeTaint(db: DB, s: AgentSession): { tainted: boolean; reason: string } {
  if (!s.trigger_run_id) return { tainted: false, reason: "사람이 직접 지시한 세션" };
  const { event } = origin(db, s);
  if (!event) return { tainted: false, reason: "트리거 이벤트 없음" };
  if (event.type === "schedule.fired" || event.type === "manual.fired") return { tainted: false, reason: `${event.type} — 스케줄·수동 실행` };
  if (event.actor_type === "agent") return { tainted: true, reason: `에이전트가 일으킨 이벤트(${event.type})로 시작` };
  if (eventTouchesTainted(db, event)) return { tainted: true, reason: `외부 출처 문서·기억을 가리키는 이벤트(${event.type})로 시작` };
  // 시스템 이벤트(신호 등)의 제목·요약은 대상 객체의 내용이다 — 그 객체를 마지막으로 쓴 행위자가 에이전트면 에이전트가 쓴 텍스트가 들어왔다
  if (event.actor_type !== "human" && lastWriterIsAgent(db, event)) return { tainted: true, reason: `에이전트가 마지막으로 쓴 객체에 대한 시스템 이벤트(${event.type})로 시작` };
  return { tainted: false, reason: `${event.actor_type ?? "시스템"} 이벤트(${event.type})로 시작` };
}

/** 세션 시간 범위 안에서 그 세션의 에이전트가 요청한 액션 run (실행 중 동시에 도는 같은 프로필의 다른 세션과는 구별하지 못한다) */
export function sessionRuns(db: DB, s: AgentSession, agentId: number): RunView[] {
  const ids = db
    .prepare("SELECT id FROM action_runs WHERE actor_type = 'agent' AND actor_id = ? AND created_at >= ? AND created_at <= ? ORDER BY id")
    .pluck()
    .all(String(agentId), s.started_at, s.finished_at ?? new Date().toISOString()) as number[];
  return ids.map((id) => getRun(db, id)!).filter(Boolean);
}

/** 팩 항목 ref → 한 줄 ("[mem:12] 문장" · "[playbook:3] 제목" · "[doc:5] 제목" · "[obj:client:3] 이름") */
function refLine(db: DB, key: string): string {
  const r = parseRef(key);
  if (!r) return `- ${key}`;
  if (r.type === "memory") {
    const m = getMemory(db, r.id);
    return `- [mem:${r.id}] ${m ? oneLine(m.statement) : "(삭제됨)"}`;
  }
  if (r.type === "note") {
    const n = getNote(db, r.id);
    return `- [${n?.kind === "playbook" ? "playbook" : "doc"}:${r.id}] ${n ? oneLine(n.title) : "(삭제됨)"}`;
  }
  const info = nodeInfo(db, [r]).get(refKey(r));
  return `- [obj:${refKey(r)}] ${info ? `${info.displayId} ${oneLine(info.title)}` : "(삭제됨)"}`;
}

const list = (lines: string[]) => (lines.length ? (lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `- … 외 ${lines.length - MAX_LINES}건`] : lines) : ["- 없음"]);

/** 끝난 세션 → 에피소드 초안 (제목 · 본문 · 오염 · 사업 · 언급 대상). 본문의 비밀값은 가린다. */
export function buildEpisode(db: DB, s: AgentSession): EpisodeDraft {
  const p = getProfile(db, s.profile_id);
  const { run, trigger, event } = origin(db, s);
  const source = trigger ? trigger.name : s.trigger_run_id ? `트리거 실행 #${s.trigger_run_id}${run ? "" : " (삭제됨)"}` : "수동 실행";
  const outcome = s.status === "succeeded" ? "성공" : "실패";
  const title = `세션 #${s.id} · ${source} · ${outcome}`;
  const agentId = p?.agent_id ?? 0;
  const model = p ? p.model || PROVIDER_INFO[p.provider].defaultModel || "기본 모델" : "";

  const request = clip(stripUntrusted(s.prompt), REQUEST_CHARS);
  const eventLine = event
    ? `이벤트: ${event.type}${event.subject_type && event.subject_id && (OBJECT_TYPES as readonly string[]).includes(event.subject_type) ? ` · 대상 ${displayId(event.subject_type as Ref["type"], event.subject_id)}` : ""}${typeof event.payload.title === "string" ? ` · 제목(데이터): ${oneLine(event.payload.title).replace(/</g, "＜")}` : ""}`
    : "";
  const result = s.status === "succeeded" ? clip(s.final_text.trim() || "(응답 텍스트 없음)", RESULT_CHARS) : `오류: ${s.error ?? "알 수 없음"}${s.final_text.trim() ? `\n\n${clip(s.final_text.trim(), RESULT_CHARS)}` : ""}`;

  const runs = agentId ? sessionRuns(db, s, agentId) : [];
  const runLines = runs.map((r) => `- ${runId(r.id)} ${r.action} · ${RUN_LABEL[r.status] ?? r.status} · ${oneLine(clip(r.result?.summary ?? r.error ?? "", 160))}`);
  const seen = s.context_refs.map((k) => refLine(db, k));
  const cited = [...new Set(listMemoryUses(db, { sessionId: s.id, how: "cited", limit: 1000 }).map((u) => u.memory_id))]
    .sort((a, b) => a - b)
    .map((id) => refLine(db, `memory:${id}`));

  const body = [
    `# ${title}`,
    `- 프로필: ${p ? `${p.name} (${p.provider}${model ? ` · ${model}` : ""})` : "(삭제됨)"} · 에이전트 ${agentId ? displayId("agent", agentId) : "—"}`,
    `- 시각: 시작 ${when(s.started_at)} · 종료 ${when(s.finished_at)} · 단계 ${s.steps} · 도구 호출 ${s.tool_calls}`,
    "## 요청",
    request || "(지시문 없음)",
    ...(eventLine ? ["", eventLine] : []),
    "## 결과",
    result,
    "## 실행한 액션",
    ...list(runLines),
    "## 참고한 기억·문서",
    ...list(seen),
    "## 인용한 기억",
    ...list(cited),
  ].join("\n");

  // 언급 대상 = 실행한 액션들이 건드린 객체 (지금 있는 것만), 사업 = 그 객체들의 사업이 하나로 모이면 그 사업
  const refs = new Map<string, Ref>();
  for (const r of runs) for (const x of r.refs) refs.set(refKey(x), x);
  const info = nodeInfo(db, [...refs.values()]);
  const mentions = [...refs.values()].filter((r) => info.has(refKey(r)));
  const businesses = new Set(mentions.map((r) => (r.type === "business" ? r.id : info.get(refKey(r))?.businessId ?? null)).filter((x): x is number => x !== null));
  const taint = episodeTaint(db, s);
  return {
    title,
    body: redactSecrets(body),
    tainted: taint.tainted,
    taintReason: taint.reason,
    businessId: businesses.size === 1 ? [...businesses][0] : null,
    mentions,
    runIds: runs.map((r) => r.id),
  };
}
