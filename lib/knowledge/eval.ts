// 검색 품질 측정 — 골든셋(질의 → 기대 객체)으로 recall@k · MRR · 지연을 잰다.
import fs from "node:fs";
import type { DB } from "@/lib/db";
import type { ObjectType } from "@/lib/ontology/types";
import { type RecallMode, type RecallOpts, recall } from "./recall";

export type GoldenCase = { q: string; expect: { type: ObjectType; title: string }[]; kind: "lexical" | "relation" | "ref" | "semantic" | "memory" };

export type CaseResult = GoldenCase & { rank: number | null; ms: number; top: string[] };

export type EvalSummary = {
  mode: RecallMode;
  n: number;
  recallAt1: number;
  recallAt5: number;
  mrr: number;
  p50: number;
  p95: number;
  byKind: Record<string, { n: number; recallAt5: number }>;
  cases: CaseResult[];
  /** 의미 검색이 실패해 어휘 + 관계로 강등된 질의 수 */
  degraded: number;
};

export function loadGolden(file: string): GoldenCase[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as GoldenCase);
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
};

export async function evaluate(db: DB, cases: GoldenCase[], mode: RecallMode, k = 10, o: RecallOpts = {}): Promise<EvalSummary> {
  const results: CaseResult[] = [];
  let degraded = 0;
  // 지연을 재므로 한 건씩 차례로
  for (const c of cases) {
    const t = performance.now();
    const r = await recall(db, { query: c.q, k, mode }, o);
    const ms = performance.now() - t;
    if (r.degraded) degraded++;
    const idx = r.hits.findIndex((h) => c.expect.some((e) => e.type === h.ref.type && h.title.includes(e.title)));
    results.push({ ...c, rank: idx >= 0 ? idx + 1 : null, ms, top: r.hits.slice(0, 3).map((h) => `${h.displayId} ${h.title}${h.similarity !== undefined ? ` (${h.similarity.toFixed(2)})` : ""}`) });
  }
  const at = (n: number, rs = results) => (rs.length ? rs.filter((r) => r.rank !== null && r.rank <= n).length / rs.length : 0);
  const kinds = [...new Set(results.map((r) => r.kind))];
  return {
    mode,
    n: results.length,
    recallAt1: at(1),
    recallAt5: at(5),
    mrr: results.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / (results.length || 1),
    p50: pct(results.map((r) => r.ms), 0.5),
    p95: pct(results.map((r) => r.ms), 0.95),
    byKind: Object.fromEntries(kinds.map((kd) => {
      const rs = results.filter((r) => r.kind === kd);
      return [kd, { n: rs.length, recallAt5: at(5, rs) }];
    })),
    cases: results,
    degraded,
  };
}
