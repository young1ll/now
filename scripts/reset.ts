// 로컬 DB 파일 삭제: npm run db:reset -- --yes
// 벡터 파일(now-vec.db)도 함께 지운다 — 원본에서 재생성되는 파생 캐시다.
import fs from "node:fs";
import { dbPath } from "@/lib/db";
import { vecPathFor } from "@/lib/knowledge/vectors";

const file = dbPath();
const vec = vecPathFor(file);
if (!process.argv.includes("--yes")) {
  console.error(`모든 데이터가 삭제됩니다: ${file} (+ 벡터 ${vec})\n계속하려면: npm run db:reset -- --yes`);
  process.exit(1);
}
for (const f of [file, `${file}-wal`, `${file}-shm`, vec, `${vec}-wal`, `${vec}-shm`]) fs.rmSync(f, { force: true });
console.log(`삭제했습니다: ${file} · ${vec}`);
