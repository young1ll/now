// 임베딩 공간 = (공급자, 모델, 차원). 벡터 자체는 now-vec.db (lib/knowledge/vectors.ts) 에 있고, 여기는 설정·상태만.
// 생성·활성화·폐기는 액션(lib/ontology/actions/embedding.ts)으로만. dim 확정·오류 기록은 워커가 쓰는 파생 상태다.
import type { DB } from "@/lib/db";

export const EMBED_PROVIDERS = ["ollama", "openai", "gemini", "voyage", "openai_compatible"] as const;
export type EmbedProvider = (typeof EMBED_PROVIDERS)[number];
export type SpaceStatus = "building" | "active" | "retired";

export type EmbeddingSpace = {
  id: number;
  name: string;
  provider: EmbedProvider;
  model: string;
  dim: number;
  base_url: string;
  api_key_env: string;
  query_prefix: string;
  passage_prefix: string;
  local_only: number;
  auto_activate: number;
  status: SpaceStatus;
  last_error: string | null;
  last_error_at: string | null;
  created_at: string;
  activated_at: string | null;
};

export type SpaceInput = Pick<EmbeddingSpace, "name" | "provider" | "model" | "base_url" | "api_key_env" | "query_prefix" | "passage_prefix"> & {
  local_only: boolean;
  auto_activate: boolean;
};

export function listSpaces(db: DB): EmbeddingSpace[] {
  return db.prepare("SELECT * FROM embedding_spaces ORDER BY status = 'retired', id DESC").all() as EmbeddingSpace[];
}

export function getSpace(db: DB, id: number): EmbeddingSpace | undefined {
  return db.prepare("SELECT * FROM embedding_spaces WHERE id = ?").get(id) as EmbeddingSpace | undefined;
}

/** 검색에 쓰는 공간 (최대 1개 — embedding.activate 가 보장) */
export function activeSpace(db: DB): EmbeddingSpace | undefined {
  return db.prepare("SELECT * FROM embedding_spaces WHERE status = 'active' ORDER BY activated_at DESC, id DESC LIMIT 1").get() as EmbeddingSpace | undefined;
}

export function insertSpace(db: DB, s: SpaceInput): number {
  return Number(
    db
      .prepare(
        `INSERT INTO embedding_spaces (name, provider, model, base_url, api_key_env, query_prefix, passage_prefix, local_only, auto_activate)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.name, s.provider, s.model, s.base_url, s.api_key_env, s.query_prefix, s.passage_prefix, s.local_only ? 1 : 0, s.auto_activate ? 1 : 0).lastInsertRowid,
  );
}

export function setSpaceStatus(db: DB, id: number, status: SpaceStatus) {
  db.prepare(`UPDATE embedding_spaces SET status = ?, activated_at = CASE WHEN ? = 'active' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE activated_at END WHERE id = ?`).run(status, status, id);
}

// ── 파생 상태 (워커) — signal_state 와 같은 취급: 액션 없이 쓴다 ──

/** 첫 응답 길이로 차원 확정. 이미 정해졌으면 바꾸지 않는다 (조건부 UPDATE — 여러 워커가 돌아도 한 번). */
export function confirmSpaceDim(db: DB, id: number, dim: number): number {
  db.prepare("UPDATE embedding_spaces SET dim = ? WHERE id = ? AND dim = 0").run(dim, id);
  return getSpace(db, id)?.dim ?? dim;
}

export function setSpaceError(db: DB, id: number, error: string | null, at: string | null) {
  db.prepare("UPDATE embedding_spaces SET last_error = ?, last_error_at = ? WHERE id = ?").run(error, at, id);
}
