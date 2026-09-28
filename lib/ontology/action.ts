import { z } from "zod";
import type { DB } from "@/lib/db";
import type { RunResult } from "@/lib/repos/runs";
import { type Fields, type InputOf, objectSchema } from "./fields";
import type { Actor, ObjectType, Ref, Risk } from "./types";

/** out: 호출자에게만 돌려주고 감사 기록에는 남기지 않는 값 (예: 발급 토큰) */
export type ActionCtx = { db: DB; actor: Actor; out: Record<string, unknown> };

export type ActionDef<S extends Fields = Fields> = {
  /** 점 표기 이름 (예: client.create). API·MCP·감사 로그의 식별자 */
  name: string;
  title: string;
  /** AI 에게 보여줄 설명 — 언제 쓰는지, 부작용이 무엇인지 */
  description: string;
  /** 이 액션이 속한 객체 유형 (카탈로그 분류) */
  objectType: ObjectType | "system";
  fields: S;
  /**
   * low: 즉시 실행 가능 / high: 외부 발송·삭제·금액 기록 → 가드 모드에서 승인 필요.
   * 함수면 (db, input, actor) — 행위자에 따라 다른 경우(에이전트가 플레이북을 고치면 high)에 actor 를 본다.
   */
  risk: Risk | ((db: DB, input: InputOf<S>, actor: Actor) => Risk);
  /** 사람만 실행 가능 (에이전트 관리, AI 모드 변경 등) */
  humanOnly?: boolean;
  /** 감사 기록에 남기지 않을 파라미터 (URL 에 비밀이 든 웹훅 등). humanOnly 액션에만 쓴다 — 승인 재실행에 원본이 필요 없도록 */
  redact?: string[];
  /**
   * 비밀값을 가릴 문자열 파라미터 (외부 본문을 받는 액션 — document.import). 검증 전에 redactSecrets 를 적용해
   * 감사 기록(params) · 승인 대기 · 실행이 모두 가린 값만 본다. 원문은 어디에도 남지 않는다.
   */
  secretFields?: string[];
  /** 트랜잭션 밖에서 실행해야 하는 액션 (VACUUM INTO 백업 등) */
  noTransaction?: boolean;
  /** 기존 객체를 대상으로 하는 액션이면 대상 유형과 id 파라미터 */
  target?: { type: ObjectType; param: keyof S & string };
  /**
   * 사업 범위 판정(policy.businessesOf)에 더할 객체 — 필드로 드러나지 않는 참조 (link.delete 의 양 끝, payment.delete 의 청구서).
   * "new_business" = 새 사업을 만든다 → 사업 범위가 있는 에이전트는 할 수 없다.
   */
  scopeRefs?: (db: DB, input: InputOf<S>) => Ref[] | "new_business";
  /** 수정 폼의 기본값 (대상 객체의 현재 값) */
  prefill?: (db: DB, id: number) => Partial<Record<keyof S, unknown>> | undefined;
  /** 승인 대기 시 보여줄 한 줄 요약 */
  preview?: (db: DB, input: InputOf<S>) => string;
  run: (ctx: ActionCtx, input: InputOf<S>) => RunResult;
};

export type AnyAction = ActionDef<Fields> & { schema: z.ZodType<Record<string, unknown>> };

/** 정의된 모든 액션 (이름 → 정의). 카탈로그(actions/index.ts)를 import 하면 순환이 되는 곳(액션 안의 검증)에서 쓴다 */
const DEFINED = new Map<string, AnyAction>();

export function defineAction<S extends Fields>(def: ActionDef<S>): AnyAction {
  const a = { ...(def as unknown as ActionDef<Fields>), schema: objectSchema(def.fields) as z.ZodType<Record<string, unknown>> };
  DEFINED.set(a.name, a);
  return a;
}

/** 지금까지 정의된 액션 — 실행 시점에는 카탈로그 전체 (executeAction 이 카탈로그를 불러온 뒤) */
export function definedActions(): AnyAction[] {
  return [...DEFINED.values()];
}

/** actor 를 모르면(화면의 위험도 표시 등) 에이전트로 본다 — 더 엄격한 쪽 */
const AGENT_VIEW: Actor = { type: "agent", id: "", name: "" };

export function resolveRisk(def: AnyAction, db: DB, input: Record<string, unknown>, actor: Actor = AGENT_VIEW): Risk {
  return typeof def.risk === "function" ? def.risk(db, input as never, actor) : def.risk;
}

export function targetRef(def: AnyAction, input: Record<string, unknown>): Ref | undefined {
  if (!def.target) return undefined;
  const id = input[def.target.param];
  return typeof id === "number" ? { type: def.target.type, id } : undefined;
}

/** AI 도구 목록용 JSON Schema. */
export function jsonSchemaOf(def: AnyAction) {
  const s = z.toJSONSchema(def.schema) as Record<string, unknown>;
  delete s.$schema;
  return s;
}
