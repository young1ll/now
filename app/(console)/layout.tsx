import type { ReactNode } from "react";
import { Shell } from "@/components/Shell";
import { currentScope } from "@/lib/context";
import { daysBetween, today } from "@/lib/dates";
import { db } from "@/lib/db";
import { migrations } from "@/lib/db/migrations";
import { computeSignals } from "@/lib/ontology/signals";
import { OPERATOR } from "@/lib/ontology/types";
import { listAgents } from "@/lib/repos/agents";
import { listBusinesses } from "@/lib/repos/businesses";
import { memoryStats } from "@/lib/repos/memories";
import { pendingCount } from "@/lib/repos/runs";
import { getAiMode } from "@/lib/repos/settings";
import { latestSnapshot } from "@/lib/repos/snapshots";
import { APP_VERSION, listBackups } from "@/lib/system";

export const dynamic = "force-dynamic";

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const d = db();
  const scope = await currentScope();
  const signals = computeSignals(d, scope);
  const backup = listBackups()[0];
  const snap = latestSnapshot(d);
  return (
    <Shell
      data={{
        businesses: listBusinesses(d),
        scope,
        aiMode: getAiMode(d),
        pending: pendingCount(d),
        agentsActive: listAgents(d, new Date().toISOString()).filter((a) => a.status === "active").length,
        signals: {
          critical: signals.filter((s) => s.severity === "critical").length,
          warning: signals.filter((s) => s.severity === "warning").length,
        },
        memoryReview: memoryStats(d, scope).review,
        operator: OPERATOR.name,
        status: {
          version: APP_VERSION,
          schema: d.pragma("user_version", { simple: true }) as number,
          schemaLatest: migrations.length,
          backupAge: backup ? `${daysBetween(backup.at.slice(0, 10), today())}일 전` : "없음",
          iac: snap ? { in_sync: "일치", drift: "드리프트", error: "오류" }[snap.status] : "미감사",
        },
      }}
    >
      {children}
    </Shell>
  );
}
