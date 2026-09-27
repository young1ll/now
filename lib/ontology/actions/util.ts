import { parseMoney, formatMoney } from "@/lib/money";
import type { DB } from "@/lib/db";
import { getBusiness } from "@/lib/repos/businesses";
import { getClient } from "@/lib/repos/clients";
import { ActionError } from "../types";

/** 사업이 존재하는지 */
export function checkBusiness(db: DB, id: number | null | undefined) {
  if (id != null) must(getBusiness(db, id), "사업");
}

/** 고객이 존재하고, businessId 가 주어지면 같은 사업 소속인지 */
export function checkClient(db: DB, clientId: number | null | undefined, businessId?: number | null) {
  if (clientId == null) return;
  const c = must(getClient(db, clientId), "고객");
  if (businessId != null && c.business_id !== businessId) throw new ActionError(`고객 '${c.name}' 은(는) 다른 사업 소속입니다`);
}

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
