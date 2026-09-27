import { agentTool } from "@/lib/agent/http";

export const dynamic = "force-dynamic";

/** 범용 도구 호출: POST /api/v1/tools/{name}  body = 도구 인자 (MCP tools/call 과 동일) */
export async function POST(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  return agentTool(req, name, async () => (await req.json().catch(() => ({}))) ?? {});
}
