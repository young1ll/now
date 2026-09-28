// 검색 색인 유지 — 이벤트(outbox)를 따라가며 바뀐 객체의 카드만 다시 만든다.
// 색인은 파생 데이터다: 지우고 reindexAll 하면 같은 결과가 나온다. 내용 해시가 같으면 쓰지 않는다
// (M2 의 임베딩도 content_hash 로 재사용하므로, 여기서의 불필요한 쓰기는 곧 불필요한 임베딩 비용이다).
import type { DB } from "@/lib/db";
import { displayId } from "@/lib/ontology/ids";
import { INTRINSIC_LINKS } from "@/lib/ontology/schema";
import { OBJECT_TYPES, type ObjectType, type Ref } from "@/lib/ontology/types";
import { lastEventId } from "@/lib/repos/events";
import { deleteSetting, getSetting, setSetting } from "@/lib/repos/settings";
import { INDEXED_TYPES, type OwnerDoc, contentHash, estimateTokens, renderOwners } from "./cards";
import { redactSecrets } from "./redact";

export type IndexResult = { rendered: number; changed: number; removed: number };

const SWEEP_EVERY_MS = 60 * 60_000;
/** 한 틱에 이보다 많은 객체가 바뀌었으면 전체 재색인이 더 싸다 */
const MAX_INCREMENTAL = 300;
/**
 * 색인 형식 버전. 청크를 만드는 규칙(비밀값 가림 등)이 바뀌면 올린다 — 저장된 값과 다르면 다음 색인 호출이
 * 곧바로 전체 재색인한다 (주기 스윕을 기다리지 않는다). 2 = M2 비밀값 가림: M1 에서 가리지 않고 색인한 청크가
 * 임베딩 공급자(외부일 수 있음)로 가기 전에 가린 텍스트로 다시 쓰이게 한다 (같은 틱에서 색인이 임베딩보다 먼저).
 */
export const INDEX_FORMAT = "2";
const FORMAT_KEY = "index_format";
const formatStale = (db: DB) => getSetting(db, FORMAT_KEY) !== INDEX_FORMAT;

function writeOwner(db: DB, raw: OwnerDoc): boolean {
  // 비밀값은 청크에 들어가기 전에 가린다 — FTS·임베딩 공급자 어디에도 원문이 가지 않도록 (해시도 가린 텍스트로)
  const doc = { ...raw, chunks: raw.chunks.map(redactSecrets) };
  const existing = db.prepare("SELECT seq, content_hash FROM chunks WHERE owner_type = ? AND owner_id = ? ORDER BY seq").all(doc.ref.type, doc.ref.id) as { seq: number; content_hash: string }[];
  const hashes = doc.chunks.map(contentHash);
  if (existing.length === hashes.length && existing.every((e, i) => e.content_hash === hashes[i] && e.seq === i)) return false;
  const upsert = db.prepare(
    `INSERT INTO chunks (owner_type, owner_id, business_id, seq, head, text, tokens, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (owner_type, owner_id, seq) DO UPDATE SET business_id = excluded.business_id, head = excluded.head, text = excluded.text, tokens = excluded.tokens,
       content_hash = excluded.content_hash, indexed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE chunks.content_hash != excluded.content_hash OR chunks.business_id IS NOT excluded.business_id`,
  );
  doc.chunks.forEach((text, seq) => upsert.run(doc.ref.type, doc.ref.id, doc.businessId, seq, text.split("\n", 1)[0], text, estimateTokens(text), hashes[seq]));
  db.prepare("DELETE FROM chunks WHERE owner_type = ? AND owner_id = ? AND seq >= ?").run(doc.ref.type, doc.ref.id, doc.chunks.length);
  return true;
}

function removeOwner(db: DB, r: Ref): boolean {
  return db.prepare("DELETE FROM chunks WHERE owner_type = ? AND owner_id = ?").run(r.type, r.id).changes > 0;
}

/** 지정한 객체들만 다시 색인 (없어진 객체는 색인에서 제거) */
export function reindexRefs(db: DB, refs: Ref[]): IndexResult {
  const res: IndexResult = { rendered: 0, changed: 0, removed: 0 };
  const removed: Ref[] = [];
  db.transaction(() => {
    for (const type of new Set(refs.map((r) => r.type))) {
      const ids = [...new Set(refs.filter((r) => r.type === type).map((r) => r.id))];
      const docs = renderOwners(db, type, ids);
      for (const id of ids) {
        const doc = docs.get(id);
        if (doc) {
          res.rendered++;
          if (writeOwner(db, doc)) res.changed++;
        } else if (removeOwner(db, { type, id })) {
          res.removed++;
          removed.push({ type, id });
        }
      }
    }
    // 삭제된 객체를 이름으로 품고 있던 카드 (외래키는 이미 NULL 이라 dependents 로는 못 찾는다)
    const mentions = removed.flatMap((r) => mentioning(db, r)).filter((m) => !refs.some((x) => x.type === m.type && x.id === m.id));
    if (mentions.length) {
      const again = reindexRefs(db, mentions);
      res.rendered += again.rendered;
      res.changed += again.changed;
    }
  })();
  return res;
}

function mentioning(db: DB, r: Ref): Ref[] {
  return (db.prepare("SELECT DISTINCT c.owner_type AS type, c.owner_id AS id FROM chunks_fts f JOIN chunks c ON c.id = f.rowid WHERE chunks_fts MATCH ?").all(`"${displayId(r.type, r.id)}"`) as Ref[])
    .filter((m) => (OBJECT_TYPES as readonly string[]).includes(m.type));
}

/** 소유자 유형 → 테이블 (전체 재색인이 id 를 묶음으로 나눠 읽는다) */
const OWNER_TABLE: Record<ObjectType, string> = {
  business: "businesses", client: "clients", task: "tasks", invoice: "invoices", expense: "expenses", note: "notes", agent: "agents", memory: "memories",
};
/** 전체 재색인의 묶음 크기 — 묶음마다 커밋한다 (FTS 쓰기가 한 트랜잭션에 쌓이면 묶음마다 느려지고, 쓰기 잠금을 오래 쥔다) */
const SWEEP_BATCH = 500;

/**
 * 전체 재색인 단계들 — 묶음 하나(유형별 id SWEEP_BATCH 개)가 자기 트랜잭션이고, 묶음 사이에 yield 한다.
 * 동기 호출(reindexAll)은 끝까지 돌리고, 워커·요청 경로의 백그라운드 스윕(reindexAllAsync)은 묶음 사이에 이벤트 루프를 내준다.
 * 중간에 멈춰도 색인은 파생 데이터라 괜찮다 — 스윕 완료 표시(index_swept_at · 형식)는 마지막에 남기므로 다음 호출이 다시 스윕한다.
 */
function* sweepSteps(db: DB, now: Date, res: IndexResult): Generator<void, void> {
  for (const type of INDEXED_TYPES) {
    const ids = db.prepare(`SELECT id FROM ${OWNER_TABLE[type]} ORDER BY id`).pluck().all() as number[];
    for (let i = 0; i < ids.length; i += SWEEP_BATCH) {
      const part = ids.slice(i, i + SWEEP_BATCH);
      db.transaction(() => {
        const docs = renderOwners(db, type, part);
        for (const id of part) {
          const doc = docs.get(id);
          if (doc) {
            res.rendered++;
            if (writeOwner(db, doc)) res.changed++;
          } else if (removeOwner(db, { type, id })) res.removed++;
        }
      })();
      yield;
    }
    db.transaction(() => {
      const live = new Set(db.prepare(`SELECT id FROM ${OWNER_TABLE[type]}`).pluck().all() as number[]);
      const stale = (db.prepare("SELECT DISTINCT owner_id FROM chunks WHERE owner_type = ?").pluck().all(type) as number[]).filter((id) => !live.has(id));
      for (const id of stale) if (removeOwner(db, { type, id })) res.removed++;
    })();
    yield;
  }
  db.transaction(() => {
    // 알 수 없는 소유자 유형(과거 버전·실험 데이터) 정리
    db.prepare(`DELETE FROM chunks WHERE owner_type NOT IN (${OBJECT_TYPES.map(() => "?").join(",")})`).run(...OBJECT_TYPES);
    setSetting(db, "index_swept_at", now.toISOString());
    setSetting(db, FORMAT_KEY, INDEX_FORMAT);
  })();
}

/** 일괄 적재 표식 (마이그레이션 12 — 있는 동안 청크 트리거가 FTS 를 건너뛴다). 한 트랜잭션 안에서만 켠다 */
const BULK_KEY = "index_bulk";

/** 거의 전부를 새로 쓰는 전체 색인인가 — 빈 색인이거나 색인 형식이 바뀌었을 때 */
const needsBulk = (db: DB) => formatStale(db) || !db.prepare("SELECT 1 FROM chunks LIMIT 1").get();

/**
 * 일괄 전체 색인: 청크를 FTS 트리거 없이 쓰고 FTS 두 개를 'rebuild' 한 번으로 만든다 — 한 트랜잭션.
 * 행마다 trigram FTS 에 넣으면 색인이 커질수록 삽입이 느려져(초선형) 수만 청크의 첫 색인이 10분을 넘는다.
 */
function bulkReindex(db: DB, now: Date): IndexResult {
  const res: IndexResult = { rendered: 0, changed: 0, removed: 0 };
  db.transaction(() => {
    setSetting(db, BULK_KEY, "1");
    for (const type of INDEXED_TYPES) {
      const docs = renderOwners(db, type);
      for (const doc of docs.values()) {
        res.rendered++;
        if (writeOwner(db, doc)) res.changed++;
      }
      const stale = (db.prepare("SELECT DISTINCT owner_id FROM chunks WHERE owner_type = ?").pluck().all(type) as number[]).filter((id) => !docs.has(id));
      for (const id of stale) if (removeOwner(db, { type, id })) res.removed++;
    }
    db.prepare(`DELETE FROM chunks WHERE owner_type NOT IN (${OBJECT_TYPES.map(() => "?").join(",")})`).run(...OBJECT_TYPES);
    db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild'); INSERT INTO chunks_words(chunks_words) VALUES ('rebuild');");
    deleteSetting(db, BULK_KEY);
    setSetting(db, "index_swept_at", now.toISOString());
    setSetting(db, FORMAT_KEY, INDEX_FORMAT);
  })();
  return res;
}

/**
 * 전체 재색인 (동기). 빈 색인·형식 변경이면 일괄 적재, 아니면 묶음 스윕 — 바뀐 것만 쓰므로 반복해도 쓰기는 없다
 * (다만 모든 카드를 다시 렌더한다 — 워커는 reindexAllAsync).
 */
export function reindexAll(db: DB, now = new Date()): IndexResult {
  if (needsBulk(db)) return bulkReindex(db, now);
  const res: IndexResult = { rendered: 0, changed: 0, removed: 0 };
  for (const _ of sweepSteps(db, now, res));
  return res;
}

const yieldLoop = () => new Promise<void>((r) => setImmediate(r));
const g = globalThis as unknown as { __nowSweep?: Promise<IndexResult> };

/** 전체 재색인 (비동기) — 묶음 사이에 이벤트 루프를 내준다. 같은 프로세스에서 이미 도는 스윕이 있으면 그것을 기다린다 */
export function reindexAllAsync(db: DB, now = new Date()): Promise<IndexResult> {
  g.__nowSweep ??= (async () => {
    const res: IndexResult = { rendered: 0, changed: 0, removed: 0 };
    try {
      await yieldLoop();
      // 일괄 적재는 한 트랜잭션 (FTS 를 끝에 한 번에 만든다) — 빈 색인·형식 변경 때 한 번뿐이다
      if (needsBulk(db)) return bulkReindex(db, now);
      for (const _ of sweepSteps(db, now, res)) await yieldLoop();
      return res;
    } finally {
      g.__nowSweep = undefined;
    }
  })();
  return g.__nowSweep;
}

/** 이 프로세스에서 백그라운드 스윕이 도는 중인가 */
export const sweepRunning = () => !!g.__nowSweep;

/** 스윕을 시작한 시점의 이벤트 머리로 커서를 (뒤로 가지 않게) 옮긴다 — 그 뒤의 변화는 다음 증분이 반영한다 */
function advanceCursor(db: DB, head: number) {
  db.transaction(() => {
    if (head > Number(getSetting(db, "index_cursor") ?? 0)) setSetting(db, "index_cursor", String(head));
  })();
}

/** 카드에 이 객체의 이름이 들어가는 객체들 (외래키로 이 객체를 가리키는 쪽 + 이 객체를 대상·근거로 둔 기억) */
function dependents(db: DB, r: Ref): Ref[] {
  const out: Ref[] = [];
  for (const l of INTRINSIC_LINKS) {
    if (l.toType !== r.type) continue;
    for (const row of db.prepare(`SELECT id FROM ${l.table} WHERE ${l.fk} = ?`).all(r.id) as { id: number }[]) out.push({ type: l.fromType, id: row.id });
  }
  for (const row of db.prepare("SELECT DISTINCT from_id AS id FROM links WHERE from_type = 'memory' AND link_type IN ('about','evidenced_by') AND to_type = ? AND to_id = ?").all(r.type, r.id) as { id: number }[]) {
    out.push({ type: "memory", id: row.id });
  }
  return out;
}

function isRef(x: unknown): x is Ref {
  const r = x as Ref;
  return !!r && typeof r.id === "number" && (OBJECT_TYPES as readonly string[]).includes(r.type);
}

type Pending = IndexResult & { mode: "none" | "incremental" | "sweep" };
const NONE: Pending = { rendered: 0, changed: 0, removed: 0, mode: "none" };

/**
 * 워커 틱마다 호출. 마지막 처리 이후의 action.applied 이벤트에서 바뀐 객체를 모아 다시 색인한다.
 * 처음이거나, 색인 형식이 바뀌었거나, 한 시간이 지났으면 전체 스윕 (이벤트 밖의 변화 — 사용자 정의 링크 상대의 이름 변경 등 — 을 따라잡는다).
 * 증분은 커서 전진과 한 트랜잭션, 스윕은 묶음마다 커밋한 뒤 커서를 옮긴다.
 */
export function indexPending(db: DB, now = new Date(), o: { periodicSweep?: boolean } = {}): Pending {
  const plan = db.transaction(() => incremental(db, now, o.periodicSweep !== false))();
  if (plan.mode !== "sweep-needed") return plan;
  const r = reindexAll(db, now);
  advanceCursor(db, plan.head);
  return { ...r, mode: "sweep" };
}

/** indexPending 의 비동기판 — 스윕이면 묶음 사이에 이벤트 루프를 내준다 (워커 — Next 서버 안에서 돈다) */
export async function indexPendingAsync(db: DB, now = new Date(), o: { periodicSweep?: boolean } = {}): Promise<Pending> {
  const plan = db.transaction(() => incremental(db, now, o.periodicSweep !== false))();
  if (plan.mode !== "sweep-needed") return plan;
  const r = await reindexAllAsync(db, now);
  advanceCursor(db, plan.head);
  return { ...r, mode: "sweep" };
}

/** 증분 반영 — 스윕이 필요하면 쓰지 않고 그렇다고 알린다 (스윕은 이 트랜잭션 밖에서 묶음으로) */
function incremental(db: DB, now: Date, periodicSweep: boolean): Pending | { mode: "sweep-needed"; head: number } {
  const swept = getSetting(db, "index_swept_at");
  const cursor = Number(getSetting(db, "index_cursor") ?? 0);
  const head = lastEventId(db);
  if (!swept || formatStale(db) || (periodicSweep && now.getTime() - new Date(swept).getTime() > SWEEP_EVERY_MS)) return { mode: "sweep-needed", head };
  if (head <= cursor) return NONE;
  const rows = db.prepare("SELECT payload FROM events WHERE id > ? AND id <= ? AND type = 'action.applied'").all(cursor, head) as { payload: string }[];
  const touched = new Map<string, Ref>();
  // 이름이 바뀌었을 수 있어 카드에 그 이름을 담은 객체까지 따라가야 하는 ref.
  // memory.* 액션은 기억만 바꾼다 — refs 의 대상(about)은 감사·그래프용이고 대상 카드는 기억 링크를 담지 않으며,
  // 기억 문장은 바뀌지 않으므로(정정은 새 행) 다른 기억의 "근거: …" 줄도 그대로다. 확장하면 대상의 기억 N개를 매번 다시 렌더한다.
  const expand = new Map<string, Ref>();
  for (const row of rows) {
    const p = JSON.parse(row.payload) as { action?: string; refs?: unknown[] };
    const memoryAction = p.action?.startsWith("memory.") ?? false;
    for (const r of p.refs ?? []) {
      if (!isRef(r)) continue;
      const key = `${r.type}:${r.id}`;
      if (memoryAction && r.type !== "memory") continue;
      touched.set(key, r);
      if (!memoryAction) expand.set(key, r);
    }
  }
  const all = new Map(touched);
  if (touched.size <= MAX_INCREMENTAL) {
    for (const r of expand.values()) {
      for (const d of dependents(db, r)) all.set(`${d.type}:${d.id}`, d);
      if (all.size > MAX_INCREMENTAL) break;
    }
  }
  // 한도는 확장 뒤의 수로 — 허브 객체에 딸린 것이 많으면 증분보다 스윕이 낫다
  if (all.size > MAX_INCREMENTAL) return { mode: "sweep-needed", head };
  const r = reindexRefs(db, [...all.values()]);
  setSetting(db, "index_cursor", String(head));
  return { ...r, mode: "incremental" };
}

/** 요청 경로에서 동기로 전체 색인해도 되는 크기 (소유자 수) — 넘으면 백그라운드 스윕을 시작하고 지금 있는 색인으로 답한다 */
const REQUEST_SWEEP_MAX = 5000;

const ownerCount = (db: DB) => INDEXED_TYPES.reduce((n, t) => n + (db.prepare(`SELECT COUNT(*) FROM ${OWNER_TABLE[t]}`).pluck().get() as number), 0);

/**
 * 화면·도구가 색인을 읽기 전에: 없으면 만들고, 반영 안 된 이벤트가 있으면 증분 반영한다.
 * 워커가 꺼져 있어도(NOW_WORKER=off) 검색이 최신이도록. 주기 스윕은 워커 몫 — 요청 경로에서는 하지 않는다.
 * 큰 데이터의 전체 색인(첫 색인 · 형식 변경 · 증분 한도 초과)은 요청 안에서 하지 않는다 — 백그라운드 스윕을 시작하고
 * "building" 을 돌려준다 (호출자는 지금 있는 색인으로 답하고 강등을 알린다).
 */
export function ensureIndexed(db: DB): "fresh" | "building" {
  if (sweepRunning()) return "building";
  const fresh = getSetting(db, "index_swept_at") && !formatStale(db);
  if (fresh && lastEventId(db) <= Number(getSetting(db, "index_cursor") ?? 0)) return "fresh";
  const plan = db.transaction(() => incremental(db, new Date(), false))();
  if (plan.mode !== "sweep-needed") return "fresh";
  if (ownerCount(db) <= REQUEST_SWEEP_MAX) {
    reindexAll(db);
    advanceCursor(db, plan.head);
    return "fresh";
  }
  reindexAllAsync(db)
    .then(() => advanceCursor(db, plan.head))
    .catch((e) => console.error("[now-index] 백그라운드 색인 실패", e));
  return "building";
}

export type IndexStats = { chunks: number; owners: number; tokens: number; byType: Record<string, number>; sweptAt: string | null; cursor: number; lag: number };

export function indexStats(db: DB): IndexStats {
  const t = db.prepare("SELECT COUNT(*) AS chunks, COUNT(DISTINCT owner_type || ':' || owner_id) AS owners, COALESCE(SUM(tokens), 0) AS tokens FROM chunks").get() as { chunks: number; owners: number; tokens: number };
  const byType = Object.fromEntries((db.prepare("SELECT owner_type AS type, COUNT(DISTINCT owner_id) AS n FROM chunks GROUP BY owner_type").all() as { type: ObjectType; n: number }[]).map((r) => [r.type, r.n]));
  const cursor = Number(getSetting(db, "index_cursor") ?? 0);
  return { ...t, byType, sweptAt: getSetting(db, "index_swept_at") ?? null, cursor, lag: Math.max(0, lastEventId(db) - cursor) };
}
