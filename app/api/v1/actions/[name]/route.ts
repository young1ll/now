import { agentTool } from "@/lib/agent/http";

export const dynamic = "force-dynamic";

/** POST /api/v1/actions/{name}  body: { params: {...}, reason: "..." } */
export async function POST(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  return agentTool(req, "run_action", async () => {
    const body = (await req.json().catch(() => ({}))) as { params?: unknown; reason?: unknown };
    return { action: name, params: body.params ?? {}, reason: body.reason };
  });
}
