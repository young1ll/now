import { agentTool } from "@/lib/agent/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return agentTool(req, "get_run", () => ({ run_id: Number(id) }));
}

/** 승인 대기 요청 철회 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return agentTool(req, "cancel_run", () => ({ run_id: Number(id) }));
}
