"use client";

import { Children, type ReactNode, useCallback, useEffect, useRef, useState } from "react";

/**
 * 열 기반 레이아웃 — 가로로 나열된 패널, 경계를 끌어 너비 조정 (더블클릭 = 기본값).
 * grow 번째 열이 남은 공간을 채우고(기본: 마지막), 나머지 열은 고정 너비다.
 * 너비는 storageKey 로 브라우저에 기억된다.
 */
export function Columns({
  storageKey,
  defaults,
  grow,
  min = 220,
  children,
  className = "",
}: {
  storageKey: string;
  /** 각 열의 기본 너비(px). grow 열의 값은 무시된다 */
  defaults: number[];
  grow?: number;
  min?: number;
  children: ReactNode;
  className?: string;
}) {
  const panes = Children.toArray(children).filter(Boolean);
  const g = grow ?? panes.length - 1;
  const width = (arr: (number | null)[], i: number) => arr[i] ?? defaults[i] ?? 360;
  const [widths, setWidths] = useState<(number | null)[]>(() => panes.map((_, i) => (i === g ? null : (defaults[i] ?? 360))));
  const drag = useRef<{ pane: number; sign: 1 | -1; x: number; w: number } | null>(null);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(`cols:${storageKey}`) ?? "null");
      if (saved && typeof saved === "object") setWidths(panes.map((_, i) => (i === g ? null : typeof saved[i] === "number" ? saved[i] : (defaults[i] ?? 360))));
    } catch {
      /* 저장소 없음 */
    }
    // 열 구성이 바뀔 때만 다시 읽는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, panes.length, g]);

  const save = useCallback(
    (w: (number | null)[]) => {
      try {
        const prev = JSON.parse(localStorage.getItem(`cols:${storageKey}`) ?? "{}");
        const merged = prev && typeof prev === "object" && !Array.isArray(prev) ? prev : {};
        w.forEach((v, i) => {
          if (v !== null) merged[i] = v;
        });
        localStorage.setItem(`cols:${storageKey}`, JSON.stringify(merged));
      } catch {
        /* 무시 */
      }
    },
    [storageKey],
  );

  /** 경계 i (열 i 와 i+1 사이): grow 왼쪽이면 열 i 를, 오른쪽이면 열 i+1 을 조정 */
  const onDown = (i: number) => (e: React.PointerEvent) => {
    const pane = i < g ? i : i + 1;
    drag.current = { pane, sign: i < g ? 1 : -1, x: e.clientX, w: width(widths, pane) };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const next = [...widths];
    next[d.pane] = Math.round(Math.max(min, Math.min(window.innerWidth * 0.7, d.w + d.sign * (e.clientX - d.x))));
    setWidths(next);
  };
  const onUp = () => {
    if (!drag.current) return;
    drag.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    save(widths);
  };

  return (
    <div className={`flex min-h-0 flex-1 flex-col md:flex-row ${className}`} onPointerMove={onMove} onPointerUp={onUp}>
      {panes.map((pane, i) => (
        <div key={i} className="contents">
          <section
            data-col={i}
            className={`flex min-h-0 min-w-0 flex-col overflow-hidden bg-panel max-md:w-full max-md:border-b max-md:border-line ${i === g ? "md:flex-1" : "md:w-[var(--col-w)] md:shrink-0"}`}
            style={i === g ? undefined : ({ "--col-w": `${width(widths, i)}px` } as React.CSSProperties)}
          >
            {pane}
          </section>
          {i < panes.length - 1 && (
            <div
              role="separator"
              aria-orientation="vertical"
              title="끌어서 너비 조정 · 더블클릭 초기화"
              onPointerDown={onDown(i)}
              onDoubleClick={() => {
                const pane2 = i < g ? i : i + 1;
                const next = [...widths];
                next[pane2] = defaults[pane2] ?? 360;
                setWidths(next);
                save(next);
              }}
              className="hidden w-[5px] shrink-0 cursor-col-resize bg-void hover:bg-primary/60 md:block"
            />
          )}
        </div>
      ))}
    </div>
  );
}

/** 열 머리 (고정) + 스크롤 본문 */
export function Column({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <>
      <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-line px-3">
        <h2 className="label-caps flex min-w-0 items-center gap-2 truncate">{title}</h2>
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto max-md:max-h-[70vh]">{children}</div>
    </>
  );
}
