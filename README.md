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
          사업 · 고객 · 업무 · 청구서 · 지출 · 문서 · 에이전트 · 기억   모든 시도 기록
```

| 계층 | 내용 |
|---|---|
| **온톨로지** | 사업·고객·업무·청구서·지출·문서·에이전트·기억 객체와 연결. 콘솔·API·MCP 가 같은 정의를 읽는다 |
| **액션** | 데이터를 바꾸는 유일한 경로 (51종). 하나의 정의가 폼 UI · AI 용 JSON Schema · 검증을 동시에 만든다 |
| **정책** | AI 운영 모드(자율/가드/감독/동결) × 위험도 → 즉시 실행 / 승인 대기 / 거부 |
| **감사** | 사람·에이전트의 모든 실행(실패·거부 포함)을 근거·결정자·결과와 함께 기록 |
| **신호** | 지연 업무, 미수금, 무응대 리드, 백업·인프라 문제 — 에이전트의 작업 큐이자 사람의 관망 화면 |
| **이벤트 · 트리거** | 모든 변화가 이벤트로 흐르고, 트리거가 AI 를 깨우거나 웹훅을 호출 (신호·승인 요청·cron) |
| **AI 런타임** | Claude · OpenAI · Gemini · OpenRouter · Ollama/LM Studio · 로컬 CLI 에이전트가 같은 관문으로 일한다 |
| **그래프** | 외래키·사용자 정의 링크·에이전트 변경 관계를 하나의 그래프로 탐색, Neo4j 분석 복제본 |
| **검색** | 하이브리드 회상 `recall`: 어휘(FTS) + 의미(벡터, 로컬 Ollama 우선) + 관계(그래프). 벡터는 지워도 다시 만들어지는 캐시 |
| **기억** | AI 가 제안하고 사람이 확인하는 사실·선호·교훈 (`memory` 객체). 중복은 보강, 숫자·날짜 충돌은 신호로, 정정은 대체(계보). AI 세션은 결정적 **컨텍스트 팩**(데이터 펜스)을 받고, 인용한 기억은 사용 기록에 남는다 |
| **IaC** | OpenTofu 로 로컬 Docker 배포, `iac:audit` 로 현행 감사·드리프트 감시 |

설계: [ARCHITECTURE](docs/ARCHITECTURE.md) · 온톨로지: [ONTOLOGY](docs/ONTOLOGY.md) · 이벤트·AI 런타임: [AUTOMATION](docs/AUTOMATION.md) · 기억·지식·검색: [MEMORY](docs/MEMORY.md) · 외부 AI 연결: [AGENTS](docs/AGENTS.md) · 인프라: [infra/README](infra/README.md) · 로드맵: [ROADMAP](docs/ROADMAP.md)

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

### 의미(벡터) 검색 (선택)

검색은 임베딩 없이도 어휘 + 관계로 동작합니다. 뜻이 비슷한 표현("클라우드 서버 비용" → AWS)까지 찾으려면 임베딩 공간을 하나 켭니다.

```bash
ollama pull bge-m3 && ollama serve   # 로컬 임베딩 — 본문이 이 기기를 떠나지 않음 (예시 데이터에 이 공간이 이미 있다)
```

콘솔 **시스템 › 검색 색인 › 임베딩 공간 추가** → 워커가 뒤에서 모든 청크를 임베딩하고, 100% 가 되면 활성화(자동 활성화 가능).
OpenAI · Gemini · Voyage · OpenAI 호환(LM Studio · vLLM · llama.cpp · TEI)도 되지만, 로컬·사설망이 아닌 공급자는 사업 데이터 본문이 외부로 나가므로 **고위험 · 사람 전용** 액션입니다.

| 환경변수 | |
|---|---|
| `NOW_VEC_PATH` | 벡터 파일 (기본: 본 DB 옆 `<이름>-vec.db`, 예 `data/now-vec.db`). 파생 캐시라 백업하지 않는다 — 지우면 다시 채운다 |
| `NOW_VECTORS=off` | 벡터 기능 끄기 (sqlite-vec 를 못 쓰는 플랫폼 등) — 어휘 + 관계로 동작 |

## 운영 배포 (IaC)

```bash
npm run iac:build                    # 이미지 빌드 (now:local)
cd infra && tofu init && tofu apply  # 로컬 Docker 에 배포 → http://127.0.0.1:3000
npm run iac:audit                    # 현행 감사 → 콘솔 /system (cron 권장)
```

## 콘솔

| 화면 | 역할 |
|---|---|
| 그래프 `/graph` · 스키마 `/ontology` | 힘 기반 그래프(이웃·경로·필터) + 상세 열, 객체 유형·속성·링크 유형 |
| AI 연결 `/ai` · 트리거 `/automations` · 이벤트 `/events` | 프로필·지시·세션 기록, 외부 AI 접속 가이드 · 트리거와 실행 · 실시간 이벤트(SSE) |
| 오퍼레이션 `/` | 상태 스트립 · 신호 큐(제안 액션) · 승인 대기 · 에이전트 · 실시간 활동 · 24h 추이 |
| 승인함 `/inbox` | 에이전트 요청의 근거·변경 내용(현재→제안) 확인 후 승인/거절 |
| 활동 로그 `/activity` | 행위자·상태·액션별 감사 로그, 실행 상세(입력·결과) |
| 일정 `/schedule` | 14일 타임라인 · 지연/오늘/7일/이후 |
| 객체 탐색 `/o/{type}` · 객체 `/o/{type}/{id}` | **열 기반**: 목록 │ 선택 객체 │ 연결 객체 (경계를 끌어 너비 조정) · 관계 그래프 · 변경 이력 |
| 재무 `/finance` | 통화별 월 손익 · 미수금 에이징 · 이번 달 지출 |
| 에이전트 `/agents` | AI 운영 모드 · 등록/정지/폐기 · 연결 방법 |
| 액션 카탈로그 `/actions` | 모든 액션과 현재 모드에서 AI 실행 결과 |
| 검색 `/search` | 회상 검색 — 결과마다 근거(참조 · 내용 · 의미 · 관계 · 주변)와 의미 유사도 |
| 기억 `/memory` | **열 기반**: 목록(검토 대기 · 확인됨 · 보관) │ 기억(근거 · 계보 · 충돌 · 확인/거절/정정) │ 관련(대상의 다른 기억 · 비슷한 기억 · 이 기억을 쓴 AI 세션). 객체 화면의 "AI 가 아는 것", 세션 화면의 "이 세션이 본 기억·문서" |
| 시스템 `/system` | 런타임 · DB · 백업 · IaC 감사/드리프트 · 검색 색인 · 임베딩 공간(상태 · 채움 % · 오류) |

단축키: `/` 검색 · `g o` 오퍼레이션 · `g i` 승인함 · `g a` 활동 · `g s` 일정 · `g m` 기억

## 명령

| 명령 | |
|---|---|
| `npm test` · `npm run typecheck` · `npm run build` | 검증 |
| `npm run db:seed` · `db:reset -- --yes` · `db:backup` | 데이터 |
| `npm run agent -- create/list/suspend/resume/revoke` | 에이전트 |
| `npm run mcp` | MCP stdio 서버 (`NOW_AGENT_TOKEN` 필요) |
| `npm run worker` | 이벤트 워커 단독 실행 (`-- --once`) |
| `node bin/now.mjs …` | 에이전트용 CLI (`NOW_URL`, `NOW_AGENT_TOKEN`) — 기억: `now context` · `now remember` · `now memories` · `now cite` |
| `npm run graph:neo4j` | Neo4j 로 그래프 동기화 / `-- --cypher 파일` |
| `npm run eval:recall` | 검색 품질(recall@k · MRR)·지연 측정 / `-- --load 50000 --verbose` · `-- --embed-url <base_url> --embed-model <모델> [--embed-provider ollama]` (임베딩 공간을 채워 lexical · vector · hybrid 비교) · `-- --vec-bench 50000 --dim 1024` (KNN 지연·정확도) |
| `npm run iac:build` · `iac:audit` | 인프라 |

## 보안 모델 (로컬 단일 운영자)

- 콘솔에는 로그인이 없습니다 → **127.0.0.1 에만 노출** (IaC 기본값). 외부 공개 전 인증 추가 필요 (로드맵).
- `proxy.ts` 가 localhost·127.0.0.1 외 Host 를 거부 (DNS 리바인딩 차단, 추가 호스트는 `NOW_ALLOWED_HOSTS`).
- 에이전트는 토큰(SHA-256 해시만 저장)으로 인증, 요청마다 상태 확인 → 정지 즉시 차단, 대기 요청 자동 철회.
- 에이전트는 자기 실행 기록만 조회. 승인 대기 중 대상이 바뀌면 승인해도 실행되지 않는다.
- 비밀값은 DB·감사 로그·IaC 스냅샷에 남기지 않습니다 (env 는 키 이름만 기록). 검색 색인에 들어가는 텍스트도 토큰·키 패턴을 가린 뒤 저장·임베딩합니다.
- 외부 임베딩 공급자(본문이 기기를 떠남)를 만들거나 켜는 것은 고위험 · 사람 전용. 기본은 로컬 Ollama.

기술 스택: Next.js 16 · React 19 · TypeScript · Tailwind CSS 4 · better-sqlite3 · zod 4 · OpenTofu (kreuzwerker/docker)
