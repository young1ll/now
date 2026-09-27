# Now — 작업 규칙

AI 가 운영하고 사람이 관망·개입하는 1인 사업 운영 체제. Next.js 16 (App Router) + better-sqlite3. UI 문구는 한국어.
설계: docs/ARCHITECTURE.md

## 명령
- `npm test` (node:test, 인메모리 DB) · `npm run typecheck` · `npm run build` — 변경 후 모두 통과시킬 것
- 예시 데이터로 확인: `NOW_DB_PATH=/tmp/x.db npm run db:seed && NOW_DB_PATH=/tmp/x.db npm run dev`

## 핵심 규칙
- **모든 쓰기는 액션으로.** 새 기능 = `lib/ontology/actions/*` 에 `defineAction` 추가. 화면·API 에서 repo 쓰기 함수를 직접 부르지 않는다.
  - 사람: `runActionForm` 서버 액션 (hidden `__action`) 또는 `?act=<액션>&p.<고정필드>=…&d.<기본값>=…` 드로어
  - 에이전트: MCP `run_action` / REST `POST /api/v1/actions/{name}`
- 위험도: 외부로 나감·삭제·금액 기록 = `high`. 상태에 따라 다르면 함수로. 에이전트가 하면 안 되는 것 = `humanOnly`.
- 새 객체 유형은 `lib/ontology/objects.ts` 에 등록 (list/get/columns/actions/actionsFor).
- 읽기는 `lib/repos/*` (첫 인자 `db: DB`). 화면은 서버 컴포넌트에서 `db()` 로 호출.
- Next 16: `params`·`searchParams`·`cookies()`·`headers()` 는 Promise. `"use server"` 파일은 async 함수만 export.

## 데이터
- 스키마 변경은 `lib/db/migrations.ts` 배열 **끝에 추가**. 기존 항목 수정 금지.
- 금액: 통화 최소 단위 정수 (`lib/money.ts`). 다른 통화는 합산하지 않는다. 날짜 `YYYY-MM-DD`.
- 비밀값은 DB·감사 결과·IaC 스냅샷에 남기지 않는다 (토큰은 해시, 발급 토큰은 `ctx.out`).
- `data/` 는 사업 데이터 — 커밋 금지.

## UI (디자인 시스템)
- 모서리 0 (`rounded` 금지), 토큰 색만 (`bg-panel`, `text-fg-3`, `border-line`, intent: primary/success/warning/danger/ai).
- 공용 컴포넌트: `components/ui` (PageHeader, Panel, Tag, Metric, ObjectLink, PropertyList …), `ActionForm`, `ActionDrawer`, `runs.tsx`.
- 식별자·수치는 `mono`. 에이전트 행위자는 `ai` 색.

## 인프라
- `infra/` OpenTofu (kreuzwerker/docker ~> 4.0). 변경 후 `tofu fmt` · `tofu validate`. 수동 변경 금지 — `npm run iac:audit` 가 드리프트로 잡는다.
