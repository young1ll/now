import type { DB } from "@/lib/db";
import { type Agent, activeGrant, getAgent } from "@/lib/repos/agents";
import { getBusiness } from "@/lib/repos/businesses";
import { matchesPattern } from "@/lib/repos/events";
import { getAiMode } from "@/lib/repos/settings";
import type { AnyAction } from "./action";
import { nodeInfo, parseRef } from "./graph";
import type { Actor, Ref, Risk } from "./types";

/** execute 의 grantId: 가드 모드의 고위험 액션이 자율 권한(agent_grants)으로 실행될 때 — 감사 run 의 result.data.grant_id 에 남는다 */
export type Decision = { kind: "execute"; grantId?: number } | { kind: "approval"; why: string } | { kind: "deny"; why: string };

/** 허용 범위: 쉼표 구분 glob ("*" = 전부, "memory.*,note.create"). 빈 값이면 아무것도 허용하지 않는다 */
export function actionAllowed(allowed: string, action: string): boolean {
  return matchesPattern(allowed, action);
}

/**
 * 액션 레지스트리 밖의 에이전트 쓰기 경로 (REST 전용 — 입력이 커서 액션 필드로 담지 않는다: IaC 감사 스냅샷).
 * 허용 범위(allowed_actions glob)로 같이 다스린다 — agent.configure 의 오타 검사도 이 이름을 안다.
 */
export const NON_ACTION_WRITES = ["iac.record_snapshot"] as const;

/** 허용 범위 밖이면 거부 사유 (decide · approveRun · 액션 밖 쓰기 경로 공용) */
export function allowedDenial(agent: Pick<Agent, "role" | "allowed_actions">, name: string): string | null {
  return actionAllowed(agent.allowed_actions, name) ? null : `이 에이전트(역할 ${agent.role})의 허용 범위 밖 액션입니다 — 허용: ${agent.allowed_actions || "(없음)"}`;
}

/** 허용 목록 정규화: 공백 제거 · 빈 항목 제거 · 중복 제거 (순서 유지) */
export function normalizeAllowed(s: string): string {
  return [...new Set(s.split(",").map((p) => p.trim()).filter(Boolean))].join(",");
}

/**
 * 이 요청이 닿는 사업들: input.business_id + 대상 객체의 사업 + ref/ids/objref/refs 필드가 가리키는 객체들의 사업
 * + 액션이 따로 밝힌 참조(scopeRefs — link.delete 의 양 끝 등). 사업 없는 공용 객체(business_id NULL 문서·기억·에이전트)는 세지 않는다.
 * 대상이 사업 자체면 그 id. "new_business" = 새 사업을 만든다 (어떤 사업 범위에도 들지 않는다).
 * 존재하지 않는 객체는 건너뛴다 — 그런 요청은 액션이 실패시킨다.
 */
export function businessesOf(db: DB, def: AnyAction, input: Record<string, unknown>, target?: Ref): number[] | "new_business" {
  const refs: Ref[] = target ? [target] : [];
  for (const [key, field] of Object.entries(def.fields)) {
    const v = input[key];
    const { kind, ref } = field.spec;
    if (v === undefined || v === null) continue;
    if (kind === "ref" && ref && typeof v === "number") refs.push({ type: ref, id: v });
    else if (kind === "ids" && ref && Array.isArray(v)) {
      for (const x of v) if (typeof x === "number") refs.push({ type: ref, id: x });
    } else if (kind === "objref" && typeof v === "string") {
      const r = parseRef(v);
      if (r) refs.push(r);
    } else if (kind === "refs" && Array.isArray(v)) {
      for (const s of v) {
        const r = typeof s === "string" ? parseRef(s) : undefined;
        if (r) refs.push(r);
      }
    }
  }
  const extra = def.scopeRefs?.(db, input as never);
  if (extra === "new_business") return "new_business";
  refs.push(...(extra ?? []));
  const ids = new Set<number>();
  if (typeof input.business_id === "number") ids.add(input.business_id);
  for (const n of nodeInfo(db, refs).values()) if (n.businessId !== null) ids.add(n.businessId);
  return [...ids].sort((a, b) => a - b);
}

const businessName = (db: DB, id: number) => getBusiness(db, id)?.name ?? `사업 ${id}`;

/**
 * 에이전트의 허용 범위(allowed_actions)·사업 범위(business_scope) 검사. 벗어나면 거부 사유, 아니면 null.
 * decide 와 approveRun(승인 시점 재검사)이 같이 쓴다.
 */
export function scopeDenial(db: DB, agent: Agent, def: AnyAction, input: Record<string, unknown>, target?: Ref): string | null {
  const notAllowed = allowedDenial(agent, def.name);
  if (notAllowed) return notAllowed;
  if (agent.business_scope !== null) {
    const touched = businessesOf(db, def, input, target);
    const scopeName = businessName(db, agent.business_scope);
    if (touched === "new_business") return `사업 범위(${scopeName}) 밖입니다 — 새 사업은 만들 수 없습니다`;
    const outside = touched.filter((b) => b !== agent.business_scope);
    // 범위 밖 사업의 이름·id 는 알려 주지 않는다 (거부 사유는 에이전트에게 돌아간다 — 읽기 도구가 숨기는 소속을 다시 드러내지 않게).
    // 사람은 run 의 대상(refs)·입력으로 확인한다.
    if (outside.length) return `사업 범위(${scopeName}) 밖입니다 — 이 에이전트는 ${scopeName} 과(와) 사업 없는 공용 객체만 다룰 수 있습니다`;
  }
  return null;
}

/**
 * 누가 무엇을 바로 실행할 수 있는가.
 * 사람·시스템은 항상 실행 (감사는 동일하게 남음). 에이전트는 순서대로:
 * 상태 → 사람 전용 → 허용 범위 → 사업 범위 → AI 모드 (frozen 거부 · supervised 승인 · autonomous 실행 ·
 * guarded: 저위험 실행, 고위험은 유효한 자율 권한이 있으면 실행 아니면 승인).
 */
export function decide(db: DB, actor: Actor, def: AnyAction, risk: Risk, input: Record<string, unknown> = {}, target?: Ref, now = new Date()): Decision {
  if (actor.type !== "agent") return { kind: "execute" };
  // 실행 중인 세션이라도 에이전트가 정지·폐기되면 그 순간부터 쓰기 거부
  const agent = getAgent(db, Number(actor.id));
  if (!agent || agent.status !== "active") return { kind: "deny", why: "에이전트가 정지·폐기 상태입니다" };
  if (def.humanOnly) return { kind: "deny", why: "사람만 실행할 수 있는 액션입니다" };
  const out = scopeDenial(db, agent, def, input, target);
  if (out) return { kind: "deny", why: out };
  switch (getAiMode(db)) {
    case "frozen":
      return { kind: "deny", why: "AI 동결 모드 — 에이전트 쓰기가 차단되어 있습니다" };
    case "supervised":
      // 자율 권한은 가드 모드에서만 — 감독 모드는 사람이 모든 쓰기를 보겠다는 뜻이다
      return { kind: "approval", why: "감독 모드 — 모든 에이전트 쓰기는 승인이 필요합니다" };
    case "guarded": {
      if (risk !== "high") return { kind: "execute" };
      const grant = activeGrant(db, agent.id, def.name, now);
      return grant ? { kind: "execute", grantId: grant.id } : { kind: "approval", why: "고위험 액션 — 승인이 필요합니다" };
    }
    case "autonomous":
      return { kind: "execute" };
  }
}

/** 도구(읽기)의 범위 — 에이전트면 그 에이전트의 사업 범위·허용 액션, 사람·시스템이면 전부 */
export type Reach = {
  agent?: Agent;
  /** 사업 범위 (null = 전체) */
  scope: number | null;
  scopeName: string | null;
  /** 이 사업의 객체를 볼 수 있는가 — 사업 없는 공용 객체(null)는 항상 */
  seesBusiness: (businessId: number | null | undefined) => boolean;
  allowsAction: (name: string) => boolean;
};

export function reachOf(db: DB, actor: Actor): Reach {
  const agent = actor.type === "agent" ? getAgent(db, Number(actor.id)) : undefined;
  const scope = agent?.business_scope ?? null;
  return {
    agent,
    scope,
    scopeName: scope === null ? null : businessName(db, scope),
    seesBusiness: (b) => scope === null || b === null || b === undefined || b === scope,
    allowsAction: (name) => !agent || actionAllowed(agent.allowed_actions, name),
  };
}
