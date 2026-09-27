import { z } from "zod";
import { authenticate } from "@/lib/agent/auth";
import { json } from "@/lib/agent/http";
import { db } from "@/lib/db";
import { insertSnapshot } from "@/lib/repos/snapshots";

export const dynamic = "force-dynamic";

const Body = z.object({
  captured_at: z.iso.datetime(),
  tool: z.string().max(40),
  status: z.enum(["in_sync", "drift", "error"]),
  message: z.string().max(2000).default(""),
  resources: z.array(z.object({ address: z.string(), type: z.string(), name: z.string(), provider: z.string(), attributes: z.record(z.string(), z.string()) })).max(500),
  changes: z.array(z.object({ address: z.string(), type: z.string(), actions: z.array(z.string()) })).max(500),
});

/** IaC 감사 결과 수신 (npm run iac:audit 이 배포된 앱에 보낼 때). 에이전트 토큰 필요. */
export async function POST(req: Request) {
  const auth = authenticate(db(), req.headers.get("authorization"));
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
  const s = parsed.data;
  const id = insertSnapshot(db(), { ...s, tool: `${s.tool} · ${auth.actor.name}` });
  return json({ id }, 201);
}
