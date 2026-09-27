// 날짜는 로컬 기준 'YYYY-MM-DD' 문자열로 다룬다.

const pad = (n: number) => String(n).padStart(2, "0");

export function toYmd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function today(): string {
  return toYmd(new Date());
}

export function parseYmd(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(ymd: string, days: number): string {
  const d = parseYmd(ymd);
  d.setDate(d.getDate() + days);
  return toYmd(d);
}

/** 월 단위 이동. 말일 보정: 1/31 + 1개월 → 2/28(29). */
export function addMonths(ymd: string, months: number): string {
  const d = parseYmd(ymd);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return toYmd(d);
}

export function monthOf(ymd: string): string {
  return ymd.slice(0, 7);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((parseYmd(to).getTime() - parseYmd(from).getTime()) / 86_400_000);
}

export function formatDate(ymdOrIso: string | null | undefined): string {
  if (!ymdOrIso) return "—";
  return ymdOrIso.slice(0, 10).replaceAll("-", ".");
}
