import { agentTool, num } from "@/lib/agent/http";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const u = new URL(req.url);
  return agentTool(req, "list_signals", () => ({
    business_id: num(u.searchParams.get("business_id")),
    severity: u.searchParams.get("severity") ?? undefined,
  }));
}
