// 예시 데이터 — 모든 기록을 액션으로 만든다 (사람·에이전트 활동이 감사 로그에 그대로 남음).
//   npm run db:seed        (빈 DB 에서만)
import { db, dbPath } from "@/lib/db";
import { reindexAll } from "@/lib/knowledge/indexer";
import { listBusinesses } from "@/lib/repos/businesses";
import { seedDemo } from "./demo-data";

const d = db();
if (listBusinesses(d, { includeArchived: true }).length > 0) {
  console.error(`이미 데이터가 있습니다 (${dbPath()}). 초기화: npm run db:reset -- --yes`);
  process.exit(1);
}

const token = seedDemo(d);
const idx = reindexAll(d);

console.log(`예시 데이터 → ${dbPath()} · 검색 색인 ${idx.rendered}개 객체`);
console.log(`\n운영 에이전트 토큰 (MCP 연결용, 다시 표시되지 않음):\nNOW_AGENT_TOKEN=${token}`);
