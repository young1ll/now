// 임베딩 워커 — 청크 중 아직 벡터가 없는 content_hash 만 공급자에 보내 채운다 (docs/MEMORY.md §7.2).
// 요청 경로에서는 문서를 임베딩하지 않는다: 여기(워커 틱)만 문서를, recall 은 질의 1회만 임베딩한다.
// 멱등: 같은 해시는 한 번만 (storeVectors 의 INSERT OR IGNORE). 공급자 장애는 공간 행에 기록하고 지수 백오프.
import type { DB } from "@/lib/db";
import { executeAction } from "@/lib/ontology/execute";
import { SYSTEM } from "@/lib/ontology/types";
import { type EmbeddingSpace, activeSpace, confirmSpaceDim, getSpace, listSpaces, setSpaceError } from "@/lib/repos/embeddings";
import { deleteSetting, getSetting, setSetting } from "@/lib/repos/settings";
import { EmbedError, makeEmbedder } from "./embed";
import { redactSecrets } from "./redact";
import { attachVectors, spaceCoverage, storeVectors, vectorsEnabled } from "./vectors";

type Env = Record<string, string | undefined>;
export type EmbedOpts = { fetchImpl?: typeof fetch; env?: Env; now?: Date; maxTexts?: number };
export type EmbedResult = { embedded: number; errors: string[]; activated: number[] };

const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;

const backoffKey = (id: number) => `embed_backoff:${id}`;
const failKey = (id: number) => `embed_failures:${id}`;
const outageKey = (id: number) => `embed_outage:${id}`;

/** 백오프 중이면 다시 시도할 시각 */
export function backoffUntil(db: DB, spaceId: number): string | undefined {
  return getSetting(db, backoffKey(spaceId));
}

/**
 * 공급자 자체가 응답하지 않아(연결 실패·시간 초과·5xx) 백오프 중이면 그 끝 시각. recall 은 이 동안 질의 임베딩을
 * 시도하지 않고 바로 강등한다 — 요청마다 시간 초과를 기다리지 않도록. 입력 문제(4xx)로 인한 백오프는 해당 없음.
 * 여러 프로세스(CLI·MCP stdio)가 같이 보도록 settings 에 둔다.
 */
export function outageUntil(db: DB, spaceId: number, now = new Date()): string | undefined {
  const until = getSetting(db, outageKey(spaceId));
  return until && Date.parse(until) > now.getTime() ? until : undefined;
}

function fail(db: DB, space: EmbeddingSpace, err: unknown, now: Date) {
  const msg = err instanceof Error ? err.message : String(err);
  const n = Number(getSetting(db, failKey(space.id)) ?? 0);
  const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** n);
  const until = new Date(now.getTime() + wait).toISOString();
  db.transaction(() => {
    setSpaceError(db, space.id, msg, now.toISOString());
    setSetting(db, failKey(space.id), String(n + 1));
    setSetting(db, backoffKey(space.id), until);
    if (err instanceof EmbedError && err.outage) setSetting(db, outageKey(space.id), until);
    else deleteSetting(db, outageKey(space.id));
  })();
}

function succeed(db: DB, space: EmbeddingSpace) {
  if (space.last_error === null && getSetting(db, failKey(space.id)) === undefined) return;
  db.transaction(() => {
    setSpaceError(db, space.id, null, null);
    deleteSetting(db, failKey(space.id));
    deleteSetting(db, backoffKey(space.id));
    deleteSetting(db, outageKey(space.id));
  })();
}

/** 아직 벡터가 없는 고유 해시 — 객체 카드(seq 0)부터, 오래된 청크부터 */
function pendingTexts(db: DB, spaceId: number, limit: number): { hash: string; text: string }[] {
  return db
    .prepare(
      `SELECT c.content_hash AS hash, MIN(c.text) AS text FROM chunks c
       LEFT JOIN vec.vectors v ON v.space_id = ? AND v.content_hash = c.content_hash
       WHERE v.id IS NULL
       GROUP BY c.content_hash ORDER BY MAX(c.seq = 0) DESC, MIN(c.id) LIMIT ?`,
    )
    .all(spaceId, limit) as { hash: string; text: string }[];
}

let inflight = false;

/**
 * building·active 공간마다 한 배치(maxTexts)씩 채운다. 워커 틱마다 호출.
 * 한 프로세스 안에서는 겹쳐 돌지 않는다 (inflight). 여러 프로세스는 INSERT OR IGNORE 로 멱등.
 */
export async function embedPending(db: DB, o: EmbedOpts = {}): Promise<EmbedResult> {
  const out: EmbedResult = { embedded: 0, errors: [], activated: [] };
  if (!vectorsEnabled(o.env) || inflight || !attachVectors(db)) return out;
  inflight = true;
  try {
    const now = o.now ?? new Date();
    for (const listed of listSpaces(db)) {
      if (listed.status === "retired") continue;
      const until = backoffUntil(db, listed.id);
      if (until && now.getTime() < Date.parse(until)) continue;
      let space = listed;
      const rows = pendingTexts(db, space.id, o.maxTexts ?? 128);
      if (rows.length) {
        try {
          // 청크는 색인 단계에서 이미 가려져 있다. 그래도 보내기 직전에 한 번 더 — 가림 이전 형식의 청크가 남아 있어도
          // (재색인 전) 원문 비밀이 공급자로 나가지 않게. 해시는 청크의 것을 그대로 쓴다 (멱등성 유지).
          const vecs = await makeEmbedder(space, o).embed(rows.map((r) => redactSecrets(r.text)), "passage");
          // 공간이 그사이 폐기됐으면 버린다
          const cur = getSpace(db, space.id);
          if (!cur || cur.status === "retired") continue;
          if (cur.dim === 0) cur.dim = confirmSpaceDim(db, cur.id, vecs[0].length);
          space = cur;
          out.embedded += storeVectors(db, space, rows.map((r, i) => ({ hash: r.hash, vec: vecs[i] })));
          succeed(db, space);
        } catch (e) {
          fail(db, space, e, now);
          out.errors.push(`${space.name}: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
      }
      if (maybeActivate(db, space.id)) out.activated.push(space.id);
    }
  } finally {
    inflight = false;
  }
  return out;
}

/** auto_activate 공간이 다 찼고 활성 공간이 없으면 시스템 액션으로 활성화 (감사 로그에 남는다) */
function maybeActivate(db: DB, id: number): boolean {
  const s = getSpace(db, id);
  if (!s || !s.auto_activate || s.status !== "building" || s.dim === 0 || activeSpace(db)) return false;
  const cov = spaceCoverage(db, id);
  if (cov.pct < 100 || cov.embedded === 0) return false;
  try {
    return executeAction(db, { actor: SYSTEM, action: "embedding.activate", params: { id }, reason: "자동 활성화: 임베딩 완료" }).status === "applied";
  } catch (e) {
    console.error("[now-embed] 자동 활성화 실패", e);
    return false;
  }
}

// ── 질의 임베딩 (recall 이 요청 경로에서 부르는 유일한 임베딩) ──

const QUERY_CACHE_MAX = 500;
const queryCache = new Map<string, Float32Array>();
/** 요청 경로의 질의 임베딩 시간 제한 — 문서 배치(60초)와 달리 사람이 기다린다. 넘으면 어휘 + 관계로 강등. */
export const QUERY_TIMEOUT_MS = 5_000;
/** 공급자 장애로 질의 임베딩이 실패하면 이 시간 동안 같은 공간에 다시 묻지 않는다 (연속 검색이 매번 기다리지 않게) */
export const QUERY_FAIL_TTL_MS = 30_000;
const queryFailures = new Map<string, { until: number; message: string }>();

export type QueryEmbedOpts = { fetchImpl?: typeof fetch; env?: Env; timeoutMs?: number; now?: number };

/**
 * 정규화된 질의 → 벡터. LRU 500개 (키 = 공간 설정 + 질의) — 에이전트는 비슷한 질의를 반복한다.
 * 질의도 문서 배치처럼 비밀값을 가린 뒤 보낸다 (§3.3: 임베딩 제공자로 나가는 텍스트) — 캐시 키도 가린 값이다.
 */
export async function embedQuery(space: EmbeddingSpace, query: string, o: QueryEmbedOpts = {}): Promise<Float32Array> {
  const q = redactSecrets(query.normalize("NFKC")).trim().replace(/\s+/g, " ");
  // 공간 id 만으로는 부족하다 (DB 를 새로 만들면 id 가 되풀이된다) — 벡터를 결정하는 설정을 모두 키에
  const spaceKey = [space.id, space.created_at, space.provider, space.model, space.base_url, space.query_prefix].join("\u0000");
  const key = `${spaceKey}\u0000${q}`;
  const hit = queryCache.get(key);
  if (hit) {
    queryCache.delete(key);
    queryCache.set(key, hit);
    return hit;
  }
  const now = o.now ?? Date.now();
  const failed = queryFailures.get(spaceKey);
  if (failed && failed.until > now) throw new EmbedError(`${failed.message} (최근 실패 — ${Math.ceil((failed.until - now) / 1000)}초 뒤 다시 시도)`, true);
  let v: Float32Array;
  try {
    [v] = await makeEmbedder(space, { fetchImpl: o.fetchImpl, env: o.env, timeoutMs: o.timeoutMs ?? QUERY_TIMEOUT_MS }).embed([q], "query");
  } catch (e) {
    if (e instanceof EmbedError && e.outage) queryFailures.set(spaceKey, { until: now + QUERY_FAIL_TTL_MS, message: e.message });
    throw e;
  }
  queryFailures.delete(spaceKey);
  queryCache.set(key, v);
  if (queryCache.size > QUERY_CACHE_MAX) queryCache.delete(queryCache.keys().next().value!);
  return v;
}
