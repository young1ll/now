import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { migrations, preMigrations } from "./migrations";

export type DB = Database.Database;

export function openDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  cacheStatements(db);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

/** 문장 캐시 상한 — 목록 길이마다 SQL 이 달라지는 조회는 lib/db/sql 의 JSON 인자로 한 문장이 되게 쓴다 (넘치면 캐시하지 않고 새로 준비) */
export const STATEMENT_CACHE_MAX = 2000;

/**
 * db.prepare 를 SQL 문자열별 캐시로 바꾼다. better-sqlite3 는 버려진(GC 된) 준비문의 네이티브 메모리를 연결을 닫을 때까지
 * 돌려주지 않아, 호출마다 prepare 하면 상주 서버·워커의 RSS 가 끝없이 는다 (분마다 틱 · 요청마다 조회). 같은 SQL 은 같은 준비문을 다시 쓴다.
 * 캐시된 준비문은 모드(pluck · raw · expand)를 기본으로 되돌려 준다 — 호출자는 여전히 `db.prepare(sql).pluck().get()` 처럼 쓴다.
 * (iterate 중인 준비문을 같은 SQL 로 다시 쓰면 "busy" 가 된다 — 이 코드베이스는 iterate 를 쓰지 않는다)
 */
export function cacheStatements(db: DB) {
  const prepare = db.prepare.bind(db);
  const cache = new Map<string, Database.Statement>();
  db.prepare = ((sql: string) => {
    const hit = cache.get(sql);
    if (hit) {
      if (hit.reader) hit.pluck(false).raw(false).expand(false);
      return hit;
    }
    const st = prepare(sql);
    if (cache.size < STATEMENT_CACHE_MAX) cache.set(sql, st);
    return st;
  }) as DB["prepare"];
}

export function migrate(db: DB) {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < migrations.length; v++) {
    db.transaction(() => {
      preMigrations[v + 1]?.(db);
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
