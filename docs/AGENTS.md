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
| `whoami` | 나의 역할 · 허용 액션 · 사업 범위 · 기억 등급 · 유효한 자율 권한 · AI 모드 · 최근 30일 신뢰 지표 · 지금 가능한 것 요약(`summary`) — **세션마다 한 번 먼저** |
| `get_overview` | AI 모드, 신호 수, 승인 대기, 업무·미수금·현금흐름, 최근 7일 자율도 — **시작할 때 먼저** |
| `list_signals` | 할 일 큐. 각 신호에 `suggested` 액션과 파라미터 |
| `describe_ontology` | 객체 유형·액션·규약 |
| `recall` | 자연어 회상 검색 — 이름·속성·접촉 이력·문서 본문(어휘) + 뜻이 비슷한 표현(의미 — 임베딩 공간이 활성일 때) + 관계(그래프). 흐릿하게 찾을 때 먼저. `about` 으로 기준 객체 주변 우선. 결과 `why`: `lexical` 내용 · `semantic` 의미 유사(`similarity` = 코사인) · `graph` 관계 · `ref` 직접 참조 · `about` 주변. `vector` 는 쓴 공간(없으면 null), `degraded` 가 있으면 의미 검색 없이 어휘 + 관계로만 찾은 결과 |
| `search_objects` / `get_object` | 유형별 목록 · 읽기 (속성·raw·연결·이력·현재 가능한 액션) |
| `list_actions` | 액션 카탈로그 + 입력 JSON Schema (사람 전용 액션 · 내 허용 범위 밖 액션 제외) |
| `run_action` | 실행. `reason` 필수 — 승인자와 감사 로그에 보인다 |
| `get_run` / `list_my_runs` / `cancel_run` | 승인 대기 결과 확인·철회 |
| `traverse` / `find_path` | 그래프: 이웃(1~4단계) · 두 객체 사이 관계 경로 |
| `list_events` | 이벤트 로그 (after_id 로 이어 읽기). 실시간은 SSE `/api/v1/events/stream` |
| `get_context` | **컨텍스트 팩** — 고정 기억 → `about` 대상의 기억(확인됨 → 활성 → 제안 → 충돌) → `task` 로 회상한 기억·문서·객체, 토큰 예산(기본 2000) 안에서. `text` 는 `<memory-context>` 데이터 펜스, `hash` 는 재현용 |
| `remember` | 기억 제안 (`memory.propose` 의 얇은 래퍼). `evidence` 1개 이상 · `reason` 필수. 결과 `status` 는 실행 상태, `memory_status` 는 기억 상태, `deduped` 면 기존 기억을 보강한 것, `conflicts` 는 충돌한 기억 |
| `cite` | 팩 밖에서 찾아 쓴 기억의 사용 기록. 없는 id 는 `unknown` 으로 알려 준다 |
| `list_memories` | 기억 목록 (상태·종류·대상). 뜻으로 찾을 때는 `recall(types: ["memory"])` — 대체·보관된 기억은 `include_inactive: true` 일 때만 |
| `list_episodes` | 최근 에피소드(끝난 AI 세션의 결정적 요약) — `since`(ISO, 비우면 최근 7일) · `limit`(≤50) · `include_tainted`(기본 true). 결과 `{id, ref "note:N", title, created_at, session_id, tainted, excerpt(앞 600자)}`, 새 것 먼저. 기억 정리(큐레이터)의 원료 |

`run_action` 결과 `status`:
- `applied` 적용 · `pending` 사람 승인 대기 (get_run 으로 확인) · `failed` 입력/규칙 오류 (error 확인 후 수정) · `denied` 정책 거부 (사람에게 요청)

### 권한 — 역할 · 범위 · 자율 권한 · 신뢰 사다리 (M5)

권한은 **좁게 시작해 증거로 넓어진다.** 넓히는 것은 항상 사람이, 좁히는 것은 워커도 자동으로 한다. `whoami` 로 지금 내 권한을 확인하고 그 안에서 일하라.

| 항목 | 의미 | 에이전트가 할 일 |
|---|---|---|
| 역할 `role` | operator(운영자) · curator(큐레이터) · researcher(리서처) · custom — 표시·기본값 | 역할에 맞는 일만 한다 (큐레이터는 기억 정리만) |
| 허용 액션 `allowed_actions` | 쉼표 glob (`*` · `memory.*,note.create`). 밖의 액션은 `denied` "이 에이전트(역할 …)의 허용 범위 밖" | `list_actions` 가 허용 범위 안의 것만 보여 준다. 밖의 일이 필요하면 `note.create`(허용되면)로 사람에게 제안 |
| 사업 범위 `business_scope` | 한 사업으로 제한 (없으면 전체). 요청이 닿는 사업 = `business_id` + 대상 객체 + 참조 필드(`client_id` · `about` · `evidence` · `link.create` 의 양쪽 …)의 객체. 사업 없는 공용 문서·기억은 통과. 새 사업은 만들 수 없다 | 읽기 도구의 `business_id` 는 생략하면 내 범위, 다른 값이면 오류. 범위 밖 객체는 검색·회상·그래프·팩·신호·이벤트에서 보이지 않고 `get_object` 는 오류 |
| 자율 권한 (`agent_grants`) | 가드 모드에서 고위험 액션 **하나**를 승인 없이 실행 (정확한 이름 · 1~90일 뒤 만료). 감독 모드에서는 무시. 허용 범위 밖이 된 권한은 쓰이지 않는다(`whoami.unusable_grants`). 권한으로 실행한 결과는 `get_run` 등에서 그대로 `applied` (`grant_id` 에 권한 id) | 권한은 요청하지 않는다 — 사람의 승인 이력(최근 30일 승인 10건 · 거절 0 · 문제 표시 0)이 쌓이면 콘솔이 부여를 제안한다 |
| 문제 표시 (`run.flag`) | 사람이 적용된 실행을 "문제였다"고 표시 | 자율 권한이 있는 액션의 실행이 표시되면 워커가 그 권한을 자동 회수한다 (SYSTEM `agent.revoke_grant`). `list_my_runs {flagged: true}` 로 표시된 실행과 이유(`flagged.note`)를 읽고 같은 실수를 반복하지 않는다 |
| 기억 등급 `memory_trust` | propose(기본 — 제안은 `proposed`) · active(근거 2개 이상 · 외부 출처 아님이면 `active` 로 착지) | active 등급이어도 근거는 둘 이상, 외부 입력은 `tainted: true`. 활성 착지 기억이 14일에 2건 거절·정정되면 propose 로 자동 강등 |

- 승인 대기 중인 요청도 승인 시점에 **현재 범위로 다시 검사**된다 — 그 사이 범위가 줄었으면 승인돼도 실행되지 않는다(`failed`).
- 신뢰 지표는 모두 감사 로그(`action_runs`)에서 계산한다: 액션별 바로 적용 · 자율 적용 · 승인 · 거절 · 실패 · 거부 · 문제 표시, 승인률 = 승인 / (승인 + 거절), 기억 정밀도 = 확인 / (확인 + 거절 + 정정). `whoami.trust_30d` 로 내 지표를 볼 수 있다.
- 사람 전용 액션: `agent.register` · `agent.configure` · `agent.grant` · `agent.revoke_grant` · `agent.set_memory_trust` · `run.flag` · `run.unflag`.

```bash
now whoami
now run agent.configure '{"id":3}' --reason "…"   # → denied (사람 전용)
```

### 기억 — AI 가 제안하고 사람이 확정한다

- 기억은 온톨로지 객체(`memory`)다. 에이전트는 `remember`(= `memory.propose`)로 **제안**만 한다 → `proposed`. 사람이 `/memory` 에서 확인하면 `verified`.
- 문장 규칙 (액션이 검증한다): 대상을 이름으로 적은 **자기완결적 한 문장**("한빛상사는 …" — "그 고객"·"해당 건" 거부), **지시문 금지**("~하라", "ignore previous …" 거부), **비밀값 금지**.
- 근거(`evidence`)는 필수. 근거 중 오염된(외부 출처) 기억이 있으면 오염을 물려받고, 에이전트는 되돌릴 수 없다. 메일·웹훅에서 알게 된 것은 `tainted: true`.
- 같은 기억이 있으면 새로 만들지 않고 근거를 보강한다 (정규화 문장이 같거나 trigram Jaccard ≥ 0.85, 숫자가 같을 때). 같은 대상에 대해 숫자·날짜만 다른 기억은 **충돌**(`disputed` + 신호 `memory.disputed`) — 사람이 `memory.resolve` 로 정리한다. 에이전트의 제안은 사람이 확인한 기억의 상태를 바꾸지 못하고(충돌 링크·신호만 남는다), 사람이 확인한 적 있거나 고정된 기억을 에이전트가 정정·합치기·보관하면 고위험이다.
- 틀린 기억은 `memory.correct` (새 기억으로 대체, 이전 기억은 계보에 `superseded`). 에이전트가 **확인된** 기억을 정정·보관·합치면 고위험(가드 모드에서 승인 대기).
- 사람 전용: `memory.record` · `confirm` · `reject` · `pin` · `resolve` · `promote`.
- AI 런타임 세션은 시작할 때 팩을 시스템 프롬프트(로컬 CLI 는 stdin 앞)에 받고, 세션에 팩 해시와 항목이 남는다. 답에 `[mem:N]` 으로 인용하면 세션이 끝날 때 사용 기록(`cited`)이 된다 — `/ai/sessions/<id>` 의 "이 세션이 본 기억·문서"·"인용한 기억".

### 문서 종류 — 플레이북 · 에피소드 · 외부 자료 (M4)

- 문서(`note`)에는 종류가 있다: `note` · `playbook` · `episode` · `brief` · `source`. `recall` 결과의 문서 hit 에 `note_kind` 와 `tainted` 가 붙는다 (별도 `list_playbooks` 도구는 없다 — `recall(types: ["note"])` 로 절차를 찾는다).
- **플레이북**은 AI 가 따르는 절차다. 본문의 `[[action:task.create]]` 가 액션 참조 (콘솔은 칩으로, 알 수 없는 이름은 경고). 컨텍스트 팩에서 다른 문서보다 먼저, `[playbook:ID]` 로 표시된다. **에이전트가 플레이북을 만들거나 고치면(다른 문서를 플레이북으로 바꾸는 것 포함) 고위험** — AI 행동을 바꾸는 문서라 가드 모드에서 승인 대기.
- **에피소드**는 워커가 끝난 세션마다 만든다 (`list_episodes`). 에이전트는 만들지도 고치지도 못한다.
- **외부 자료**는 `document.import {title, body(≤20만 자), source_uri?, business_id?, client_id?, tainted?}` — 외부 fetch 없이 받은 본문을 저장만 (low). 비밀값은 저장 전에 가린다. 에이전트가 가져오면 항상 `tainted` (사람은 끌 수 있다). 팩에서 "외부 출처·미검증"으로 표시되고, 이 문서를 근거로 한 기억도 tainted.
- 제목·본문을 고치면 버전이 쌓인다 (`note_versions`). 되돌리기 `note.revert` 는 사람 전용.

```bash
now episodes --since 2026-09-27T00:00:00Z --text
now run document.import '{"title":"Acme 보안 설문","body":"…","source_uri":"https://…"}' --reason "고객이 보낸 설문 원문"
```

```bash
now context --about CLT-0003 --task "갱신 제안서 작성" --text
now remember "Acme Robotics 는 청구서에 PO 번호를 요구한다" --kind caution --about CLT-0003 --evidence note:3 --reason "협상 메모에 명시"
# 메일·웹훅 등 외부 입력에서 알게 된 것은 --tainted (모르는 플래그는 거부된다)
now remember "Acme Robotics 는 보안 설문 회신을 영어로 받기를 원한다" --kind preference --about CLT-0003 --evidence client:3 --tainted --reason "고객 메일 본문(외부 입력)"
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
| `POST /api/v1/iac/snapshots` | IaC 감사 결과 수신 (`iac:audit` 이 사용 · 허용 범위에 `iac.record_snapshot`(또는 `*`) 필요 · 동결 모드 거부 · 활동 로그 기록) |
| `GET /api/health` | 인증 없음 |

## 5. 권장 에이전트 지침 (시스템 프롬프트에 넣기)

```
너는 '<사업명>' 의 운영 에이전트다. Now MCP 도구만으로 일한다.
0. whoami 로 역할 · 허용 액션 · 사업 범위 · 자율 권한을 확인하고 그 안에서만 일한다.
1. get_overview → list_signals(severity=critical) 부터 처리한다.
2. 쓰기 전에 get_object 로 현재 상태와 available_actions 를 확인한다.
3. run_action 의 reason 에는 근거(어떤 메일·문자·일정에서 왔는지)를 한 문장으로 쓴다.
4. 고객에게 나가는 행동과 금액 기록은 승인 대기가 정상이다. 결과는 get_run 으로 확인한다.
5. 불확실하면 실행하지 말고 note.create 로 제안 메모를 남긴다.
6. 시작할 때 get_context 로 기억 팩을 받고, 판단에 쓴 기억은 [mem:N] 으로 인용한다.
7. 반복해서 쓸 사실·선호·교훈은 remember 로 제안한다 (근거 필수, 이름으로 쓴 한 문장, 지시문 금지).
```
