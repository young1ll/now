import { AGENT_STATUSES, createAgent, getAgent, setAgentStatus } from "@/lib/repos/agents";
import { AI_MODES, getAiMode, setSetting } from "@/lib/repos/settings";
import { backupNow } from "@/lib/system";
import { defineAction } from "../action";
import { f } from "../fields";
import { displayId } from "../ids";
import { ActionError } from "../types";
import { must } from "./util";

export const AI_MODE_LABEL = {
  autonomous: "자율 — 모두 즉시 실행, 감사만",
  guarded: "가드 — 고위험만 승인",
  supervised: "감독 — 모든 쓰기 승인",
  frozen: "동결 — 에이전트 쓰기 차단",
} as const;

const AGENT_STATUS_LABEL = { active: "활성", suspended: "정지", revoked: "폐기" } as const;

export const systemActions = [
  defineAction({
    name: "system.backup",
    title: "지금 백업",
    description: "데이터베이스 전체를 일관된 스냅샷으로 백업한다 (data/backups, 최근 30개 보관). 부작용 없음.",
    objectType: "system",
    risk: "low",
    noTransaction: true,
    fields: {},
    run({ db }) {
      const b = backupNow(db);
      return { summary: `백업 ${b.file} (${Math.round(b.bytes / 1024)} KB)`, refs: [], data: b };
    },
  }),
  defineAction({
    name: "agent.register",
    title: "에이전트 등록",
    description: "외부 AI 에이전트를 등록하고 API 토큰을 발급한다 (토큰은 한 번만 표시).",
    objectType: "agent",
    risk: "high",
    humanOnly: true,
    fields: { name: f.text("이름", { required: true, placeholder: "Claude Code (운영)" }), description: f.textarea("역할 설명") },
    run({ db, out }, i) {
      const { id, token } = createAgent(db, { name: i.name, description: i.description ?? "" });
      out.token = token; // 감사 기록에는 남기지 않는다
      return { summary: `에이전트 ${displayId("agent", id)} '${i.name}' 등록`, refs: [{ type: "agent", id }] };
    },
  }),
  defineAction({
    name: "agent.set_status",
    title: "에이전트 상태 변경",
    description: "에이전트를 정지(suspended)·재개(active)·폐기(revoked)한다. 정지·폐기된 토큰은 즉시 거부된다.",
    objectType: "agent",
    risk: "high",
    humanOnly: true,
    target: { type: "agent", param: "id" },
    fields: {
      id: f.ref("에이전트", "agent", { required: true }),
      status: f.enum("상태", AGENT_STATUSES, AGENT_STATUS_LABEL, { required: true }),
    },
    run({ db }, i) {
      const a = must(getAgent(db, i.id), "에이전트");
      if (a.status === "revoked") throw new ActionError("폐기된 에이전트는 되살릴 수 없습니다. 새로 등록하세요");
      setAgentStatus(db, i.id, i.status);
      return { summary: `에이전트 '${a.name}' → ${AGENT_STATUS_LABEL[i.status]}`, refs: [{ type: "agent", id: i.id }] };
    },
  }),
  defineAction({
    name: "system.set_ai_mode",
    title: "AI 운영 모드 변경",
    description: "에이전트 쓰기 행동에 대한 사람의 개입 수준을 바꾼다.",
    objectType: "system",
    risk: "high",
    humanOnly: true,
    fields: { mode: f.enum("모드", AI_MODES, AI_MODE_LABEL, { required: true }) },
    run({ db }, i) {
      const prev = getAiMode(db);
      setSetting(db, "ai_mode", i.mode);
      return { summary: `AI 운영 모드 ${prev} → ${i.mode}`, refs: [] };
    },
  }),
];
