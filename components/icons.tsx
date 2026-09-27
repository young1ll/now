// 16px 선형 아이콘 세트 (Blueprint 느낌의 단순 기하).
import type { SVGProps } from "react";

const P: Record<string, string> = {
  ops: "M2 2h5v5H2zM9 2h5v3H9zM9 7h5v7H9zM2 9h5v5H2z",
  inbox: "M2 9l2-6h8l2 6v5H2zM2 9h4l1 2h2l1-2h4",
  activity: "M1 8h3l2-5 4 10 2-5h3",
  calendar: "M2 3h12v11H2zM2 6h12M5 1v3M11 1v3",
  client: "M8 8a3 3 0 100-6 3 3 0 000 6zM2 15c0-3 3-5 6-5s6 2 6 5",
  task: "M2 2h12v12H2zM5 8l2 2 4-4",
  invoice: "M3 1h10v14l-2-1-2 1-2-1-2 1-2-1zM5 5h6M5 8h6M5 11h3",
  expense: "M1 4h14v9H1zM1 7h14M4 10h3",
  note: "M3 1h7l3 3v11H3zM10 1v3h3M5 8h6M5 11h6",
  business: "M1 14h14M2 14V5l6-3 6 3v9M6 14v-4h4v4",
  agent: "M4 5h8v8H4zM8 2v3M6 8h1M9 8h1M6 11h4M2 8h2M12 8h2",
  action: "M9 1L3 9h5l-1 6 6-8H8z",
  finance: "M2 14V9M6 14V5M10 14V7M14 14V2",
  system: "M2 2h12v4H2zM2 10h12v4H2zM4 4h1M4 12h1",
  search: "M7 12A5 5 0 107 2a5 5 0 000 10zM11 11l4 4",
  close: "M3 3l10 10M13 3L3 13",
  plus: "M8 2v12M2 8h12",
  check: "M2 8l4 4 8-8",
  x: "M4 4l8 8M12 4l-8 8",
  arrow: "M3 8h10M9 4l4 4-4 4",
  external: "M9 2h5v5M14 2L7 9M12 10v4H2V4h4",
  pause: "M5 3v10M11 3v10",
  play: "M4 2l10 6-10 6z",
  warning: "M8 1l7 14H1zM8 6v4M8 12v1",
  shield: "M8 1l6 2v5c0 4-3 6-6 7-3-1-6-3-6-7V3z",
  bolt: "M9 1L3 9h5l-1 6 6-8H8z",
  print: "M4 6V1h8v5M4 12H1V6h14v6h-3M4 9h8v6H4z",
  graph: "M4 4h3v3H4zM10 2h3v3h-3zM10 10h3v3h-3zM2 11h3v3H2zM7 5.5l3-2M6.5 7l4 4M5 12.5h5",
  schema: "M2 2h5v4H2zM9 10h5v4H9zM9 2h5v4H9zM4.5 6v6H9M11.5 6v4",
  event: "M8 1v3M8 12v3M1 8h3M12 8h3M8 11a3 3 0 100-6 3 3 0 000 6z",
  trigger: "M2 8h4l2-5 2 10 2-5h2M14 3v2M14 11v2",
  ai: "M8 1l1.5 4.5L14 7l-4.5 1.5L8 13l-1.5-4.5L2 7l4.5-1.5z",
  columns: "M1 2h14v12H1zM6 2v12M11 2v12",
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 14, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="square" aria-hidden {...rest}>
      <path d={P[name]} />
    </svg>
  );
}
