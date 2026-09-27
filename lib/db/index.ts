import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { migrations } from "./migrations";

export type DB = Database.Database;

export function openDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function migrate(db: DB) {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < migrations.length; v++) {
    db.transaction(() => {
      db.exec(migrations[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export function dbPath() {
  // 로컬 전용 앱이라 배포 트레이싱이 필요 없다.
  return path.resolve(/*turbopackIgnore: true*/ process.env.NOW_DB_PATH ?? "data/now.db");
}

// dev 서버의 HMR 로 모듈이 다시 평가돼도 연결을 하나만 유지한다.
const g = globalThis as unknown as { __nowDb?: DB };

export function db(): DB {
  g.__nowDb ??= openDb(dbPath());
  return g.__nowDb;
}
