# Now — AI 가 운영하고 사람이 관망·개입하는 사업 운영 체제

1인 창업가가 여러 사업을 굴리기 위한 **로컬 우선 Business OS**.
일상 운영(고객 후속 조치, 업무 생성, 청구·정산 준비, 문서화)은 **AI 에이전트가 MCP/REST 로 수행**하고,
사람은 **콘솔에서 관망하다가 필요할 때 개입**합니다 — 승인·거절, 에이전트 정지, AI 운영 모드 전환.

```
            ┌──────────── 사람 (운영자) ────────────┐
            │  콘솔: 오퍼레이션 · 승인함 · 활동 로그  │  관망 · 개입
            └───────────────────┬───────────────────┘
                                │ 같은 관문
 AI 에이전트 ── MCP / REST ──► 액션(Action) ──► 정책(Policy) ──► 실행 · 승인 대기 · 거부
                                │                                   │
                          온톨로지(Ontology)                     감사(Audit)
               사업 · 고객 · 업무 · 청구서 · 지출 · 문서 · 에이전트    모든 시도 기록
```

| 계층 | 내용 |
|---|---|
| **온톨로지** | 사업·고객·업무·청구서·지출·문서·에이전트 객체와 연결. 콘솔·API·MCP 가 같은 정의를 읽는다 |
| **액션** | 데이터를 바꾸는 유일한 경로 (26종). 하나의 정의가 폼 UI · AI 용 JSON Schema · 검증을 동시에 만든다 |
| **정책** | AI 운영 모드(자율/가드/감독/동결) × 위험도 → 즉시 실행 / 승인 대기 / 거부 |
| **감사** | 사람·에이전트의 모든 실행(실패·거부 포함)을 근거·결정자·결과와 함께 기록 |
| **신호** | 지연 업무, 미수금, 무응대 리드, 백업·인프라 문제 — 에이전트의 작업 큐이자 사람의 관망 화면 |
| **IaC** | OpenTofu 로 로컬 Docker 배포, `iac:audit` 로 현행 감사·드리프트 감시 |

설계 상세: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · 에이전트 연결: [docs/AGENTS.md](docs/AGENTS.md) · 인프라: [infra/README.md](infra/README.md) · 다음 단계: [docs/ROADMAP.md](docs/ROADMAP.md)

---

## 빠른 시작 (개발 모드)

요구사항: Node.js 22+

```bash
npm install
npm run db:seed      # (선택) 예시 데이터 + 운영 에이전트 토큰 출력
npm run dev          # http://localhost:3000
```

### AI 에이전트 연결 (Claude Code)

```bash
npm run agent -- create "Claude Code (운영)"        # 토큰 발급 (콘솔 /agents 에서도 가능)
claude mcp add --transport http now http://localhost:3000/api/mcp \
  --header "Authorization: Bearer now_…"
```

그다음 Claude 에게: *"get_overview 로 현황을 보고 list_signals 의 신호를 처리해 줘"*.
고위험 행동은 콘솔 **승인함**에 쌓이고, 사람이 승인하면 실행됩니다.

## 운영 배포 (IaC)

```bash
npm run iac:build                    # 이미지 빌드 (now:local)
cd infra && tofu init && tofu apply  # 로컬 Docker 에 배포 → http://127.0.0.1:3000
npm run iac:audit                    # 현행 감사 → 콘솔 /system (cron 권장)
```

## 콘솔

| 화면 | 역할 |
|---|---|
| 오퍼레이션 `/` | 상태 스트립 · 신호 큐(제안 액션) · 승인 대기 · 에이전트 · 실시간 활동 · 24h 추이 |
| 승인함 `/inbox` | 에이전트 요청의 근거·변경 내용(현재→제안) 확인 후 승인/거절 |
| 활동 로그 `/activity` | 행위자·상태·액션별 감사 로그, 실행 상세(입력·결과) |
| 일정 `/schedule` | 14일 타임라인 · 지연/오늘/7일/이후 |
| 객체 탐색 `/o/{type}` · 객체 `/o/{type}/{id}` | 속성 · 연결 · 상태별 가능한 액션 · 변경 이력 |
| 재무 `/finance` | 통화별 월 손익 · 미수금 에이징 · 이번 달 지출 |
| 에이전트 `/agents` | AI 운영 모드 · 등록/정지/폐기 · 연결 방법 |
| 액션 카탈로그 `/actions` | 모든 액션과 현재 모드에서 AI 실행 결과 |
| 시스템 `/system` | 런타임 · DB · 백업 · IaC 감사/드리프트 |

단축키: `/` 검색 · `g o` 오퍼레이션 · `g i` 승인함 · `g a` 활동 · `g s` 일정

## 명령

| 명령 | |
|---|---|
| `npm test` · `npm run typecheck` · `npm run build` | 검증 |
| `npm run db:seed` · `db:reset -- --yes` · `db:backup` | 데이터 |
| `npm run agent -- create/list/suspend/resume/revoke` | 에이전트 |
| `npm run mcp` | MCP stdio 서버 (`NOW_AGENT_TOKEN` 필요) |
| `npm run iac:build` · `iac:audit` | 인프라 |

## 보안 모델 (로컬 단일 운영자)

- 콘솔에는 로그인이 없습니다 → **127.0.0.1 에만 노출** (IaC 기본값). 외부 공개 전 인증 추가 필요 (로드맵).
- `proxy.ts` 가 localhost·127.0.0.1 외 Host 를 거부 (DNS 리바인딩 차단, 추가 호스트는 `NOW_ALLOWED_HOSTS`).
- 에이전트는 토큰(SHA-256 해시만 저장)으로 인증, 요청마다 상태 확인 → 정지 즉시 차단, 대기 요청 자동 철회.
- 에이전트는 자기 실행 기록만 조회. 승인 대기 중 대상이 바뀌면 승인해도 실행되지 않는다.
- 비밀값은 DB·감사 로그·IaC 스냅샷에 남기지 않습니다 (env 는 키 이름만 기록).

기술 스택: Next.js 16 · React 19 · TypeScript · Tailwind CSS 4 · better-sqlite3 · zod 4 · OpenTofu (kreuzwerker/docker)
