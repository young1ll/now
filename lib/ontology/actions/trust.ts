// 신뢰 사다리 액션 (docs/MEMORY.md §15) — 에이전트의 역할·허용 범위·사업 범위·자율 권한·기억 등급, 실행 문제 표시.
// 모두 사람 전용이다. 넓히는 것(권한 부여·등급 상승·범위 확대)은 사람만, 좁히는 것(회수·강등)은 워커의 enforceTrust 도
// SYSTEM 행위자로 같은 액션을 부른다 — 자동 강등도 감사 로그에 사유와 함께 남는다.
import type { DB } from "@/lib/db";
import { AGENT_ROLE, MEMORY_TRUST, ROLE_DEFAULT_ALLOWED } from "@/lib/labels";
import {
  AGENT_ROLES, type Agent, MEMORY_TRUST_LEVELS, activeGrant, configureAgent, extendGrant, getAgent, getGrant, grantState, insertGrant, revokeGrant,
} from "@/lib/repos/agents";
import { getBusiness } from "@/lib/repos/businesses";
import { getRun, setRunFlag } from "@/lib/repos/runs";
import { type AnyAction, defineAction, definedActions } from "../action";
import { f } from "../fields";
import { displayId, runId } from "../ids";
import { NON_ACTION_WRITES, actionAllowed, normalizeAllowed } from "../policy";
import { ActionError, type Actor, type Ref } from "../types";
import { checkBusiness, labels, must } from "./util";

const AGT = (id: number) => displayId("agent", id);
const agentRef = (id: number): Ref => ({ type: "agent", id });
const who = (a: Actor) => a.name || `${a.type}:${a.id}`;

/** 에이전트에게 줄 수 있는 액션 (사람 전용은 허용 목록에 넣어도 정책이 거부한다) */
const agentActions = (): AnyAction[] => definedActions().filter((a) => !a.humanOnly);

/**
 * 허용 범위 입력 검증: 쉼표 glob, 각 항목이 알려진 액션 하나 이상과 맞아야 한다 (오타 방지). "*" 허용.
 * 정규화한 문자열을 돌려준다. 빈 값은 "아무것도 못 함" — 명시적으로 막고 싶으면 에이전트를 정지하라.
 */
export function validateAllowed(raw: string): string {
  const s = normalizeAllowed(raw);
  if (!s) throw new ActionError("허용 액션이 비어 있습니다 — 전부 허용은 '*', 쓰기를 모두 막으려면 에이전트를 정지하세요");
  const names = [...definedActions().map((a) => a.name), ...NON_ACTION_WRITES];
  for (const p of s.split(",")) {
    if (p === "*") continue;
    if (!/^[a-z_*][a-z0-9_.*]*$/.test(p)) throw new ActionError(`허용 액션 형식이 올바르지 않습니다: '${p}' — 예: memory.*, note.create`);
    if (!names.some((n) => actionAllowed(p, n))) throw new ActionError(`알려진 액션과 맞지 않는 항목: '${p}' — 오타인지 확인하세요 (list_actions)`);
  }
  return s;
}

/** 새 허용 범위가 이전에 없던 에이전트 액션을 허용하는가 */
function widensActions(before: string, after: string): string[] {
  return [...agentActions().map((a) => a.name), ...NON_ACTION_WRITES]
    .filter((n) => actionAllowed(after, n) && !actionAllowed(before, n));
}

const scopeLabel = (db: DB, id: number | null) => (id === null ? "전체" : (getBusiness(db, id)?.name ?? `사업 ${id}`));

function liveAgent(db: DB, id: number): Agent {
  const a = must(getAgent(db, id), "에이전트");
  if (a.status === "revoked") throw new ActionError("폐기된 에이전트입니다");
  return a;
}

const roleField = f.enum("역할", AGENT_ROLES, AGENT_ROLE, { help: "operator=운영자 · curator=큐레이터(기억 정리) · researcher=리서처 · custom=사용자 정의 — 표시·기본값용, 권한은 허용 액션·사업 범위가 정한다" });
const allowedField = f.text("허용 액션", {
  max: 500,
  help: "쉼표로 구분한 glob — '*' 전부, 'memory.*,note.create'. 각 항목은 알려진 액션과 맞아야 한다. 에이전트가 이 밖의 액션을 요청하면 거부(denied)",
  placeholder: "memory.*, note.create",
});
const scopeField = f.ref("사업 범위", "business", { nullable: true, help: "이 사업의 객체만 읽고 쓴다. 비우면 전체 사업" });

/** agent.register 의 선택 필드 (system.ts) */
export const registerScopeFields = { role: roleField, allowed_actions: allowedField, business_scope: scopeField };

/** agent.register 의 역할·범위 정규화: 허용 범위를 생략하면 역할의 기본값 */
export function registerScope(db: DB, i: { role?: Agent["role"]; allowed_actions?: string; business_scope?: number | null }) {
  const role = i.role ?? "operator";
  const allowed = validateAllowed(i.allowed_actions?.trim() ? i.allowed_actions : ROLE_DEFAULT_ALLOWED[role]);
  checkBusiness(db, i.business_scope);
  return { role, allowed_actions: allowed, business_scope: i.business_scope ?? null };
}

export const trustActions = [
  defineAction({
    name: "agent.configure",
    title: "에이전트 설정",
    description:
      "에이전트의 역할 · 허용 액션(쉼표 glob) · 사업 범위를 바꾼다. 사업 범위(비우면 전체)가 있으면 그 사업의 객체만 읽고 쓴다. 범위를 넓히는 변경은 요약에 '권한 확대'로 남는다. 이미 승인 대기 중인 요청도 승인 시점에 새 범위로 다시 검사된다.",
    objectType: "agent",
    risk: "high",
    humanOnly: true,
    target: { type: "agent", param: "id" },
    fields: { id: f.ref("에이전트", "agent", { required: true }), role: roleField, allowed_actions: allowedField, business_scope: scopeField },
    prefill: (db, id) => {
      const a = getAgent(db, id);
      return a && { role: a.role, allowed_actions: a.allowed_actions, business_scope: a.business_scope };
    },
    run({ db }, i) {
      const a = liveAgent(db, i.id);
      const role = i.role ?? a.role;
      const allowed = i.allowed_actions === undefined ? a.allowed_actions : validateAllowed(i.allowed_actions);
      const scope = i.business_scope === undefined ? a.business_scope : i.business_scope;
      checkBusiness(db, scope);
      const changes: string[] = [];
      if (role !== a.role) changes.push(`역할 ${AGENT_ROLE[a.role]} → ${AGENT_ROLE[role]}`);
      if (allowed !== a.allowed_actions) changes.push(`허용 ${a.allowed_actions} → ${allowed}`);
      if (scope !== a.business_scope) changes.push(`범위 ${scopeLabel(db, a.business_scope)} → ${scopeLabel(db, scope)}`);
      if (!changes.length) throw new ActionError("바뀐 설정이 없습니다");
      const newActions = widensActions(a.allowed_actions, allowed);
      // 범위 확대: 전체로 풀거나 다른 사업으로 옮기면 이전에 못 보던 사업에 닿는다
      const widerScope = a.business_scope !== null && scope !== a.business_scope;
      const widened = newActions.length > 0 || widerScope;
      configureAgent(db, a.id, { role, allowed_actions: allowed, business_scope: scope });
      return {
        summary: `에이전트 ${AGT(a.id)} '${a.name}' 설정 — ${changes.join(" · ")}${widened ? " · 권한 확대" : ""}`,
        refs: [agentRef(a.id), ...(scope !== null ? [{ type: "business" as const, id: scope }] : [])],
        data: { widened, new_actions: newActions.slice(0, 50), before: { role: a.role, allowed_actions: a.allowed_actions, business_scope: a.business_scope }, after: { role, allowed_actions: allowed, business_scope: scope } },
      };
    },
  }),
  defineAction({
    name: "agent.grant",
    title: "자율 권한 부여",
    description:
      "가드 모드에서 이 에이전트의 고위험 액션 하나를 승인 없이 실행하게 한다 (정확한 액션 이름 하나 · 1~90일 뒤 만료). 저위험 액션은 권한이 필요 없다. 같은 액션의 유효 권한이 있으면 만료일을 연장한다. 감독 모드에서는 무시되고, 권한으로 실행한 결과가 문제 표시(run.flag)되면 자동 회수된다.",
    objectType: "agent",
    risk: "high",
    humanOnly: true,
    fields: {
      agent_id: f.ref("에이전트", "agent", { required: true }),
      action: f.text("액션", { required: true, max: 100, help: "정확한 액션 이름 (glob 아님) — 예: task.delete", placeholder: "task.delete" }),
      days: f.number("기간 (일)", { int: true, min: 1, max: 90, help: "1~90, 기본 30" }),
    },
    preview: (_db, i) => `자율 권한 ${i.action} · ${i.days ?? 30}일`,
    run({ db, actor }, i) {
      const a = liveAgent(db, i.agent_id);
      const name = i.action.trim();
      const def = definedActions().find((x) => x.name === name);
      if (!def) throw new ActionError(`알 수 없는 액션: ${name}`);
      if (def.humanOnly) throw new ActionError(`${name} 은(는) 사람 전용 액션이라 에이전트에게 권한을 줄 수 없습니다`);
      if (def.risk === "low") throw new ActionError(`${name} 은(는) 저위험 액션이라 권한이 필요 없습니다 — 가드 모드에서 바로 실행됩니다`);
      if (!actionAllowed(a.allowed_actions, name)) throw new ActionError(`${name} 은(는) 이 에이전트의 허용 범위(${a.allowed_actions}) 밖입니다 — 먼저 agent.configure 로 허용하세요`);
      const days = i.days ?? 30;
      const now = new Date();
      const until = new Date(now.getTime() + days * 86_400_000).toISOString();
      const cur = activeGrant(db, a.id, name, now);
      if (cur) {
        const expires = cur.expires_at > until ? cur.expires_at : until;
        extendGrant(db, cur.id, expires);
        return {
          summary: `에이전트 '${a.name}' 자율 권한 ${name} 연장 → ${expires.slice(0, 10)}`,
          refs: [agentRef(a.id)],
          data: { grant_id: cur.id, action: name, expires_at: expires, extended: true },
        };
      }
      const id = insertGrant(db, { agent_id: a.id, action: name, granted_by: who(actor), granted_at: now.toISOString(), expires_at: until });
      return {
        summary: `에이전트 '${a.name}' 자율 권한 ${name} · ${days}일 (만료 ${until.slice(0, 10)})`,
        refs: [agentRef(a.id)],
        data: { grant_id: id, action: name, expires_at: until, extended: false },
      };
    },
  }),
  defineAction({
    name: "agent.revoke_grant",
    title: "자율 권한 회수",
    description: "유효한 자율 권한을 회수한다. 이후 그 액션은 가드 모드에서 다시 승인이 필요하다.",
    objectType: "agent",
    risk: "low",
    humanOnly: true,
    fields: { grant_id: f.number("권한 id", { required: true, int: true, min: 1 }), reason: f.text("사유", { required: true, max: 300 }) },
    preview: (db, i) => `자율 권한 #${i.grant_id} 회수 (${getGrant(db, i.grant_id)?.action ?? "?"})`,
    run({ db, actor }, i) {
      const g = must(getGrant(db, i.grant_id), "자율 권한");
      const state = grantState(g);
      if (state !== "active") throw new ActionError(`이미 ${state === "revoked" ? "회수된" : "만료된"} 권한입니다`);
      revokeGrant(db, g.id, who(actor), i.reason);
      const a = getAgent(db, g.agent_id);
      return {
        summary: `에이전트 '${a?.name ?? AGT(g.agent_id)}' 자율 권한 ${g.action} 회수 — ${i.reason}`,
        refs: [agentRef(g.agent_id)],
        data: { grant_id: g.id, action: g.action },
      };
    },
  }),
  defineAction({
    name: "agent.set_memory_trust",
    title: "기억 등급 변경",
    description:
      "에이전트의 기억 제안이 어디에 착지하는가: propose(항상 제안됨 — 사람 확인 필요) · active(근거 2개 이상이고 외부 출처가 아니면 활성으로 착지). 올리는 것은 사람, 내리는 것은 워커(사람이 거절·정정한 활성 착지 기억 2건 이상 — 14일)도 한다.",
    objectType: "agent",
    risk: "high",
    humanOnly: true,
    fields: {
      agent_id: f.ref("에이전트", "agent", { required: true }),
      level: f.enum("기억 등급", MEMORY_TRUST_LEVELS, labels(MEMORY_TRUST), { required: true }),
      note: f.text("메모", { max: 300 }),
    },
    run({ db }, i) {
      const a = liveAgent(db, i.agent_id);
      if (a.memory_trust === i.level) throw new ActionError(`이미 기억 등급이 '${MEMORY_TRUST[i.level].label}' 입니다`);
      configureAgent(db, a.id, { memory_trust: i.level });
      return {
        summary: `에이전트 '${a.name}' 기억 등급 ${MEMORY_TRUST[a.memory_trust].label} → ${MEMORY_TRUST[i.level].label}${i.note?.trim() ? ` — ${i.note.trim()}` : ""}`,
        refs: [agentRef(a.id)],
        data: { before: a.memory_trust, after: i.level },
      };
    },
  }),
  defineAction({
    name: "run.flag",
    title: "실행 문제 표시",
    description: "적용된 에이전트 실행을 '문제였다'고 표시한다. 신뢰 지표(문제 표시 수)와 자율 권한 자동 회수에 반영된다. 되돌리기는 아니다 — 필요하면 따로 고친다.",
    objectType: "system",
    risk: "low",
    humanOnly: true,
    fields: { run_id: f.number("실행 id", { required: true, int: true, min: 1 }), note: f.text("무엇이 문제였나", { required: true, max: 500 }) },
    run({ db, actor }, i) {
      const r = must(getRun(db, i.run_id), "실행 기록");
      if (r.actor_type !== "agent") throw new ActionError("에이전트의 실행만 문제 표시할 수 있습니다");
      if (r.status !== "applied") throw new ActionError(`적용된 실행만 문제 표시할 수 있습니다 (현재: ${r.status})`);
      if (r.flagged_at) throw new ActionError(`${runId(r.id)} 은(는) 이미 문제 표시되어 있습니다`);
      setRunFlag(db, r.id, { by: who(actor), note: i.note });
      return {
        summary: `${runId(r.id)} (${r.action} · ${r.actor_name}) 문제 표시: ${i.note}`,
        refs: [agentRef(Number(r.actor_id)), ...r.refs.filter((x) => x.type !== "agent")],
        data: { run_id: r.id, action: r.action, agent_id: Number(r.actor_id) },
      };
    },
  }),
  defineAction({
    name: "run.unflag",
    title: "문제 표시 해제",
    description: "잘못 붙인 문제 표시를 해제한다. 이미 자동 회수된 권한은 되살아나지 않는다 (다시 부여해야 한다).",
    objectType: "system",
    risk: "low",
    humanOnly: true,
    fields: { run_id: f.number("실행 id", { required: true, int: true, min: 1 }) },
    run({ db }, i) {
      const r = must(getRun(db, i.run_id), "실행 기록");
      if (!r.flagged_at) throw new ActionError(`${runId(r.id)} 은(는) 문제 표시되어 있지 않습니다`);
      setRunFlag(db, r.id, null);
      return { summary: `${runId(r.id)} 문제 표시 해제`, refs: [agentRef(Number(r.actor_id))], data: { run_id: r.id } };
    },
  }),
];
