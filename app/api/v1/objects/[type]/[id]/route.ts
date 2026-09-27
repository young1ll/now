import { agentTool } from "@/lib/agent/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ type: string; id: string }> }) {
  const { type, id } = await ctx.params;
  return agentTool(req, "get_object", () => ({ type, id: Number(id) }));
}
