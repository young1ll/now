import type { ObjectType } from "./types";

export const PREFIX: Record<ObjectType, string> = {
  business: "BIZ",
  client: "CLT",
  task: "TSK",
  invoice: "INV",
  expense: "EXP",
  note: "DOC",
  agent: "AGT",
};

/** 사람이 읽는 객체 식별자: CLT-0003 */
export function displayId(type: ObjectType, id: number): string {
  return `${PREFIX[type]}-${String(id).padStart(4, "0")}`;
}

export function runId(id: number): string {
  return `RUN-${String(id).padStart(6, "0")}`;
}
