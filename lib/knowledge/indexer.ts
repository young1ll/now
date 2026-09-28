// 검색 색인 유지 — 이벤트(outbox)를 따라가며 바뀐 객체의 카드만 다시 만든다.
// 색인은 파생 데이터다: 지우고 reindexAll 하면 같은 결과가 나온다. 내용 해시가 같으면 쓰지 않는다
// (M2 의 임베딩도 content_hash 로 재사용하므로, 여기서의 불필요한 쓰기는 곧 불필요한 임베딩 비용이다).
import type { DB } from "@/lib/db";
import { displayId } from "@/lib/ontology/ids";
import { INTRINSIC_LINKS } from "@/lib/ontology/schema";
import { OBJECT_TYPES, type ObjectType, type Ref } from "@/lib/ontology/types";
import { lastEventId } from "@/lib/repos/events";
import { getSetting, setSetting } from "@/lib/repos/settings";
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

/** 전체 재색인. 바뀐 것만 쓰므로 반복 실행해도 싸다. */
export function reindexAll(db: DB, now = new Date()): IndexResult {
  const res: IndexResult = { rendered: 0, changed: 0, removed: 0 };
  db.transaction(() => {
    for (const type of INDEXED_TYPES) {
      const docs = renderOwners(db, type);
      for (const doc of docs.values()) {
        res.rendered++;
        if (writeOwner(db, doc)) res.changed++;
      }
      const stale = (db.prepare("SELECT DISTINCT owner_id AS id FROM chunks WHERE owner_type = ?").all(type) as { id: number }[]).filter((r) => !docs.has(r.id));
      for (const r of stale) if (removeOwner(db, { type, id: r.id })) res.removed++;
    }
    // 알 수 없는 소유자 유형(과거 버전·실험 데이터) 정리
    db.prepare(`DELETE FROM chunks WHERE owner_type NOT IN (${OBJECT_TYPES.map(() => "?").join(",")})`).run(...OBJECT_TYPES);
    setSetting(db, "index_swept_at", now.toISOString());
    setSetting(db, FORMAT_KEY, INDEX_FORMAT);
  })();
  return res;
}

/** 카드에 이 객체의 이름이 들어가는 객체들 (외래키로 이 객체를 가리키는 쪽) */
function dependents(db: DB, r: Ref): Ref[] {
  const out: Ref[] = [];
  for (const l of INTRINSIC_LINKS) {
    if (l.toType !== r.type) continue;
    for (const row of db.prepare(`SELECT id FROM ${l.table} WHERE ${l.fk} = ?`).all(r.id) as { id: number }[]) out.push({ type: l.fromType, id: row.id });
  }
  return out;
}

function isRef(x: unknown): x is Ref {
  const r = x as Ref;
  return !!r && typeof r.id === "number" && (OBJECT_TYPES as readonly string[]).includes(r.type);
}

/**
 * 워커 틱마다 호출. 마지막 처리 이후의 action.applied 이벤트에서 바뀐 객체를 모아 다시 색인한다.
 * 처음이거나, 색인 형식이 바뀌었거나, 한 시간이 지났으면 전체 스윕 (이벤트 밖의 변화 — 사용자 정의 링크 상대의 이름 변경 등 — 을 따라잡는다).
 */
export function indexPending(db: DB, now = new Date(), o: { periodicSweep?: boolean } = {}): IndexResult & { mode: "none" | "incremental" | "sweep" } {
  // 커서 전진과 색인 쓰기를 한 트랜잭션으로 (여러 워커가 돌아도 결과가 같다)
  return db.transaction(() => pending(db, now, o.periodicSweep !== false))();
}

function pending(db: DB, now: Date, periodicSweep: boolean): IndexResult & { mode: "none" | "incremental" | "sweep" } {
  const swept = getSetting(db, "index_swept_at");
  const cursor = Number(getSetting(db, "index_cursor") ?? 0);
  const head = lastEventId(db);
  if (!swept || formatStale(db) || (periodicSweep && now.getTime() - new Date(swept).getTime() > SWEEP_EVERY_MS)) {
    const r = reindexAll(db, now);
    setSetting(db, "index_cursor", String(head));
    return { ...r, mode: "sweep" };
  }
  if (head <= cursor) return { rendered: 0, changed: 0, removed: 0, mode: "none" };
  const rows = db.prepare("SELECT payload FROM events WHERE id > ? AND id <= ? AND type = 'action.applied'").all(cursor, head) as { payload: string }[];
  const touched = new Map<string, Ref>();
  for (const row of rows) {
    const refs = (JSON.parse(row.payload) as { refs?: unknown[] }).refs ?? [];
    for (const r of refs) if (isRef(r)) touched.set(`${r.type}:${r.id}`, r);
  }
  if (touched.size > MAX_INCREMENTAL) {
    const r = reindexAll(db, now);
    setSetting(db, "index_cursor", String(head));
    return { ...r, mode: "sweep" };
  }
  const all = new Map(touched);
  for (const r of touched.values()) for (const d of dependents(db, r)) all.set(`${d.type}:${d.id}`, d);
  const r = reindexRefs(db, [...all.values()]);
  setSetting(db, "index_cursor", String(head));
  return { ...r, mode: "incremental" };
}

/**
 * 화면·도구가 색인을 읽기 전에: 없으면 만들고, 반영 안 된 이벤트가 있으면 증분 반영한다.
 * 워커가 꺼져 있어도(NOW_WORKER=off) 검색이 최신이도록. 주기 스윕은 워커 몫 — 요청 경로에서는 하지 않는다.
 */
export function ensureIndexed(db: DB) {
  if (!getSetting(db, "index_swept_at") || formatStale(db) || lastEventId(db) > Number(getSetting(db, "index_cursor") ?? 0)) indexPending(db, new Date(), { periodicSweep: false });
}

export type IndexStats = { chunks: number; owners: number; tokens: number; byType: Record<string, number>; sweptAt: string | null; cursor: number; lag: number };

export function indexStats(db: DB): IndexStats {
  const t = db.prepare("SELECT COUNT(*) AS chunks, COUNT(DISTINCT owner_type || ':' || owner_id) AS owners, COALESCE(SUM(tokens), 0) AS tokens FROM chunks").get() as { chunks: number; owners: number; tokens: number };
  const byType = Object.fromEntries((db.prepare("SELECT owner_type AS type, COUNT(DISTINCT owner_id) AS n FROM chunks GROUP BY owner_type").all() as { type: ObjectType; n: number }[]).map((r) => [r.type, r.n]));
  const cursor = Number(getSetting(db, "index_cursor") ?? 0);
  return { ...t, byType, sweptAt: getSetting(db, "index_swept_at") ?? null, cursor, lag: Math.max(0, lastEventId(db) - cursor) };
}
