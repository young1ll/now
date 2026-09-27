"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/", label: "대시보드", icon: "◎" },
  { href: "/clients", label: "고객 · 거래처", icon: "◉" },
  { href: "/tasks", label: "업무 · 마감", icon: "☑" },
  { href: "/finance", label: "매출 · 정산", icon: "₩" },
  { href: "/knowledge", label: "지식 · 문서", icon: "❏" },
  { href: "/infra", label: "인프라", icon: "☁" },
  { href: "/settings", label: "설정", icon: "⚙" },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav className="-mx-1 flex gap-0.5 overflow-x-auto md:mx-0 md:flex-col">
      {ITEMS.map((it) => {
        const active = it.href === "/" ? path === "/" : path.startsWith(it.href);
        return (
          <Link
            key={it.href}
            href={it.href}
            className={`flex shrink-0 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap ${
              active
                ? "bg-zinc-200/70 font-medium text-zinc-900 dark:bg-zinc-800 dark:text-white"
                : "text-zinc-600 hover:bg-zinc-200/40 dark:text-zinc-400 dark:hover:bg-zinc-800/60"
            }`}
          >
            <span className="w-4 text-center text-xs opacity-70">{it.icon}</span>
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}
