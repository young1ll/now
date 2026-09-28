import { z } from "zod";
import { authenticate } from "@/lib/agent/auth";
import { json } from "@/lib/agent/http";
import { db } from "@/lib/db";
import { allowedDenial } from "@/lib/ontology/policy";
import { getAgent } from "@/lib/repos/agents";
import { insertRun } from "@/lib/repos/runs";
import { getAiMode } from "@/lib/repos/settings";
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

/**
 * IaC 감사 결과 수신 (npm run iac:audit 이 배포된 앱에 보낼 때). 에이전트 토큰 필요.
 * 허용 범위(allowed_actions — 'iac.record_snapshot') 밖이거나 동결 모드면 거부, 모든 수신은 활동 로그에 기록된다. 순서는 수신 순서(서버 기준).
 */
export async function POST(req: Request) {
  const d = db();
  const auth = authenticate(d, req.headers.get("authorization"));
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
  const s = parsed.data;
  const base = { action: "iac.record_snapshot", actor: auth.actor, risk: "low" as const, params: { status: s.status, tool: s.tool, captured_at: s.captured_at }, businessIds: [] as number[] };
  // 허용 범위: 액션 레지스트리 밖의 쓰기지만 에이전트의 allowed_actions 로 다스린다 (좁힌 에이전트가 드리프트 신호를 바꾸지 못하게)
  const agent = getAgent(d, Number(auth.actor.id));
  const denied = agent ? allowedDenial(agent, base.action) : "에이전트를 찾을 수 없습니다";
  if (denied) {
    insertRun(d, { ...base, status: "denied", error: denied });
    return json({ error: denied }, 403);
  }
  if (getAiMode(d) === "frozen") {
    insertRun(d, { ...base, status: "denied", error: "AI 동결 모드" });
    return json({ error: "AI 동결 모드 — 에이전트 쓰기가 차단되어 있습니다" }, 403);
  }
  if (Date.parse(s.captured_at) > Date.now() + 5 * 60_000) return json({ error: "captured_at 이 미래입니다" }, 400);
  const id = d.transaction(() => {
    const snapId = insertSnapshot(d, { ...s, tool: `${s.tool} · ${auth.actor.name}` });
    insertRun(d, { ...base, status: "applied", result: { summary: `IaC 감사 기록: ${s.status} · 리소스 ${s.resources.length} · 변경 ${s.changes.length}`, refs: [] } });
    return snapId;
  })();
  return json({ id }, 201);
}
