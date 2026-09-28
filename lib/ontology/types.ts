export const OBJECT_TYPES = ["business", "client", "task", "invoice", "expense", "note", "agent", "memory"] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];

export type Ref = { type: ObjectType; id: number };

export type Actor = {
  type: "human" | "agent" | "system";
  id: string;
  name: string;
};

export type Risk = "low" | "high";

export type RunStatus = "applied" | "pending" | "rejected" | "failed" | "denied" | "cancelled";

export const OPERATOR: Actor = {
  type: "human",
  id: "operator",
  name: process.env.NOW_OPERATOR_NAME || "운영자",
};

export const SYSTEM: Actor = { type: "system", id: "system", name: "시스템" };

/** 사업 규칙 위반 등 예상된 실패. 메시지는 사용자/에이전트에게 그대로 보여준다. */
export class ActionError extends Error {}

export function refKey(r: Ref) {
  return `${r.type}:${r.id}`;
}
