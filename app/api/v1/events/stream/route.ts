import { authenticate } from "@/lib/agent/auth";
import { json } from "@/lib/agent/http";
import { db } from "@/lib/db";
import { eventStream } from "@/lib/events/sse";

export const dynamic = "force-dynamic";

/** 에이전트용 실시간 이벤트 스트림 (SSE). ?after=<id> · ?type=signal. */
export function GET(req: Request) {
  const auth = authenticate(db(), req.headers.get("authorization"));
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  return eventStream(req, db);
}
