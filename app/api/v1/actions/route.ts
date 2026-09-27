import { agentTool } from "@/lib/agent/http";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const u = new URL(req.url);
  return agentTool(req, "list_actions", () => ({ object_type: u.searchParams.get("object_type") ?? undefined }));
}
