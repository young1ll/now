"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/** 관망 화면 자동 새로고침. 탭이 보이지 않으면 멈춘다. */
export function AutoRefresh({ seconds = 10 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds]);
  return null;
}

export function CopyButton({ text, label = "복사" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-sm"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? "복사됨" : label}
    </button>
  );
}

/** select 변경 즉시 제출 */
export function AutoSubmitSelect(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} onChange={(e) => e.currentTarget.form?.requestSubmit()} />;
}

/** 전역 단축키: / 검색, g+o 오퍼레이션, g+i 승인함, g+a 활동 */
export function Hotkeys() {
  const router = useRouter();
  useEffect(() => {
    let g = false;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (e.key === "/") {
        e.preventDefault();
        (document.getElementById("global-search") as HTMLInputElement | null)?.focus();
        return;
      }
      if (e.key === "g") {
        g = true;
        setTimeout(() => (g = false), 800);
        return;
      }
      if (g) {
        const to = { o: "/", i: "/inbox", a: "/activity", s: "/schedule", c: "/o/client", t: "/o/task" }[e.key];
        if (to) router.push(to);
        g = false;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);
  return null;
}
