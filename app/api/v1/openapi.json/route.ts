import { TOOLS, toolJsonSchema } from "@/lib/agent/tools";
import { APP_VERSION } from "@/lib/system";

export const dynamic = "force-dynamic";

/** OpenAPI 3.1 — GPT Actions · LangChain · 기타 도구 프레임워크가 그대로 읽을 수 있게. 인증 불필요(스펙만). */
export function GET(req: Request) {
  const origin = new URL(req.url).origin;
  const paths: Record<string, unknown> = {};
  for (const t of TOOLS) {
    paths[`/api/v1/tools/${t.name}`] = {
      post: {
        operationId: t.name,
        summary: t.description.split(".")[0].slice(0, 120),
        description: t.description,
        requestBody: { required: true, content: { "application/json": { schema: toolJsonSchema(t) } } },
        responses: {
          "200": { description: "도구 결과 (JSON)", content: { "application/json": { schema: { type: "object" } } } },
          "400": { description: "입력 오류" },
          "401": { description: "토큰 없음/무효" },
          "403": { description: "에이전트 정지·폐기" },
        },
      },
    };
  }
  return Response.json({
    openapi: "3.1.0",
    info: { title: "Now Business OS — Agent API", version: APP_VERSION, description: "AI 에이전트가 사업 운영 체제를 조작하는 도구 API. 모든 쓰기는 run_action 을 통해 정책·승인·감사를 거친다." },
    servers: [{ url: origin }],
    security: [{ bearer: [] }],
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "에이전트 토큰 (now_…)" } } },
    paths,
  });
}
