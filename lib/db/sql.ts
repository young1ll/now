// 가변 길이 목록을 SQL 문 하나로 — `id IN (?, ?, …)` 처럼 목록 길이마다 SQL 문이 달라지면 문장 캐시(lib/db)가 소용없고,
// better-sqlite3 는 버려진 준비문의 네이티브 메모리를 연결을 닫을 때까지 돌려주지 않는다 (상주 서버·워커의 RSS 가 계속 는다).
// 목록은 JSON 문자열 인자 하나로 넘긴다: `col IN ${IN_JSON}` + jsonList(ids).

/** `IN` 오른쪽: JSON 배열 인자 하나의 원소들 */
export const IN_JSON = "(SELECT value FROM json_each(?))";

/** 행 값 `(a, b) IN` 오른쪽: [[a, b], …] JSON 인자 하나 */
export const PAIRS_JSON = "(SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))";

export const jsonList = (xs: readonly unknown[]) => JSON.stringify(xs);

/** 객체 참조 목록 → PAIRS_JSON 인자 ([[type, id], …]) */
export const refPairs = (refs: readonly { type: string; id: number }[]) => JSON.stringify(refs.map((r) => [r.type, r.id]));
