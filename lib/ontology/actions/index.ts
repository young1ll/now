import type { AnyAction } from "../action";
import { businessActions } from "./business";
import { clientActions } from "./client";
import { financeActions } from "./finance";
import { noteActions } from "./note";
import { systemActions } from "./system";
import { taskActions } from "./task";

/** 액션 카탈로그. 사람(UI)·에이전트(API/MCP) 모두 이 목록으로만 데이터를 바꾼다. */
export const ACTION_LIST: AnyAction[] = [
  ...businessActions,
  ...clientActions,
  ...taskActions,
  ...financeActions,
  ...noteActions,
  ...systemActions,
];

export const ACTIONS: Record<string, AnyAction> = Object.fromEntries(ACTION_LIST.map((a) => [a.name, a]));
