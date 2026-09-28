// 벡터 저장소 — 본 DB 에 ATTACH 한 파생 전용 파일(now-vec.db). 지우면 워커가 원본 청크에서 다시 채운다.
// 백업(VACUUM INTO)은 main 만 담으므로 벡터로 부풀지 않는다 (docs/MEMORY.md §2, §7).
//
//   vec.vectors        (space_id, content_hash) → f: L2 정규화 float32 — 재정렬·정확 점수용
//   vec.knn_<space>    vec0(e bit[D]) — rowid = vectors.id, 부호 비트 1차 후보(해밍 거리)
//   vec.spaces         space_id → 본 DB 공간 행의 지문(created_at·공급자·모델·주소·접두사)
//
// 벡터 파일은 공간 id 로만 묶이는데, 본 DB 를 새로 만들거나 복원하면 id(1…)가 되풀이된다. 그래서 공간마다
// 지문을 남기고, 붙일 때(attach)와 쓸 때 본 DB 와 다르면 그 공간의 벡터·knn 테이블을 버린다 — 다른 모델의
// 벡터가 섞이거나, 옛 차원의 knn 테이블에 막혀 영구 실패하지 않도록. 캐시라 버려도 다시 채워질 뿐이다.
//
// 검색: bit 후보 max(k*20, 200) → float 내적 재정렬. 5만 청크에서 전수 float 스캔보다 수 배 빠르고,
// 재정렬 덕분에 최종 순서는 정확한 코사인이다 (후보 안에 들기만 하면).
import fs from "node:fs";
import path from "node:path";
import * as sqliteVec from "sqlite-vec";
import type { DB } from "@/lib/db";
import type { EmbeddingSpace } from "@/lib/repos/embeddings";

type Env = Record<string, string | undefined>;

export function vectorsEnabled(env: Env = process.env): boolean {
  return env.NOW_VECTORS !== "off";
}

/** 벡터 파일 경로. 본 DB 가 메모리면 벡터도 메모리 (테스트·평가가 실제 파일을 건드리지 않게 NOW_VEC_PATH 보다 우선). */
export function vecPathFor(mainFile: string, env: Env = process.env): string {
  if (!mainFile || mainFile === ":memory:") return ":memory:";
  if (env.NOW_VEC_PATH) return path.resolve(env.NOW_VEC_PATH);
  const ext = path.extname(mainFile);
  return path.join(path.dirname(mainFile), `${path.basename(mainFile, ext)}-vec${ext || ".db"}`);
}

type AttachState = { ok: boolean; path: string; error?: string };
const states = new WeakMap<DB, AttachState>();
let lastError: string | undefined;

/**
 * sqlite-vec 적재 → ATTACH → 스키마. 연결마다 한 번. 실패(플랫폼 미지원 등)하면 이유를 기억하고 false —
 * 호출자는 어휘 + 관계로 자연 강등한다.
 */
export function attachVectors(db: DB): boolean {
  const known = states.get(db);
  if (known) return known.ok;
  const file = vecPathFor(db.name);
  // HMR 로 이 모듈만 다시 평가된 경우: 연결은 이미 붙어 있다
  const attached = (db.pragma("database_list") as { name: string }[]).some((d) => d.name === "vec");
  // ATTACH 는 트랜잭션 안에서 할 수 없다 — 실패로 기억하지 않고 이번만 없는 것으로 (다음 호출에서 다시 시도)
  if (!attached && db.inTransaction) return false;
  try {
    if (!attached) {
      sqliteVec.load(db);
      if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
      db.prepare("ATTACH DATABASE ? AS vec").run(file);
      if (file !== ":memory:") db.pragma("vec.journal_mode = WAL");
    }
    db.exec(`CREATE TABLE IF NOT EXISTS vec.vectors (
      id           INTEGER PRIMARY KEY,
      space_id     INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      f            BLOB NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE (space_id, content_hash)
    )`);
    db.exec("CREATE TABLE IF NOT EXISTS vec.spaces (space_id INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL)");
    reconcileSpaces(db);
    states.set(db, { ok: true, path: file });
    return true;
  } catch (e) {
    lastError = `sqlite-vec 를 불러올 수 없습니다: ${e instanceof Error ? e.message : String(e)}`;
    states.set(db, { ok: false, path: file, error: lastError });
    return false;
  }
}

export type VectorStoreInfo = { enabled: boolean; attached: boolean; path: string; bytes: number; error?: string };

export function vectorStoreInfo(db: DB): VectorStoreInfo {
  const enabled = vectorsEnabled();
  const attached = enabled && attachVectors(db);
  const st = states.get(db);
  const file = st?.path ?? vecPathFor(db.name);
  const size = (f: string) => (f !== ":memory:" && fs.existsSync(f) ? fs.statSync(f).size : 0);
  return { enabled, attached, path: file, bytes: size(file) + size(`${file}-wal`), error: st?.error ?? (attached ? undefined : lastError) };
}

// ── 쓰기 ─────────────────────────────────────────────

const knnTable = (spaceId: number) => `vec.knn_${Math.trunc(spaceId)}`;
/** bit 벡터는 8의 배수 — 남는 비트는 0 */
const bitDim = (dim: number) => Math.ceil(dim / 8) * 8;

function knnExists(db: DB, spaceId: number): boolean {
  return !!db.prepare("SELECT 1 FROM vec.sqlite_master WHERE name = ?").get(`knn_${Math.trunc(spaceId)}`);
}

// ── 소유 확인 (본 DB 공간 ↔ 벡터 파일) ────────────────

/** 이 공간의 벡터를 결정하는 본 DB 행의 지문. dim 은 넣지 않는다 (0 → 첫 응답에서 확정되므로) — 모델이 같으면 같다. */
function fingerprintOf(db: DB, spaceId: number): string | undefined {
  const r = db.prepare("SELECT created_at, provider, model, base_url, passage_prefix FROM main.embedding_spaces WHERE id = ?").get(spaceId) as
    | { created_at: string; provider: string; model: string; base_url: string; passage_prefix: string }
    | undefined;
  return r ? JSON.stringify([r.created_at, r.provider, r.model, r.base_url, r.passage_prefix]) : undefined;
}

const storedFingerprint = (db: DB, spaceId: number) =>
  (db.prepare("SELECT fingerprint FROM vec.spaces WHERE space_id = ?").get(spaceId) as { fingerprint: string } | undefined)?.fingerprint;

/** 공간 하나의 벡터·knn 테이블·지문을 모두 버린다 */
function purgeSpace(db: DB, spaceId: number): number {
  db.exec(`DROP TABLE IF EXISTS ${knnTable(spaceId)}`);
  db.prepare("DELETE FROM vec.spaces WHERE space_id = ?").run(spaceId);
  return db.prepare("DELETE FROM vec.vectors WHERE space_id = ?").run(spaceId).changes;
}

const knnTableIds = (db: DB) =>
  (db.prepare("SELECT name FROM vec.sqlite_master WHERE type = 'table' AND name GLOB 'knn_[0-9]*' AND name NOT GLOB 'knn_*_*'").all() as { name: string }[]).map((r) => Number(r.name.slice(4)));

/** 벡터 파일에 있는 공간 중 본 DB 의 같은 id 공간과 지문이 다르거나(없거나) 지문이 없는 것을 버린다. attach 때 한 번. */
function reconcileSpaces(db: DB) {
  db.transaction(() => {
    const ids = new Set([
      ...knnTableIds(db),
      ...(db.prepare("SELECT DISTINCT space_id AS id FROM vec.vectors").all() as { id: number }[]).map((r) => r.id),
      ...(db.prepare("SELECT space_id AS id FROM vec.spaces").all() as { id: number }[]).map((r) => r.id),
    ]);
    for (const id of ids) {
      const fp = fingerprintOf(db, id);
      if (!fp || storedFingerprint(db, id) !== fp) purgeSpace(db, id);
    }
  })();
}

/** 쓰기 전에: 벡터 파일의 이 공간 데이터가 본 DB 의 이 공간 것이 아니면 버리고 지문을 새로 남긴다 */
function claimSpace(db: DB, spaceId: number) {
  const fp = fingerprintOf(db, spaceId);
  if (!fp) throw new Error(`임베딩 공간 ${spaceId} 이 없습니다`);
  if (storedFingerprint(db, spaceId) === fp) return;
  purgeSpace(db, spaceId);
  db.prepare("INSERT INTO vec.spaces (space_id, fingerprint) VALUES (?, ?)").run(spaceId, fp);
}

/** 읽기 전에: 이 공간의 벡터가 본 DB 의 이 공간 것인가 (아니면 검색하지 않는다 — 다음 쓰기가 비우고 다시 채운다) */
function ownsSpace(db: DB, spaceId: number): boolean {
  const fp = fingerprintOf(db, spaceId);
  return !!fp && storedFingerprint(db, spaceId) === fp;
}

/** 차원이 정해진 공간의 knn 테이블 (없으면 만든다) */
export function ensureKnn(db: DB, space: Pick<EmbeddingSpace, "id" | "dim">) {
  if (space.dim <= 0) throw new Error("차원이 정해지지 않은 공간입니다");
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${knnTable(space.id)} USING vec0(e bit[${bitDim(space.dim)}])`);
}

export function normalize(v: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(v);
  let s = 0;
  for (let i = 0; i < out.length; i++) s += out[i] * out[i];
  const n = Math.sqrt(s);
  if (n > 0) for (let i = 0; i < out.length; i++) out[i] /= n;
  return out;
}

/** 부호 비트 양자화: 성분 > 0 → 1 */
export function toBits(v: Float32Array): Buffer {
  const bits = Buffer.alloc(bitDim(v.length) / 8);
  for (let i = 0; i < v.length; i++) if (v[i] > 0) bits[i >> 3] |= 1 << (i & 7);
  return bits;
}

const toBlob = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const fromBlob = (b: Buffer) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

/** 멱등 저장: 이미 있는 (공간, 해시)는 건너뛴다 (knn 삽입도). 여러 프로세스가 같은 것을 채워도 한 번만 들어간다. */
export function storeVectors(db: DB, space: Pick<EmbeddingSpace, "id" | "dim">, items: { hash: string; vec: Float32Array }[]): number {
  let n = 0;
  db.transaction(() => {
    claimSpace(db, space.id);
    ensureKnn(db, space);
    const insVec = db.prepare("INSERT OR IGNORE INTO vec.vectors (space_id, content_hash, f) VALUES (?, ?, ?)");
    const insKnn = db.prepare(`INSERT INTO ${knnTable(space.id)} (rowid, e) VALUES (?, vec_bit(?))`);
    for (const it of items) {
      if (it.vec.length !== space.dim) throw new Error(`벡터 차원 ${it.vec.length} ≠ 공간 차원 ${space.dim}`);
      const r = insVec.run(space.id, it.hash, toBlob(it.vec));
      if (!r.changes) continue;
      insKnn.run(BigInt(r.lastInsertRowid), toBits(it.vec));
      n++;
    }
  })();
  return n;
}

// ── 검색 ─────────────────────────────────────────────

/** vec0 의 k 상한 */
const VEC0_MAX_K = 4096;

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * KNN: bit 해밍 거리로 후보를 넉넉히 뽑고 float 내적(= 코사인, 둘 다 정규화)으로 재정렬.
 * q 는 정규화된 질의 벡터. 반환 score 는 코사인 유사도.
 */
export function knn(db: DB, space: Pick<EmbeddingSpace, "id" | "dim">, q: Float32Array, k: number, o: { candidates?: number } = {}): { hash: string; score: number }[] {
  if (space.dim <= 0 || q.length !== space.dim || !knnExists(db, space.id) || !ownsSpace(db, space.id)) return [];
  const cand = Math.min(VEC0_MAX_K, o.candidates ?? Math.max(k * 20, 200));
  const ids = (db.prepare(`SELECT rowid AS id FROM ${knnTable(space.id)} WHERE e MATCH vec_bit(?) AND k = ?`).all(toBits(q), cand) as { id: number }[]).map((r) => r.id);
  if (!ids.length) return [];
  const rows = db.prepare(`SELECT content_hash AS hash, f FROM vec.vectors WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as { hash: string; f: Buffer }[];
  return rows
    .map((r) => ({ hash: r.hash, score: dot(q, fromBlob(r.f)) }))
    .sort((a, b) => b.score - a.score || a.hash.localeCompare(b.hash))
    .slice(0, k);
}

/** 저장된 벡터 (정규화 float) — 해시 → 벡터. 이 공간 것이 아니면(지문 불일치) 빈 결과. 큐레이터의 의미 중복 비교용 (질의 임베딩 없이) */
export function vectorsFor(db: DB, space: Pick<EmbeddingSpace, "id" | "dim">, hashes: string[]): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  if (!hashes.length || space.dim <= 0 || !ownsSpace(db, space.id)) return out;
  const uniq = [...new Set(hashes)];
  for (let i = 0; i < uniq.length; i += 500) {
    const part = uniq.slice(i, i + 500);
    const rows = db.prepare(`SELECT content_hash AS hash, f FROM vec.vectors WHERE space_id = ? AND content_hash IN (${part.map(() => "?").join(",")})`).all(space.id, ...part) as { hash: string; f: Buffer }[];
    for (const r of rows) out.set(r.hash, fromBlob(r.f));
  }
  return out;
}

// ── 정리 · 상태 ──────────────────────────────────────

/**
 * 청크에 더는 없는 content_hash 의 벡터, 폐기(retired)·삭제된 공간의 벡터와 knn 테이블을 지운다.
 * 워커의 시간당 스윕에서 호출. 벡터는 캐시라 지나치게 지워도 다시 채워질 뿐이다.
 */
export function gcVectors(db: DB): { removed: number; dropped: number } {
  if (!vectorsEnabled() || !attachVectors(db)) return { removed: 0, dropped: 0 };
  let removed = 0;
  let dropped = 0;
  db.transaction(() => {
    const live = new Set((db.prepare("SELECT id FROM embedding_spaces WHERE status != 'retired'").all() as { id: number }[]).map((r) => r.id));
    // 폐기·알 수 없는 공간, 그리고 본 DB 의 공간과 지문이 다른(다른 DB 의) 공간: knn 테이블째 DROP
    const tables = knnTableIds(db);
    const spaces = new Set([
      ...tables,
      ...(db.prepare("SELECT DISTINCT space_id AS id FROM vec.vectors").all() as { id: number }[]).map((r) => r.id),
      ...(db.prepare("SELECT space_id AS id FROM vec.spaces").all() as { id: number }[]).map((r) => r.id),
    ]);
    for (const id of spaces) {
      if (live.has(id) && ownsSpace(db, id)) continue;
      if (tables.includes(id)) dropped++;
      removed += purgeSpace(db, id);
    }
    // 청크에서 사라진 해시 (knn 행 먼저)
    const orphans = db.prepare("SELECT v.id, v.space_id FROM vec.vectors v WHERE NOT EXISTS (SELECT 1 FROM main.chunks c WHERE c.content_hash = v.content_hash)").all() as { id: number; space_id: number }[];
    for (const o of orphans) {
      if (tables.includes(o.space_id)) db.prepare(`DELETE FROM ${knnTable(o.space_id)} WHERE rowid = ?`).run(BigInt(o.id));
      removed += db.prepare("DELETE FROM vec.vectors WHERE id = ?").run(o.id).changes;
    }
  })();
  return { removed, dropped };
}

export type Coverage = { total: number; embedded: number; pct: number };

/** 공간이 얼마나 채워졌나 — 고유 content_hash 기준. pct 는 내림(99.96% 를 100% 로 보이지 않게). */
export function spaceCoverage(db: DB, spaceId: number): Coverage {
  const total = (db.prepare("SELECT COUNT(DISTINCT content_hash) AS n FROM chunks").get() as { n: number }).n;
  if (!vectorsEnabled() || !attachVectors(db)) return { total, embedded: 0, pct: total ? 0 : 100 };
  const embedded = (
    db.prepare("SELECT COUNT(*) AS n FROM vec.vectors v WHERE v.space_id = ? AND EXISTS (SELECT 1 FROM main.chunks c WHERE c.content_hash = v.content_hash)").get(spaceId) as { n: number }
  ).n;
  return { total, embedded, pct: total ? Math.floor((embedded / total) * 1000) / 10 : 100 };
}
