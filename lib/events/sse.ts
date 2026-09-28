import type { DB } from "@/lib/db";
import { type NowEvent, listEvents, matchesPattern } from "@/lib/repos/events";

/** 이벤트 SSE 스트림. after 이후 이벤트를 1초 간격으로 밀어 준다. 재접속 시 Last-Event-ID 로 이어받기. */
/** reauth: 주기적으로 다시 확인할 인증 (false 면 스트림 종료 — 정지·폐기·단기 토큰 만료) · visible: 보낼 이벤트만 거르기 (에이전트의 사업 범위) */
export function eventStream(req: Request, getDb: () => DB, opts: { type?: string; reauth?: () => boolean; visible?: (evs: NowEvent[]) => NowEvent[] } = {}) {
  const url = new URL(req.url);
  let after = Number(req.headers.get("last-event-id") ?? url.searchParams.get("after") ?? NaN);
  if (!Number.isFinite(after)) after = listEvents(getDb(), { limit: 1 })[0]?.id ?? 0;
  const rawType = opts.type ?? url.searchParams.get("type") ?? undefined;
  // "signal." 접두사도 "signal.*" 패턴으로
  const type = rawType ? rawType.split(",").map((p) => (p.trim().endsWith(".") ? `${p.trim()}*` : p.trim())).join(",") : undefined;
  const enc = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(`retry: 3000\n: connected after=${after}\n\n`));
      let beats = 0;
      timer = setInterval(() => {
        try {
          const evs = listEvents(getDb(), { afterId: after, limit: 200 });
          if (evs.length) after = evs[evs.length - 1].id;
          for (const e of opts.visible ? opts.visible(evs) : evs) {
            if (type && !matchesPattern(type, e.type)) continue;
            controller.enqueue(enc.encode(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
          }
          if (++beats % 5 === 0 && opts.reauth && !opts.reauth()) {
            controller.enqueue(enc.encode("event: auth.expired\ndata: {}\n\n"));
            clearInterval(timer);
            controller.close();
            return;
          }
          if (beats % 15 === 0) controller.enqueue(enc.encode(": ping\n\n"));
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
