import type { DB } from "@/lib/db";
import { authenticateAgent } from "@/lib/repos/agents";
import type { Actor } from "@/lib/ontology/types";

export type AuthResult = { ok: true; actor: Actor } | { ok: false; status: 401 | 403; error: string };

/** Authorization: Bearer <token> → 활성 에이전트 행위자. */
export function authenticate(db: DB, header: string | null): AuthResult {
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) return { ok: false, status: 401, error: "Authorization: Bearer <agent token> 헤더가 필요합니다" };
  const a = authenticateAgent(db, token);
  if (!a) return { ok: false, status: 401, error: "유효하지 않은 토큰입니다" };
  if (a.status !== "active") return { ok: false, status: 403, error: `에이전트가 ${a.status === "suspended" ? "정지" : "폐기"} 상태입니다` };
  return { ok: true, actor: { type: "agent", id: String(a.id), name: a.name } };
}
