import { db } from "@/lib/db";
import { eventStream } from "@/lib/events/sse";

export const dynamic = "force-dynamic";

/** 콘솔(로컬 운영자) 실시간 이벤트 — proxy.ts 의 Host 제한 안에서만 열린다. */
export function GET(req: Request) {
  return eventStream(req, db);
}
