import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Nav } from "@/components/Nav";
import { ScopeSwitcher } from "@/components/ScopeSwitcher";
import { currentScope } from "@/lib/context";
import { db } from "@/lib/db";
import { listBusinesses } from "@/lib/repos/businesses";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Now · 사업 운영 체제", template: "%s · Now" },
  description: "고객·업무·매출·지식·인프라를 한곳에서 운영하는 로컬 사업 운영 체제",
};

// 모든 화면이 로컬 DB 를 직접 읽으므로 항상 요청 시점에 렌더링한다.
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: ReactNode }) {
  const businesses = listBusinesses(db());
  const scope = await currentScope();
  return (
    <html lang="ko">
      <body>
        <div className="flex min-h-screen flex-col md:flex-row">
          <aside className="no-print border-b border-zinc-200 bg-zinc-100/60 p-4 md:sticky md:top-0 md:h-screen md:w-56 md:shrink-0 md:border-r md:border-b-0 dark:border-zinc-800 dark:bg-zinc-900/40">
            <a href="/" className="mb-3 block md:mb-5">
              <div className="text-lg font-bold tracking-tight">Now</div>
              <div className="muted text-xs">사업 운영 체제</div>
            </a>
            {businesses.length > 0 && (
              <div className="mb-3 md:mb-5">
                <ScopeSwitcher businesses={businesses} current={scope} />
              </div>
            )}
            <Nav />
          </aside>
          <main className="min-w-0 flex-1 p-4 md:p-8">
            <div className="mx-auto max-w-6xl">{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}
