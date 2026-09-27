import type { DB } from "@/lib/db";
import { addDays, addMonths, monthOf, today } from "@/lib/dates";
import { recentInteractions } from "./clients";
import { monthlyPnl, receivables } from "./finance";
import { listConnections } from "./infra";
import { type Scope, scopeWhere } from "./scope";
import { dueTasks, taskCounts } from "./tasks";

/** 기준일로부터 과거 n개월 'YYYY-MM' 목록 (오래된 순). */
export function lastMonths(n: number, on = today()): string[] {
  return Array.from({ length: n }, (_, i) => monthOf(addMonths(on, i - (n - 1))));
}

function sumByCurrency<T>(rows: T[], currency: (r: T) => string, amount: (r: T) => number) {
  const m = new Map<string, number>();
  for (const r of rows) m.set(currency(r), (m.get(currency(r)) ?? 0) + amount(r));
  return [...m].map(([currency, amount]) => ({ currency, amount }));
}

export function dashboard(db: DB, scope: Scope, on = today()) {
  const month = monthOf(on);
  const [where, params] = scopeWhere(scope);
  const clients = db
    .prepare(
      `SELECT COUNT(*) FILTER (WHERE status = 'active') AS active,
              COUNT(*) FILTER (WHERE status = 'lead') AS leads
       FROM clients WHERE ${where}`,
    )
    .get(...params) as { active: number; leads: number };

  const ar = receivables(db, scope, on);
  const connections = listConnections(db, scope, month);
  const pnl = monthlyPnl(db, scope, lastMonths(6, on));

  return {
    month,
    tasks: taskCounts(db, scope, on),
    upcoming: dueTasks(db, scope, addDays(on, 7)),
    clients,
    receivables: {
      items: ar,
      totals: sumByCurrency(ar, (r) => r.currency, (r) => r.balance),
      overdue: ar.filter((r) => r.overdue).length,
    },
    pnl,
    thisMonth: pnl.filter((p) => p.month === month),
    infra: {
      connections,
      counts: {
        ok: connections.filter((c) => c.last_status === "ok").length,
        issues: connections.filter((c) => c.last_status === "degraded" || c.last_status === "down").length,
        unchecked: connections.filter((c) => !c.last_status || c.last_status === "unknown").length,
      },
      overBudget: connections.filter(
        (c) => c.monthly_budget != null && c.month_cost != null && c.month_cost > c.monthly_budget,
      ),
      cost: sumByCurrency(
        connections.filter((c) => c.month_cost != null),
        (c) => c.currency,
        (c) => c.month_cost ?? 0,
      ),
    },
    recent: recentInteractions(db, scope, 5),
  };
}
