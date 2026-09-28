import { db } from "@/lib/db";
import type { Actor } from "@/lib/ontology/types";
import { authenticate } from "./auth";
import { ToolError, callTool } from "./tools";

export function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

/** 에이전트 인증 후 도구 실행 → JSON. REST 엔드포인트 공용. */
export async function agentTool(req: Request, tool: string, args: (actor: Actor) => unknown | Promise<unknown>) {
  const auth = authenticate(db(), req.headers.get("authorization"));
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  try {
    return json(await callTool(db(), auth.actor, tool, await args(auth.actor)));
  } catch (e) {
    if (e instanceof ToolError) return json({ error: e.message }, 400);
    // 예상하지 못한 오류: 서버 로그에 남기고, 에이전트에게는 빈 500 대신 JSON 오류를 준다 (내부 메시지는 싣지 않는다)
    console.error(`[now-api] ${tool}`, e);
    return json({ error: "내부 오류 — 요청을 처리하지 못했습니다" }, 500);
  }
}

export function num(v: string | null): number | undefined {
  if (v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
