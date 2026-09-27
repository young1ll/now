import { agentTool, num } from "@/lib/agent/http";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const u = new URL(req.url);
  return agentTool(req, "list_my_runs", () => ({ status: u.searchParams.get("status") ?? undefined, limit: num(u.searchParams.get("limit")) }));
}
