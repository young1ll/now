import { db } from "@/lib/db";
import { authenticate } from "@/lib/agent/auth";
import { type JsonRpcRequest, handleMcp } from "@/lib/agent/mcp";

export const dynamic = "force-dynamic";

// MCP Streamable HTTP (무상태). 요청마다 Bearer 토큰으로 에이전트를 식별한다.
export async function POST(req: Request) {
  const auth = authenticate(db(), req.headers.get("authorization"));
  if (!auth.ok) {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: auth.error } }, {
      status: auth.status,
      headers: { "WWW-Authenticate": 'Bearer realm="now"' },
    });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }
  if (Array.isArray(body) && body.length === 0) {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: empty batch" } }, { status: 400 });
  }
  const messages = (Array.isArray(body) ? body : [body]) as JsonRpcRequest[];
  const responses = messages.map((m) => handleMcp(db(), auth.actor, m)).filter((r) => r !== null);
  if (responses.length === 0) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? responses : responses[0]);
}

export function GET() {
  // 서버 발신 스트림은 제공하지 않는다 (무상태 서버)
  return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
}

export function DELETE() {
  return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
}
