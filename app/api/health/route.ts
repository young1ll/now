import { db } from "@/lib/db";
import { APP_VERSION } from "@/lib/system";
import { migrations } from "@/lib/db/migrations";

export const dynamic = "force-dynamic";

/** 컨테이너 헬스체크·외부 모니터링용. 인증 없음, 민감 정보 없음. */
export function GET() {
  try {
    const schema = db().prepare("PRAGMA user_version").pluck().get() as number;
    db().prepare("SELECT 1").get();
    const ok = schema === migrations.length;
    return Response.json(
      { status: ok ? "ok" : "degraded", version: APP_VERSION, schema, time: new Date().toISOString() },
      { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return Response.json({ status: "down", error: e instanceof Error ? e.message : String(e) }, { status: 503 });
  }
}
