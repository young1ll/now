import Link from "next/link";
import type { ReactNode } from "react";
import { switchScope } from "@/app/actions/console";
import { AutoSubmitSelect, Hotkeys } from "@/components/client";
import { Icon, type IconName } from "@/components/icons";
import { NavLink } from "@/components/NavLink";
import type { AiMode } from "@/lib/repos/settings";

export type ShellData = {
  businesses: { id: number; name: string; color: string }[];
  scope: number | null;
  aiMode: AiMode;
  pending: number;
  agentsActive: number;
  signals: { critical: number; warning: number };
  operator: string;
  status: { schema: number; schemaLatest: number; backupAge: string; iac: string; version: string };
};

const AI_MODE_TAG: Record<AiMode, { label: string; cls: string }> = {
  autonomous: { label: "자율", cls: "border-ai text-ai-fg" },
  guarded: { label: "가드", cls: "border-success text-success-fg" },
  supervised: { label: "감독", cls: "border-warning text-warning-fg" },
  frozen: { label: "동결", cls: "border-danger bg-danger/20 text-danger-fg" },
};

type NavItem = { href: string; label: string; icon: IconName; badge?: number; badgeTone?: "warning" | "danger" };

export function Shell({ data, children }: { data: ShellData; children: ReactNode }) {
  const groups: { label: string; items: NavItem[] }[] = [
    {
      label: "운영",
      items: [
        { href: "/", label: "오퍼레이션", icon: "ops", badge: data.signals.critical || undefined, badgeTone: "danger" },
        { href: "/inbox", label: "승인함", icon: "inbox", badge: data.pending || undefined, badgeTone: "warning" },
        { href: "/activity", label: "활동 로그", icon: "activity" },
        { href: "/schedule", label: "일정 · 마감", icon: "calendar" },
      ],
    },
    {
      label: "온톨로지",
      items: [
        { href: "/o/client", label: "고객 · 거래처", icon: "client" },
        { href: "/o/task", label: "업무", icon: "task" },
        { href: "/o/invoice", label: "청구서", icon: "invoice" },
        { href: "/o/expense", label: "지출", icon: "expense" },
        { href: "/o/note", label: "지식 · 문서", icon: "note" },
        { href: "/o/business", label: "사업", icon: "business" },
        { href: "/graph", label: "그래프", icon: "graph" },
        { href: "/ontology", label: "스키마", icon: "schema" },
      ],
    },
    {
      label: "분석",
      items: [{ href: "/finance", label: "재무 · 정산", icon: "finance" }],
    },
    {
      label: "자동화 · AI",
      items: [
        { href: "/ai", label: "AI 연결", icon: "ai" },
        { href: "/automations", label: "트리거", icon: "trigger" },
        { href: "/events", label: "이벤트", icon: "event" },
        { href: "/agents", label: "에이전트", icon: "agent" },
        { href: "/actions", label: "액션 카탈로그", icon: "action" },
        { href: "/system", label: "시스템 · 인프라", icon: "system" },
      ],
    },
  ];
  const mode = AI_MODE_TAG[data.aiMode];

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Hotkeys />
      {/* 상단 바 */}
      <header className="no-print flex h-10 shrink-0 items-center gap-3 border-b border-void bg-panel px-3">
        <Link href="/" className="flex items-center gap-2 pr-2">
          <span className="flex size-5 items-center justify-center bg-fg text-[11px] font-black text-canvas">N</span>
          <span className="text-[13px] font-bold tracking-[0.18em]">NOW</span>
          <span className="hidden text-[11px] text-fg-4 lg:inline">BUSINESS OS</span>
        </Link>
        <form action="/search" className="relative hidden max-w-md flex-1 md:block">
          <Icon name="search" size={12} className="absolute top-1/2 left-2 -translate-y-1/2 text-fg-4" />
          <input id="global-search" name="q" placeholder="객체 검색 …   /" className="field h-7 min-h-0 pl-7 text-[12px]" />
        </form>
        <div className="ml-auto flex items-center gap-2">
          {data.businesses.length > 0 && (
            <form action={switchScope}>
              <AutoSubmitSelect name="scope" defaultValue={data.scope ?? "all"} className="field h-7 min-h-0 w-auto max-w-32 py-0 text-[12px] sm:max-w-none" aria-label="사업 범위">
                <option value="all">전체 사업</option>
                {data.businesses.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </AutoSubmitSelect>
            </form>
          )}
          <Link href="/agents" title="AI 운영 모드" className={`flex h-7 items-center gap-1.5 border px-2 text-[11px] font-semibold ${mode.cls}`}>
            <Icon name="shield" size={12} /> <span className="hidden sm:inline">AI</span> {mode.label}
            <span className="hidden font-normal text-fg-3 lg:inline">· 에이전트 {data.agentsActive}</span>
          </Link>
          <Link
            href="/inbox"
            className={`flex h-7 items-center gap-1.5 border px-2 text-[11px] font-semibold ${data.pending ? "border-warning bg-warning/15 text-warning-fg" : "border-line text-fg-3"}`}
          >
            <Icon name="inbox" size={12} /> <span className="hidden sm:inline">승인</span> {data.pending}
          </Link>
          <span className="hidden items-center gap-1.5 border-l border-line pl-3 text-[12px] text-fg-2 sm:flex">
            <Icon name="client" size={12} /> {data.operator}
          </span>
        </div>
      </header>

      {/* 모바일 내비 */}
      <nav className="no-print flex shrink-0 overflow-x-auto border-b border-void bg-panel md:hidden">
        {groups.flatMap((g) => g.items).map((it) => (
          <Link key={it.href} href={it.href} className="flex h-9 shrink-0 items-center gap-1.5 border-r border-line-soft px-3 text-[12px] whitespace-nowrap text-fg-2">
            <Icon name={it.icon} size={12} /> {it.label}
            {it.badge ? <span className={`mono px-1 text-[10px] ${it.badgeTone === "danger" ? "bg-danger text-white" : "bg-warning text-void"}`}>{it.badge}</span> : null}
          </Link>
        ))}
      </nav>

      <div className="flex min-h-0 flex-1">
        {/* 좌측 내비 */}
        <nav className="no-print hidden w-52 shrink-0 flex-col overflow-y-auto border-r border-void bg-panel py-2 md:flex">
          {groups.map((g) => (
            <div key={g.label} className="mb-2">
              <div className="label-caps px-4 pt-2 pb-1 text-fg-4">{g.label}</div>
              {g.items.map((it) => (
                <NavLink key={it.href} href={it.href}>
                  <Icon name={it.icon} size={14} className="shrink-0 opacity-80" />
                  <span className="flex-1 truncate">{it.label}</span>
                  {it.badge ? (
                    <span className={`mono px-1 text-[10.5px] font-semibold ${it.badgeTone === "danger" ? "bg-danger text-white" : "bg-warning text-void"}`}>{it.badge}</span>
                  ) : null}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <main className="min-w-0 flex-1 overflow-y-auto bg-canvas">{children}</main>
      </div>

      {/* 하단 상태 바 */}
      <footer className="no-print flex h-6 shrink-0 items-center gap-4 border-t border-void bg-panel px-3 text-[11px] text-fg-3">
        <span className="mono">v{data.status.version}</span>
        <span className={data.status.schema === data.status.schemaLatest ? "" : "text-danger-fg"}>
          schema {data.status.schema}/{data.status.schemaLatest}
        </span>
        <span>백업 {data.status.backupAge}</span>
        <span>IaC {data.status.iac}</span>
        <span className="ml-auto hidden gap-3 sm:flex">
          <span><kbd className="mono text-fg-2">/</kbd> 검색</span>
          <span><kbd className="mono text-fg-2">g o</kbd> 오퍼레이션</span>
          <span><kbd className="mono text-fg-2">g i</kbd> 승인함</span>
          <span><kbd className="mono text-fg-2">g a</kbd> 활동</span>
        </span>
      </footer>
    </div>
  );
}
