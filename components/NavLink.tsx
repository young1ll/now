"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export function NavLink({ href, children }: { href: string; children: ReactNode }) {
  const path = usePathname();
  const active = href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      className={`flex h-8 items-center gap-2.5 border-l-2 px-4 text-[12.5px] ${
        active ? "border-primary-hi bg-raised text-fg" : "border-transparent text-fg-2 hover:bg-raised/60 hover:text-fg"
      }`}
    >
      {children}
    </Link>
  );
}
