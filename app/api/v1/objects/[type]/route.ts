import { agentTool, num } from "@/lib/agent/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ type: string }> }) {
  const { type } = await ctx.params;
  const u = new URL(req.url);
  return agentTool(req, "search_objects", () => ({
    type,
    query: u.searchParams.get("q") ?? undefined,
    business_id: num(u.searchParams.get("business_id")),
    limit: num(u.searchParams.get("limit")),
  }));
}
