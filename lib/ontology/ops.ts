// 운영 현황 집계 — 오퍼레이션 화면과 MCP get_overview 가 공유.
import type { DB } from "@/lib/db";
import { addMonths, monthOf, today } from "@/lib/dates";
import { listAgents } from "@/lib/repos/agents";
import { monthlyPnl, receivables } from "@/lib/repos/finance";
import { listRuns, pendingCount, runStats } from "@/lib/repos/runs";
import type { Scope } from "@/lib/repos/scope";
import { getAiMode } from "@/lib/repos/settings";
import { latestSnapshot } from "@/lib/repos/snapshots";
import { dueTasks, taskCounts } from "@/lib/repos/tasks";
import { addDays } from "@/lib/dates";
import { computeSignals } from "./signals";

/** 기준일로부터 과거 n개월 'YYYY-MM' 목록 (오래된 순). */
export function lastMonths(n: number, on = today()): string[] {
  return Array.from({ length: n }, (_, i) => monthOf(addMonths(on, i - (n - 1))));
}

export function sumByCurrency<T>(rows: T[], currency: (r: T) => string, amount: (r: T) => number) {
  const m = new Map<string, number>();
  for (const r of rows) m.set(currency(r), (m.get(currency(r)) ?? 0) + amount(r));
  return [...m].map(([currency, amount]) => ({ currency, amount }));
}

export function opsOverview(db: DB, scope: Scope, on = today()) {
  const since24h = new Date(Date.now() - 86_400_000).toISOString();
  const ar = receivables(db, scope, on);
  const month = monthOf(on);
  const pnl = monthlyPnl(db, scope, [month]);
  const agents = listAgents(db, since24h);
  return {
    on,
    aiMode: getAiMode(db),
    signals: computeSignals(db, scope, on),
    pending: { count: pendingCount(db), runs: listRuns(db, { status: "pending", limit: 20 }) },
    runs24h: runStats(db, since24h),
    recentRuns: listRuns(db, { limit: 30 }),
    agents: {
      active: agents.filter((a) => a.status === "active").length,
      total: agents.filter((a) => a.status !== "revoked").length,
      list: agents,
    },
    tasks: taskCounts(db, scope, on),
    agenda: dueTasks(db, scope, addDays(on, 7)),
    receivables: {
      totals: sumByCurrency(ar, (r) => r.currency, (r) => r.balance),
      count: ar.length,
      overdue: ar.filter((r) => r.overdue).length,
    },
    cash: pnl.filter((p) => p.income || p.expense),
    iac: latestSnapshot(db),
  };
}
