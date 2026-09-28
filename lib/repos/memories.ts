// 기억(memory) 저장소. 읽기 함수는 어디서나, 쓰기 함수는 lib/ontology/actions/memory.ts 에서만 부른다
// (예외: recordMemoryUse — 사용 기록은 텔레메트리라 액션이 아니다. agents.last_seen_at 과 같은 취급).
import type { DB } from "@/lib/db";
import { IN_JSON, jsonList } from "@/lib/db/sql";
import type { ObjectType, Ref } from "@/lib/ontology/types";
import type { Scope } from "./scope";

export const MEMORY_KINDS = ["fact", "preference", "lesson", "procedure_hint", "caution"] as const;
export const MEMORY_STATUSES = ["proposed", "active", "verified", "disputed", "superseded", "retired"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];
export type MemoryOrigin = "human" | "agent" | "consolidation" | "import";

/** 아직 살아 있는(검토·사용 대상) 상태 */
export const LIVE_STATUSES: MemoryStatus[] = ["proposed", "active", "verified", "disputed"];
/** 보관된 상태 — 기본 검색·컨텍스트에서 빠진다 */
export const INACTIVE_STATUSES: MemoryStatus[] = ["superseded", "retired"];
/** 검토 대기 = 사람이 아직 보지 않았거나 충돌 중 */
export const REVIEW_STATUSES: MemoryStatus[] = ["proposed", "active", "disputed"];

export type Memory = {
  id: number;
  business_id: number | null;
  kind: MemoryKind;
  statement: string;
  status: MemoryStatus;
  confidence: number;
  origin: MemoryOrigin;
  tainted: number;
  pinned: number;
  valid_from: string | null;
  valid_to: string | null;
  supersedes_id: number | null;
  superseded_by_id: number | null;
  created_by: string;
  verified_by: string | null;
  verified_at: string | null;
  retired_reason: string | null;
  use_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
};

export type MemoryRow = Memory & { business_name: string | null };

const SELECT = "SELECT m.*, b.name AS business_name FROM memories m LEFT JOIN businesses b ON b.id = m.business_id";

/** 범위: 전체(null) 또는 한 사업 — 전역 기억(business_id NULL)은 모든 사업 범위에서 보인다 */
function scopeCond(scope: Scope): [string, unknown[]] {
  return scope === null ? ["1=1", []] : ["(m.business_id = ? OR m.business_id IS NULL)", [scope]];
}

/** 기억 목록 (최신 순). limit 기본 500 — 음수면 한도 없음 (신호처럼 전부 세야 하는 곳) */
export function listMemories(
  db: DB,
  scope: Scope,
  f: { status?: string[]; kind?: string; about?: Ref; q?: string; pinned?: boolean; limit?: number } = {},
): MemoryRow[] {
  const [sc, sp] = scopeCond(scope);
  const conds = [sc];
  const params: unknown[] = [...sp];
  if (f.status?.length) {
    conds.push(`m.status IN (${f.status.map(() => "?").join(",")})`);
    params.push(...f.status);
  }
  if (f.kind) {
    conds.push("m.kind = ?");
    params.push(f.kind);
  }
  if (f.pinned !== undefined) {
    conds.push("m.pinned = ?");
    params.push(f.pinned ? 1 : 0);
  }
  if (f.about) {
    conds.push("m.id IN (SELECT from_id FROM links WHERE link_type = 'about' AND from_type = 'memory' AND to_type = ? AND to_id = ?)");
    params.push(f.about.type, f.about.id);
  }
  if (f.q?.trim()) {
    conds.push("m.statement LIKE ? ESCAPE '\\'");
    params.push(`%${f.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  return db.prepare(`${SELECT} WHERE ${conds.join(" AND ")} ORDER BY m.id DESC LIMIT ?`).all(...params, f.limit ?? 500) as MemoryRow[];
}

export function getMemory(db: DB, id: number): MemoryRow | undefined {
  return db.prepare(`${SELECT} WHERE m.id = ?`).get(id) as MemoryRow | undefined;
}

export type MemoryLinks = { about: Ref[]; evidence: Ref[]; contradicts: number[]; promotedTo?: Ref };

type LinkRow = { link_type: string; from_type: ObjectType; from_id: number; to_type: ObjectType; to_id: number };

export function memoryLinks(db: DB, id: number): MemoryLinks {
  const rows = db
    .prepare(
      `SELECT link_type, from_type, from_id, to_type, to_id FROM links
       WHERE (from_type = 'memory' AND from_id = ?) OR (link_type = 'contradicts' AND to_type = 'memory' AND to_id = ?) ORDER BY id`,
    )
    .all(id, id) as LinkRow[];
  const out: MemoryLinks = { about: [], evidence: [], contradicts: [] };
  for (const r of rows) {
    const to = { type: r.to_type, id: r.to_id };
    if (r.link_type === "about" && r.from_id === id) out.about.push(to);
    else if (r.link_type === "evidenced_by" && r.from_id === id) out.evidence.push(to);
    else if (r.link_type === "promoted_to" && r.from_id === id) out.promotedTo = to;
    else if (r.link_type === "contradicts") {
      const other = r.from_type === "memory" && r.from_id === id ? r.to_id : r.from_id;
      if (other !== id && !out.contradicts.includes(other)) out.contradicts.push(other);
    }
  }
  return out;
}

/** 한 객체에 관한 기억 (about 링크) — 상태 순서(확인됨 → 활성 → 제안됨 → 충돌 …) 다음 id 순 */
export function memoriesAbout(db: DB, ref: Ref, statuses: string[] = LIVE_STATUSES): MemoryRow[] {
  if (!statuses.length) return [];
  const order = MEMORY_STATUS_ORDER.map((s) => `WHEN '${s}' THEN ${MEMORY_STATUS_ORDER.indexOf(s)}`).join(" ");
  return db
    .prepare(
      `${SELECT} WHERE m.id IN (SELECT from_id FROM links WHERE link_type = 'about' AND from_type = 'memory' AND to_type = ? AND to_id = ?)
       AND m.status IN (${statuses.map(() => "?").join(",")}) ORDER BY CASE m.status ${order} ELSE 9 END, m.id`,
    )
    .all(ref.type, ref.id, ...statuses) as MemoryRow[];
}

/** 컨텍스트·목록에서의 상태 우선순위 */
export const MEMORY_STATUS_ORDER: MemoryStatus[] = ["verified", "active", "proposed", "disputed", "superseded", "retired"];

/** 정정 계보: supersedes 체인을 양방향으로 따라간 전체 (오래된 것 → 새 것) */
export function lineage(db: DB, id: number): MemoryRow[] {
  const start = getMemory(db, id);
  if (!start) return [];
  const seen = new Set([id]);
  const back: MemoryRow[] = [];
  for (let cur = start.supersedes_id; cur && !seen.has(cur); ) {
    const m = getMemory(db, cur);
    if (!m) break;
    seen.add(cur);
    back.unshift(m);
    cur = m.supersedes_id;
  }
  const fwd: MemoryRow[] = [];
  for (let cur = start.superseded_by_id; cur && !seen.has(cur); ) {
    const m = getMemory(db, cur);
    if (!m) break;
    seen.add(cur);
    fwd.push(m);
    cur = m.superseded_by_id;
  }
  return [...back, start, ...fwd];
}

/** 사업별 검토 대기(제안 + 활성) 수와 가장 오래된 날짜 — 신호용 집계 (목록 한도에 걸리지 않는다) */
export function reviewCounts(db: DB, scope: Scope): { business_id: number | null; business_name: string | null; n: number; since: string }[] {
  const [sc, sp] = scopeCond(scope);
  return db
    .prepare(
      `SELECT m.business_id, b.name AS business_name, COUNT(*) AS n, substr(MIN(m.created_at), 1, 10) AS since
       FROM memories m LEFT JOIN businesses b ON b.id = m.business_id
       WHERE ${sc} AND m.status IN ('proposed','active') GROUP BY m.business_id ORDER BY COALESCE(m.business_id, 0)`,
    )
    .all(...sp) as { business_id: number | null; business_name: string | null; n: number; since: string }[];
}

export type MemoryStats = Record<MemoryStatus, number> & { total: number; review: number; pinned: number };

export function memoryStats(db: DB, scope: Scope): MemoryStats {
  const [sc, sp] = scopeCond(scope);
  const rows = db.prepare(`SELECT m.status, COUNT(*) AS n, SUM(m.pinned) AS pinned FROM memories m WHERE ${sc} GROUP BY m.status`).all(...sp) as { status: MemoryStatus; n: number; pinned: number }[];
  const s = Object.fromEntries(MEMORY_STATUSES.map((k) => [k, 0])) as MemoryStats;
  s.total = 0;
  s.review = 0;
  s.pinned = 0;
  for (const r of rows) {
    s[r.status] = r.n;
    s.total += r.n;
    if (REVIEW_STATUSES.includes(r.status)) s.review += r.n;
    if (LIVE_STATUSES.includes(r.status)) s.pinned += r.pinned ?? 0;
  }
  return s;
}

export type MemoryUse = { id: number; memory_id: number; session_id: number | null; actor: string; how: "context" | "cited"; used_at: string };

export function listMemoryUses(db: DB, f: { memoryId?: number; sessionId?: number; how?: "context" | "cited"; limit?: number }): MemoryUse[] {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (f.memoryId !== undefined) {
    conds.push("memory_id = ?");
    params.push(f.memoryId);
  }
  if (f.sessionId !== undefined) {
    conds.push("session_id = ?");
    params.push(f.sessionId);
  }
  if (f.how) {
    conds.push("how = ?");
    params.push(f.how);
  }
  return db.prepare(`SELECT * FROM memory_uses ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`).all(...params, f.limit ?? 100) as MemoryUse[];
}

/** "사용"을 세는 기간 (승격 후보 · 미사용 만료) */
export const USE_WINDOW_DAYS = 90;

/**
 * 실제로 쓰인 횟수 (M4 §6.5) — use_count 는 텔레메트리 누계라 실패한 세션의 팩 포함까지 센다.
 * 여기서의 사용 = since 이후 인용(cited) + 컨텍스트 포함(context) 중 성공한 세션(status succeeded)이거나 세션 밖(MCP·REST get_context).
 * ids 를 주면 그 기억만, 없으면 사용이 있는 모든 기억. 없는 id 는 결과에 없다 (= 0).
 */
export function effectiveUses(db: DB, since: string, ids?: number[]): Map<number, number> {
  const out = new Map<number, number>();
  if (ids && !ids.length) return out;
  const run = (part?: number[]) => {
    const rows = db
      .prepare(
        `SELECT u.memory_id AS id, COUNT(*) AS n FROM memory_uses u LEFT JOIN agent_sessions s ON s.id = u.session_id
         WHERE u.used_at >= ? AND (u.how = 'cited' OR u.session_id IS NULL OR s.status = 'succeeded')
         ${part ? `AND u.memory_id IN ${IN_JSON}` : ""} GROUP BY u.memory_id`,
      )
      .all(since, ...(part ? [jsonList(part)] : [])) as { id: number; n: number }[];
    for (const r of rows) out.set(r.id, r.n);
  };
  if (!ids) run();
  else for (let i = 0; i < ids.length; i += 500) run(ids.slice(i, i + 500));
  return out;
}

// ── 쓰기 (액션 전용) ──────────────────────────────────

export type NewMemory = {
  business_id: number | null;
  kind: MemoryKind;
  statement: string;
  status: MemoryStatus;
  confidence: number;
  origin: MemoryOrigin;
  tainted: boolean;
  valid_from: string | null;
  valid_to: string | null;
  supersedes_id?: number | null;
  created_by: string;
  verified_by?: string | null;
};

const now = () => new Date().toISOString();

export function insertMemory(db: DB, m: NewMemory): number {
  const at = now();
  return Number(
    db
      .prepare(
        `INSERT INTO memories (business_id, kind, statement, status, confidence, origin, tainted, valid_from, valid_to, supersedes_id, created_by, verified_by, verified_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(m.business_id, m.kind, m.statement, m.status, m.confidence, m.origin, m.tainted ? 1 : 0, m.valid_from, m.valid_to, m.supersedes_id ?? null, m.created_by,
        m.verified_by ?? null, m.verified_by ? at : null, at, at).lastInsertRowid,
  );
}

type Patch = Partial<Pick<Memory, "status" | "confidence" | "tainted" | "pinned" | "superseded_by_id" | "verified_by" | "verified_at" | "retired_reason" | "use_count">>;

export function updateMemory(db: DB, id: number, p: Patch) {
  const keys = Object.keys(p).filter((k) => p[k as keyof Patch] !== undefined);
  if (!keys.length) return;
  db.prepare(`UPDATE memories SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => p[k as keyof Patch]), now(), id);
}

/** 기억에서 나가는 링크 (중복은 무시). 새로 만들어졌으면 true */
export function addMemoryLink(db: DB, linkType: string, memoryId: number, to: Ref, note = ""): boolean {
  return db.prepare("INSERT OR IGNORE INTO links (link_type, from_type, from_id, to_type, to_id, note) VALUES (?, 'memory', ?, ?, ?, ?)").run(linkType, memoryId, to.type, to.id, note).changes > 0;
}

/** 두 기억 사이의 충돌 링크 (방향 무관) 삭제 */
export function removeContradiction(db: DB, a: number, b: number) {
  db.prepare(
    `DELETE FROM links WHERE link_type = 'contradicts' AND from_type = 'memory' AND to_type = 'memory'
     AND ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))`,
  ).run(a, b, b, a);
}

/** from 의 about/evidence 링크를 into 로 옮긴다 (합치기) */
export function moveMemoryLinks(db: DB, from: number, into: number) {
  const rows = db.prepare("SELECT id, link_type, to_type, to_id, note FROM links WHERE from_type = 'memory' AND from_id = ? AND link_type IN ('about','evidenced_by')").all(from) as { id: number; link_type: string; to_type: ObjectType; to_id: number; note: string }[];
  for (const r of rows) {
    if (!(r.to_type === "memory" && r.to_id === into)) addMemoryLink(db, r.link_type, into, { type: r.to_type, id: r.to_id }, r.note);
    db.prepare("DELETE FROM links WHERE id = ?").run(r.id);
  }
}

/**
 * 사용 기록 (텔레메트리 — 액션이 아님). 컨텍스트에 포함(context) 또는 AI 가 인용(cited).
 * 존재하지 않는 id 는 건너뛰고, 기록한 id 만 돌려준다. 같은 호출 안의 중복 id 는 한 번만.
 */
export function recordMemoryUse(db: DB, ids: number[], o: { sessionId?: number | null; actor: string; how: "context" | "cited" }): number[] {
  const uniq = [...new Set(ids.filter((x) => Number.isInteger(x) && x > 0))];
  if (!uniq.length) return [];
  const at = now();
  const done: number[] = [];
  db.transaction(() => {
    const ins = db.prepare("INSERT INTO memory_uses (memory_id, session_id, actor, how, used_at) VALUES (?, ?, ?, ?, ?)");
    const bump = db.prepare("UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?");
    for (const id of uniq) {
      if (!bump.run(at, id).changes) continue;
      ins.run(id, o.sessionId ?? null, o.actor, o.how, at);
      done.push(id);
    }
  })();
  return done;
}

/** "[mem:12]" · "[mem:12 · 확인됨]" 인용 파싱 */
export function parseCitations(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\[mem:(\d+)(?=[\]\s·,])/g)) {
    const n = Number(m[1]);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

export const actorKey = (a: { type: string; id: string }) => `${a.type}:${a.id}`;

/** created_by ('agent:3' · 'human:operator') → 사람이 읽는 이름 */
export function creatorName(db: DB, createdBy: string): string {
  const [type, id] = createdBy.split(":");
  if (type === "agent") return (db.prepare("SELECT name FROM agents WHERE id = ?").get(Number(id)) as { name: string } | undefined)?.name ?? `에이전트 ${id}`;
  if (type === "system") return "시스템";
  return "사람";
}
