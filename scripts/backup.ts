// 실행 중에도 안전한 온라인 백업: npm run db:backup
import path from "node:path";
import fs from "node:fs";
import { db, dbPath } from "@/lib/db";

const dir = path.join(path.dirname(dbPath()), "backups");
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13);
const dest = path.join(dir, `now-${stamp}.db`);
db()
  .backup(dest)
  .then(() => console.log(`백업 완료 → ${dest}`))
  .catch((e) => {
    console.error("백업 실패:", e);
    process.exit(1);
  });
