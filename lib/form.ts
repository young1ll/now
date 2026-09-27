// FormData → 타입 있는 값. 서버 액션에서 사용한다.
import { parseMoney } from "@/lib/money";

export class FormError extends Error {}

export function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v.trim() : "";
}

export function required(fd: FormData, key: string, label = key): string {
  const v = str(fd, key);
  if (!v) throw new FormError(`${label}을(를) 입력하세요`);
  return v;
}

export function int(fd: FormData, key: string): number {
  const n = Number(str(fd, key));
  if (!Number.isInteger(n)) throw new FormError(`${key} 값이 올바르지 않습니다`);
  return n;
}

export function optInt(fd: FormData, key: string): number | null {
  const v = str(fd, key);
  if (!v) return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

export function optDate(fd: FormData, key: string): string | null {
  const v = str(fd, key);
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

export function date(fd: FormData, key: string, label = key): string {
  const v = optDate(fd, key);
  if (!v) throw new FormError(`${label} 날짜를 입력하세요`);
  return v;
}

export function oneOf<T extends string>(fd: FormData, key: string, allowed: readonly T[], fallback: T): T {
  const v = str(fd, key) as T;
  return allowed.includes(v) ? v : fallback;
}

export function money(fd: FormData, key: string, currency: string, label = key): number {
  const v = parseMoney(str(fd, key), currency);
  if (v === null) throw new FormError(`${label} 금액이 올바르지 않습니다`);
  return v;
}

export function optMoney(fd: FormData, key: string, currency: string): number | null {
  return parseMoney(str(fd, key), currency);
}

export function checkbox(fd: FormData, key: string): boolean {
  return fd.get(key) === "on";
}

export function tags(fd: FormData, key: string): string {
  return str(fd, key)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .join(", ");
}
