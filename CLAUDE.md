# Now — 작업 규칙

1인 사업가용 로컬 사업 운영 체제. Next.js 16 (App Router) + better-sqlite3. UI 문구는 한국어.

## 명령
- `npm test` — node:test + 인메모리 DB. 변경 후 반드시 실행
- `npm run typecheck`, `npm run build`
- 예시 데이터로 확인: `NOW_DB_PATH=/tmp/x.db npm run db:seed && NOW_DB_PATH=/tmp/x.db npm run dev`

## 구조 규칙
- 데이터 접근은 `lib/repos/*` 에만. 함수는 첫 인자로 `db: DB` 를 받는다 (테스트에서 `openDb(":memory:")` 주입).
- 화면은 서버 컴포넌트에서 `db()` 로 repo 를 직접 호출. 변경은 `app/actions/*` 서버 액션으로, `formAction()` 으로 감싸 `FormError` 를 `?error=` 로 돌려준다.
- 사업 범위: `Scope = number | null` (null = 전체). `currentScope()` 는 쿠키 기반.
- Next 16: `params`, `searchParams`, `cookies()` 는 모두 Promise — `await` 필수.

## 데이터 규칙
- 스키마 변경은 `lib/db/migrations.ts` 배열 **끝에 새 항목 추가**. 기존 항목 수정 금지.
- 금액: 통화 최소 단위 정수 (`lib/money.ts` 의 `parseMoney`/`formatMoney`). 서로 다른 통화는 합산하지 않는다.
- 날짜: `'YYYY-MM-DD'` 문자열 (`lib/dates.ts`). 시각은 ISO 8601.
- 비밀값은 DB 에 저장하지 않는다. `infra_connections.credential_env` 는 환경변수 이름만.
- `data/` 는 사용자 사업 데이터 — 절대 커밋하지 않는다.
