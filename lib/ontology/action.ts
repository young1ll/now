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
  /** low: 즉시 실행 가능 / high: 외부 발송·삭제·금액 기록 → 가드 모드에서 승인 필요 */
  risk: Risk | ((db: DB, input: InputOf<S>) => Risk);
  /** 사람만 실행 가능 (에이전트 관리, AI 모드 변경 등) */
  humanOnly?: boolean;
  /** 트랜잭션 밖에서 실행해야 하는 액션 (VACUUM INTO 백업 등) */
  noTransaction?: boolean;
  /** 기존 객체를 대상으로 하는 액션이면 대상 유형과 id 파라미터 */
  target?: { type: ObjectType; param: keyof S & string };
  /** 수정 폼의 기본값 (대상 객체의 현재 값) */
  prefill?: (db: DB, id: number) => Partial<Record<keyof S, unknown>> | undefined;
  /** 승인 대기 시 보여줄 한 줄 요약 */
  preview?: (db: DB, input: InputOf<S>) => string;
  run: (ctx: ActionCtx, input: InputOf<S>) => RunResult;
};

export type AnyAction = ActionDef<Fields> & { schema: z.ZodType<Record<string, unknown>> };

export function defineAction<S extends Fields>(def: ActionDef<S>): AnyAction {
  return { ...(def as unknown as ActionDef<Fields>), schema: objectSchema(def.fields) as z.ZodType<Record<string, unknown>> };
}

export function resolveRisk(def: AnyAction, db: DB, input: Record<string, unknown>): Risk {
  return typeof def.risk === "function" ? def.risk(db, input as never) : def.risk;
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
