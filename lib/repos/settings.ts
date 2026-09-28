import type { DB } from "@/lib/db";

/**
 * AI 운영 모드 — 에이전트 쓰기 행동에 대한 사람의 개입 수준.
 *  autonomous : 모두 즉시 실행, 감사만
 *  guarded    : 고위험(외부 발송·삭제·금액) 행동만 승인 대기  ← 기본
 *  supervised : 모든 쓰기 행동 승인 대기
 *  frozen     : 에이전트 쓰기 차단 (읽기만 허용)
 */
export const AI_MODES = ["autonomous", "guarded", "supervised", "frozen"] as const;
export type AiMode = (typeof AI_MODES)[number];

export function getSetting(db: DB, key: string): string | undefined {
  return (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
}

export function setSetting(db: DB, key: string, value: string) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function deleteSetting(db: DB, key: string) {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

export function getAiMode(db: DB): AiMode {
  const v = getSetting(db, "ai_mode");
  return (AI_MODES as readonly string[]).includes(v ?? "") ? (v as AiMode) : "guarded";
}
