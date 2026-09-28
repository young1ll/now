#!/usr/bin/env node
// now — Now Business OS 명령줄 클라이언트. 셸을 쓸 수 있는 모든 AI(Codex CLI · Gemini CLI · aider · 로컬 LLM 에이전트)와 사람이 쓴다.
// 의존성 없음 (Node 18+). 접속: NOW_URL (기본 http://127.0.0.1:3000), NOW_AGENT_TOKEN (에이전트 토큰).
const HELP = `now — Now 사업 운영 체제 CLI (에이전트용)

환경변수  NOW_URL=http://127.0.0.1:3000   NOW_AGENT_TOKEN=now_…

읽기
  now overview [--business N]            운영 현황 (먼저 호출)
  now signals [--severity critical]      주의가 필요한 상태 = 할 일 큐 (제안 액션 포함)
  now ontology                           객체 유형 · 속성 · 링크 유형 · 액션
  now recall <자연어 질의> [--about ref] [--k 10]   내용·관계를 함께 보는 회상 검색 (찾을 때 먼저)
  now search <type> [검색어]             type: client task invoice expense note business agent memory
  now get <ref>                          객체 상세 (ref: client:3 또는 CLT-0003)
  now traverse <ref> [--depth 2]         그래프 이웃
  now path <ref> <ref>                   두 객체 사이 관계 경로
  now actions [type]                     실행 가능한 액션과 입력 스키마
  now events [--after ID] [--type signal.] [--follow]   이벤트 로그 / 실시간 구독

기억 (AI 가 제안하고 사람이 확인한다)
  now context [--about ref,ref] [--task "하려는 일"] [--budget 2000]   작업용 기억·문서 팩 (<memory-context> 데이터)
  now remember "<문장>" --kind fact --about ref --evidence ref[,ref] --reason "근거"
      kind: fact 사실 · preference 선호 · lesson 교훈 · procedure_hint 절차 힌트 · caution 주의
      문장은 대상을 이름으로 쓴 한 문장 ("한빛상사는 …"), 지시문·비밀값 금지. evidence 1개 이상 필수
  now memories [--status proposed,active] [--kind fact] [--about ref]   기억 목록
  now cite <기억 id…>                     팩 밖에서 찾아 쓴 기억의 사용 기록 (답에는 [mem:N] 으로 인용)

쓰기 (정책·승인·감사를 거친다)
  now run <action> '<params JSON>' --reason "근거"
      예) now run task.create '{"business_id":1,"title":"원천세 신고","due_date":"2026-10-10"}' --reason "월간 반복"
      결과 status: applied · pending(사람 승인 대기) · failed · denied
  now runs [--status pending]            내 실행 기록
  now run-status <run_id>                승인 결과 확인
  now cancel <run_id>                    승인 대기 철회

기타
  now tools                              모든 도구 이름
  now call <tool> '<args JSON>'          임의 도구 호출
  --text                                 JSON 대신 사람이 읽기 쉬운 출력
`;

const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--") && !["follow", "text", "help"].includes(k)) (flags[k] = next), i++;
    else flags[k] = true;
  } else pos.push(a);
}

const BASE = (process.env.NOW_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const TOKEN = process.env.NOW_AGENT_TOKEN || "";
const num = (v) => (v === undefined || v === true ? undefined : Number(v));
const list = (v) => (v === undefined || v === true ? undefined : String(v).split(",").map((x) => x.trim()).filter(Boolean));

function die(msg, code = 1) {
  process.stderr.write(`now: ${msg}\n`);
  process.exit(code);
}

async function call(tool, args = {}) {
  if (!TOKEN) die("NOW_AGENT_TOKEN 이 필요합니다 (콘솔 /agents 에서 발급)");
  let res;
  try {
    res = await fetch(`${BASE}/api/v1/tools/${tool}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(args),
    });
  } catch (e) {
    die(`${BASE} 에 연결할 수 없습니다 (${e.cause?.code ?? e.message})`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) die(body.error ?? `HTTP ${res.status}`, res.status === 401 || res.status === 403 ? 3 : 2);
  return body;
}

function parseJson(s, what) {
  if (s === undefined) return {};
  try {
    return JSON.parse(s);
  } catch {
    die(`${what} 가 올바른 JSON 이 아닙니다: ${s}`);
  }
}

function print(data) {
  if (!flags.text) return console.log(JSON.stringify(data, null, 2));
  if (Array.isArray(data)) return data.forEach((d) => print(d));
  if (data?.signals || data?.events) return print(data.signals ?? data.events);
  if (data && typeof data === "object") {
    if ("severity" in data && "title" in data) return console.log(`[${data.severity}] ${data.title}${data.displayId ? ` (${data.displayId})` : ""}`);
    if ("display_id" in data && "title" in data) return console.log(`${data.display_id}\t${data.status ?? ""}\t${data.title}`);
    if ("display_id" in data && "statement" in data) return console.log(`${data.display_id}\t${data.status}\t${data.statement}`);
    if (typeof data.text === "string" && "hash" in data && "items" in data) return console.log(data.text || "(팩 없음 — 관련 기억·문서가 없습니다)");
    if ("run_id" in data) return console.log(`RUN ${data.run_id}\t${data.status}\t${data.action}\t${data.summary ?? data.error ?? ""}`);
    if ("type" in data && "created_at" in data && "payload" in data) return console.log(`${data.id}\t${data.created_at}\t${data.type}\t${data.payload.summary ?? data.payload.title ?? ""}`);
  }
  console.log(JSON.stringify(data, null, 2));
}

async function follow() {
  if (!TOKEN) die("NOW_AGENT_TOKEN 이 필요합니다");
  const q = new URLSearchParams();
  if (flags.after) q.set("after", flags.after);
  if (flags.type) q.set("type", flags.type);
  const res = await fetch(`${BASE}/api/v1/events/stream?${q}`, { headers: { authorization: `Bearer ${TOKEN}` } }).catch((e) => die(e.message));
  if (!res.ok) die(`HTTP ${res.status}`);
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block.split("\n").find((l) => l.startsWith("data: "));
      if (data) print(JSON.parse(data.slice(6)));
    }
  }
}

const [cmd, a1, a2] = pos;
const commands = {
  overview: () => call("get_overview", { business_id: num(flags.business) }),
  signals: async () => call("list_signals", { business_id: num(flags.business), severity: flags.severity }),
  ontology: () => call("describe_ontology"),
  recall: () => {
    const query = pos.slice(1).join(" ");
    if (!query) die("질의가 필요합니다");
    return call("recall", { query, about: flags.about, k: num(flags.k), business_id: num(flags.business) });
  },
  search: () => call("search_objects", { type: a1, query: a2, business_id: num(flags.business), limit: num(flags.limit) }),
  get: () => {
    const m = String(a1 ?? "").match(/^([a-z]+):(\d+)$/);
    if (m) return call("get_object", { type: m[1], id: Number(m[2]) });
    return call("traverse", { ref: a1, depth: 1 }).then((g) => {
      const n = g.nodes?.[0];
      if (!n) die(`객체를 찾을 수 없습니다: ${a1}`);
      const [type, id] = n.ref.split(":");
      return call("get_object", { type, id: Number(id) });
    });
  },
  traverse: () => call("traverse", { ref: a1, depth: num(flags.depth) }),
  path: () => call("find_path", { from: a1, to: a2 }),
  actions: () => call("list_actions", { object_type: a1 }),
  events: () => (flags.follow ? follow() : call("list_events", { after_id: num(flags.after), type: flags.type, limit: num(flags.limit) })),
  context: () => call("get_context", { about: list(flags.about), task: flags.task === true ? undefined : flags.task, budget_tokens: num(flags.budget), business_id: num(flags.business) }),
  remember: () => {
    if (!a1) die('문장이 필요합니다: now remember "<문장>" --kind fact --evidence ref --reason "근거"');
    if (!flags.reason) die('--reason "근거" 가 필요합니다');
    if (!flags.evidence) die("--evidence ref 가 필요합니다 (근거 객체 1개 이상)");
    return call("remember", {
      statement: a1,
      kind: flags.kind === undefined || flags.kind === true ? "fact" : flags.kind,
      about: list(flags.about),
      evidence: list(flags.evidence),
      confidence: num(flags.confidence),
      contradicts: list(flags.contradicts)?.map(Number),
      reason: flags.reason,
    });
  },
  memories: () => call("list_memories", { status: list(flags.status), kind: flags.kind === true ? undefined : flags.kind, about: flags.about === true ? undefined : flags.about, business_id: num(flags.business), limit: num(flags.limit) }),
  cite: () => {
    const ids = pos.slice(1).flatMap((x) => x.split(",")).map((x) => Number(String(x).replace(/^(mem:|MEM-0*)/i, ""))).filter((n) => n > 0);
    if (!ids.length) die("기억 id 가 필요합니다: now cite 12 15");
    return call("cite", { memory_ids: ids });
  },
  run: () => {
    if (!a1) die("액션 이름이 필요합니다");
    if (!flags.reason) die('--reason "근거" 가 필요합니다');
    return call("run_action", { action: a1, params: parseJson(a2, "params"), reason: flags.reason });
  },
  runs: () => call("list_my_runs", { status: flags.status, limit: num(flags.limit) }),
  "run-status": () => call("get_run", { run_id: Number(a1) }),
  cancel: () => call("cancel_run", { run_id: Number(a1) }),
  tools: async () => {
    const spec = await fetch(`${BASE}/api/v1/openapi.json`).then((r) => r.json()).catch((e) => die(e.message));
    return Object.values(spec.paths).map((p) => ({ name: p.post.operationId, description: p.post.summary }));
  },
  call: () => call(a1, parseJson(a2, "args")),
};

if (!cmd || flags.help || cmd === "help") {
  console.log(HELP);
  process.exit(0);
}
if (!commands[cmd]) die(`알 수 없는 명령: ${cmd} (now --help)`);
const out = await commands[cmd]();
if (out !== undefined) {
  print(out);
  // 쓰기 결과는 종료 코드로도 알린다: 0 applied · 10 pending · 11 failed · 12 denied
  if (cmd === "run" || cmd === "remember") process.exit({ applied: 0, pending: 10, failed: 11, denied: 12 }[out.status] ?? 0);
}
