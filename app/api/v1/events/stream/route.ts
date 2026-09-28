import { authenticate } from "@/lib/agent/auth";
import { json } from "@/lib/agent/http";
import { visibleEvents } from "@/lib/agent/tools";
import { reachOf } from "@/lib/ontology/policy";
import { db } from "@/lib/db";
import { eventStream } from "@/lib/events/sse";

export const dynamic = "force-dynamic";

/** 에이전트용 실시간 이벤트 스트림 (SSE). ?after=<id> · ?type=signal. */
export function GET(req: Request) {
  const auth = authenticate(db(), req.headers.get("authorization"));
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  const header = req.headers.get("authorization");
  const actor = auth.actor;
  // 사업 범위가 있는 에이전트는 범위 안(과 공용) 이벤트만 — list_events 도구와 같은 규칙. 범위는 폴링마다 다시 읽는다
  return eventStream(req, db, { reauth: () => authenticate(db(), header).ok, visible: (evs) => visibleEvents(db(), reachOf(db(), actor), evs) });
}
