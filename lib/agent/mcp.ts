// 최소 MCP 서버 (JSON-RPC 2.0). Streamable HTTP(무상태, JSON 응답)와 stdio 가 공유한다.
// 지원: initialize, notifications/initialized, ping, tools/list, tools/call
import type { DB } from "@/lib/db";
import type { Actor } from "@/lib/ontology/types";
import { APP_VERSION } from "@/lib/system";
import { TOOLS, ToolError, callTool, toolJsonSchema } from "./tools";

export const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

type Id = string | number | null;
export type JsonRpcRequest = { jsonrpc: "2.0"; id?: Id; method: string; params?: Record<string, unknown> };
export type JsonRpcResponse = { jsonrpc: "2.0"; id: Id; result?: unknown; error?: { code: number; message: string } };

export const INSTRUCTIONS = `Now — 1인 사업가용 사업 운영 체제.
당신은 이 사업의 운영 에이전트다. 사람(운영자)은 콘솔에서 관망하고 필요할 때 개입한다.
- 시작: get_overview → list_signals 로 할 일을 파악한다.
- 찾기: recall (자연어 — 내용·관계를 함께 본다) 또는 search_objects (유형별 목록). 읽기: get_object. 쓰기: run_action (반드시 reason 에 근거를 적는다).
- 고위험 액션(발행·삭제·금액 기록)은 AI 운영 모드에 따라 승인 대기(pending)가 된다. 대기 결과는 get_run 으로 확인.
- 확실하지 않으면 실행하지 말고 note.create 로 제안 메모를 남기거나 사람에게 물어라.`;

function ok(id: Id, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}
function fail(id: Id, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** 메시지 하나 처리. 알림(id 없음)이면 null. */
export function handleMcp(db: DB, actor: Actor, msg: JsonRpcRequest): JsonRpcResponse | null {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(msg?.id ?? null, -32600, "Invalid Request");
  // id 없는 메시지는 알림 — 어떤 것도 실행하지 않고 응답하지 않는다
  if (msg.id === undefined) return null;
  const id = msg.id;

  switch (msg.method) {
    case "initialize": {
      const requested = String(msg.params?.protocolVersion ?? "");
      return ok(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "now-business-os", version: APP_VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: toolJsonSchema(t) })),
      });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      try {
        const data = callTool(db, actor, name, msg.params?.arguments);
        const structured = data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : { items: data };
        return ok(id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: structured, isError: false });
      } catch (e) {
        if (e instanceof ToolError) return ok(id, { content: [{ type: "text", text: e.message }], isError: true });
        return ok(id, { content: [{ type: "text", text: `내부 오류: ${e instanceof Error ? e.message : String(e)}` }], isError: true });
      }
    }
    default:
      return fail(id, -32601, `Method not found: ${msg.method}`);
  }
}
