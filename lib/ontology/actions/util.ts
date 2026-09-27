import { parseMoney, formatMoney } from "@/lib/money";
import { ActionError } from "../types";

export function toMinor(v: number | string, currency: string, label = "금액"): number {
  const n = parseMoney(String(v), currency);
  if (n === null) throw new ActionError(`${label}이(가) 올바르지 않습니다: ${v}`);
  return n;
}

export function must<T>(v: T | undefined, what: string): T {
  if (v === undefined || v === null) throw new ActionError(`${what}을(를) 찾을 수 없습니다`);
  return v;
}

/** undefined 인 키는 현재 값을 유지한다 (부분 수정). */
export function merge<T extends object>(current: T, patch: Partial<Record<keyof T, unknown>>): T {
  const out = { ...current } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) out[k] = v;
  return out as T;
}

export function labels<K extends string>(m: Record<K, string | { label: string }>): Record<K, string> {
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === "string" ? v : (v as { label: string }).label])) as Record<K, string>;
}

export function normTags(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  return s
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .join(", ");
}

export { formatMoney };
