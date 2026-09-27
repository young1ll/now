import type { DB } from "@/lib/db";
import { getAiMode } from "@/lib/repos/settings";
import type { AnyAction } from "./action";
import type { Actor, Risk } from "./types";

export type Decision = { kind: "execute" } | { kind: "approval"; why: string } | { kind: "deny"; why: string };

/**
 * 누가 무엇을 바로 실행할 수 있는가.
 * 사람·시스템은 항상 실행 (감사는 동일하게 남음). 에이전트는 AI 운영 모드와 위험도에 따른다.
 */
export function decide(db: DB, actor: Actor, def: AnyAction, risk: Risk): Decision {
  if (actor.type !== "agent") return { kind: "execute" };
  if (def.humanOnly) return { kind: "deny", why: "사람만 실행할 수 있는 액션입니다" };
  switch (getAiMode(db)) {
    case "frozen":
      return { kind: "deny", why: "AI 동결 모드 — 에이전트 쓰기가 차단되어 있습니다" };
    case "supervised":
      return { kind: "approval", why: "감독 모드 — 모든 에이전트 쓰기는 승인이 필요합니다" };
    case "guarded":
      return risk === "high" ? { kind: "approval", why: "고위험 액션 — 승인이 필요합니다" } : { kind: "execute" };
    case "autonomous":
      return { kind: "execute" };
  }
}
