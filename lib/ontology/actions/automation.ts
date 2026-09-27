// 자동화 설정 액션 — 트리거 · AI 프로필 · AI 세션 요청. 설정은 사람 전용, 실행 요청은 기록된다.
import { PROVIDER_INFO } from "@/lib/ai/providers";
import { validateCron } from "@/lib/events/cron";
import { createAgent } from "@/lib/repos/agents";
import { PROVIDERS, createSession, deleteProfile, getProfile, insertProfile, updateProfile } from "@/lib/repos/ai";
import { emitEvent } from "@/lib/repos/events";
import { deleteTrigger, enqueueRun, getTrigger, insertTrigger, updateTrigger } from "@/lib/repos/triggers";
import { defineAction } from "../action";
import { f } from "../fields";
import { ActionError } from "../types";
import { must } from "./util";

const PROVIDER_LABELS = Object.fromEntries(PROVIDERS.map((p) => [p, PROVIDER_INFO[p].label])) as Record<(typeof PROVIDERS)[number], string>;

const triggerFields = {
  name: f.text("이름", { required: true }),
  kind: f.enum("유형", ["event", "schedule"] as const, { event: "이벤트", schedule: "스케줄(cron)" }, { required: true }),
  event_pattern: f.text("이벤트 패턴", { help: "signal.raised · action.pending · action.* · 쉼표로 여러 개", placeholder: "signal.raised" }),
  filter: f.textarea("필터 (JSON)", { help: '예: {"payload.severity": ["critical"], "payload.kind": "invoice.overdue"}' }),
  schedule: f.text("스케줄 (cron)", { help: "분 시 일 월 요일 — 예: 0 8 * * 1-5 (평일 08:00)", placeholder: "0 8 * * 1-5" }),
  target: f.enum("대상", ["agent", "webhook"] as const, { agent: "AI 에이전트 실행", webhook: "웹훅 POST" }, { required: true }),
  profile_id: f.choice("AI 프로필", "ai_profiles"),
  prompt_template: f.textarea("프롬프트 템플릿", { help: "{{event.type}} · {{event.payload.title}} · {{event_json}} 치환. 비우면 기본 지시문" }),
  webhook_url: f.text("웹훅 URL", { max: 500, placeholder: "https://… 또는 env:SLACK_WEBHOOK_URL", help: "URL 에 비밀이 들어 있으면(Slack·Discord) env:환경변수이름 으로 — 발송 시점에 읽는다" }),
  secret_env: f.text("서명 비밀 환경변수 이름", { help: "X-Now-Signature: sha256=HMAC(본문) — 값은 .env.local 에만" }),
  cooldown_sec: f.number("쿨다운 (초)", { int: true, min: 0, max: 86400 }),
  enabled: f.boolean("활성"),
};

type TriggerIn = { [K in keyof typeof triggerFields]?: unknown };

function normalizeTrigger(i: TriggerIn) {
  const kind = String(i.kind) as "event" | "schedule";
  const target = String(i.target) as "agent" | "webhook";
  const filterText = String(i.filter ?? "").trim() || "{}";
  try {
    const parsed = JSON.parse(filterText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
  } catch {
    throw new ActionError("필터는 JSON 객체여야 합니다");
  }
  if (kind === "event" && !String(i.event_pattern ?? "").trim()) throw new ActionError("이벤트 패턴을 입력하세요 (예: signal.raised)");
  if (kind === "schedule") {
    const err = validateCron(String(i.schedule ?? ""));
    if (err) throw new ActionError(err);
  }
  if (target === "webhook" && !/^(https?:\/\/|env:[A-Z_][A-Z0-9_]*$)/.test(String(i.webhook_url ?? ""))) throw new ActionError("웹훅 URL 은 http(s):// 또는 env:환경변수이름 이어야 합니다");
  if (target === "agent" && !i.profile_id) throw new ActionError("AI 프로필을 선택하세요");
  const secret = String(i.secret_env ?? "").trim();
  if (secret && !/^[A-Z_][A-Z0-9_]*$/.test(secret)) throw new ActionError("서명 비밀에는 값이 아니라 환경변수 이름만 입력하세요");
  return {
    name: String(i.name),
    kind,
    event_pattern: kind === "event" ? String(i.event_pattern).trim() : "",
    filter: filterText,
    schedule: kind === "schedule" ? String(i.schedule).trim() : "",
    target,
    webhook_url: target === "webhook" ? String(i.webhook_url).trim() : "",
    secret_env: target === "webhook" ? secret : "",
    profile_id: target === "agent" ? Number(i.profile_id) : null,
    prompt_template: String(i.prompt_template ?? ""),
    cooldown_sec: Number(i.cooldown_sec ?? 0),
    enabled: i.enabled !== false,
  };
}

const profileFields = {
  name: f.text("이름", { required: true }),
  provider: f.enum("공급자", PROVIDERS, PROVIDER_LABELS, { required: true }),
  model: f.text("모델", { help: "비우면 공급자 기본값 (Claude: claude-opus-5)" }),
  base_url: f.text("Base URL", { max: 300, help: "비우면 공급자 기본값. 로컬: http://127.0.0.1:11434/v1" }),
  api_key_env: f.text("API 키 환경변수 이름", { help: "비우면 공급자 기본 (ANTHROPIC_API_KEY 등). 값은 .env.local 에만" }),
  command: f.textarea("명령 (로컬 CLI 에이전트)", { help: '예: claude -p --mcp-config .mcp.json · codex exec - · gemini -p "$(cat)"' }),
  system_prompt: f.textarea("추가 지시문", { help: "기본 운영 지시문 뒤에 덧붙는다 (역할·담당 사업·금지 사항)" }),
  max_steps: f.number("최대 단계", { int: true, min: 1, max: 50 }),
};

type ProfileIn = { [K in keyof typeof profileFields]?: unknown } & { enabled?: unknown };

function normalizeProfile(i: ProfileIn) {
  const provider = String(i.provider) as (typeof PROVIDERS)[number];
  const keyEnv = String(i.api_key_env ?? "").trim();
  if (keyEnv && !/^[A-Z_][A-Z0-9_]*$/.test(keyEnv)) throw new ActionError("API 키에는 값이 아니라 환경변수 이름만 입력하세요 (예: ANTHROPIC_API_KEY)");
  const baseUrl = String(i.base_url ?? "").trim();
  if (baseUrl && !/^https?:\/\//.test(baseUrl)) throw new ActionError("Base URL 은 http(s):// 로 시작해야 합니다");
  if (provider === "command" && !String(i.command ?? "").trim()) throw new ActionError("로컬 CLI 에이전트는 명령이 필요합니다");
  if (provider === "openai_compatible" && !baseUrl) throw new ActionError("OpenAI 호환 공급자는 Base URL 이 필요합니다");
  return {
    name: String(i.name),
    provider,
    model: String(i.model ?? "").trim(),
    base_url: baseUrl,
    api_key_env: keyEnv,
    command: String(i.command ?? "").trim(),
    system_prompt: String(i.system_prompt ?? ""),
    max_steps: Number(i.max_steps ?? 12),
    enabled: i.enabled !== false,
  };
}

export const automationActions = [
  defineAction({
    name: "trigger.create",
    title: "트리거 만들기",
    description: "이벤트나 스케줄에 반응해 AI 에이전트를 깨우거나 웹훅을 호출하는 트리거를 만든다.",
    objectType: "system",
    risk: "high",
    humanOnly: true,
    redact: ["webhook_url"],
    fields: triggerFields,
    run({ db }, i) {
      const id = insertTrigger(db, normalizeTrigger(i));
      return { summary: `트리거 '${i.name}' 생성`, refs: [], data: { trigger_id: id } };
    },
  }),
  defineAction({
    name: "trigger.update",
    title: "트리거 수정",
    description: "트리거 설정을 바꾼다 (넘긴 필드만).",
    objectType: "system",
    risk: "high",
    humanOnly: true,
    redact: ["webhook_url"],
    fields: { id: f.number("트리거 id", { required: true, int: true, min: 1 }), ...Object.fromEntries(Object.entries(triggerFields).map(([k, v]) => [k, { ...v, schema: v.schema.optional(), spec: { ...v.spec, required: false } }])) } as typeof triggerFields & { id: ReturnType<typeof f.number> },
    run({ db }, i) {
      const cur = must(getTrigger(db, Number(i.id)), "트리거");
      const merged: TriggerIn = { ...cur, enabled: !!cur.enabled, ...Object.fromEntries(Object.entries(i).filter(([, v]) => v !== undefined)) };
      updateTrigger(db, cur.id, normalizeTrigger(merged));
      return { summary: `트리거 '${merged.name}' 수정${i.enabled === false ? " (비활성)" : i.enabled === true ? " (활성)" : ""}`, refs: [] };
    },
  }),
  defineAction({
    name: "trigger.delete",
    title: "트리거 삭제",
    description: "트리거와 실행 기록을 삭제한다.",
    objectType: "system",
    risk: "high",
    humanOnly: true,
    fields: { id: f.number("트리거 id", { required: true, int: true, min: 1 }) },
    run({ db }, i) {
      const t = must(getTrigger(db, i.id), "트리거");
      deleteTrigger(db, i.id);
      return { summary: `트리거 '${t.name}' 삭제`, refs: [] };
    },
  }),
  defineAction({
    name: "trigger.fire",
    title: "트리거 수동 실행",
    description: "트리거를 지금 한 번 실행한다 (manual.fired 이벤트로). 워커가 곧 처리한다.",
    objectType: "system",
    risk: "low",
    humanOnly: true,
    fields: { id: f.number("트리거 id", { required: true, int: true, min: 1 }), note: f.text("메모") },
    run({ db, actor }, i) {
      const t = must(getTrigger(db, i.id), "트리거");
      const eventId = emitEvent(db, { type: "manual.fired", actor, payload: { trigger_id: t.id, trigger: t.name, note: i.note ?? "" } });
      const runId = enqueueRun(db, t.id, eventId);
      return { summary: `트리거 '${t.name}' 수동 실행 대기`, refs: [], data: { trigger_run_id: runId } };
    },
  }),
  defineAction({
    name: "ai_profile.create",
    title: "AI 프로필 만들기",
    description: "AI 공급자·모델로 일하는 실행 프로필을 만든다. 전용 에이전트 신원이 함께 생기고, 모든 행동은 그 신원으로 감사된다.",
    objectType: "agent",
    risk: "high",
    humanOnly: true,
    fields: profileFields,
    run({ db }, i) {
      const p = normalizeProfile(i);
      // 런타임은 토큰 없이 프로세스 안에서 도구를 부르므로, 발급 토큰은 버린다 (필요하면 에이전트 화면에서 재발급 대신 새 에이전트를 등록)
      const { id: agentId } = createAgent(db, { name: `AI · ${p.name}`, description: `${PROVIDER_INFO[p.provider].label}${p.model ? ` · ${p.model}` : ""} 실행 프로필` });
      const id = insertProfile(db, { ...p, agent_id: agentId });
      return { summary: `AI 프로필 '${p.name}' (${PROVIDER_INFO[p.provider].label}) 생성`, refs: [{ type: "agent", id: agentId }], data: { profile_id: id } };
    },
  }),
  defineAction({
    name: "ai_profile.update",
    title: "AI 프로필 수정",
    description: "AI 프로필 설정을 바꾼다.",
    objectType: "agent",
    risk: "high",
    humanOnly: true,
    fields: { id: f.number("프로필 id", { required: true, int: true, min: 1 }), ...profileFields, enabled: f.boolean("활성") },
    run({ db }, i) {
      const cur = must(getProfile(db, i.id), "AI 프로필");
      updateProfile(db, cur.id, normalizeProfile({ ...cur, enabled: !!cur.enabled, ...Object.fromEntries(Object.entries(i).filter(([, v]) => v !== undefined)) }));
      return { summary: `AI 프로필 '${i.name}' 수정`, refs: [{ type: "agent", id: cur.agent_id }] };
    },
  }),
  defineAction({
    name: "ai_profile.delete",
    title: "AI 프로필 삭제",
    description: "AI 프로필과 세션 기록을 삭제한다. 에이전트 신원은 감사 기록 보존을 위해 폐기 상태로 남는다.",
    objectType: "agent",
    risk: "high",
    humanOnly: true,
    fields: { id: f.number("프로필 id", { required: true, int: true, min: 1 }) },
    run({ db }, i) {
      const p = must(getProfile(db, i.id), "AI 프로필");
      db.prepare("UPDATE triggers SET profile_id = NULL, enabled = 0 WHERE profile_id = ?").run(p.id);
      deleteProfile(db, p.id);
      db.prepare("UPDATE agents SET status = 'revoked' WHERE id = ?").run(p.agent_id);
      return { summary: `AI 프로필 '${p.name}' 삭제 (연결된 트리거 비활성)`, refs: [{ type: "agent", id: p.agent_id }] };
    },
  }),
  defineAction({
    name: "ai.run",
    title: "AI 에게 지시",
    description: "AI 프로필에게 작업을 지시한다. 세션은 대기열에 들어가 워커가 실행한다.",
    objectType: "agent",
    risk: "low",
    humanOnly: true,
    fields: { profile_id: f.choice("AI 프로필", "ai_profiles", { required: true }), prompt: f.textarea("지시", { required: true }) },
    run({ db }, i) {
      const p = must(getProfile(db, Number(i.profile_id)), "AI 프로필");
      if (!p.enabled) throw new ActionError("비활성 프로필입니다");
      const id = createSession(db, p.id, String(i.prompt));
      return { summary: `'${p.name}' 에게 지시: ${String(i.prompt).slice(0, 60)}`, refs: [{ type: "agent", id: p.agent_id }], data: { session_id: id } };
    },
  }),
];
