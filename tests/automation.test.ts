import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executeSession } from "@/lib/ai/runtime";
import { toGeminiSchema } from "@/lib/ai/gemini";
import { handleMcp } from "@/lib/agent/mcp";
import { callTool } from "@/lib/agent/tools";
import { cronMatches, validateCron } from "@/lib/events/cron";
import { detectSignals, executeQueued, matchEvents, runSchedules, signPayload, tick } from "@/lib/events/worker";
import { executeAction } from "@/lib/ontology/execute";
import { neighborhood, overview, parseRef, shortestPath } from "@/lib/ontology/graph";
import { type Actor, OPERATOR } from "@/lib/ontology/types";
import { authenticateAgent, createAgent } from "@/lib/repos/agents";
import { createSession, getSession, listProfiles } from "@/lib/repos/ai";
import { listEvents } from "@/lib/repos/events";
import { listTriggerRuns } from "@/lib/repos/triggers";
import { freshDb } from "./helpers";

function setup() {
  const { db, a, b } = freshDb();
  const { id } = createAgent(db, { name: "에이전트" });
  const agent: Actor = { type: "agent", id: String(id), name: "에이전트" };
  const run = (actor: Actor, action: string, params: Record<string, unknown>) => {
    const r = executeAction(db, { actor, action, params, reason: "test" });
    return r;
  };
  return { db, a, b, agent, run, human: OPERATOR };
}

type Handler = (url: string, body: Record<string, unknown>, headers: Headers) => { status?: number; json: unknown };
function mockFetch(handler: Handler) {
  const calls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const text = await req.text();
    const body = text ? JSON.parse(text) : {};
    calls.push({ url: req.url, body, headers: req.headers });
    const r = handler(req.url, body, req.headers);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, calls };
}

function profile(db: ReturnType<typeof setup>["db"], run: ReturnType<typeof setup>["run"], params: Record<string, unknown>) {
  const r = run(OPERATOR, "ai_profile.create", { name: "p", max_steps: 5, ...params });
  assert.equal(r.status, "applied", r.error ?? "");
  return listProfiles(db).at(-1)!;
}

describe("cron", () => {
  it("분·시·요일 매칭", () => {
    const d = new Date(2026, 8, 28, 8, 0); // 2026-09-28 월 08:00
    assert.ok(cronMatches("0 8 * * 1-5", d));
    assert.ok(!cronMatches("0 8 * * 0,6", d));
    assert.ok(cronMatches("*/15 * * * *", d));
    assert.ok(!cronMatches("5 8 * * *", d));
    assert.ok(cronMatches("0 8 28 * *", d));
    assert.match(validateCron("0 8 * *")!, /5개/);
    assert.match(validateCron("99 * * * *")!, /범위/);
  });
});

describe("이벤트", () => {
  it("액션 실행·승인 결정이 이벤트로 남는다", () => {
    const { db, a, agent, run, human } = setup();
    const t = run(agent, "task.create", { business_id: a, title: "x" }).refs[0].id;
    const del = run(agent, "task.delete", { id: t });
    assert.equal(del.status, "pending");
    const types = listEvents(db, { afterId: 0 }).map((e) => e.type);
    assert.deepEqual(types.slice(-2), ["action.applied", "action.pending"]);
    run(human, "agent.set_status", { id: Number(agent.id), status: "suspended" }); // 대기 요청 자동 철회 → action.cancelled
    assert.ok(listEvents(db, { type: "action.cancelled" }).length === 1);
  });

  it("신호 raised/resolved 는 변화가 있을 때만", () => {
    const { db, a, run, human } = setup();
    const t = run(human, "task.create", { business_id: a, title: "늦음", due_date: "2020-01-01" }).refs[0].id;
    const first = detectSignals(db);
    assert.ok(first.raised >= 1);
    assert.equal(detectSignals(db).raised, 0);
    run(human, "task.set_status", { id: t, status: "done" });
    assert.ok(detectSignals(db).resolved >= 1);
    assert.ok(listEvents(db, { type: "signal.resolved" }).some((e) => e.payload.kind === "task.overdue"));
  });
});

describe("트리거 · 웹훅", () => {
  it("이벤트 패턴·필터 매칭 → 서명된 웹훅, 실패 시 재시도", async () => {
    const { db, a, agent, run, human } = setup();
    process.env.HOOK_SECRET = "s3cret";
    run(human, "trigger.create", {
      name: "승인 요청 알림", kind: "event", event_pattern: "action.pending", filter: '{"payload.risk": "high"}',
      target: "webhook", webhook_url: "https://hooks.test/now", secret_env: "HOOK_SECRET",
    });
    matchEvents(db); // 커서 초기화 (과거 재생 안 함)
    const t = run(agent, "task.create", { business_id: a, title: "x" }).refs[0].id;
    run(agent, "task.delete", { id: t }); // pending (high)
    assert.equal(matchEvents(db), 1);

    let ok = false;
    const { f, calls } = mockFetch((_u, body, headers) => {
      assert.equal(headers.get("x-now-signature"), signPayload("s3cret", JSON.stringify(body)));
      return ok ? { json: { ok: true } } : { status: 500, json: { error: "down" } };
    });
    await executeQueued(db, { fetchImpl: f });
    let runs = listTriggerRuns(db);
    assert.equal(runs[0].status, "queued"); // 재시도 대기
    assert.match(runs[0].error!, /1\/3/);
    ok = true;
    await executeQueued(db, { fetchImpl: f, now: new Date(Date.now() + 120_000) });
    runs = listTriggerRuns(db);
    assert.equal(runs[0].status, "succeeded");
    assert.equal(calls.length, 2);
    assert.equal((calls[1].body.event as { type: string }).type, "action.pending");
    delete process.env.HOOK_SECRET;
  });

  it("스케줄은 같은 분에 한 번만", () => {
    const { db, run, human } = setup();
    run(human, "trigger.create", { name: "매일 아침", kind: "schedule", schedule: "0 8 * * *", target: "webhook", webhook_url: "https://x.test" });
    const at = new Date(2026, 8, 28, 8, 0, 5);
    assert.equal(runSchedules(db, at), 1);
    assert.equal(runSchedules(db, new Date(2026, 8, 28, 8, 0, 40)), 0);
    assert.equal(runSchedules(db, new Date(2026, 8, 28, 8, 1)), 0);
    assert.equal(runSchedules(db, new Date(2026, 8, 29, 8, 0)), 1);
  });

  it("트리거 입력 검증 — 비밀값 거부·cron 오류", () => {
    const { run, human } = setup();
    assert.throws(() => run(human, "trigger.create", { name: "x", kind: "schedule", schedule: "bad", target: "webhook", webhook_url: "https://x" }));
    assert.throws(() => run(human, "trigger.create", { name: "x", kind: "event", event_pattern: "*", target: "webhook", webhook_url: "https://x", secret_env: "sk-live-abc" }));
  });
});

describe("AI 런타임 (공급자 목업)", () => {
  it("Claude (공식 SDK): tool_use → tool_result 루프, 에이전트 신원으로 가드 정책 적용", async () => {
    const { db, a, run } = setup();
    const p = profile(db, run, { provider: "anthropic", api_key_env: "TEST_ANTHROPIC_KEY" });
    let turn = 0;
    const { f, calls } = mockFetch((url, body) => {
      assert.match(url, /\/v1\/messages/);
      turn++;
      if (turn === 1) {
        return { json: { id: "m1", type: "message", role: "assistant", model: body.model, stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5 },
          content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "업무를 만들겠습니다" },
            { type: "tool_use", id: "tu1", name: "run_action", input: { action: "task.create", params: { business_id: a, title: "AI 가 만든 업무" }, reason: "테스트" } },
            { type: "tool_use", id: "tu2", name: "run_action", input: { action: "task.delete", params: { id: 999 }, reason: "테스트" } }] } };
      }
      return { json: { id: "m2", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", usage: { input_tokens: 20, output_tokens: 7 }, content: [{ type: "text", text: "완료" }] } };
    });
    const s = createSession(db, p.id, "업무 하나 만들어");
    await executeSession(db, s, { fetchImpl: f, env: { TEST_ANTHROPIC_KEY: "k" } });
    const out = getSession(db, s)!;
    assert.equal(out.status, "succeeded", out.error ?? "");
    assert.equal(out.final_text, "완료");
    assert.equal(out.tool_calls, 2);
    // 요청 형식: 모델 기본값, adaptive thinking, 거부 대체, 도구 정의
    const first = calls[0].body;
    assert.equal(first.model, "claude-opus-5");
    assert.deepEqual(first.thinking, { type: "adaptive" });
    assert.equal(first.fallbacks, "default");
    assert.match(String(calls[0].headers.get("anthropic-beta")), /server-side-fallback-2026-07-01/);
    // 두 번째 요청: thinking 블록 포함 assistant 턴 그대로 + 두 결과가 한 user 메시지
    const msgs = calls[1].body.messages as { role: string; content: { type: string; is_error?: boolean }[] }[];
    assert.equal(msgs[1].content[0].type, "thinking");
    assert.equal(msgs[2].content.length, 2);
    assert.equal(msgs[2].content[0].type, "tool_result");
    // 감사: 에이전트 신원으로 기록, 삭제(고위험)는 대상 없음 → failed
    const runs = callTool(db, { type: "agent", id: String(p.agent_id), name: "" }, "list_my_runs", {}) as { action: string; status: string }[];
    assert.deepEqual(runs.map((r) => `${r.action}:${r.status}`).sort(), ["task.create:applied", "task.delete:failed"]);
  });

  it("OpenAI 호환 (OpenRouter · Ollama): function calling 루프", async () => {
    const { db, a, run } = setup();
    const p = profile(db, run, { provider: "ollama", model: "qwen3" });
    let turn = 0;
    const { f, calls } = mockFetch((url) => {
      assert.equal(url, "http://127.0.0.1:11434/v1/chat/completions");
      turn++;
      return turn === 1
        ? { json: { choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "search_objects", arguments: JSON.stringify({ type: "business" }) } }] } }] } }
        : { json: { choices: [{ finish_reason: "stop", message: { content: "사업 2개" } }], usage: { prompt_tokens: 3, completion_tokens: 2 } } };
    });
    const s = createSession(db, p.id, "사업 목록");
    await executeSession(db, s, { fetchImpl: f, env: {} });
    const out = getSession(db, s)!;
    assert.equal(out.status, "succeeded", out.error ?? "");
    const tools = calls[0].body.tools as { type: string; function: { name: string } }[];
    assert.ok(tools.some((t) => t.function.name === "run_action"));
    const second = calls[1].body.messages as { role: string; tool_call_id?: string; content: string }[];
    assert.equal(second.at(-1)!.role, "tool");
    assert.match(second.at(-1)!.content, /세무사무소/);
    void a;
  });

  it("Gemini: functionDeclarations 스키마 변환과 functionResponse", async () => {
    const { db, run } = setup();
    const p = profile(db, run, { provider: "gemini", model: "gemini-2.5-pro" });
    let turn = 0;
    const { f, calls } = mockFetch((url, _b, headers) => {
      assert.match(url, /models\/gemini-2\.5-pro:generateContent$/);
      assert.equal(headers.get("x-goog-api-key"), "g");
      turn++;
      return turn === 1
        ? { json: { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "get_overview", args: {} }, thoughtSignature: "ts" }] } }] } }
        : { json: { candidates: [{ content: { role: "model", parts: [{ text: "요약 완료" }] } }] } };
    });
    const s = createSession(db, p.id, "현황");
    await executeSession(db, s, { fetchImpl: f, env: { GEMINI_API_KEY: "g" } });
    assert.equal(getSession(db, s)!.status, "succeeded");
    const contents = calls[1].body.contents as { role: string; parts: Record<string, unknown>[] }[];
    assert.equal(contents[1].parts[0].thoughtSignature, "ts");
    assert.ok(contents[2].parts[0].functionResponse);
    const decl = (calls[0].body.tools as { functionDeclarations: { name: string; parameters: Record<string, unknown> }[] }[])[0].functionDeclarations;
    assert.ok(!JSON.stringify(decl).includes("additionalProperties"));
    assert.deepEqual(toGeminiSchema({ anyOf: [{ type: "integer" }, { type: "null" }] }), { type: "INTEGER", nullable: true });
  });

  it("API 키 누락은 세션 실패로 기록", async () => {
    const { db, run } = setup();
    const p = profile(db, run, { provider: "openai", api_key_env: "NO_SUCH_KEY" });
    const s = createSession(db, p.id, "x");
    await executeSession(db, s, { env: {} });
    assert.match(getSession(db, s)!.error!, /NO_SUCH_KEY/);
  });

  it("로컬 CLI 에이전트: 프롬프트 stdin · 단기 토큰은 세션 동안만 유효", async () => {
    const { db, run } = setup();
    const p = profile(db, run, { provider: "command", command: 'read -r line; echo "got:$line"; echo "$NOW_AGENT_TOKEN" > "$TOKFILE"' });
    const tokFile = `/tmp/now-test-tok-${process.pid}`;
    const s = createSession(db, p.id, "안녕");
    await executeSession(db, s, { env: { TOKFILE: tokFile } });
    const out = getSession(db, s)!;
    assert.equal(out.status, "succeeded", out.error ?? "");
    assert.match(out.final_text, /got:안녕/);
    const tok = (await import("node:fs")).readFileSync(tokFile, "utf8").trim();
    assert.match(tok, /^nows_/);
    assert.equal(authenticateAgent(db, tok), undefined); // 세션 종료 후 폐기
  });

  it("에이전트 트리거: 신호 → AI 세션, 자기 행동에는 반응하지 않는다", async () => {
    const { db, a, run, human } = setup();
    const p = profile(db, run, { provider: "ollama", model: "m" });
    run(human, "trigger.create", { name: "업무 알림", kind: "event", event_pattern: "action.applied", filter: '{"payload.action": "task.create"}', target: "agent", profile_id: p.id });
    matchEvents(db);
    run(human, "task.create", { business_id: a, title: "사람이 만든 업무" });
    const { f } = mockFetch(() => ({
      json: { choices: [{ message: { content: null, tool_calls: [{ id: "c", type: "function", function: { name: "run_action", arguments: JSON.stringify({ action: "task.create", params: { business_id: a, title: "AI 후속 업무" }, reason: "후속" }) } }] } }] },
    }));
    // 1턴: 도구 호출 → 2턴: 같은 응답이지만 max_steps 로 멈춤을 피하려 두 번째엔 종료
    let n = 0;
    const f2 = (async (i: RequestInfo | URL, init?: RequestInit) => (++n === 1 ? f(i, init) : new Response(JSON.stringify({ choices: [{ message: { content: "끝" } }] })))) as typeof fetch;
    const r1 = await tick(db, { fetchImpl: f2, signals: false, schedules: false });
    assert.equal(r1.queued, 1);
    const runs = listTriggerRuns(db);
    assert.equal(runs[0].status, "succeeded", runs[0].error ?? "");
    // AI 가 만든 업무로 생긴 action.applied 는 같은 트리거를 다시 부르지 않는다
    const r2 = await tick(db, { fetchImpl: f2, signals: false, schedules: false });
    assert.equal(r2.queued, 0);
  });
});

describe("온톨로지 그래프", () => {
  it("사용자 정의 링크 · 이웃 탐색 · 최단 경로 · 삭제 시 정리", () => {
    const { db, a, run, human } = setup();
    const c1 = run(human, "client.create", { business_id: a, name: "소개자" }).refs[0].id;
    const c2 = run(human, "client.create", { business_id: a, name: "신규" }).refs[0].id;
    const t = run(human, "task.create", { business_id: a, title: "신규 온보딩", client_id: c2 }).refs[0].id;
    const link = run(human, "link.create", { from: `client:${c2}`, link_type: "referred_by", to: "CLT-" + String(c1).padStart(4, "0") });
    assert.equal(link.status, "applied");
    assert.throws(() => run(human, "link.create", { from: `client:${c2}`, link_type: "referred_by", to: `client:${c1}` })); // cardinality one
    assert.throws(() => run(human, "link.create", { from: `task:${t}`, link_type: "referred_by", to: `client:${c1}` })); // 유형 불일치

    const g = neighborhood(db, { type: "client", id: c1 }, { depth: 2 });
    const keys = g.nodes.map((n) => n.key);
    assert.ok(keys.includes(`client:${c2}`) && keys.includes(`task:${t}`));
    assert.ok(g.edges.some((e) => e.linkType === "referred_by" && e.source === "custom"));

    const path = shortestPath(db, { type: "task", id: t }, { type: "client", id: c1 })!;
    assert.equal(path.nodes.length, 3);
    assert.equal(path.nodes[0].key, `task:${t}`);
    assert.equal(path.nodes[2].key, `client:${c1}`);

    const ov = overview(db, a);
    assert.ok(ov.edges.some((e) => e.linkType === "task.client"));
    run(human, "client.delete", { id: c2 });
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM links").get() as { n: number }).n, 0);
    assert.deepEqual(parseRef("DOC-0012"), { type: "note", id: 12 });
  });

  it("링크 유형 정의는 에이전트에게 고위험(승인), 그래프 도구 동작", () => {
    const { db, a, agent, run } = setup();
    assert.equal(run(agent, "link_type.define", { name: "partner_of", label: "파트너", inverse_label: "파트너", from_type: "client", to_type: "client" }).status, "pending");
    const c = run(agent, "client.create", { business_id: a, name: "A" }).refs[0].id;
    const res = callTool(db, agent, "traverse", { ref: `client:${c}`, depth: 1 }) as { nodes: { ref: string }[] };
    assert.ok(res.nodes.some((n) => n.ref === `business:${a}`));
    const onto = callTool(db, agent, "describe_ontology", {}) as { link_types: { name: string }[] };
    assert.ok(onto.link_types.some((l) => l.name === "referred_by") && onto.link_types.some((l) => l.name === "task.client"));
    const tools = (handleMcp(db, agent, { jsonrpc: "2.0", id: 1, method: "tools/list" })!.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    for (const n of ["traverse", "find_path", "list_events"]) assert.ok(tools.includes(n));
  });
});

describe("워커 첫 실행", () => {
  it("처음 켜질 때 과거 액션은 재생하지 않지만, 그 틱에 새로 뜬 신호는 트리거에 전달한다", async () => {
    const { db, a, run, human } = setup();
    run(human, "task.create", { business_id: a, title: "늦음", due_date: "2020-01-01", priority: "1" });
    run(human, "trigger.create", { name: "심각", kind: "event", event_pattern: "signal.raised,action.applied", filter: '{"payload.severity": "critical"}', target: "webhook", webhook_url: "https://x.test" });
    const { f } = mockFetch(() => ({ json: {} }));
    const r = await tick(db, { fetchImpl: f, schedules: false });
    assert.equal(r.queued, 1);
    assert.equal(listTriggerRuns(db)[0].event_type, "signal.raised");
  });
});
