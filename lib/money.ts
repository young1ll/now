// 금액은 통화의 최소 단위 정수로 저장한다 (KRW 1원 = 1, USD 1달러 = 100).

export function fractionDigits(currency: string): number {
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
    .maximumFractionDigits ?? 0;
}

/** "1,234.5" 같은 사용자 입력 → 최소 단위 정수. 해석 불가하면 null. */
export function parseMoney(input: string, currency: string): number | null {
  const cleaned = input.replace(/[,\s₩$€¥]/g, "");
  if (cleaned === "" || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 10 ** fractionDigits(currency));
}

export function toMajor(minor: number, currency: string): number {
  return minor / 10 ** fractionDigits(currency);
}

export function formatMoney(minor: number, currency: string): string {
  return new Intl.NumberFormat("ko-KR", { style: "currency", currency }).format(
    toMajor(minor, currency),
  );
}
