// 신호(signals): 지금 주의가 필요한 상태. 에이전트의 작업 큐이자 사람의 관망 화면.
import type { DB } from "@/lib/db";
import { addDays, daysBetween, today } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { listClients } from "@/lib/repos/clients";
import { listInvoices } from "@/lib/repos/finance";
import type { Scope } from "@/lib/repos/scope";
import { latestSnapshot } from "@/lib/repos/snapshots";
import { listTasks } from "@/lib/repos/tasks";
import { listBackups } from "@/lib/system";
import { displayId } from "./ids";
import type { Ref } from "./types";

export type Severity = "critical" | "warning" | "info";

export type Signal = {
  /** 안정적인 식별자 (같은 상태면 같은 key) */
  key: string;
  kind: string;
  severity: Severity;
  title: string;
  detail: string;
  ref?: Ref;
  displayId?: string;
  businessId: number | null;
  /** 이 상태가 시작된 날짜 */
  since?: string;
  /** 해결에 쓸 만한 액션과 미리 채울 파라미터 */
  suggested: { action: string; label: string; params: Record<string, unknown> }[];
};

const RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

export function computeSignals(db: DB, scope: Scope, on = today()): Signal[] {
  const out: Signal[] = [];

  for (const t of listTasks(db, scope, { view: "open" })) {
    if (!t.due_date) continue;
    const d = daysBetween(on, t.due_date);
    const ref = { type: "task" as const, id: t.id };
    if (d < 0) {
      out.push({
        key: `task.overdue:${t.id}`,
        kind: "task.overdue",
        severity: d < -3 || t.priority === 1 ? "critical" : "warning",
        title: `마감 ${-d}일 지남 · ${t.title}`,
        detail: [t.business_name, t.client_name].filter(Boolean).join(" · "),
        ref,
        displayId: displayId("task", t.id),
        businessId: t.business_id,
        since: t.due_date,
        suggested: [
          { action: "task.set_status", label: "완료 처리", params: { id: t.id, status: "done" } },
          { action: "task.update", label: "마감 재조정", params: { id: t.id, due_date: addDays(on, 3) } },
        ],
      });
    } else if (d <= 2 && t.priority === 1) {
      out.push({
        key: `task.due_soon:${t.id}`,
        kind: "task.due_soon",
        severity: "warning",
        title: `${d === 0 ? "오늘" : `D-${d}`} 마감 (높음) · ${t.title}`,
        detail: [t.business_name, t.client_name].filter(Boolean).join(" · "),
        ref,
        displayId: displayId("task", t.id),
        businessId: t.business_id,
        since: on,
        suggested: [{ action: "task.set_status", label: "진행 시작", params: { id: t.id, status: "doing" } }],
      });
    }
  }

  for (const i of listInvoices(db, scope)) {
    const ref = { type: "invoice" as const, id: i.id };
    if (i.status === "sent" && i.balance > 0 && i.due_date && i.due_date < on) {
      const d = daysBetween(i.due_date, on);
      out.push({
        key: `invoice.overdue:${i.id}`,
        kind: "invoice.overdue",
        severity: d > 14 ? "critical" : "warning",
        title: `미수 ${d}일 · ${i.number} ${formatMoney(i.balance, i.currency)}`,
        detail: [i.client_name, i.business_name].filter(Boolean).join(" · "),
        ref,
        displayId: displayId("invoice", i.id),
        businessId: i.business_id,
        since: i.due_date,
        suggested: [
          ...(i.client_id ? [{ action: "client.log_interaction", label: "독촉 연락 기록", params: { client_id: i.client_id, kind: "email", summary: `${i.number} 입금 요청` } }] : []),
          { action: "payment.record", label: "입금 기록", params: { invoice_id: i.id } },
        ],
      });
    }
    if (i.status === "draft" && daysBetween(i.issue_date, on) >= 7) {
      out.push({
        key: `invoice.draft_stale:${i.id}`,
        kind: "invoice.draft_stale",
        severity: "info",
        title: `작성 중 ${daysBetween(i.issue_date, on)}일 · ${i.number} ${formatMoney(i.total, i.currency)}`,
        detail: [i.client_name, i.business_name].filter(Boolean).join(" · "),
        ref,
        displayId: displayId("invoice", i.id),
        businessId: i.business_id,
        since: i.issue_date,
        suggested: [{ action: "invoice.issue", label: "발행", params: { id: i.id } }],
      });
    }
  }

  for (const c of listClients(db, scope)) {
    const last = c.last_contact ?? c.created_at.slice(0, 10);
    const gap = daysBetween(last, on);
    const ref = { type: "client" as const, id: c.id };
    const follow = { action: "client.log_interaction", label: "접촉 기록", params: { client_id: c.id, kind: "call" } };
    if (c.status === "lead" && gap >= 7) {
      out.push({
        key: `client.lead_idle:${c.id}`,
        kind: "client.lead_idle",
        severity: "warning",
        title: `잠재 고객 ${gap}일 무응대 · ${c.name}`,
        detail: c.business_name,
        ref,
        displayId: displayId("client", c.id),
        businessId: c.business_id,
        since: last,
        suggested: [follow, { action: "task.create", label: "후속 업무 생성", params: { business_id: c.business_id, client_id: c.id, title: `${c.name} 후속 연락`, due_date: addDays(on, 2), priority: "1" } }],
      });
    }
    if (c.status === "active" && gap >= 30) {
      out.push({
        key: `client.stale:${c.id}`,
        kind: "client.stale",
        severity: "info",
        title: `진행 고객 ${gap}일 접촉 없음 · ${c.name}`,
        detail: c.business_name,
        ref,
        displayId: displayId("client", c.id),
        businessId: c.business_id,
        since: last,
        suggested: [follow],
      });
    }
  }

  // 시스템 신호는 전체 범위에서만
  if (scope === null) {
    const backups = listBackups();
    const lastBackup = backups[0]?.at.slice(0, 10);
    if (!lastBackup || daysBetween(lastBackup, on) > 7) {
      out.push({
        key: "system.backup_stale",
        kind: "system.backup_stale",
        severity: "warning",
        title: lastBackup ? `마지막 백업 ${daysBetween(lastBackup, on)}일 전` : "백업 기록 없음",
        detail: "콘솔 '지금 백업' 또는 npm run db:backup",
        businessId: null,
        since: lastBackup,
        suggested: [{ action: "system.backup", label: "지금 백업", params: {} }],
      });
    }
    const snap = latestSnapshot(db);
    if (!snap) {
      out.push({ key: "iac.never_audited", kind: "iac.never_audited", severity: "info", title: "IaC 감사 기록 없음", detail: "npm run iac:audit", businessId: null, suggested: [] });
    } else if (snap.status !== "in_sync") {
      out.push({
        key: `iac.${snap.status}:${snap.id}`,
        kind: `iac.${snap.status}`,
        severity: snap.status === "drift" ? "critical" : "warning",
        title: snap.status === "drift" ? `인프라 드리프트 · 변경 ${snap.change_count}건` : "IaC 감사 실패",
        detail: snap.message || snap.tool,
        businessId: null,
        since: snap.captured_at.slice(0, 10),
        suggested: [],
      });
    } else if (daysBetween(snap.captured_at.slice(0, 10), on) > 7) {
      out.push({ key: "iac.audit_stale", kind: "iac.audit_stale", severity: "info", title: `IaC 감사 ${daysBetween(snap.captured_at.slice(0, 10), on)}일 경과`, detail: "npm run iac:audit", businessId: null, suggested: [] });
    }
  }

  return out.sort((a, b) => RANK[a.severity] - RANK[b.severity] || (a.since ?? "").localeCompare(b.since ?? ""));
}
