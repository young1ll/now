// 작은 막대 차트 (SVG). 색은 dataviz 검증 팔레트 series-1/2, 범례·수치 라벨·호버 툴팁 포함.

type Bar = { label: string; a: number; b: number; title: string };

/** 누적 막대: a(시리즈1) 아래, b(시리즈2) 위. 2px 간격, 기준선 고정. */
export function StackedBars({ data, aLabel, bLabel, height = 96 }: { data: Bar[]; aLabel: string; bLabel: string; height?: number }) {
  const max = Math.max(1, ...data.map((d) => d.a + d.b));
  const w = 100 / data.length;
  const totalA = data.reduce((s, d) => s + d.a, 0);
  const totalB = data.reduce((s, d) => s + d.b, 0);
  return (
    <figure>
      <div className="mb-2 flex items-center gap-4 text-[11px] text-fg-2">
        <span className="flex items-center gap-1.5"><span className="size-2.5 bg-series-1" />{aLabel} <span className="mono text-fg">{totalA}</span></span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 bg-series-2" />{bLabel} <span className="mono text-fg">{totalB}</span></span>
        <span className="mono ml-auto text-fg-4">최대 {max}/h</span>
      </div>
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className="block w-full" style={{ height }} role="img" aria-label={`${aLabel} ${totalA}, ${bLabel} ${totalB}`}>
        {[0.5, 1].map((f) => (
          <line key={f} x1="0" x2="100" y1={height - (height - 2) * f} y2={height - (height - 2) * f} stroke="var(--color-line-soft)" strokeWidth="0.3" vectorEffect="non-scaling-stroke" />
        ))}
        {data.map((d, i) => {
          const ha = ((height - 2) * d.a) / max;
          const hb = ((height - 2) * d.b) / max;
          const x = i * w + w * 0.15;
          const bw = w * 0.7;
          return (
            <g key={d.label}>
              <title>{d.title}</title>
              <rect x={i * w} y={0} width={w} height={height} fill="transparent" />
              {d.a > 0 && <rect x={x} y={height - ha} width={bw} height={ha} fill="var(--color-series-1)" />}
              {d.b > 0 && <rect x={x} y={height - ha - hb - (d.a > 0 ? 1 : 0)} width={bw} height={hb} fill="var(--color-series-2)" />}
            </g>
          );
        })}
        <line x1="0" x2="100" y1={height - 0.5} y2={height - 0.5} stroke="var(--color-line-strong)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mono mt-1 flex justify-between text-[10px] text-fg-4">
        <span>{data[0]?.label}</span>
        <span>{data[Math.floor(data.length / 2)]?.label}</span>
        <span>{data[data.length - 1]?.label}</span>
      </div>
    </figure>
  );
}

/** 가로 비교 막대 (수입 vs 지출). 각 행 2개 막대, 표 안에서 사용. */
export function PairBar({ a, b, max, title }: { a: number; b: number; max: number; title: string }) {
  const pa = (a / Math.max(max, 1)) * 100;
  const pb = (b / Math.max(max, 1)) * 100;
  return (
    <div className="flex flex-col gap-[2px] py-0.5" title={title}>
      <div className="h-[6px] bg-series-1" style={{ width: `${pa}%` }} />
      <div className="h-[6px] bg-series-2" style={{ width: `${pb}%` }} />
    </div>
  );
}
