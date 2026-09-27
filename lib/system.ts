// 런타임·데이터 상태 — /system 화면, /api/health, 신호(signals)에서 사용.
import fs from "node:fs";
import path from "node:path";
import { type DB, dbPath } from "@/lib/db";
import { migrations } from "@/lib/db/migrations";

export const APP_VERSION = "0.3.0";
const startedAt = new Date().toISOString();

export type BackupInfo = { file: string; at: string; bytes: number };

export function backupDir() {
  return path.join(path.dirname(dbPath()), "backups");
}

export function listBackups(): BackupInfo[] {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".db"))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { file: f, at: st.mtime.toISOString(), bytes: st.size };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

const size = (f: string) => (fs.existsSync(f) ? fs.statSync(f).size : 0);

export function runtimeInfo(db: DB) {
  const file = dbPath();
  const schema = db.pragma("user_version", { simple: true }) as number;
  const tables = ["businesses", "clients", "tasks", "invoices", "payments", "expenses", "notes", "agents", "action_runs", "infra_snapshots"];
  const counts = Object.fromEntries(
    tables.map((t) => [t, (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]),
  ) as Record<string, number>;
  const integrity = (db.pragma("quick_check", { simple: true }) as string) === "ok";
  return {
    version: APP_VERSION,
    node: process.version,
    pid: process.pid,
    startedAt,
    uptimeSec: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    db: {
      path: file,
      bytes: size(file),
      walBytes: size(`${file}-wal`),
      schema,
      schemaLatest: migrations.length,
      integrity,
      counts,
    },
    backups: listBackups(),
  };
}

const KEEP_BACKUPS = 30;

/** 일관된 온라인 백업 (VACUUM INTO). 트랜잭션 밖에서 호출해야 한다. 최근 30개만 보관. */
export function backupNow(db: DB): BackupInfo {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const file = path.join(dir, `now-${stamp}.db`);
  if (fs.existsSync(file)) throw new Error("같은 초에 이미 백업이 있습니다");
  db.prepare("VACUUM INTO ?").run(file);
  for (const old of listBackups().slice(KEEP_BACKUPS)) fs.rmSync(path.join(dir, old.file), { force: true });
  return listBackups().find((b) => b.file === path.basename(file))!;
}
