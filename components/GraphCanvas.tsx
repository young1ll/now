"use client";

import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

export type CanvasNode = { key: string; type: string; displayId: string; title: string; status?: string };
export type CanvasEdge = { key: string; from: string; to: string; label: string; source: "intrinsic" | "derived" | "custom" };

import { TYPE_COLOR, TYPE_LABEL } from "@/lib/ontology/palette";

export { TYPE_COLOR, TYPE_LABEL };

type N = SimulationNodeDatum & CanvasNode;
type L = SimulationLinkDatum<N> & CanvasEdge;

/** 힘 기반 온톨로지 그래프. 노드 클릭 → ?sel=type:id (같은 화면의 오른쪽 열에 상세). 휠 확대 · 배경 끌기 이동 · 노드 끌기. */
export function GraphCanvas({ nodes, edges, selected, focus, navigate = false, minHeight = 420 }: { nodes: CanvasNode[]; edges: CanvasEdge[]; selected?: string; focus?: string; navigate?: boolean; minHeight?: number }) {
  const router = useRouter();
  const sp = useSearchParams();
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [, setFrame] = useState(0);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [hover, setHover] = useState<string | null>(null);

  const sim = useMemo(() => {
    const ns: N[] = nodes.map((n) => ({ ...n }));
    const byKey = new Map(ns.map((n) => [n.key, n]));
    const ls: L[] = edges.filter((e) => byKey.has(e.from) && byKey.has(e.to)).map((e) => ({ ...e, source: e.from, target: e.to }) as unknown as L);
    const s = forceSimulation<N>(ns)
      .force("link", forceLink<N, L>(ls).id((d) => d.key).distance((l) => ((l.source as unknown as N).type === "agent" ? 150 : 95)).strength(0.35))
      .force("charge", forceManyBody().strength(-420).distanceMax(600))
      .force("x", forceX(0).strength(0.04))
      .force("y", forceY(0).strength(0.04))
      .force("collide", forceCollide(34))
      .stop();
    const f = focus ? byKey.get(focus) : undefined;
    if (f) {
      f.fx = 0;
      f.fy = 0;
    }
    for (let i = 0; i < 300; i++) s.tick();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of ns) {
      minX = Math.min(minX, n.x!);
      maxX = Math.max(maxX, n.x!);
      minY = Math.min(minY, n.y!);
      maxY = Math.max(maxY, n.y!);
    }
    const bounds = { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX + 120, h: maxY - minY + 80 };
    return { s, ns, ls, byKey, bounds };
  }, [nodes, edges, focus]);

  useEffect(() => {
    const el = svgRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = () => {
    const k = Math.max(0.3, Math.min(1.6, Math.min(size.w / sim.bounds.w, size.h / sim.bounds.h)));
    setView({ x: -sim.bounds.cx * k, y: -sim.bounds.cy * k, k });
  };
  // 그래프가 바뀌거나 크기가 정해지면 화면에 맞춘다
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(fit, [sim, size.w > 0 && size.h > 0 ? Math.round(size.w / 50) : 0]);

  useEffect(() => {
    sim.s.on("tick", () => setFrame((f) => f + 1));
    return () => {
      sim.s.stop();
    };
  }, [sim]);

  const toWorld = (cx: number, cy: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (cx - r.left - size.w / 2 - view.x) / view.k, y: (cy - r.top - size.h / 2 - view.y) / view.k };
  };

  const pan = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const dragNode = useRef<{ n: N; moved: boolean } | null>(null);

  const select = (key: string) => {
    if (navigate) {
      const [t, id] = key.split(":");
      router.push(`/o/${t}/${id}`);
      return;
    }
    const q = new URLSearchParams(sp.toString());
    q.set("sel", key);
    router.push(`?${q}`, { scroll: false });
  };

  const neighbors = useMemo(() => {
    const k = hover ?? selected;
    if (!k) return null;
    const set = new Set([k]);
    for (const l of sim.ls) {
      const a = (l.source as N).key;
      const b = (l.target as N).key;
      if (a === k) set.add(b);
      if (b === k) set.add(a);
    }
    return set;
  }, [hover, selected, sim]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-inset" style={{ minHeight }}>
      <svg
        ref={svgRef}
        width={size.w}
        height={size.h}
        className="block cursor-grab active:cursor-grabbing"
        onWheel={(e) => {
          const k = Math.min(3, Math.max(0.25, view.k * (e.deltaY < 0 ? 1.12 : 0.89)));
          setView((v) => ({ ...v, k }));
        }}
        onPointerDown={(e) => {
          if ((e.target as Element).closest("[data-node]")) return;
          pan.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (dragNode.current) {
            const p = toWorld(e.clientX, e.clientY);
            dragNode.current.n.fx = p.x;
            dragNode.current.n.fy = p.y;
            dragNode.current.moved = true;
            sim.s.alpha(0.3).restart();
          } else if (pan.current) {
            const p = pan.current;
            setView((v) => ({ ...v, x: p.vx + e.clientX - p.x, y: p.vy + e.clientY - p.y }));
          }
        }}
        onPointerUp={() => {
          const d = dragNode.current;
          if (d && !d.moved) select(d.n.key);
          if (d && d.n.key !== focus) {
            d.n.fx = null;
            d.n.fy = null;
          }
          dragNode.current = null;
          pan.current = null;
        }}
      >
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--color-line-strong)" />
          </marker>
        </defs>
        <g transform={`translate(${size.w / 2 + view.x},${size.h / 2 + view.y}) scale(${view.k})`}>
          {sim.ls.map((l) => {
            const a = l.source as N;
            const b = l.target as N;
            const dim = neighbors && !(neighbors.has(a.key) && neighbors.has(b.key));
            const dx = b.x! - a.x!;
            const dy = b.y! - a.y!;
            const len = Math.hypot(dx, dy) || 1;
            const r = 12;
            return (
              <g key={l.key} opacity={dim ? 0.12 : 1}>
                <line
                  x1={a.x}
                  y1={a.y}
                  x2={b.x! - (dx / len) * r}
                  y2={b.y! - (dy / len) * r}
                  stroke={l.source === "custom" ? "var(--color-primary-fg)" : "var(--color-line-strong)"}
                  strokeWidth={l.source === "custom" ? 1.6 : 1}
                  strokeDasharray={l.source === "derived" ? "3 3" : undefined}
                  markerEnd="url(#arrow)"
                />
                {(l.source === "custom" || (neighbors && !dim)) && view.k > 0.6 && (
                  <text x={(a.x! + b.x!) / 2} y={(a.y! + b.y!) / 2 - 3} fontSize={9} textAnchor="middle" fill="var(--color-fg-3)">
                    {l.label}
                  </text>
                )}
              </g>
            );
          })}
          {sim.ns.map((n) => {
            const isSel = n.key === selected;
            const dim = neighbors && !neighbors.has(n.key);
            return (
              <g
                key={n.key}
                data-node
                transform={`translate(${n.x},${n.y})`}
                opacity={dim ? 0.25 : 1}
                className="cursor-pointer"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  dragNode.current = { n, moved: false };
                  (e.currentTarget.ownerSVGElement as Element).setPointerCapture(e.pointerId);
                }}
                onPointerEnter={() => setHover(n.key)}
                onPointerLeave={() => setHover(null)}
              >
                <title>{`${n.displayId} · ${n.title}${n.status ? ` · ${n.status}` : ""}`}</title>
                {isSel && <rect x={-16} y={-16} width={32} height={32} fill="none" stroke="var(--color-fg)" strokeWidth={1.5} />}
                <rect x={-10} y={-10} width={20} height={20} fill={TYPE_COLOR[n.type] ?? "#738091"} stroke="var(--color-inset)" strokeWidth={2} />
                {view.k > 0.45 && (
                  <text y={24} fontSize={10} textAnchor="middle" fill={isSel ? "var(--color-fg)" : "var(--color-fg-2)"} style={{ paintOrder: "stroke", stroke: "var(--color-inset)", strokeWidth: 3 }}>
                    {n.title.length > 18 ? `${n.title.slice(0, 17)}…` : n.title}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      <div className="pointer-events-none absolute top-2 left-2 flex flex-wrap gap-x-3 gap-y-1 border border-line bg-panel/90 px-2 py-1 text-[11px] text-fg-2">
        {Object.entries(TYPE_LABEL)
          .filter(([t]) => nodes.some((n) => n.type === t))
          .map(([t, l]) => (
            <span key={t} className="flex items-center gap-1">
              <span className="size-2.5" style={{ background: TYPE_COLOR[t] }} />
              {l} <span className="mono text-fg-4">{nodes.filter((n) => n.type === t).length}</span>
            </span>
          ))}
        <span className="flex items-center gap-1 text-fg-3">
          <svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke="var(--color-primary-fg)" strokeWidth="1.6" /></svg>사용자 링크
        </span>
        <span className="flex items-center gap-1 text-fg-3">
          <svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke="var(--color-line-strong)" strokeDasharray="3 3" /></svg>에이전트 변경
        </span>
      </div>
      <div className="absolute right-2 bottom-2 flex gap-1">
        <button className="btn btn-sm" onClick={() => setView((v) => ({ ...v, k: Math.min(3, v.k * 1.2) }))}>＋</button>
        <button className="btn btn-sm" onClick={() => setView((v) => ({ ...v, k: Math.max(0.25, v.k / 1.2) }))}>－</button>
        <button className="btn btn-sm" onClick={fit}>맞춤</button>
      </div>
    </div>
  );
}
