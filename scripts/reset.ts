// 로컬 DB 파일 삭제: npm run db:reset -- --yes
import fs from "node:fs";
import { dbPath } from "@/lib/db";

const file = dbPath();
if (!process.argv.includes("--yes")) {
  console.error(`모든 데이터가 삭제됩니다: ${file}\n계속하려면: npm run db:reset -- --yes`);
  process.exit(1);
}
for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
console.log(`삭제했습니다: ${file}`);
