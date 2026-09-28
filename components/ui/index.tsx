import Link from "next/link";
import type { ReactNode } from "react";
import { Icon, type IconName } from "@/components/icons";
import type { Tone } from "@/lib/labels";
import { displayId } from "@/lib/ontology/ids";
import type { ObjectType } from "@/lib/ontology/types";

export const OBJECT_ICON: Record<ObjectType, IconName> = {
  business: "business",
  client: "client",
  task: "task",
  invoice: "invoice",
  expense: "expense",
  note: "note",
  agent: "agent",
};

/** 페이지 머리 — 제목 줄 + 식별자 + 우측 액션. 하단 1px 경계. */
export function PageHeader({
  icon,
  eyebrow,
  title,
  meta,
  actions,
  error,
  live,
}: {
  icon?: IconName;
  eyebrow?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  error?: string;
  live?: boolean;
}) {
  return (
    <header className="border-b border-line bg-panel">
      <div className="flex min-h-14 flex-wrap items-center justify-between gap-3 px-5 py-2.5">
        <div className="flex min-w-0 items-center gap-3">
          {icon && (
            <span className="flex size-8 shrink-0 items-center justify-center border border-line bg-raised text-fg-2">
              <Icon name={icon} size={16} />
            </span>
          )}
          <div className="min-w-0">
            {eyebrow && <div className="label-caps mb-0.5 flex items-center gap-2">{eyebrow}</div>}
            <h1 className="truncate text-[16px] font-semibold tracking-tight">{title}</h1>
            {meta && <div className="mt-0.5 line-clamp-2 text-[12px] text-fg-3">{meta}</div>}
          </div>
        </div>
        <div className="no-print flex flex-wrap items-center gap-1.5">
          {live && <LiveIndicator />}
          {actions}
        </div>
      </div>
      {error && (
        <div role="alert" className="flex items-center gap-2 border-t border-danger/50 bg-danger/15 px-5 py-2 text-[12.5px] text-danger-fg">
          <Icon name="warning" /> {error}
        </div>
      )}
    </header>
  );
}

export function LiveIndicator() {
  return (
    <span className="mr-2 inline-flex items-center gap-1.5 text-[11px] text-success-fg">
      <span className="size-1.5 animate-pulse bg-success-fg" /> LIVE
    </span>
  );
}

/** 패널 — Foundry 식 카드. 헤더는 대문자 라벨. */
export function Panel({
  title,
  count,
  action,
  children,
  className = "",
  flush = false,
}: {
  title?: ReactNode;
  count?: number | string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <section className={`flex min-w-0 flex-col border border-line bg-panel ${className}`}>
      {(title || action) && (
        <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-line px-3">
          <h2 className="label-caps flex items-center gap-2">
            {title}
            {count !== undefined && <span className="mono bg-raised px-1.5 text-[10.5px] text-fg-2">{count}</span>}
          </h2>
          {action && <div className="no-print flex items-center gap-1">{action}</div>}
        </div>
      )}
      <div className={flush ? "min-h-0 flex-1" : "min-h-0 flex-1 p-3"}>{children}</div>
    </section>
  );
}

const TAG: Record<Tone | "ai" | "none", string> = {
  green: "border-success/60 bg-success/15 text-success-fg",
  amber: "border-warning/60 bg-warning/15 text-warning-fg",
  red: "border-danger/60 bg-danger/15 text-danger-fg",
  blue: "border-primary/60 bg-primary/15 text-primary-fg",
  slate: "border-line-strong/70 bg-raised text-fg-2",
  zinc: "border-line bg-transparent text-fg-4",
  ai: "border-ai/60 bg-ai/15 text-ai-fg",
  none: "border-line bg-transparent text-fg-3",
};

export function Tag({ tone = "slate", children, title }: { tone?: Tone | "ai" | "none"; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex h-5 items-center gap-1 border px-1.5 text-[11px] leading-none font-medium whitespace-nowrap ${TAG[tone]}`}>
      {children}
    </span>
  );
}

export const SEVERITY = {
  critical: { label: "심각", tone: "red" as Tone, bar: "bg-danger" },
  warning: { label: "주의", tone: "amber" as Tone, bar: "bg-warning" },
  info: { label: "정보", tone: "blue" as Tone, bar: "bg-primary" },
};

export const RUN_STATUS: Record<string, { label: string; tone: Tone }> = {
  applied: { label: "적용", tone: "green" },
  pending: { label: "승인 대기", tone: "amber" },
  rejected: { label: "거절", tone: "zinc" },
  failed: { label: "실패", tone: "red" },
  denied: { label: "거부", tone: "red" },
  cancelled: { label: "철회", tone: "zinc" },
};

/** 행위자 표시 — AI 와 사람을 한눈에 구분 */
export function Actor({ type, name }: { type: string; name: string }) {
  if (type === "agent")
    return (
      <span className="inline-flex items-center gap-1 text-ai-fg">
        <Icon name="agent" size={12} /> {name}
      </span>
    );
  if (type === "system") return <span className="text-fg-3">⚙ {name}</span>;
  return (
    <span className="inline-flex items-center gap-1 text-fg-2">
      <Icon name="client" size={12} /> {name}
    </span>
  );
}

/** 객체 참조 링크: [아이콘] CLT-0003 제목 */
export function ObjectLink({ type, id, title, compact }: { type: ObjectType; id: number; title?: string; compact?: boolean }) {
  return (
    <Link href={`/o/${type}/${id}`} className="group inline-flex max-w-full min-w-0 items-center gap-1.5 align-middle">
      <Icon name={OBJECT_ICON[type]} size={12} className="shrink-0 text-fg-3" />
      <span className="mono shrink-0 text-primary-fg group-hover:underline">{displayId(type, id)}</span>
      {title && !compact && <span className="truncate text-fg group-hover:underline">{title}</span>}
    </Link>
  );
}

/** 속성 목록 (Foundry Object View 의 Properties) */
export function PropertyList({ items }: { items: { label: string; value: ReactNode; mono?: boolean }[] }) {
  return (
    <dl className="grid grid-cols-[minmax(90px,35%)_1fr] text-[12.5px]">
      {items.map((it, i) => (
        <div key={i} className="contents">
          <dt className="border-b border-line-soft py-1.5 pr-2 text-fg-3">{it.label}</dt>
          <dd className={`min-w-0 border-b border-line-soft py-1.5 break-words ${it.mono ? "mono" : ""}`}>{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 지표 셀 — 상태 스트립용 */
export function Metric({
  label,
  value,
  sub,
  tone,
  href,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "danger" | "warning" | "success" | "ai";
  href?: string;
}) {
  const color = { danger: "text-danger-fg", warning: "text-warning-fg", success: "text-success-fg", ai: "text-ai-fg" }[tone ?? "success"];
  const body = (
    <>
      <div className="label-caps">{label}</div>
      <div className={`mono mt-1 text-[18px] leading-tight font-semibold ${tone ? color : "text-fg"}`}>{value}</div>
      {sub && <div className="mt-0.5 truncate text-[11px] text-fg-3">{sub}</div>}
    </>
  );
  const cls = "block min-w-0 border-r border-line px-4 py-2.5 last:border-r-0";
  return href ? <Link href={href} className={`${cls} hover:bg-raised`}>{body}</Link> : <div className={cls}>{body}</div>;
}

export function Empty({ children, icon = "check" }: { children: ReactNode; icon?: IconName }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-8 text-center text-[12.5px] text-fg-3">
      <Icon name={icon} size={20} className="text-fg-4" />
      {children}
    </div>
  );
}

export function Callout({ tone = "blue", title, children }: { tone?: "blue" | "amber" | "red" | "green" | "ai"; title?: ReactNode; children: ReactNode }) {
  const c = {
    blue: "border-primary bg-primary/10",
    amber: "border-warning bg-warning/10",
    red: "border-danger bg-danger/10",
    green: "border-success bg-success/10",
    ai: "border-ai bg-ai/10",
  }[tone];
  return (
    <div className={`border-l-2 px-3 py-2 text-[12.5px] ${c}`}>
      {title && <div className="mb-0.5 font-semibold">{title}</div>}
      <div className="text-fg-2">{children}</div>
    </div>
  );
}

export function Tabs({ items, current }: { items: { key: string; label: ReactNode; href: string }[]; current: string }) {
  return (
    <nav className="no-print flex overflow-x-auto border-b border-line bg-panel px-3">
      {items.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={`-mb-px flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-3 text-[12.5px] whitespace-nowrap ${
            t.key === current ? "border-primary-hi text-fg" : "border-transparent text-fg-3 hover:text-fg"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

export function Field({ label, hint, children, className = "" }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="label-caps mb-1 block">{label}</span>
      {children}
      {hint && <span className="mt-0.5 block text-[11px] text-fg-4">{hint}</span>}
    </label>
  );
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
