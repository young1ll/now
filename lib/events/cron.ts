// 5필드 cron (분 시 일 월 요일). *, */n, a-b, a-b/n, a,b 지원. 시간대는 서버 TZ.
const RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
] as const;

function parseField(f: string, [lo, hi]: readonly [number, number]): Set<number> {
  const out = new Set<number>();
  for (const part of f.split(",")) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) throw new Error(`cron 필드 오류: ${part}`);
    const step = m[2] ? Number(m[2]) : 1;
    let [a, b] = m[1] === "*" ? [lo, hi] : m[1].split("-").map(Number);
    if (b === undefined) b = m[2] ? hi : a;
    if (a < lo || b > hi || a > b || step < 1) throw new Error(`cron 범위 오류: ${part}`);
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string) {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error("cron 은 5개 필드여야 합니다 (분 시 일 월 요일)");
  const sets = f.map((x, i) => parseField(x, RANGES[i]));
  // 요일 7 → 0 (일요일) 허용
  if (f[4].includes("7")) sets[4].add(0);
  return { sets, domStar: f[2] === "*", dowStar: f[4] === "*" };
}

export function cronMatches(expr: string, d: Date): boolean {
  const { sets, domStar, dowStar } = parseCron(expr);
  const [min, hour, dom, mon, dow] = sets;
  if (!min.has(d.getMinutes()) || !hour.has(d.getHours()) || !mon.has(d.getMonth() + 1)) return false;
  // 표준 cron: 일·요일 둘 다 지정되면 OR
  const domOk = dom.has(d.getDate());
  const dowOk = dow.has(d.getDay());
  if (domStar && dowStar) return true;
  if (domStar) return dowOk;
  if (dowStar) return domOk;
  return domOk || dowOk;
}

export function validateCron(expr: string): string | null {
  try {
    parseCron(expr);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
