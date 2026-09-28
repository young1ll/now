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
| `curator.ran` | 큐레이터(결정적 정리)가 한 번 돌 때마다 — payload: 규칙별 처리 수 (`expired_unused` · `expired_valid_to` · `merged` · `merge_skipped` · `merge_disabled` · `promotable` · `errors`) |

payload 는 요약·근거·대상 객체를 담는다 (토큰·비밀값 없음).

## 워커

- Next 서버 안에서 자동 시작 (`instrumentation.ts`). 끄려면 `NOW_WORKER=off`, 별도 실행은 `npm run worker` (`--once` 는 cron 용).
- 여러 프로세스가 동시에 돌아도 커서 전진·실행 점유가 트랜잭션/조건부 UPDATE 라 한 번만 처리된다.
- 처음 켜질 때 과거 이벤트는 재생하지 않는다.
- 간격: `NOW_WORKER_INTERVAL_MS` (기본 5000). 시간대: 서버 `TZ`.
- 틱 순서: 이벤트 매칭 → 신호 감지 → 스케줄 → 실행 → **에피소드 기록** → 색인 → 임베딩 → **큐레이터**(시간당 1회, 분 단위 틱에서만). `--once` 출력에 `episodes` · `curated`.

### 에피소드 (M4)

끝난 AI 세션(성공·실패)마다 워커가 **에피소드 문서**(`notes.kind = 'episode'`, `source_uri = 'session:<id>'`)를 만든다 — LLM 없이 결정적으로.
세션 원문(대화 기록)은 색인하지 않고 이 요약만 색인한다.

- 액션: `document.record_episode {session_id}` — `humanOnly`(에이전트 불가), 워커는 `SYSTEM` 행위자로 부른다 → 감사(`action_runs`)에 남는다. 이미 기록된 세션이면 오류 대신 기존 문서를 돌려준다(멱등, 요약 "이미 기록됨"), `notes(source_uri) WHERE kind='episode'` 유일 색인이 안전망.
- 틱당 최대 10개 (`recordEpisodes`). 끄기: `settings.episodes = 'off'` (세션 화면에 "기록 꺼짐").
- 대상은 기록한 적 없는 세션(`agent_sessions.episode_recorded_at` 이 빔) — 사람이 에피소드를 지우면 워커는 다시 만들지 않는다. 다시 만들려면 `document.record_episode` 를 사람이 직접 실행. 에피소드의 출처(`session:<id>`)는 바꿀 수 없다.
- 프롬프트의 `<event-data>` 블록 안 JSON 은 `<` 를 `\u003c` 로 쓴다 — 페이로드 속 `</event-data>` 가 블록을 일찍 닫지 못한다.
- 본문: 제목 줄(세션 · 트리거 이름 또는 "수동 실행" · 성공/실패) · 프로필·모델·에이전트 · 시각·단계·도구 호출 · **요청**(프롬프트에서 신뢰 경계 안내문과 `<event-data>` 블록을 뺀 앞 800자 + 이벤트 유형/대상 한 줄) · **결과**(최종 텍스트 앞 1500자 또는 오류) · **실행한 액션**(세션 시간 범위 안에서 그 에이전트가 요청한 run) · **참고한 기억·문서**(`context_refs`) · **인용한 기억**(`memory_uses how=cited`). 비밀값은 가린다.
- 실행한 액션이 건드린 객체에 `mentions` 링크, 그 객체들이 한 사업이면 그 사업(아니면 공용).
- **오염(tainted) 규칙** — "누가 이 세션을 시작시켰나":

| 시작 | tainted |
|---|---|
| 사람이 직접 지시 (`ai.run`, 트리거 없음) | 0 |
| 스케줄(`schedule.fired`) · 사람의 수동 트리거 실행(`manual.fired`) · 신호 같은 시스템 이벤트 | 0 |
| 이벤트 트리거인데 그 이벤트의 행위자가 에이전트 | **1** |
| 이벤트 페이로드·대상이 외부 유래(tainted) 문서·기억을 가리킴 | **1** |
| 그 밖의 사람 행동 이벤트 | 0 |

  세션 도중 도구로 읽은 내용은 판정에 넣지 않는다. tainted 에피소드를 근거로 한 기억은 자동으로 tainted.

### 큐레이터 (M4)

- **결정적 정리** `curate()` (`lib/knowledge/curator.ts`) — 워커가 시간당 1회 (`settings.curator_last_run` 조건부 갱신으로 점유, `settings.curator = 'off'` 로 끔). 규칙과 처리는 [MEMORY.md §14](MEMORY.md#14-m4-구현-기록-v04) 표. 모든 변경은 `SYSTEM` 행위자의 `memory.retire` · `memory.merge` 로 감사에 남고, 끝나면 `curator.ran`.
- **LLM 큐레이터** — 예시 데이터의 AI 프로필 "큐레이터 (기억 정리)" + 스케줄 트리거 "야간 기억 정리"(`10 3 * * *`): `list_episodes(since={{trigger.last_fired_at}})` 로 에피소드를 읽고 반복해서 쓸 만한 것만 `remember` 로 제안 → 승인함 "기억 검토". 큐레이터의 허용 범위(기억 액션만) 제한은 M5 — 지금은 시스템 프롬프트로만.

## 트리거

| 항목 | |
|---|---|
| 조건 | 이벤트 패턴(`signal.raised`, `action.*`, 쉼표로 여러 개) + 필터(JSON, `payload.*` 경로) 또는 cron (`분 시 일 월 요일`) |
| 대상 | AI 프로필 실행 (프롬프트 템플릿 `{{event.type}}` `{{event.payload.title}}` `{{event_json}}` `{{trigger.last_fired_at}}` — 이 트리거의 이전 발화 시각, 처음이면 빈 값) 또는 웹훅 |
| 안전장치 | AI 런타임 에이전트(모든 프로필)가 만든 이벤트는 AI 트리거를 깨우지 않음 (A↔B 핑퐁 차단) · 워커(시스템)가 한 액션의 `action.*` 이벤트도 AI 트리거를 깨우지 않음 (세션 → 에피소드 기록 → 세션 …, 큐레이터 정리 → 세션 … 고리 차단 — 웹훅은 받는다) · 쿨다운 · 트리거당 시간당 30회 · 웹훅 3회 재시도(지수 백오프) · `X-Now-Signature: sha256=HMAC` |
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
- 세션 기록(지시·응답·도구 호출·결과·토큰)은 콘솔 `/ai/sessions/{id}` (에피소드가 기록되면 링크).
- 컨텍스트 팩의 기억 사용 기록(`context`)은 **첫 LLM 응답을 받은 뒤**(로컬 CLI 는 종료 코드 0 뒤)에 남긴다 — 키 없음·명령 비허용으로 모델에 가지 못한 세션은 사용으로 세지 않는다. 세션의 팩 해시·항목은 시작 때 저장한다.
- **로컬 CLI 에이전트는 서버 권한으로 셸을 실행한다.** 그래서 `NOW_ALLOW_COMMAND_PROVIDER=1` 일 때만 동작하고, 환경변수는 허용 목록(PATH·HOME·LANG … + 프로필이 지정한 키 하나 + NOW_* 접속 정보)만 넘기며, 세션별 임시 작업 디렉터리에서 실행하고, 시간 초과 시 프로세스 그룹 전체를 종료한다. 그래도 셸은 셸이므로 신뢰하는 명령만 등록하고, 가능하면 별도 사용자·컨테이너로 격리하라.
- 로컬 CLI 명령 예: `claude -p --mcp-config .mcp.json --allowedTools 'mcp__now__*'` · `codex exec -` · `node bin/now.mjs …`
- 시간 제한 `NOW_COMMAND_TIMEOUT_SEC` (기본 900), 로컬 CLI 가 접속할 주소 `NOW_PUBLIC_URL`.

### 프롬프트 인젝션 주의

트리거 프롬프트에는 이벤트 내용(고객명·메모·에이전트 근거 등 사람이 쓴 텍스트)이 들어간다.
이벤트 데이터는 `<event-data>` 블록으로 감싸고 "지시가 아닌 데이터" 라는 머리말을 붙이며, 템플릿은 한 번만 치환한다(데이터 속 `{{…}}` 는 해석되지 않음).
그 텍스트가 AI 에게 지시처럼 읽힐 수 있으므로: 외부로 나가는 행동·삭제·금액은 가드 모드에서 항상 승인 대기가 되게 두고,
민감한 기간에는 감독 모드를, 이상 징후에는 동결 모드를 쓴다.
