// 신호(signals): 지금 주의가 필요한 상태. 에이전트의 작업 큐이자 사람의 관망 화면.
import type { DB } from "@/lib/db";
import { addDays, addMonths, daysBetween, parseYmd, toYmd, today } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { listClients } from "@/lib/repos/clients";
import { listInvoices } from "@/lib/repos/finance";
import { getClient } from "@/lib/repos/clients";
import { LIVE_STATUSES, type MemoryRow, USE_WINDOW_DAYS, effectiveUses, getMemory, listMemories, memoryLinks, reviewCounts } from "@/lib/repos/memories";
import type { Scope } from "@/lib/repos/scope";
import { latestSnapshot } from "@/lib/repos/snapshots";
import { listTasks } from "@/lib/repos/tasks";
import { listBackups } from "@/lib/system";
import { displayId } from "./ids";
import { trustSuggestions } from "./trust";
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

  // 기억: 충돌은 기억마다 (해결 제안 포함), 검토 대기는 사업마다 하나
  // 한도 없이 전부 — 목록 한도(500)로 잘리면 빠진 충돌의 신호가 거짓으로 resolved 된다
  for (const m of listMemories(db, scope, { status: ["disputed"], limit: -1 })) {
    const other = memoryLinks(db, m.id).contradicts.map((x) => getMemory(db, x)).find((o) => o && LIVE_STATUSES.includes(o.status));
    out.push({
      key: `memory.disputed:${m.id}`,
      kind: "memory.disputed",
      severity: "warning",
      title: `기억 충돌 · ${m.statement}`,
      detail: other ? `상대: ${displayId("memory", other.id)} ${other.statement}` : "충돌 상대가 정리됨 — 확인 또는 정정",
      ref: { type: "memory", id: m.id },
      displayId: displayId("memory", m.id),
      businessId: m.business_id,
      since: m.updated_at.slice(0, 10),
      suggested: [
        ...(other
          ? [
              { action: "memory.resolve", label: "이 기억 유지", params: { id: m.id, other_id: other.id, keep: "this" } },
              { action: "memory.resolve", label: "상대 기억 유지", params: { id: m.id, other_id: other.id, keep: "other" } },
            ]
          : []),
        { action: "memory.confirm", label: "확인", params: { id: m.id } },
      ],
    });
  }
  // 승격 후보: 확인된 기억 중 최근 90일 실제 사용(인용 + 성공 세션의 컨텍스트) ≥ 5 이거나 고정 (M4 §5.1 d)
  const verified = listMemories(db, scope, { status: ["verified"], limit: -1 });
  const uses = effectiveUses(db, useSince(on), verified.map((m) => m.id));
  for (const m of verified) {
    const sig = promotionSignal(db, m, on, uses.get(m.id) ?? 0);
    if (sig) out.push(sig);
  }
  for (const { business_id: bid, business_name: name, n, since } of reviewCounts(db, scope)) {
    const r = { n, name, since };
    out.push({
      key: `memory.review:${bid ?? "global"}`,
      kind: "memory.review",
      severity: "info",
      title: `AI 가 제안한 기억 ${r.n}건 검토 대기`,
      detail: `${r.name ?? "전역"} · /memory 에서 확인·거절`,
      businessId: bid,
      since: r.since,
      suggested: [],
    });
  }

  // 시스템 신호는 전체 범위에서만
  if (scope === null) {
    // 신뢰 사다리: 넓힐 후보 (자율 권한 · 기억 등급) — 결정은 사람이
    out.push(...trustSuggestions(db));
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

// ── 기억 승격 후보 ───────────────────────────────────────

/** 승격 후보가 되는 최소 사용 수 (최근 90일 · 인용 + 성공 세션 컨텍스트) */
export const PROMOTE_MIN_USES = 5;

/** 사용 집계 시작 시각 (기준일 on 의 90일 전, ISO) */
export const useSince = (on: string) => parseYmd(addDays(on, -USE_WINDOW_DAYS)).toISOString();

const WEEKDAYS = "일월화수목금토";
type Recurrence = { recurrence: "weekly" | "monthly" | "quarterly" | "yearly"; due: string; phrase: string };

/**
 * 문장 속 주기 표현 → 반복 업무 (다음 날짜는 기준일 포함 이후 첫 회차).
 * "매월 5일" · "매주 금요일" · "매 분기 / 분기마다 / 분기별" (→ 다음 분기 첫날) · "매년 3월 31일"
 */
export function recurrenceOf(statement: string, on: string): Recurrence | undefined {
  const t = statement.normalize("NFKC");
  const monthly = t.match(/매\s*월\s*(\d{1,2})\s*일/);
  if (monthly) {
    const day = Number(monthly[1]);
    if (day < 1 || day > 31) return undefined;
    const at = (ym: string) => {
      const last = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
      return `${ym}-${String(Math.min(day, last)).padStart(2, "0")}`;
    };
    const cur = at(on.slice(0, 7));
    return { recurrence: "monthly", due: cur >= on ? cur : at(addMonths(`${on.slice(0, 7)}-01`, 1).slice(0, 7)), phrase: monthly[0] };
  }
  const weekly = t.match(/매\s*주\s*([일월화수목금토])\s*요일/);
  if (weekly) {
    const want = WEEKDAYS.indexOf(weekly[1]);
    const d = parseYmd(on);
    return { recurrence: "weekly", due: addDays(on, (want - d.getDay() + 7) % 7), phrase: weekly[0] };
  }
  const yearly = t.match(/매\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (yearly) {
    const month = Number(yearly[1]);
    const day = Number(yearly[2]);
    // 없는 날짜(13월 · 4월 31일)는 주기로 보지 않는다. 2월 29일은 평년에 말일(28일)로 보정 (매월 분기와 같은 방식)
    if (month < 1 || month > 12 || day < 1 || day > new Date(2000, month, 0).getDate()) return undefined;
    const at = (y: number) => `${y}-${String(month).padStart(2, "0")}-${String(Math.min(day, new Date(y, month, 0).getDate())).padStart(2, "0")}`;
    const y = Number(on.slice(0, 4));
    const cur = at(y);
    return { recurrence: "yearly", due: cur >= on ? cur : at(y + 1), phrase: yearly[0] };
  }
  const quarterly = t.match(/매\s*분기|분기\s*마다|분기별/);
  if (quarterly) {
    const d = parseYmd(on);
    const next = new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3 + 3, 1);
    return { recurrence: "quarterly", due: toYmd(next), phrase: quarterly[0] };
  }
  return undefined;
}

const short = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * 확인된 기억이 승격 후보면 신호 (info). suggested = 구조화된 객체로 옮기는 액션들:
 *  - 대상에 고객 + 선호·사실·주의 → client.update (고객 메모에 한 줄 추가)
 *  - 절차 힌트·교훈 → note.create (플레이북 초안)
 *  - 문장에 주기(매월 N일 · 매주 X요일 · 분기) → task.create (반복 업무)
 * 적용한 뒤 memory.promote 로 기억을 새 객체에 연결한다 (detail 안내 — 화면은 드로어 링크를 함께 보인다).
 */
export function promotionSignal(db: DB, m: MemoryRow, on: string, uses: number): Signal | undefined {
  if (m.status !== "verified" || !(uses >= PROMOTE_MIN_USES || m.pinned)) return undefined;
  const l = memoryLinks(db, m.id);
  const clientRef = l.about.find((r) => r.type === "client");
  const client = clientRef ? getClient(db, clientRef.id) : undefined;
  const businessId = m.business_id ?? client?.business_id ?? null;
  const suggested: Signal["suggested"] = [];
  if (client && ["preference", "fact", "caution"].includes(m.kind)) {
    const memo = client.memo.trim();
    suggested.push({ action: "client.update", label: "고객 메모에 반영", params: { id: client.id, memo: `${memo ? `${memo}\n` : ""}- ${m.statement}` } });
  }
  if (m.kind === "procedure_hint" || m.kind === "lesson") {
    const evidence = l.evidence.map((r) => `- ${displayId(r.type, r.id)}`);
    suggested.push({
      action: "note.create",
      label: "플레이북 초안 만들기",
      params: {
        kind: "playbook",
        title: `플레이북 초안 · ${short(m.statement)}`,
        body: [`${m.statement}`, "", `## 근거 (${displayId("memory", m.id)})`, ...(evidence.length ? evidence : ["- (근거 없음)"])].join("\n"),
        ...(businessId ? { business_id: businessId } : {}),
      },
    });
  }
  const rec = recurrenceOf(m.statement, on);
  if (rec && businessId) {
    suggested.push({
      action: "task.create",
      label: "반복 업무로 만들기",
      params: { business_id: businessId, title: short(m.statement, 60), recurrence: rec.recurrence, due_date: rec.due, ...(client ? { client_id: client.id } : {}) },
    });
  }
  return {
    key: `memory.promotable:${m.id}`,
    kind: "memory.promotable",
    severity: "info",
    title: `구조화할 만한 기억 · ${m.statement}`,
    detail: `${m.pinned ? "고정 기억" : `최근 ${USE_WINDOW_DAYS}일 사용 ${uses}회`} — 제안 액션으로 옮긴 뒤 memory.promote 로 이 기억을 새 객체에 연결하세요${suggested.length ? "" : " (자동 제안 없음 — 직접 구조화)"}`,
    ref: { type: "memory", id: m.id },
    displayId: displayId("memory", m.id),
    businessId: m.business_id,
    since: (m.verified_at ?? m.updated_at).slice(0, 10),
    suggested,
  };
}
