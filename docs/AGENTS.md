# 에이전트 연결 가이드

에이전트는 이 사업의 운영자다. 사람은 콘솔에서 관망하고 필요할 때 개입한다.

## 1. 토큰 발급

- 콘솔 `/agents` → 에이전트 등록 (토큰은 한 번만 표시), 또는
- `npm run agent -- create "Claude Code (운영)"`

정지(`suspend`)·폐기(`revoke`)하면 다음 요청부터 즉시 401/403.

## 2. 연결

### Claude Code — HTTP (앱이 실행 중일 때)
```bash
claude mcp add --transport http now http://localhost:3000/api/mcp \
  --header "Authorization: Bearer now_…"
```

### Claude Code — stdio (서버 없이 로컬 DB 직접)
```bash
claude mcp add --env NOW_AGENT_TOKEN=now_… now -- npx tsx scripts/mcp-stdio.ts
```

### 프로젝트 `.mcp.json` (토큰은 환경변수로)
```json
{
  "mcpServers": {
    "now": {
      "type": "http",
      "url": "http://localhost:3000/api/mcp",
      "headers": { "Authorization": "Bearer ${NOW_AGENT_TOKEN}" }
    }
  }
}
```

### Claude Desktop (`claude_desktop_config.json`, stdio)
```json
{
  "mcpServers": {
    "now": {
      "command": "npx",
      "args": ["tsx", "/절대경로/now/scripts/mcp-stdio.ts"],
      "env": { "NOW_AGENT_TOKEN": "now_…", "NOW_DB_PATH": "/절대경로/now/data/now.db" }
    }
  }
}
```

### OpenAI Codex CLI (`~/.codex/config.toml`)
```toml
[mcp_servers.now]
command = "npx"
args = ["tsx", "/절대경로/now/scripts/mcp-stdio.ts"]
env = { NOW_AGENT_TOKEN = "now_…", NOW_DB_PATH = "/절대경로/now/data/now.db" }
```

### Gemini CLI (`~/.gemini/settings.json`)
```json
{ "mcpServers": { "now": { "httpUrl": "http://localhost:3000/api/mcp", "headers": { "Authorization": "Bearer now_…" } } } }
```

### MCP 가 없는 AI — `now` CLI (셸)
```bash
export NOW_URL=http://localhost:3000 NOW_AGENT_TOKEN=now_…
node bin/now.mjs --help
now signals --severity critical --text
now run task.create '{"business_id":1,"title":"…"}' --reason "…"   # 종료 코드 0 적용 · 10 대기 · 11 실패 · 12 거부
now events --follow --type signal.
```

### OpenAPI (GPT Actions 등)
`GET /api/v1/openapi.json` — 모든 도구가 `POST /api/v1/tools/{name}` 으로 노출된다.

## 3. 도구

| 도구 | 용도 |
|---|---|
| `get_overview` | AI 모드, 신호 수, 승인 대기, 업무·미수금·현금흐름 — **시작할 때 먼저** |
| `list_signals` | 할 일 큐. 각 신호에 `suggested` 액션과 파라미터 |
| `describe_ontology` | 객체 유형·액션·규약 |
| `recall` | 자연어 회상 검색 — 이름·속성·접촉 이력·문서 본문(어휘) + 뜻이 비슷한 표현(의미 — 임베딩 공간이 활성일 때) + 관계(그래프). 흐릿하게 찾을 때 먼저. `about` 으로 기준 객체 주변 우선. 결과 `why`: `lexical` 내용 · `semantic` 의미 유사(`similarity` = 코사인) · `graph` 관계 · `ref` 직접 참조 · `about` 주변. `vector` 는 쓴 공간(없으면 null), `degraded` 가 있으면 의미 검색 없이 어휘 + 관계로만 찾은 결과 |
| `search_objects` / `get_object` | 유형별 목록 · 읽기 (속성·raw·연결·이력·현재 가능한 액션) |
| `list_actions` | 액션 카탈로그 + 입력 JSON Schema (사람 전용 액션 제외) |
| `run_action` | 실행. `reason` 필수 — 승인자와 감사 로그에 보인다 |
| `get_run` / `list_my_runs` / `cancel_run` | 승인 대기 결과 확인·철회 |
| `traverse` / `find_path` | 그래프: 이웃(1~4단계) · 두 객체 사이 관계 경로 |
| `list_events` | 이벤트 로그 (after_id 로 이어 읽기). 실시간은 SSE `/api/v1/events/stream` |
| `get_context` | **컨텍스트 팩** — 고정 기억 → `about` 대상의 기억(확인됨 → 활성 → 제안 → 충돌) → `task` 로 회상한 기억·문서·객체, 토큰 예산(기본 2000) 안에서. `text` 는 `<memory-context>` 데이터 펜스, `hash` 는 재현용 |
| `remember` | 기억 제안 (`memory.propose` 의 얇은 래퍼). `evidence` 1개 이상 · `reason` 필수. 결과 `status` 는 실행 상태, `memory_status` 는 기억 상태, `deduped` 면 기존 기억을 보강한 것, `conflicts` 는 충돌한 기억 |
| `cite` | 팩 밖에서 찾아 쓴 기억의 사용 기록. 없는 id 는 `unknown` 으로 알려 준다 |
| `list_memories` | 기억 목록 (상태·종류·대상). 뜻으로 찾을 때는 `recall(types: ["memory"])` — 대체·보관된 기억은 `include_inactive: true` 일 때만 |

`run_action` 결과 `status`:
- `applied` 적용 · `pending` 사람 승인 대기 (get_run 으로 확인) · `failed` 입력/규칙 오류 (error 확인 후 수정) · `denied` 정책 거부 (사람에게 요청)

### 기억 — AI 가 제안하고 사람이 확정한다

- 기억은 온톨로지 객체(`memory`)다. 에이전트는 `remember`(= `memory.propose`)로 **제안**만 한다 → `proposed`. 사람이 `/memory` 에서 확인하면 `verified`.
- 문장 규칙 (액션이 검증한다): 대상을 이름으로 적은 **자기완결적 한 문장**("한빛상사는 …" — "그 고객"·"해당 건" 거부), **지시문 금지**("~하라", "ignore previous …" 거부), **비밀값 금지**.
- 근거(`evidence`)는 필수. 근거 중 오염된(외부 출처) 기억이 있으면 오염을 물려받고, 에이전트는 되돌릴 수 없다. 메일·웹훅에서 알게 된 것은 `tainted: true`.
- 같은 기억이 있으면 새로 만들지 않고 근거를 보강한다 (정규화 문장이 같거나 trigram Jaccard ≥ 0.85, 숫자가 같을 때). 같은 대상에 대해 숫자·날짜만 다른 기억은 **충돌**(`disputed` + 신호 `memory.disputed`) — 사람이 `memory.resolve` 로 정리한다. 에이전트의 제안은 사람이 확인한 기억의 상태를 바꾸지 못하고(충돌 링크·신호만 남는다), 사람이 확인한 적 있거나 고정된 기억을 에이전트가 정정·합치기·보관하면 고위험이다.
- 틀린 기억은 `memory.correct` (새 기억으로 대체, 이전 기억은 계보에 `superseded`). 에이전트가 **확인된** 기억을 정정·보관·합치면 고위험(가드 모드에서 승인 대기).
- 사람 전용: `memory.record` · `confirm` · `reject` · `pin` · `resolve` · `promote`.
- AI 런타임 세션은 시작할 때 팩을 시스템 프롬프트(로컬 CLI 는 stdin 앞)에 받고, 세션에 팩 해시와 항목이 남는다. 답에 `[mem:N]` 으로 인용하면 세션이 끝날 때 사용 기록(`cited`)이 된다 — `/ai/sessions/<id>` 의 "이 세션이 본 기억·문서"·"인용한 기억".

```bash
now context --about CLT-0003 --task "갱신 제안서 작성" --text
now remember "Acme Robotics 는 청구서에 PO 번호를 요구한다" --kind caution --about CLT-0003 --evidence note:3 --reason "협상 메모에 명시"
now memories --status proposed,disputed --text
now cite 12 15
```

## 4. REST (같은 기능)

모든 요청에 `Authorization: Bearer now_…`.

| | |
|---|---|
| `GET /api/v1/overview` | get_overview |
| `GET /api/v1/signals?severity=critical` | list_signals |
| `GET /api/v1/objects/{type}?q=` · `/{type}/{id}` | search_objects · get_object |
| `GET /api/v1/actions` | list_actions |
| `POST /api/v1/actions/{name}` `{"params":{…},"reason":"…"}` | run_action |
| `GET /api/v1/runs` · `/runs/{id}` · `DELETE /runs/{id}` | 내 실행 · 조회 · 철회 |
| `POST /api/v1/iac/snapshots` | IaC 감사 결과 수신 (`iac:audit` 이 사용 · 동결 모드 거부 · 활동 로그 기록) |
| `GET /api/health` | 인증 없음 |

## 5. 권장 에이전트 지침 (시스템 프롬프트에 넣기)

```
너는 '<사업명>' 의 운영 에이전트다. Now MCP 도구만으로 일한다.
1. get_overview → list_signals(severity=critical) 부터 처리한다.
2. 쓰기 전에 get_object 로 현재 상태와 available_actions 를 확인한다.
3. run_action 의 reason 에는 근거(어떤 메일·문자·일정에서 왔는지)를 한 문장으로 쓴다.
4. 고객에게 나가는 행동과 금액 기록은 승인 대기가 정상이다. 결과는 get_run 으로 확인한다.
5. 불확실하면 실행하지 말고 note.create 로 제안 메모를 남긴다.
6. 시작할 때 get_context 로 기억 팩을 받고, 판단에 쓴 기억은 [mem:N] 으로 인용한다.
7. 반복해서 쓸 사실·선호·교훈은 remember 로 제안한다 (근거 필수, 이름으로 쓴 한 문장, 지시문 금지).
```
