// 온톨로지 그래프: 객체 = 노드, 링크(외래키 · 감사 파생 · 사용자 정의) = 간선.
// 저장소는 SQLite 그대로 두고, 그래프 질의(이웃·경로·전체)는 이 계층에서 계산한다.
import type { DB } from "@/lib/db";
import { IN_JSON, jsonList } from "@/lib/db/sql";
import { CLIENT_STATUS, INVOICE_STATUS, MEMORY_STATUS, TASK_STATUS, type Tone } from "@/lib/labels";
import type { Scope } from "@/lib/repos/scope";
import { displayId } from "./ids";
import { DERIVED_LINKS, INTRINSIC_LINKS, customLinkTypes } from "./schema";
import { OBJECT_TYPES, type ObjectType, type Ref, refKey } from "./types";

export type GraphNode = {
  key: string;
  type: ObjectType;
  id: number;
  displayId: string;
  title: string;
  status?: { label: string; tone: Tone };
  businessId: number | null;
};

export type GraphEdge = {
  key: string;
  from: string;
  to: string;
  linkType: string;
  label: string;
  source: "intrinsic" | "derived" | "custom";
  /** custom 링크의 id (삭제용) */
  linkId?: number;
};

export type Graph = { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean };

// ── 노드 정보 (유형별 일괄 조회) ─────────────────────────

const NODE_SQL: Record<ObjectType, string> = {
  business: "SELECT id, name AS title, CASE archived WHEN 1 THEN 'archived' ELSE 'active' END AS status, id AS business_id FROM businesses",
  client: "SELECT id, name AS title, status, business_id FROM clients",
  task: "SELECT id, title, status, business_id FROM tasks",
  invoice: "SELECT i.id, i.number || COALESCE(' · ' || c.name, '') AS title, i.status, i.business_id FROM invoices i LEFT JOIN clients c ON c.id = i.client_id",
  expense: "SELECT id, description AS title, NULL AS status, business_id FROM expenses",
  note: "SELECT id, title, NULL AS status, business_id FROM notes",
  agent: "SELECT id, name AS title, status, NULL AS business_id FROM agents",
  memory: "SELECT id, statement AS title, status, business_id FROM memories",
};

function statusOf(type: ObjectType, s: string | null): GraphNode["status"] {
  if (!s) return undefined;
  if (type === "client") return CLIENT_STATUS[s as keyof typeof CLIENT_STATUS];
  if (type === "task") return TASK_STATUS[s as keyof typeof TASK_STATUS];
  if (type === "invoice") return INVOICE_STATUS[s as keyof typeof INVOICE_STATUS];
  if (type === "agent") return { active: { label: "활성", tone: "green" as Tone }, suspended: { label: "정지", tone: "amber" as Tone }, revoked: { label: "폐기", tone: "zinc" as Tone } }[s];
  if (type === "business") return s === "archived" ? { label: "보관", tone: "zinc" } : undefined;
  if (type === "memory") return MEMORY_STATUS[s as keyof typeof MEMORY_STATUS];
  return undefined;
}

type NodeRow = { id: number; title: string; status: string | null; business_id: number | null };

function toNode(type: ObjectType, r: NodeRow): GraphNode {
  return { key: refKey({ type, id: r.id }), type, id: r.id, displayId: displayId(type, r.id), title: r.title, status: statusOf(type, r.status), businessId: r.business_id };
}

export function nodeInfo(db: DB, refs: Ref[]): Map<string, GraphNode> {
  const out = new Map<string, GraphNode>();
  const byType = new Map<ObjectType, number[]>();
  for (const r of refs) byType.set(r.type, [...(byType.get(r.type) ?? []), r.id]);
  for (const [type, ids] of byType) {
    const uniq = [...new Set(ids)];
    for (let i = 0; i < uniq.length; i += 500) {
      const chunk = uniq.slice(i, i + 500);
      const sql = `SELECT * FROM (${NODE_SQL[type]}) WHERE id IN ${IN_JSON}`;
      for (const row of db.prepare(sql).all(jsonList(chunk)) as NodeRow[]) out.set(refKey({ type, id: row.id }), toNode(type, row));
    }
  }
  return out;
}

// ── 간선 ─────────────────────────────────────────────

type RawEdge = { from: Ref; to: Ref; linkType: string; label: string; source: GraphEdge["source"]; linkId?: number };

/** 한 객체에 닿는 모든 간선 (양방향) */
export function edgesOf(db: DB, ref: Ref): RawEdge[] {
  const out: RawEdge[] = [];
  for (const l of INTRINSIC_LINKS) {
    if (l.fromType === ref.type) {
      const r = db.prepare(`SELECT ${l.fk} AS to_id FROM ${l.table} WHERE id = ? AND ${l.fk} IS NOT NULL`).get(ref.id) as { to_id: number } | undefined;
      if (r) out.push({ from: ref, to: { type: l.toType as ObjectType, id: r.to_id }, linkType: l.name, label: l.label, source: "intrinsic" });
    }
    if (l.toType === ref.type) {
      for (const r of db.prepare(`SELECT id FROM ${l.table} WHERE ${l.fk} = ?`).all(ref.id) as { id: number }[]) {
        out.push({ from: { type: l.fromType, id: r.id }, to: ref, linkType: l.name, label: l.label, source: "intrinsic" });
      }
    }
  }
  // 에이전트 → 변경한 객체 (감사 로그 파생)
  const touched = DERIVED_LINKS[0];
  if (ref.type === "agent") {
    const rows = db
      .prepare(
        `SELECT DISTINCT f.object_type AS type, f.object_id AS id FROM action_runs r JOIN action_run_refs f ON f.run_id = r.id
         WHERE r.actor_type = 'agent' AND r.actor_id = ? AND r.status = 'applied' LIMIT 200`,
      )
      .all(String(ref.id)) as Ref[];
    for (const t of rows) out.push({ from: ref, to: t, linkType: touched.name, label: touched.label, source: "derived" });
  } else {
    const rows = db
      .prepare(
        `SELECT DISTINCT CAST(r.actor_id AS INTEGER) AS id FROM action_runs r JOIN action_run_refs f ON f.run_id = r.id
         WHERE r.actor_type = 'agent' AND r.status = 'applied' AND f.object_type = ? AND f.object_id = ?`,
      )
      .all(ref.type, ref.id) as { id: number }[];
    for (const a of rows) out.push({ from: { type: "agent", id: a.id }, to: ref, linkType: touched.name, label: touched.label, source: "derived" });
  }
  // 사용자 정의 링크
  const labels = new Map(customLinkTypes(db).map((l) => [l.name, l.label]));
  const rows = db
    .prepare("SELECT * FROM links WHERE (from_type = ? AND from_id = ?) OR (to_type = ? AND to_id = ?)")
    .all(ref.type, ref.id, ref.type, ref.id) as { id: number; link_type: string; from_type: ObjectType; from_id: number; to_type: ObjectType; to_id: number }[];
  for (const r of rows) {
    out.push({ from: { type: r.from_type, id: r.from_id }, to: { type: r.to_type, id: r.to_id }, linkType: r.link_type, label: labels.get(r.link_type) ?? r.link_type, source: "custom", linkId: r.id });
  }
  return out;
}

/**
 * 객체가 외래키로 가리키는 "주인" 객체 (업무·청구서·문서 → 고객). 사업은 넣지 않는다 — 사업 전체의 기억은 대상 객체의 문맥이 아니다.
 * 세션 컨텍스트 팩이 업무 세션에 그 고객에 관한 기억도 싣게 한다 (결정적: 스키마 순서).
 */
export function ownersOf(db: DB, ref: Ref): Ref[] {
  const out: Ref[] = [];
  for (const l of INTRINSIC_LINKS) {
    if (l.fromType !== ref.type || l.toType === "business" || l.toType === "*") continue;
    const r = db.prepare(`SELECT ${l.fk} AS to_id FROM ${l.table} WHERE id = ? AND ${l.fk} IS NOT NULL`).get(ref.id) as { to_id: number } | undefined;
    if (r) out.push({ type: l.toType as ObjectType, id: r.to_id });
  }
  return out;
}

function edgeKey(e: RawEdge) {
  return `${e.linkType}|${refKey(e.from)}|${refKey(e.to)}`;
}

function finish(db: DB, refs: Ref[], raw: RawEdge[], truncated: boolean): Graph {
  const nodes = nodeInfo(db, refs);
  const edges = new Map<string, GraphEdge>();
  for (const e of raw) {
    const from = refKey(e.from);
    const to = refKey(e.to);
    if (!nodes.has(from) || !nodes.has(to)) continue;
    edges.set(edgeKey(e), { key: edgeKey(e), from, to, linkType: e.linkType, label: e.label, source: e.source, linkId: e.linkId });
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], truncated };
}

export type TraverseOpts = { depth?: number; limit?: number; linkTypes?: string[]; includeDerived?: boolean };

/** 한 객체에서 depth 단계까지 이웃 탐색 (BFS) */
export function neighborhood(db: DB, start: Ref, o: TraverseOpts = {}): Graph {
  const depth = Math.min(Math.max(o.depth ?? 1, 1), 4);
  const limit = o.limit ?? 150;
  const seen = new Map<string, Ref>([[refKey(start), start]]);
  const raw: RawEdge[] = [];
  let frontier = [start];
  let truncated = false;
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: Ref[] = [];
    for (const r of frontier) {
      for (const e of edgesOf(db, r)) {
        if (o.linkTypes && !o.linkTypes.includes(e.linkType)) continue;
        if (o.includeDerived === false && e.source === "derived") continue;
        raw.push(e);
        for (const n of [e.from, e.to]) {
          const k = refKey(n);
          if (seen.has(k)) continue;
          if (seen.size >= limit) {
            truncated = true;
            continue;
          }
          seen.set(k, n);
          next.push(n);
        }
      }
    }
    frontier = next;
  }
  return finish(db, [...seen.values()], raw, truncated);
}

/** 두 객체 사이의 최단 경로 (무방향 BFS). 없으면 null. */
export function shortestPath(db: DB, a: Ref, b: Ref, maxDepth = 6): Graph | null {
  const target = refKey(b);
  const prev = new Map<string, { ref: Ref; via?: RawEdge; parent?: string }>([[refKey(a), { ref: a }]]);
  let frontier = [a];
  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next: Ref[] = [];
    for (const r of frontier) {
      for (const e of edgesOf(db, r)) {
        const other = refKey(e.from) === refKey(r) ? e.to : e.from;
        const k = refKey(other);
        if (prev.has(k)) continue;
        prev.set(k, { ref: other, via: e, parent: refKey(r) });
        if (k === target) {
          const refs: Ref[] = [];
          const raw: RawEdge[] = [];
          for (let cur: string | undefined = k; cur; cur = prev.get(cur)!.parent) {
            const p = prev.get(cur)!;
            refs.push(p.ref);
            if (p.via) raw.push(p.via);
          }
          return finish(db, refs.reverse(), raw, false);
        }
        next.push(other);
      }
    }
    frontier = next;
  }
  return null;
}

/** 범위 전체 그래프 (개요). 유형 필터 · 노드 상한. */
export function overview(db: DB, scope: Scope, o: { types?: ObjectType[]; limit?: number; includeDerived?: boolean } = {}): Graph {
  const types = o.types?.length ? o.types : OBJECT_TYPES.filter((t) => t !== "expense");
  const limit = o.limit ?? 400;
  const refs: Ref[] = [];
  let truncated = false;
  for (const type of types) {
    const rows = db.prepare(`SELECT id, business_id FROM (${NODE_SQL[type]})`).all() as { id: number; business_id: number | null }[];
    for (const r of rows) {
      if (scope !== null && type !== "agent" && r.business_id !== null && r.business_id !== scope && !(type === "business" && r.id === scope)) continue;
      if (refs.length >= limit) {
        truncated = true;
        break;
      }
      refs.push({ type, id: r.id });
    }
  }
  const inSet = new Set(refs.map(refKey));
  const raw: RawEdge[] = [];
  for (const l of INTRINSIC_LINKS) {
    if (!types.includes(l.fromType) || !types.includes(l.toType as ObjectType)) continue;
    for (const r of db.prepare(`SELECT id, ${l.fk} AS to_id FROM ${l.table} WHERE ${l.fk} IS NOT NULL`).all() as { id: number; to_id: number }[]) {
      raw.push({ from: { type: l.fromType, id: r.id }, to: { type: l.toType as ObjectType, id: r.to_id }, linkType: l.name, label: l.label, source: "intrinsic" });
    }
  }
  const labels = new Map(customLinkTypes(db).map((l) => [l.name, l.label]));
  for (const r of db.prepare("SELECT * FROM links").all() as { id: number; link_type: string; from_type: ObjectType; from_id: number; to_type: ObjectType; to_id: number }[]) {
    raw.push({ from: { type: r.from_type, id: r.from_id }, to: { type: r.to_type, id: r.to_id }, linkType: r.link_type, label: labels.get(r.link_type) ?? r.link_type, source: "custom", linkId: r.id });
  }
  if (o.includeDerived !== false && types.includes("agent")) {
    const rows = db
      .prepare(
        `SELECT DISTINCT CAST(r.actor_id AS INTEGER) AS agent_id, f.object_type AS type, f.object_id AS id FROM action_runs r JOIN action_run_refs f ON f.run_id = r.id
         WHERE r.actor_type = 'agent' AND r.status = 'applied'`,
      )
      .all() as { agent_id: number; type: ObjectType; id: number }[];
    for (const r of rows) raw.push({ from: { type: "agent", id: r.agent_id }, to: { type: r.type, id: r.id }, linkType: "agent.touched", label: DERIVED_LINKS[0].label, source: "derived" });
  }
  return finish(db, refs, raw.filter((e) => inSet.has(refKey(e.from)) && inSet.has(refKey(e.to))), truncated);
}

/** "client:3" · "CLT-0003" → Ref */
export function parseRef(s: string): Ref | undefined {
  const t = s.trim();
  const m1 = t.match(/^([a-z]+):(\d+)$/);
  if (m1 && (OBJECT_TYPES as readonly string[]).includes(m1[1])) return { type: m1[1] as ObjectType, id: Number(m1[2]) };
  const m2 = t.toUpperCase().match(/^([A-Z]{3})-0*(\d+)$/);
  if (m2) {
    const PREF: Record<string, ObjectType> = { BIZ: "business", CLT: "client", TSK: "task", INV: "invoice", EXP: "expense", DOC: "note", AGT: "agent", MEM: "memory" };
    const type = PREF[m2[1]];
    if (type) return { type, id: Number(m2[2]) };
  }
  return undefined;
}

export function objectExists(db: DB, r: Ref): boolean {
  return nodeInfo(db, [r]).has(refKey(r));
}

/** 객체 삭제 시 사용자 정의 링크 정리 */
export function deleteLinksFor(db: DB, r: Ref) {
  db.prepare("DELETE FROM links WHERE (from_type = ? AND from_id = ?) OR (to_type = ? AND to_id = ?)").run(r.type, r.id, r.type, r.id);
}
