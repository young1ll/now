// 사업(business) 범위 필터. null 이면 "전체 사업".
export type Scope = number | null;

/** `alias.business_id = ?` 조건과 파라미터를 만든다. 전체 범위면 항상 참. */
export function scopeWhere(scope: Scope, column = "business_id"): [string, unknown[]] {
  return scope === null ? ["1=1", []] : [`${column} = ?`, [scope]];
}
