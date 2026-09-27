# Now — 1인 사업가를 위한 사업 운영 체제

여러 사업을 동시에 굴리는 1인 창업가가 **고객 · 업무 · 매출 · 지식 · 인프라**를 한 화면에서 운영하기 위한 로컬 웹앱입니다.
모든 데이터는 내 컴퓨터의 SQLite 파일 하나에 저장되며, 외부 서버나 계정이 필요 없습니다.

| 모듈 | 하는 일 |
|---|---|
| **대시보드** | 이번 달 순이익, 미수금, 마감 임박·지연 업무, 인프라 이상·예산 초과를 한눈에 |
| **고객 · 거래처** (CRM) | 고객 상태(잠재·진행·보류·종료), 접촉 이력, 고객별 업무·청구서·문서 |
| **업무 · 마감** | 마감일·우선순위, 반복 업무(매주·매월·분기·매년 — 완료하면 다음 회차 자동 생성) |
| **매출 · 청구 · 정산** | 청구서(부가세·일련번호·PDF 인쇄), 입금 기록 → 자동 완납 처리, 지출, 월별 손익(현금주의, 통화별) |
| **지식 · 문서** | SOP·체크리스트·템플릿을 마크다운으로, 전문 검색(FTS5)·태그·공용 문서 |
| **인프라** | AWS · GCP · Azure · Palantir · HTTP 서비스 연결 등록, 헬스체크, 자격증명 설정 여부, 월 비용 vs 예산 |

사이드바의 **사업 범위**로 "전체 사업" ↔ 특정 사업을 전환하면 모든 화면이 그 범위로 필터링됩니다.

---

## 빠른 시작

요구사항: **Node.js 22+**

```bash
npm install
npm run db:seed     # (선택) 예시 데이터 — 빈 DB 에서만 실행됨
npm run dev         # http://localhost:3000
```

매일 쓸 때는 빌드해서 실행하는 편이 빠릅니다.

```bash
npm run build && npm start
```

처음 실행하면 사업을 하나 등록하는 화면이 나옵니다.

## 데이터

- 위치: `./data/now.db` (환경변수 `NOW_DB_PATH` 로 변경). `data/` 는 git 에 커밋되지 않습니다.
- 백업: `npm run db:backup` → `data/backups/now-YYYYMMDD-HHMM.db` (서버 실행 중에도 안전)
- 초기화: `npm run db:reset -- --yes`
- 스키마는 앱 시작 시 자동 마이그레이션됩니다 (`lib/db/migrations.ts`).

## 인프라 연동과 비밀값

비밀값(API 키, 토큰)은 **DB 에 저장하지 않습니다.** 연결마다 *환경변수 이름*만 적고, 실제 값은 `.env.local` 에 둡니다.

```bash
cp .env.local.example .env.local
# AWS_PROD_ACCESS_KEY=...
```

현재 상태 판정은 두 가지 근거만 사용합니다 — 추측하지 않습니다.

1. **헬스체크 URL** 응답: 2xx·3xx 정상 / 4xx 주의 / 5xx·무응답 장애
2. **자격증명 환경변수** 존재 여부: 없으면 정상 → 주의로 낮춤

월 비용은 지금은 수동 입력입니다. 공급자 API(AWS Cost Explorer, GCP Billing, Azure Cost Management, Foundry)로 자동 수집하는 어댑터는 [로드맵](docs/ROADMAP.md)에 있습니다.

## 개발

```bash
npm test            # 단위·통합 테스트 (node:test, 인메모리 SQLite)
npm run typecheck
npm run build
```

```
app/                 화면 (Next.js App Router, 서버 컴포넌트)
  actions/           서버 액션 — 폼 제출 처리 (모듈별)
components/          공용 UI
lib/
  db/                SQLite 연결 + 마이그레이션
  repos/             데이터 접근 계층 (모듈별, 순수 함수 + db 인자 → 테스트 용이)
  infra/             인프라 공급자 정보 · 상태 점검
  money.ts dates.ts  금액(최소 단위 정수) · 날짜('YYYY-MM-DD') 헬퍼
scripts/             seed · reset · backup
tests/               node:test
docs/ROADMAP.md      다음 단계
```

기술 스택: Next.js 16 · React 19 · TypeScript · Tailwind CSS 4 · better-sqlite3
