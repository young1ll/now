# 아키텍처

## 원칙

1. **AI 가 1차 사용자, 사람은 감독자.** 모든 기능은 먼저 에이전트가 쓸 수 있어야 하고(MCP/REST), 콘솔은 관망·개입에 최적화한다.
2. **변경의 단일 관문.** 사람의 폼도, 에이전트의 도구 호출도 `executeAction()` 하나를 지난다. 우회 경로가 없어야 감사가 완전하다.
3. **정의 한 번, 표면 여러 개.** 액션 필드 정의 → zod 검증 + JSON Schema(AI) + 폼(사람). 객체 정의 → 탐색기·객체 화면·API·MCP.
4. **추측하지 않는 상태.** 신호·IaC 감사는 관측 가능한 근거만 쓴다.
5. **로컬 우선.** SQLite 파일 하나, 백업 = 스냅샷 파일.

## 계층

```
lib/ontology/
  types.ts        ObjectType · Actor(human/agent/system) · ActionError
  fields.ts       필드 DSL: f.text / f.money / f.ref / f.items … → zod + UI 명세
  action.ts       defineAction(): name, risk(정적/동적), humanOnly, target, prefill, preview, run
  actions/*.ts    액션 카탈로그 (사업·고객·업무·청구·입금·지출·문서·에이전트·시스템)
  policy.ts       decide(actor, action, risk, AI 모드) → execute | approval | deny
  execute.ts      executeAction · approveRun · rejectRun · cancelRun (+ 감사 기록)
  objects.ts      객체 유형: list/get/속성/연결/상태별 액션(actionsFor)
  signals.ts      computeSignals → 심각도·근거·제안 액션(파라미터 포함)
  ops.ts          오퍼레이션 집계
  form.ts         FormData → 액션 파라미터
lib/ontology/schema.ts · graph.ts   속성·링크 유형 정의, 그래프 질의 (이웃·경로·전체)
lib/events/       워커 (신호 감지·cron·트리거 매칭·실행·색인 유지), SSE
lib/knowledge/    검색 색인(파생): 객체 카드·문서 구획 → chunks + FTS, 하이브리드 recall, 품질 평가 (docs/MEMORY.md)
lib/ai/           AI 런타임: 공급자 어댑터 (Anthropic SDK · OpenAI 호환 · Gemini) + 세션 실행 + 로컬 CLI
lib/agent/
  auth.ts         Bearer 토큰 → 에이전트 행위자 (정지·폐기 거부)
  tools.ts        에이전트 도구 14종 (MCP·REST·CLI 공용)
  mcp.ts          JSON-RPC 2.0 MCP 서버 (Streamable HTTP 무상태 + stdio)
lib/repos/        SQL 접근 (db 인자 주입 → 테스트는 :memory:)
app/(console)/    콘솔 화면 (서버 컴포넌트)
app/actions/console.ts   사람의 쓰기: runActionForm · decideRun · switchScope
app/api/          /api/health · /api/mcp · /api/v1/*
```

## 액션 실행 흐름

```
요청(actor, action, params, reason)
  → 스키마 검증 (strict: 모르는 필드 거부)
  → 위험도 (정적 또는 현재 데이터 기준: 예) 발행된 청구서의 수정은 high)
  → 정책
      human/system          → 실행
      agent + humanOnly     → denied
      agent + frozen        → denied
      agent + supervised    → pending
      agent + guarded       → high 면 pending, low 면 실행
      agent + autonomous    → 실행
  → 실행은 트랜잭션 안에서 (백업처럼 noTransaction 인 액션 제외)
  → action_runs + action_run_refs 기록
```

- 승인 시에는 **그 시점의 데이터로 다시 검증·실행**한다. 승인 대기로 들어갈 때 대상 객체의 지문을 저장하고,
  승인 시점에 대상이 바뀌었으면(예: 에이전트가 발행 요청 뒤 초안 금액을 바꿈) 실행하지 않고 failed 로 기록한다.
- 요청한 에이전트가 정지·폐기되면 대기 요청은 자동 철회되고, 승인도 거부된다.
- 부분 수정의 이름·제목은 빈 값 금지, 고객 연결은 같은 사업 소속만, 지출·입금은 양수이며 입금은 잔액 이하.
- 사람의 입력 오류는 폼에 되돌리고 기록하지 않는다. 에이전트의 모든 시도는 실패·거부 포함 기록한다 (모니터링 데이터).
- `out` 채널: 발급 토큰처럼 호출자에게만 주고 감사에 남기지 않는 값.

## 데이터 규칙

- 금액: 통화 최소 단위 정수. 액션 입력은 주 통화 단위(원, 달러) → 사업/청구서 통화로 변환. 통화가 다르면 합산하지 않는다.
- 날짜 `YYYY-MM-DD`, 시각 ISO 8601.
- 스키마 변경은 `lib/db/migrations.ts` 끝에 추가.

## 디자인 시스템 (콘솔)

Palantir Blueprint 계열 다크 테마: 모서리 0, 1px 경계, 조밀한 표, 대문자 섹션 라벨, 식별자·수치는 모노스페이스.
색은 의미에만: primary(행동) · success · warning · danger · ai(에이전트 행위자). 토큰은 `app/globals.css` 의 `@theme`.
차트 시리즈 색(`series-1/2`)은 dataviz 검증기로 다크 표면(#252A31) 대비·색각 분리를 통과한 값.
고객에게 나가는 문서(청구서 인쇄)는 콘솔 테마와 분리된 밝은 레이아웃.
