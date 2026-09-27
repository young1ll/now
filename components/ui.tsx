import type { ReactNode } from "react";
import type { Tone } from "@/lib/labels";

export function PageHeader({
  title,
  description,
  actions,
  error,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  error?: string;
}) {
  return (
    <header className="mb-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="muted mt-1 text-sm">{description}</p>}
        </div>
        {actions && <div className="no-print flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {error && (
        <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}
    </header>
  );
}

export function Card({
  title,
  action,
  children,
  className = "",
  flush = false,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <section className={`rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/60 ${className}`}>
      {(title || action) && (
        <div className="flex items-center justify-between gap-2 border-b border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
          <h2 className="text-sm font-semibold">{title}</h2>
          {action && <div className="no-print text-sm">{action}</div>}
        </div>
      )}
      <div className={flush ? "" : "p-4"}>{children}</div>
    </section>
  );
}

const TONES: Record<Tone, string> = {
  green: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950 dark:text-emerald-300",
  amber: "bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-950 dark:text-amber-300",
  blue: "bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-950 dark:text-sky-300",
  red: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-950 dark:text-red-300",
  slate: "bg-slate-100 text-slate-700 ring-slate-500/20 dark:bg-slate-800 dark:text-slate-300",
  zinc: "bg-zinc-100 text-zinc-500 ring-zinc-500/20 dark:bg-zinc-800 dark:text-zinc-400",
};

export function Badge({ tone = "slate", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone]}`}>
      {children}
    </span>
  );
}

export function BizTag({ name, color }: { name: string | null; color?: string | null }) {
  if (!name) return <span className="muted text-xs">공용</span>;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-zinc-600 dark:text-zinc-400">
      <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color ?? "#a1a1aa" }} />
      {name}
    </span>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
  href,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "red" | "amber";
  href?: string;
}) {
  const color = tone === "red" ? "text-red-600 dark:text-red-400" : tone === "amber" ? "text-amber-600 dark:text-amber-400" : "";
  const body = (
    <>
      <div className="muted text-xs">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
      {hint && <div className="muted mt-1 text-xs">{hint}</div>}
    </>
  );
  const cls = "block rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900/60";
  return href ? (
    <a href={href} className={`${cls} hover:border-indigo-300 dark:hover:border-indigo-700`}>{body}</a>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="muted py-6 text-center text-sm">{children}</p>;
}

export function Field({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">{label}</span>
      {children}
    </label>
  );
}

export function Tabs({ items, current }: { items: { href: string; label: string; key: string }[]; current: string }) {
  return (
    <nav className="no-print mb-4 flex gap-1 border-b border-zinc-200 dark:border-zinc-800">
      {items.map((t) => (
        <a
          key={t.key}
          href={t.href}
          className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${
            t.key === current
              ? "border-indigo-600 font-medium text-indigo-700 dark:text-indigo-300"
              : "border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
          }`}
        >
          {t.label}
        </a>
      ))}
    </nav>
  );
}
