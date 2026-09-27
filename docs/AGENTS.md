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
| `search_objects` / `get_object` | 읽기 (속성·raw·연결·이력·현재 가능한 액션) |
| `list_actions` | 액션 카탈로그 + 입력 JSON Schema (사람 전용 액션 제외) |
| `run_action` | 실행. `reason` 필수 — 승인자와 감사 로그에 보인다 |
| `get_run` / `list_my_runs` / `cancel_run` | 승인 대기 결과 확인·철회 |
| `traverse` / `find_path` | 그래프: 이웃(1~4단계) · 두 객체 사이 관계 경로 |
| `list_events` | 이벤트 로그 (after_id 로 이어 읽기). 실시간은 SSE `/api/v1/events/stream` |

`run_action` 결과 `status`:
- `applied` 적용 · `pending` 사람 승인 대기 (get_run 으로 확인) · `failed` 입력/규칙 오류 (error 확인 후 수정) · `denied` 정책 거부 (사람에게 요청)

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
```
