// 이벤트 워커 단독 실행 — 서버 없이 트리거·AI 세션을 돌릴 때 (예: stdio MCP 만 쓰는 환경).
//   npm run worker            (상주)
//   npm run worker -- --once  (한 번만 처리하고 종료, cron 용)
import { db, dbPath } from "@/lib/db";
import { startWorker, tick } from "@/lib/events/worker";

if (process.argv.includes("--once")) {
  tick(db()).then((r) => {
    console.log(JSON.stringify(r));
    process.exit(0);
  });
} else {
  startWorker(db);
  console.log(`[now-worker] 시작 · DB ${dbPath()} · ${process.env.NOW_WORKER_INTERVAL_MS ?? 5000}ms 간격`);
  setInterval(() => {}, 1 << 30);
}
