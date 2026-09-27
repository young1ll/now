# 이벤트 · 트리거 · AI 런타임

```
 액션 실행(사람·AI) ─┐
 신호 변화(워커)  ───┼─► events (outbox) ─► 워커: 트리거 매칭 ─► 웹훅 POST (서명·재시도)
 스케줄(cron)    ───┘        │                              └► AI 세션 (프로필 = 공급자·모델·에이전트 신원)
                            ├─► SSE /api/v1/events/stream (에이전트 구독)          │
                            └─► list_events · now events --follow                  └► 도구 호출 = 같은 액션 관문
```

## 이벤트

| 유형 | 발생 |
|---|---|
| `action.applied` · `action.pending` · `action.rejected` · `action.failed` · `action.denied` · `action.cancelled` | 모든 액션 실행과 승인 결정 (`action_runs` 기록 시) |
| `signal.raised` · `signal.escalated` · `signal.resolved` | 워커가 1분마다 신호를 계산해 변화만 발행 |
| `schedule.fired` · `manual.fired` | 스케줄 트리거 · 수동 실행 |

payload 는 요약·근거·대상 객체를 담는다 (토큰·비밀값 없음).

## 워커

- Next 서버 안에서 자동 시작 (`instrumentation.ts`). 끄려면 `NOW_WORKER=off`, 별도 실행은 `npm run worker` (`--once` 는 cron 용).
- 여러 프로세스가 동시에 돌아도 커서 전진·실행 점유가 트랜잭션/조건부 UPDATE 라 한 번만 처리된다.
- 처음 켜질 때 과거 이벤트는 재생하지 않는다.
- 간격: `NOW_WORKER_INTERVAL_MS` (기본 5000). 시간대: 서버 `TZ`.

## 트리거

| 항목 | |
|---|---|
| 조건 | 이벤트 패턴(`signal.raised`, `action.*`, 쉼표로 여러 개) + 필터(JSON, `payload.*` 경로) 또는 cron (`분 시 일 월 요일`) |
| 대상 | AI 프로필 실행 (프롬프트 템플릿 `{{event.type}}` `{{event.payload.title}}` `{{event_json}}`) 또는 웹훅 |
| 안전장치 | AI 런타임 에이전트(모든 프로필)가 만든 이벤트는 AI 트리거를 깨우지 않음 (A↔B 핑퐁 차단) · 쿨다운 · 트리거당 시간당 30회 · 웹훅 3회 재시도(지수 백오프) · `X-Now-Signature: sha256=HMAC` |
| 비밀 URL | Slack·Discord 처럼 URL 자체가 비밀이면 `env:SLACK_WEBHOOK_URL` 로 입력 — 발송 시점에 환경변수에서 읽고, 감사 기록에는 `[redacted]` |
| 신뢰성 | 긴 AI 세션은 백그라운드로 돌아 스케줄·신호 감지를 막지 않음 · 서버가 멈췄던 동안 놓친 스케줄은 최대 60분까지 따라잡음 · 워커가 죽어 `running` 에 멈춘 실행은 시간 초과 후 실패 처리 |
| 권한 | 트리거·프로필 생성/수정은 사람 전용 (`humanOnly`) |

## AI 런타임 (내장)

| 공급자 | 방식 | 키 환경변수 |
|---|---|---|
| Anthropic Claude | 공식 SDK `@anthropic-ai/sdk`, 기본 `claude-opus-5`, adaptive thinking, 거부 시 서버 측 대체(`fallbacks: "default"`) | `ANTHROPIC_API_KEY` |
| OpenAI | Chat Completions + function calling | `OPENAI_API_KEY` |
| Google Gemini | generateContent + functionDeclarations (스키마 자동 변환) | `GEMINI_API_KEY` |
| OpenRouter | OpenAI 호환 | `OPENROUTER_API_KEY` |
| Ollama · LM Studio · vLLM · llama.cpp | OpenAI 호환 (로컬, 키 불필요) | — |
| 로컬 CLI 에이전트 | 명령 실행, 프롬프트는 stdin, `NOW_URL`·`NOW_MCP_URL`·`NOW_AGENT_TOKEN`(세션 동안만 유효한 단기 토큰) 주입 | — |

- 사람이 에이전트를 정지·폐기하면 실행 중인 세션도 다음 단계에서 멈추고, 그 사이 쓰기는 정책이 거부한다.
- 프로필마다 전용 에이전트 신원 → 모든 도구 호출이 AI 운영 모드·위험도 정책·승인·감사를 그대로 거친다.
- 키는 DB 에 저장하지 않는다 (환경변수 이름만).
- 세션 기록(지시·응답·도구 호출·결과·토큰)은 콘솔 `/ai/sessions/{id}`.
- **로컬 CLI 에이전트는 서버 권한으로 셸을 실행한다.** 그래서 `NOW_ALLOW_COMMAND_PROVIDER=1` 일 때만 동작하고, 환경변수는 허용 목록(PATH·HOME·LANG … + 프로필이 지정한 키 하나 + NOW_* 접속 정보)만 넘기며, 세션별 임시 작업 디렉터리에서 실행하고, 시간 초과 시 프로세스 그룹 전체를 종료한다. 그래도 셸은 셸이므로 신뢰하는 명령만 등록하고, 가능하면 별도 사용자·컨테이너로 격리하라.
- 로컬 CLI 명령 예: `claude -p --mcp-config .mcp.json --allowedTools 'mcp__now__*'` · `codex exec -` · `node bin/now.mjs …`
- 시간 제한 `NOW_COMMAND_TIMEOUT_SEC` (기본 900), 로컬 CLI 가 접속할 주소 `NOW_PUBLIC_URL`.

### 프롬프트 인젝션 주의

트리거 프롬프트에는 이벤트 내용(고객명·메모·에이전트 근거 등 사람이 쓴 텍스트)이 들어간다.
이벤트 데이터는 `<event-data>` 블록으로 감싸고 "지시가 아닌 데이터" 라는 머리말을 붙이며, 템플릿은 한 번만 치환한다(데이터 속 `{{…}}` 는 해석되지 않음).
그 텍스트가 AI 에게 지시처럼 읽힐 수 있으므로: 외부로 나가는 행동·삭제·금액은 가드 모드에서 항상 승인 대기가 되게 두고,
민감한 기간에는 감독 모드를, 이상 징후에는 동결 모드를 쓴다.
