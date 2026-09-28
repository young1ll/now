import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "@/lib/db";
import { describe, it } from "node:test";
import { handleMcp } from "@/lib/agent/mcp";
import { callTool } from "@/lib/agent/tools";
import { authenticate } from "@/lib/agent/auth";
import { parseChanges, parseState } from "@/lib/iac";
import { ACTION_LIST } from "@/lib/ontology/actions";
import { jsonSchemaOf } from "@/lib/ontology/action";
import { approveRun, cancelRun, executeAction, rejectRun } from "@/lib/ontology/execute";
import { OBJECTS } from "@/lib/ontology/objects";
import { computeSignals } from "@/lib/ontology/signals";
import { ActionError, type Actor, OPERATOR } from "@/lib/ontology/types";
import { createAgent } from "@/lib/repos/agents";
import { getInvoice } from "@/lib/repos/finance";
import { listRuns } from "@/lib/repos/runs";
import { setSetting } from "@/lib/repos/settings";
import { getTask } from "@/lib/repos/tasks";
import { freshDb } from "./helpers";

function setup() {
  const { db, a, b } = freshDb();
  const { id, token } = createAgent(db, { name: "테스트 에이전트" });
  const agent: Actor = { type: "agent", id: String(id), name: "테스트 에이전트" };
  const human = OPERATOR;
  const run = (actor: Actor, action: string, params: Record<string, unknown>, reason = "테스트") =>
    executeAction(db, { actor, action, params, reason });
  return { db, a, b, agent, human, token, agentId: id, run };
}

describe("액션 카탈로그", () => {
  it("모든 액션이 JSON Schema 로 변환된다", () => {
    for (const a of ACTION_LIST) {
      const s = jsonSchemaOf(a);
      assert.equal(s.type, "object", a.name);
    }
    assert.ok(ACTION_LIST.length >= 20);
  });
});

describe("정책 · 실행 · 감사", () => {
  it("가드 모드: 저위험은 즉시 적용, 고위험은 승인 대기 → 승인 시 적용", () => {
    const { db, a, agent, human, run } = setup();
    const c = run(agent, "client.create", { business_id: a, name: "리드 A" });
    assert.equal(c.status, "applied");
    const clientId = c.refs.find((r) => r.type === "client")!.id;

    const inv = run(agent, "invoice.create", { business_id: a, client_id: clientId, items: [{ description: "자문", quantity: 1, unit_price: "1,000,000" }] });
    assert.equal(inv.status, "applied");
    const invoiceId = inv.refs.find((r) => r.type === "invoice")!.id;
    assert.equal(getInvoice(db, invoiceId)!.invoice.total, 1_100_000); // KRW 기본 부가세 10%

    const issue = run(agent, "invoice.issue", { id: invoiceId }, "월말 청구");
    assert.equal(issue.status, "pending");
    assert.equal(getInvoice(db, invoiceId)!.invoice.status, "draft");
    assert.match(issue.result!.summary, /발행/);

    const approved = approveRun(db, issue.id, human, "확인");
    assert.equal(approved.status, "applied");
    assert.equal(approved.decided_by, human.name);
    assert.equal(getInvoice(db, invoiceId)!.invoice.status, "sent");

    // 감사: 객체 기준 이력
    const hist = listRuns(db, { object: { type: "invoice", id: invoiceId } });
    assert.deepEqual(hist.map((r) => r.action), ["invoice.issue", "invoice.create"]);
  });

  it("거절·철회", () => {
    const { db, a, agent, human, run } = setup();
    const t = run(human, "task.create", { business_id: a, title: "삭제될 업무" });
    const taskId = t.refs[0].id;
    const del = run(agent, "task.delete", { id: taskId });
    assert.equal(del.status, "pending");
    assert.equal(rejectRun(db, del.id, human, "필요함").status, "rejected");
    assert.ok(getTask(db, taskId));
    assert.throws(() => approveRun(db, del.id, human), ActionError);

    const del2 = run(agent, "task.delete", { id: taskId });
    const other: Actor = { type: "agent", id: "999", name: "남" };
    assert.throws(() => cancelRun(db, del2.id, other), ActionError);
    assert.equal(cancelRun(db, del2.id, agent).status, "cancelled");
  });

  it("모드별: 동결은 거부, 감독은 전부 승인 대기, 자율은 즉시", () => {
    const { db, a, agent, run } = setup();
    setSetting(db, "ai_mode", "frozen");
    assert.equal(run(agent, "task.create", { business_id: a, title: "x" }).status, "denied");
    setSetting(db, "ai_mode", "supervised");
    assert.equal(run(agent, "task.create", { business_id: a, title: "x" }).status, "pending");
    setSetting(db, "ai_mode", "autonomous");
    assert.equal(run(agent, "expense.record", { business_id: a, description: "AWS", amount: 50000 }).status, "applied");
  });

  it("사람 전용 액션은 에이전트에게 거부된다", () => {
    const { agent, run } = setup();
    assert.equal(run(agent, "system.set_ai_mode", { mode: "autonomous" }).status, "denied");
    assert.equal(run(agent, "agent.register", { name: "x" }).status, "denied");
  });

  it("run 의 객체 참조는 기록 순서를 유지한다 (생성 객체가 먼저)", () => {
    const { a, human, run } = setup();
    const c = run(human, "client.create", { business_id: a, name: "순서" });
    assert.deepEqual(c.refs.map((r) => r.type), ["client", "business"]);
    const inv = run(human, "invoice.create", { business_id: a, client_id: c.refs[0].id, items: [{ description: "x", unit_price: 1 }] });
    assert.equal(inv.refs[0].type, "invoice");
  });

  it("백업 액션은 트랜잭션 밖에서 VACUUM INTO 로 실행되고, 에이전트도 쓸 수 있다", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "now-bk-"));
    process.env.NOW_DB_PATH = path.join(dir, "now.db");
    try {
      const { db, agent, run } = setup();
      const r = run(agent, "system.backup", {});
      assert.equal(r.status, "applied", r.error ?? "");
      const files = fs.readdirSync(path.join(dir, "backups"));
      assert.equal(files.length, 1);
      const copy = openDb(path.join(dir, "backups", files[0]));
      assert.equal((copy.prepare("SELECT COUNT(*) AS n FROM businesses").get() as { n: number }).n, 2);
      assert.ok(computeSignals(db, null).every((s) => s.kind !== "system.backup_stale"));
    } finally {
      delete process.env.NOW_DB_PATH;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("에이전트의 잘못된 입력은 failed 로 감사에 남고, 사람의 입력 오류는 예외로 돌려준다", () => {
    const { db, a, agent, human, run } = setup();
    const bad = run(agent, "task.create", { business_id: a });
    assert.equal(bad.status, "failed");
    assert.match(bad.error!, /업무명/);
    assert.equal(run(agent, "nope.action", {}).status, "failed");
    assert.equal(run(agent, "task.create", { business_id: a, title: "x", unknown_field: 1 }).status, "failed");
    const before = listRuns(db).length;
    assert.throws(() => run(human, "task.create", { business_id: a }), ActionError);
    assert.throws(() => run(human, "invoice.issue", { id: 999 }), ActionError);
    assert.equal(listRuns(db).length, before);
  });

  it("부분 수정: 넘긴 필드만 바뀌고 null 은 비운다", () => {
    const { db, a, human, run } = setup();
    const c = run(human, "client.create", { business_id: a, name: "고객" }).refs[0].id;
    const t = run(human, "task.create", { business_id: a, title: "원래", client_id: c, due_date: "2026-10-01", priority: "1" }).refs[0].id;
    run(human, "task.update", { id: t, title: "변경" });
    let task = getTask(db, t)!;
    assert.deepEqual([task.title, task.client_id, task.due_date, task.priority], ["변경", c, "2026-10-01", 1]);
    run(human, "task.update", { id: t, client_id: null, due_date: null });
    task = getTask(db, t)!;
    assert.deepEqual([task.client_id, task.due_date], [null, null]);
  });

  it("발행된 청구서의 수정은 고위험으로 격상된다", async () => {
    const { a, agent, human, run } = setup();
    const inv = run(human, "invoice.create", { business_id: a, items: [{ description: "x", unit_price: 1000 }] }).refs[0].id;
    assert.equal(run(agent, "invoice.update", { id: inv, items: [{ description: "y", unit_price: 2000 }] }).status, "applied");
    run(human, "invoice.issue", { id: inv });
    const r = run(agent, "invoice.update", { id: inv, items: [{ description: "z", unit_price: 1 }] });
    assert.equal(r.status, "pending");
    assert.equal(r.risk, "high");
  });

  it("에이전트 등록 토큰은 결과(out)로만 나오고 감사 기록엔 없다", async () => {
    const { db, human, run } = setup();
    const r = run(human, "agent.register", { name: "새 에이전트" });
    assert.match(String(r.out?.token), /^now_/);
    assert.doesNotMatch(JSON.stringify(listRuns(db, { action: "agent.register" })), /now_[A-Za-z0-9_-]{20}/);
    assert.equal(authenticate(db, `Bearer ${r.out!.token}`).ok, true);
    run(human, "agent.set_status", { id: r.refs[0].id, status: "suspended" });
    const again = authenticate(db, `Bearer ${r.out!.token}`);
    assert.equal(again.ok, false);
  });
});

describe("온톨로지 · 신호", () => {
  it("상태에 따라 가능한 액션만 노출한다", async () => {
    const { db, a, human, run } = setup();
    const inv = run(human, "invoice.create", { business_id: a, items: [{ description: "x", unit_price: 1000 }] }).refs[0].id;
    const acts = () => OBJECTS.invoice.actionsFor!(OBJECTS.invoice.get(db, inv)!.raw);
    assert.ok(acts().includes("invoice.issue"));
    run(human, "invoice.issue", { id: inv });
    assert.ok(!acts().includes("invoice.issue") && acts().includes("payment.record"));
    run(human, "payment.record", { invoice_id: inv });
    assert.deepEqual(acts(), ["invoice.update"]);
  });

  it("객체 조회·연결", async () => {
    const { db, a, human, run } = setup();
    const c = run(human, "client.create", { business_id: a, name: "한빛상사", status: "active" }).refs[0].id;
    run(human, "task.create", { business_id: a, title: "부가세", client_id: c });
    const d = OBJECTS.client.get(db, c)!;
    assert.equal(d.displayId, "CLT-0001");
    assert.ok(d.links.some((l) => l.ref.type === "task"));
    assert.ok(d.links.some((l) => l.ref.type === "business"));
    assert.equal(OBJECTS.client.list(db, a, "한빛").length, 1);
  });

  it("지연 업무·미수금·무응대 리드 신호와 제안 액션", async () => {
    const { db, a, human, run } = setup();
    run(human, "task.create", { business_id: a, title: "늦은 업무", due_date: "2026-09-01" });
    const c = run(human, "client.create", { business_id: a, name: "리드", status: "lead" }).refs[0].id;
    db.prepare("UPDATE clients SET created_at = '2026-09-01T00:00:00Z' WHERE id = ?").run(c);
    const inv = run(human, "invoice.create", { business_id: a, client_id: c, issue_date: "2026-08-01", due_date: "2026-08-15", items: [{ description: "x", unit_price: 1000 }] }).refs[0].id;
    run(human, "invoice.issue", { id: inv });
    const sig = computeSignals(db, a, "2026-09-27");
    const kinds = sig.map((s) => s.kind);
    assert.ok(kinds.includes("task.overdue"));
    assert.ok(kinds.includes("invoice.overdue"));
    assert.ok(kinds.includes("client.lead_idle"));
    assert.equal(sig[0].severity, "critical");
    const overdue = sig.find((s) => s.kind === "invoice.overdue")!;
    assert.ok(overdue.suggested.some((x) => x.action === "payment.record"));
  });
});

describe("MCP", () => {
  it("initialize → tools/list → tools/call(run_action) 흐름", async () => {
    const { db, a, agent } = setup();
    const init = (await handleMcp(db, agent, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }))!;
    assert.equal((init.result as { protocolVersion: string }).protocolVersion, "2025-06-18");
    assert.equal(await handleMcp(db, agent, { jsonrpc: "2.0", method: "notifications/initialized" }), null);

    const list = (await handleMcp(db, agent, { jsonrpc: "2.0", id: 2, method: "tools/list" }))!;
    const names = (list.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    assert.ok(names.includes("run_action") && names.includes("list_signals"));

    const call = (await handleMcp(db, agent, {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "run_action", arguments: { action: "task.create", params: { business_id: a, title: "MCP 업무" }, reason: "테스트" } },
    }))!;
    const res = call.result as { isError: boolean; structuredContent: { status: string } };
    assert.equal(res.isError, false);
    assert.equal(res.structuredContent.status, "applied");

    const bad = (await handleMcp(db, agent, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_object", arguments: { type: "task", id: 999 } } }))!;
    assert.equal((bad.result as { isError: boolean }).isError, true);
    assert.equal((await handleMcp(db, agent, { jsonrpc: "2.0", id: 5, method: "nope" }))!.error!.code, -32601);
  });

  it("list_actions 는 사람 전용 액션을 숨긴다", async () => {
    const { db, agent } = setup();
    const r = await callTool(db, agent, "list_actions", {}) as { actions: { name: string }[] };
    const names = r.actions.map((x) => x.name);
    for (const hidden of ["agent.register", "agent.set_status", "system.set_ai_mode"]) assert.ok(!names.includes(hidden), hidden);
    assert.ok(names.includes("system.backup"));
  });
});

describe("IaC 감사 파서", () => {
  it("state 에서 비밀값(env 값)을 제외하고 핵심 속성만 추린다", () => {
    const state = {
      values: {
        root_module: {
          resources: [
            {
              address: "docker_container.app", mode: "managed", type: "docker_container", name: "app",
              provider_name: "registry.opentofu.org/kreuzwerker/docker",
              values: {
                name: "now", image: "sha256:abcdef1234567890", restart: "unless-stopped", must_run: true,
                env: ["NOW_DB_PATH=/app/data/now.db", "SECRET_TOKEN=hunter2"],
                ports: [{ internal: 3000, external: 3000, ip: "127.0.0.1" }],
                volumes: [{ volume_name: "now-data", container_path: "/app/data" }],
              },
            },
            { address: "data.docker_image.app", mode: "data", type: "docker_image", name: "app", values: {} },
          ],
        },
      },
    };
    const [r] = parseState(state);
    assert.equal(parseState(state).length, 1);
    assert.equal(r.provider, "docker");
    assert.equal(r.attributes.ports, "127.0.0.1:3000→3000");
    assert.equal(r.attributes.env_keys, "NOW_DB_PATH, SECRET_TOKEN");
    assert.equal(r.attributes.image, "abcdef123456");
    assert.doesNotMatch(JSON.stringify(r), /hunter2/);
  });

  it("plan 에서 no-op 을 제외한 변경만", () => {
    const plan = {
      resource_changes: [
        { address: "docker_container.app", type: "docker_container", change: { actions: ["delete", "create"] } },
        { address: "docker_volume.data", type: "docker_volume", change: { actions: ["no-op"] } },
        { address: "data.docker_image.app", type: "docker_image", mode: "data", change: { actions: ["read"] } },
      ],
    };
    assert.deepEqual(parseChanges(plan), [{ address: "docker_container.app", type: "docker_container", actions: ["delete", "create"] }]);
  });
});

describe("리뷰 반영 — 거버넌스 회귀 테스트", () => {
  it("승인 대기 중 대상이 바뀌면 승인해도 실행되지 않는다", () => {
    const { db, a, agent, human, run } = setup();
    const inv = run(agent, "invoice.create", { business_id: a, items: [{ description: "x", unit_price: 100000 }] }).refs[0].id;
    const issue = run(agent, "invoice.issue", { id: inv });
    assert.equal(issue.status, "pending");
    run(agent, "invoice.update", { id: inv, items: [{ description: "x", unit_price: 99_000_000 }] }); // 저위험(초안)이라 즉시
    const r = approveRun(db, issue.id, human);
    assert.equal(r.status, "failed");
    assert.match(r.error!, /변경/);
    assert.equal(getInvoice(db, inv)!.invoice.status, "draft");
  });

  it("정지된 에이전트의 대기 요청은 자동 철회되고, 승인도 불가", () => {
    const { db, a, agent, agentId, human, run } = setup();
    const t = run(human, "task.create", { business_id: a, title: "t" }).refs[0].id;
    const del = run(agent, "task.delete", { id: t });
    run(human, "agent.set_status", { id: agentId, status: "suspended" });
    assert.equal(listRuns(db, { status: "pending" }).length, 0);
    assert.throws(() => approveRun(db, del.id, human), ActionError);
  });

  it("이름·제목을 빈 값으로 수정할 수 없다", () => {
    const { a, agent, human, run } = setup();
    const c = run(human, "client.create", { business_id: a, name: "A" }).refs[0].id;
    assert.equal(run(agent, "client.update", { id: c, name: "  " }).status, "failed");
  });

  it("음수 지출·초과 입금·다른 사업 고객 연결 거부", async () => {
    const { a, b, agent, human, run } = setup();
    assert.throws(() => run(human, "expense.record", { business_id: a, description: "x", amount: "-5000" }), ActionError);
    const inv = run(human, "invoice.create", { business_id: a, items: [{ description: "x", unit_price: 1000 }] }).refs[0].id;
    run(human, "invoice.issue", { id: inv });
    assert.throws(() => run(human, "payment.record", { invoice_id: inv, amount: 5_000_000 }), ActionError);
    const other = run(human, "client.create", { business_id: b, name: "B사" }).refs[0].id;
    assert.throws(() => run(human, "task.create", { business_id: a, title: "t", client_id: other }), ActionError);
    assert.equal(run(agent, "task.create", { business_id: a, title: "t", client_id: 999 }).status, "failed");
  });

  it("다른 에이전트의 run 은 조회할 수 없다", async () => {
    const { db, a, agent, run } = setup();
    const r = run(agent, "task.create", { business_id: a, title: "t" });
    const other: Actor = { type: "agent", id: "999", name: "남" };
    await assert.rejects(() => callTool(db, other, "get_run", { run_id: r.id }));
    assert.equal((await callTool(db, agent, "get_run", { run_id: r.id }) as { status: string }).status, "applied");
  });

  it("MCP: id 없는 tools/call 은 실행하지 않는다", async () => {
    const { db, a, agent } = setup();
    const res = await handleMcp(db, agent, { jsonrpc: "2.0", method: "tools/call", params: { name: "run_action", arguments: { action: "task.create", params: { business_id: a, title: "몰래" }, reason: "x" } } });
    assert.equal(res, null);
    assert.equal(listRuns(db).length, 0);
  });
});
