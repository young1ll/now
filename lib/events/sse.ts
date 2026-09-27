import type { DB } from "@/lib/db";
import { listEvents } from "@/lib/repos/events";

/** 이벤트 SSE 스트림. after 이후 이벤트를 1초 간격으로 밀어 준다. 재접속 시 Last-Event-ID 로 이어받기. */
export function eventStream(req: Request, getDb: () => DB, opts: { type?: string } = {}) {
  const url = new URL(req.url);
  let after = Number(req.headers.get("last-event-id") ?? url.searchParams.get("after") ?? NaN);
  if (!Number.isFinite(after)) after = listEvents(getDb(), { limit: 1 })[0]?.id ?? 0;
  const type = opts.type ?? url.searchParams.get("type") ?? undefined;
  const enc = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(`retry: 3000\n: connected after=${after}\n\n`));
      let beats = 0;
      timer = setInterval(() => {
        try {
          const evs = listEvents(getDb(), { afterId: after, limit: 200 });
          for (const e of evs) {
            after = e.id;
            if (type && !(type.endsWith(".") ? e.type.startsWith(type) : e.type === type)) continue;
            controller.enqueue(enc.encode(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
          }
          if (++beats % 15 === 0) controller.enqueue(enc.encode(": ping\n\n"));
        } catch {
          clearInterval(timer);
          controller.close();
        }
      }, 1000);
      req.signal.addEventListener("abort", () => {
        clearInterval(timer);
        try {
          controller.close();
        } catch {
          /* 이미 닫힘 */
        }
      });
    },
    cancel() {
      clearInterval(timer);
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } });
}
