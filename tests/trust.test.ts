import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ToolError, callTool } from "@/lib/agent/tools";
import { approveRun, executeAction, rejectRun } from "@/lib/ontology/execute";
import { computeSignals } from "@/lib/ontology/signals";
import { agentTrust, approvalHistory, autonomyStats, enforceTrust, humanMemoryDecisions, maybeEnforceTrust, memoryOutcomes, trustSuggestions } from "@/lib/ontology/trust";
import { type Actor, ActionError, OPERATOR, SYSTEM } from "@/lib/ontology/types";
import { getAgent, getGrant, grantsOverview, listGrants } from "@/lib/repos/agents";
import { createNote } from "@/lib/repos/notes";
import { detectSignals } from "@/lib/events/worker";
import { listEvents } from "@/lib/repos/events";
import { getMemory } from "@/lib/repos/memories";
import { getRun, grantIdOf, listRuns } from "@/lib/repos/runs";
import { setSetting } from "@/lib/repos/settings";
import { freshDb } from "./helpers";

type Params = Record<string, unknown>;

function setup() {
  const { db, a, b } = freshDb();
  const run = (actor: Actor, action: string, params: Params) => executeAction(db, { actor, action, params, reason: "test" });
  const ok = (actor: Actor, action: string, params: Params) => {
    const r = run(actor, action, params);
    assert.equal(r.status, "applied", r.error ?? "");
    return r;
  };
  const H = (action: string, params: Params) => ok(OPERATOR, action, params);
  const register = (name: string, extra: Params = {}): Actor => {
    const r = H("agent.register", { name, ...extra });
    return { type: "agent", id: String(r.refs[0].id), name };
  };
  const idOf = (r: { refs: { type: string; id: number }[] }, type: string) => r.refs.find((x) => x.type === type)!.id;
  const ca = idOf(H("client.create", { business_id: a, name: "한빛상사" }), "client");
  const cb = idOf(H("client.create", { business_id: b, name: "Acme Robotics" }), "client");
  const task = (business: number, title = "업무") => idOf(H("task.create", { business_id: business, title }), "task");
  const memId = (r: { result: { data?: unknown } | null }) => (r.result?.data as { memory_id: number }).memory_id;
  return { db, a, b, run, ok, H, register, idOf, ca, cb, task, memId };
}

const toolError = async (p: Promise<unknown>, re: RegExp) => {
  await assert.rejects(p, (e: unknown) => e instanceof ToolError && re.test(e.message));
};

describe("신뢰 사다리 — 허용 범위 (allowed_actions)", () => {
  it("허용 범위 밖이면 denied + 감사 기록, glob 동작, 역할 기본값", () => {
    const { db, a, run, ok, register } = setup();
    const researcher = register("리서치", { role: "researcher", allowed_actions: "note.*,memory.propose" });
    const n = ok(researcher, "note.create", { business_id: a, title: "세법 개정 메모", body: "요약" }).refs[0].id;
    ok(researcher, "note.update", { id: n, body: "요약 v2" }); // note.* glob
    const denied = run(researcher, "task.create", { business_id: a, title: "몰래 만든 업무" });
    assert.equal(denied.status, "denied");
    assert.match(denied.error!, /역할 researcher.*허용 범위 밖/);
    assert.equal(getRun(db, denied.id)!.status, "denied", "거부도 감사에 남는다");
    // 역할만 주면 기본 허용 범위 (큐레이터: memory.propose · merge · retire)
    const curator = register("큐레이터", { role: "curator" });
    assert.equal(getAgent(db, Number(curator.id))!.allowed_actions, "memory.propose,memory.merge,memory.retire");
    const c = run(curator, "task.create", { business_id: a, title: "x" });
    assert.equal(c.status, "denied");
    // 기본값 '*' · 범위 없음 = 기존 동작 그대로
    const ops = register("운영");
    assert.equal(getAgent(db, Number(ops.id))!.allowed_actions, "*");
    ok(ops, "task.create", { business_id: a, title: "평소 업무" });
  });

  it("agent.configure: 오타 검사 · '*' 허용 · 권한 확대 표시 · 빈 값 거부", () => {
    const { db, H, register } = setup();
    const ag = register("리서치", { allowed_actions: "note.create" });
    const id = Number(ag.id);
    assert.throws(() => executeAction(db, { actor: OPERATOR, action: "agent.configure", params: { id, allowed_actions: "memroy.*" } }), (e: unknown) => e instanceof ActionError && /알려진 액션과 맞지 않는/.test(e.message));
    assert.throws(() => executeAction(db, { actor: OPERATOR, action: "agent.configure", params: { id, allowed_actions: " , " } }), ActionError);
    assert.throws(() => executeAction(db, { actor: OPERATOR, action: "agent.register", params: { name: "x", allowed_actions: "taks.create" } }), ActionError);
    const wide = H("agent.configure", { id, allowed_actions: "note.create, memory.*" });
    assert.match(wide.result!.summary, /권한 확대/);
    assert.equal(getAgent(db, id)!.allowed_actions, "note.create,memory.*", "정규화");
    const narrow = H("agent.configure", { id, allowed_actions: "memory.propose" });
    assert.doesNotMatch(narrow.result!.summary, /권한 확대/);
    const all = H("agent.configure", { id, allowed_actions: "*", role: "custom" });
    assert.match(all.result!.summary, /권한 확대/);
    assert.equal(getAgent(db, id)!.role, "custom");
    assert.throws(() => executeAction(db, { actor: OPERATOR, action: "agent.configure", params: { id, allowed_actions: "*" } }), /바뀐 설정이 없습니다/);
    // 에이전트는 설정을 바꿀 수 없다
    const self = executeAction(db, { actor: ag, action: "agent.configure", params: { id, allowed_actions: "*" } });
    assert.equal(self.status, "denied");
  });
});

describe("신뢰 사다리 — 사업 범위 (business_scope)", () => {
  it("쓰기: input.business_id · 대상 · ref 필드 · link 양쪽 · 새 사업 — 범위 밖 denied, 공용 객체 통과", () => {
    const { db, a, b, run, ok, H, register, ca, cb, task } = setup();
    const ag = register("세무 전담", { business_scope: a });
    const deny = (action: string, params: Params, re = /사업 범위\(세무사무소\) 밖/) => {
      const r = run(ag, action, params);
      assert.equal(r.status, "denied", `${action} ${JSON.stringify(params)} → ${r.status} ${r.error ?? ""}`);
      assert.match(r.error!, re);
    };
    deny("task.create", { business_id: b, title: "다른 사업 업무" });
    ok(ag, "task.create", { business_id: a, title: "범위 안 업무" });
    // ref 필드: 범위 안 사업에 다른 사업의 고객을 붙이려 함
    deny("task.create", { business_id: a, client_id: cb, title: "섞인 업무" });
    // 대상 객체
    const tb = task(b, "SaaS 업무");
    deny("task.update", { id: tb, title: "고침" });
    deny("task.set_status", { id: tb, status: "done" });
    deny("client.log_interaction", { client_id: cb, kind: "call", summary: "통화" });
    // 대상을 다른 사업으로 옮기기
    const ta = task(a, "세무 업무");
    deny("task.update", { id: ta, business_id: b });
    // link.create 양쪽
    deny("link.create", { from: `client:${ca}`, link_type: "referred_by", to: `client:${cb}` });
    const ca2 = H("client.create", { business_id: a, name: "김민수" }).refs[0].id;
    ok(ag, "link.create", { from: `client:${ca2}`, link_type: "referred_by", to: `client:${ca}` });
    // link.delete: 필드는 link_id 뿐 — 양 끝(scopeRefs)으로 판정
    const lb = (H("link.create", { from: `client:${cb}`, link_type: "referred_by", to: `client:${H("client.create", { business_id: b, name: "Beta" }).refs[0].id}` }).result!.data as { link_id: number }).link_id;
    deny("link.delete", { link_id: lb });
    // 새 사업은 어떤 범위에도 들지 않는다
    deny("business.create", { name: "새 사업", currency: "KRW" }, /새 사업/);
    // 공용 객체(사업 없는 문서·기억)는 통과
    const g = ok(ag, "note.create", { title: "공용 체크리스트", body: "- 항목" }).refs[0].id;
    ok(ag, "memory.propose", { statement: "공용 체크리스트는 분기마다 갱신된다", kind: "fact", evidence: [`note:${g}`] });
    // 기억의 근거가 다른 사업 객체면 거부 (refs 필드)
    deny("memory.propose", { statement: "Acme Robotics 는 SSO 를 요구한다", kind: "fact", about: [`client:${cb}`], evidence: [`client:${cb}`] });
    assert.equal(getAgent(db, Number(ag.id))!.business_scope, a);
  });

  it("읽기 도구: business_id 기본값 = 범위 · 다른 값 ToolError · 결과 필터 · get_object 범위 밖 ToolError · list_actions 필터", async () => {
    const { db, a, b, H, register, ca, cb } = setup();
    H("link.create", { from: `client:${cb}`, link_type: "referred_by", to: `client:${ca}` });
    H("note.create", { business_id: b, client_id: cb, title: "Acme 협상 메모", body: "SSO 요구" });
    H("note.create", { business_id: a, client_id: ca, title: "한빛 기장 메모", body: "월말 정산" });
    const ag = register("세무 전담", { business_scope: a, allowed_actions: "task.*,memory.propose" });

    const objs = (await callTool(db, ag, "search_objects", {})) as { business_id: number | null; type: string }[];
    assert.ok(objs.length > 0);
    assert.ok(objs.every((o) => o.business_id === a || o.business_id === null), JSON.stringify(objs));
    const clients = (await callTool(db, ag, "search_objects", { type: "client" })) as { id: number }[];
    assert.deepEqual(clients.map((c) => c.id), [ca]);
    const biz = (await callTool(db, ag, "search_objects", { type: "business" })) as { id: number }[];
    assert.deepEqual(biz.map((x) => x.id), [a]);
    await toolError(callTool(db, ag, "search_objects", { business_id: b }), /사업 범위\(세무사무소\) 밖/);
    await toolError(callTool(db, ag, "list_signals", { business_id: b }), /사업 범위/);

    await toolError(callTool(db, ag, "get_object", { type: "client", id: cb }), /범위 밖/);
    const got = (await callTool(db, ag, "get_object", { type: "client", id: ca })) as { links: { id: number; type: string }[]; available_actions: string[] };
    assert.ok(!got.links.some((l) => l.type === "client" && l.id === cb), "범위 밖 고객으로의 링크는 숨긴다");
    assert.ok(!got.available_actions.includes("client.update"), "허용 범위 밖 액션은 목록에서 뺀다");

    const g = (await callTool(db, ag, "traverse", { ref: `client:${ca}`, depth: 2 })) as { nodes: { ref: string }[]; edges: { from: string; to: string }[] };
    assert.ok(!g.nodes.some((n) => n.ref === `client:${cb}`));
    assert.ok(g.edges.every((e) => e.from !== `client:${cb}` && e.to !== `client:${cb}`));
    await toolError(callTool(db, ag, "traverse", { ref: `client:${cb}` }), /범위 밖/);
    await toolError(callTool(db, ag, "find_path", { from: `client:${ca}`, to: `client:${cb}` }), /범위 밖/);
    await toolError(callTool(db, ag, "get_context", { about: [`client:${cb}`] }), /범위 밖/);

    const rec = (await callTool(db, ag, "recall", { query: "메모" })) as { hits: { title: string }[] };
    assert.ok(rec.hits.some((h) => h.title.includes("한빛")), JSON.stringify(rec.hits));
    assert.ok(rec.hits.every((h) => !h.title.includes("Acme")), "다른 사업의 메모는 회상되지 않는다");
    const titles = (await callTool(db, ag, "recall", { query: "Acme SSO" })) as { hits: { title: string }[] };
    assert.ok(titles.hits.every((h) => !h.title.includes("Acme")), JSON.stringify(titles.hits));

    const acts = (await callTool(db, ag, "list_actions", {})) as { actions: { name: string }[] };
    assert.ok(acts.actions.length > 0);
    assert.ok(acts.actions.every((x) => x.name.startsWith("task.") || x.name === "memory.propose"), JSON.stringify(acts.actions.map((x) => x.name)));

    const ev = (await callTool(db, ag, "list_events", { limit: 200 })) as { events: { subject_type: string | null; subject_id: number | null }[]; last_id: number };
    assert.ok(ev.events.length > 0);
    assert.ok(!ev.events.some((e) => e.subject_type === "client" && e.subject_id === cb), "범위 밖 객체가 주체인 이벤트는 뺀다");
    const sigs = (await callTool(db, ag, "list_signals", {})) as { businessId: number | null }[];
    assert.ok(sigs.every((s) => s.businessId === a || s.businessId === null));
    // 범위 없는 에이전트는 그대로 전부
    const all = register("전체");
    const every = (await callTool(db, all, "search_objects", { type: "client" })) as { id: number }[];
    assert.equal(every.length, 2);
  });
});

describe("신뢰 사다리 — 자율 권한 (agent_grants)", () => {
  it("guarded + high + 권한 → applied(grant_id), 만료 → pending, supervised 무시, frozen deny, low 거부, 연장", () => {
    const { db, a, run, H, register, task } = setup();
    const ag = register("운영");
    const agentId = Number(ag.id);
    const t1 = task(a, "지울 업무 1");
    assert.equal(run(ag, "task.delete", { id: t1 }).status, "pending", "권한 없으면 승인 대기");

    const g = H("agent.grant", { agent_id: agentId, action: "task.delete", days: 30 });
    const grantId = (g.result!.data as { grant_id: number }).grant_id;
    const t2 = task(a, "지울 업무 2");
    const r = run(ag, "task.delete", { id: t2 });
    assert.equal(r.status, "applied", r.error ?? "");
    assert.equal(grantIdOf(r), grantId, "감사 결과에 grant_id");
    assert.equal(r.decided_by, null);

    // 저위험 액션은 권한 불필요 → 거부, 사람 전용 · 허용 범위 밖도 거부
    assert.throws(() => executeAction(db, { actor: OPERATOR, action: "agent.grant", params: { agent_id: agentId, action: "task.create" } }), /저위험/);
    assert.throws(() => executeAction(db, { actor: OPERATOR, action: "agent.grant", params: { agent_id: agentId, action: "memory.confirm" } }), /사람 전용/);
    assert.throws(() => executeAction(db, { actor: OPERATOR, action: "agent.grant", params: { agent_id: agentId, action: "task.nope" } }), /알 수 없는 액션/);
    assert.throws(() => executeAction(db, { actor: OPERATOR, action: "agent.grant", params: { agent_id: agentId, action: "task.delete", days: 91 } }), ActionError);
    // 함수형 위험도(memory.retire)는 부여 가능
    H("agent.grant", { agent_id: agentId, action: "memory.retire", days: 7 });
    const narrow = register("좁은", { allowed_actions: "task.create" });
    assert.throws(() => executeAction(db, { actor: OPERATOR, action: "agent.grant", params: { agent_id: Number(narrow.id), action: "task.delete" } }), /허용 범위/);

    // 연장: 같은 권한 행의 만료일을 늘린다
    const before = getGrant(db, grantId)!.expires_at;
    const ext = H("agent.grant", { agent_id: agentId, action: "task.delete", days: 60 });
    assert.equal((ext.result!.data as { grant_id: number; extended: boolean }).grant_id, grantId);
    assert.equal((ext.result!.data as { extended: boolean }).extended, true);
    assert.ok(getGrant(db, grantId)!.expires_at > before);
    assert.equal(listGrants(db, { agentId, active: true }).filter((x) => x.action === "task.delete").length, 1);

    // 감독 모드는 권한을 무시
    H("system.set_ai_mode", { mode: "supervised" });
    assert.equal(run(ag, "task.delete", { id: task(a, "지울 업무 3") }).status, "pending");
    H("system.set_ai_mode", { mode: "frozen" });
    assert.equal(run(ag, "task.delete", { id: task(a, "지울 업무 4") }).status, "denied");
    H("system.set_ai_mode", { mode: "guarded" });

    // 만료된 권한 → 다시 승인 대기 (행은 그대로 — 시각으로 판단)
    db.prepare("UPDATE agent_grants SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), grantId);
    assert.equal(run(ag, "task.delete", { id: task(a, "지울 업무 5") }).status, "pending");
    assert.equal(getGrant(db, grantId)!.revoked_at, null);

    // 회수 → 이후 승인 대기, 이미 회수된 권한은 다시 회수 못 함
    const g2 = (H("agent.grant", { agent_id: agentId, action: "task.delete" }).result!.data as { grant_id: number }).grant_id;
    assert.notEqual(g2, grantId, "만료된 권한은 연장이 아니라 새 권한");
    assert.equal(run(ag, "task.delete", { id: task(a, "지울 업무 6") }).status, "applied");
    H("agent.revoke_grant", { grant_id: g2, reason: "테스트" });
    assert.equal(run(ag, "task.delete", { id: task(a, "지울 업무 7") }).status, "pending");
    assert.throws(() => executeAction(db, { actor: OPERATOR, action: "agent.revoke_grant", params: { grant_id: g2, reason: "다시" } }), /이미 회수된/);
  });

  it("승인 시점 재검사: 대기 이후 에이전트 범위가 줄면 승인도 거부", () => {
    const { db, a, b, run, H, register, task } = setup();
    const ag = register("운영");
    const id = Number(ag.id);
    const p1 = run(ag, "task.delete", { id: task(a, "a 업무") });
    const p2 = run(ag, "task.delete", { id: task(b, "b 업무") });
    const p3 = run(ag, "task.delete", { id: task(a, "a 업무 2") });
    assert.deepEqual([p1.status, p2.status, p3.status], ["pending", "pending", "pending"]);
    H("agent.configure", { id, business_scope: a });
    const r2 = approveRun(db, p2.id, OPERATOR);
    assert.equal(r2.status, "failed");
    assert.match(r2.error!, /권한 범위가 바뀌어.*사업 범위/);
    assert.equal(approveRun(db, p1.id, OPERATOR).status, "applied", "범위 안이면 승인 실행");
    H("agent.configure", { id, allowed_actions: "task.create" });
    const r3 = approveRun(db, p3.id, OPERATOR);
    assert.equal(r3.status, "failed");
    assert.match(r3.error!, /허용 범위 밖/);
  });
});

describe("신뢰 사다리 — 기억 착지", () => {
  it("memory_trust active + 근거 2 + 비오염 → active, 오염 · 근거 1 · propose 등급 → proposed", () => {
    const { db, a, ok, H, register, ca, memId } = setup();
    const ag = register("기억 에이전트");
    const n1 = H("note.create", { business_id: a, client_id: ca, title: "기장 미팅", body: "월말 일괄" }).refs[0].id;
    const n2 = H("note.create", { business_id: a, client_id: ca, title: "기장 메일", body: "월말 일괄 발행" }).refs[0].id;
    const ev = [`note:${n1}`, `note:${n2}`];
    const p0 = ok(ag, "memory.propose", { statement: "한빛상사는 세금계산서를 월말에 일괄 발행받기를 원한다", kind: "preference", about: [`client:${ca}`], evidence: ev });
    assert.equal(getMemory(db, memId(p0))!.status, "proposed", "기본 등급 propose");

    H("agent.set_memory_trust", { agent_id: Number(ag.id), level: "active" });
    const p1 = ok(ag, "memory.propose", { statement: "한빛상사는 기장 자료를 매월 5일까지 보낸다", kind: "fact", about: [`client:${ca}`], evidence: ev });
    assert.equal(getMemory(db, memId(p1))!.status, "active");
    assert.equal((p1.result!.data as { landing: string }).landing, "active");
    const p2 = ok(ag, "memory.propose", { statement: "한빛상사는 법인카드를 두 장 쓴다", kind: "fact", about: [`client:${ca}`], evidence: ev, tainted: true });
    assert.equal(getMemory(db, memId(p2))!.status, "proposed", "오염이면 proposed");
    const p3 = ok(ag, "memory.propose", { statement: "한빛상사는 전자세금계산서만 받는다", kind: "fact", about: [`client:${ca}`], evidence: [`note:${n1}`] });
    assert.equal(getMemory(db, memId(p3))!.status, "proposed", "근거 1개면 proposed");
    assert.throws(() => executeAction(db, { actor: OPERATOR, action: "agent.set_memory_trust", params: { agent_id: Number(ag.id), level: "active" } }), /이미/);
  });
});

describe("신뢰 사다리 — 지표 · 후보 · 자동 강등", () => {
  it("agentTrust: 액션별 바로 적용 · 승인 · 거절 · 실패 · 거부 · 문제 표시 · 자율, 승인률, 기억 정밀도", () => {
    const { db, a, run, ok, H, register, ca, task, memId } = setup();
    const ag = register("운영");
    const id = Number(ag.id);
    for (let i = 0; i < 3; i++) ok(ag, "task.create", { business_id: a, title: `업무 ${i}` });
    const p = [0, 1, 2].map((i) => run(ag, "task.delete", { id: task(a, `지울 ${i}`) }));
    approveRun(db, p[0].id, OPERATOR);
    approveRun(db, p[1].id, OPERATOR);
    rejectRun(db, p[2].id, OPERATOR, "아직 필요");
    assert.equal(run(ag, "system.set_ai_mode", { mode: "autonomous" }).status, "denied");
    assert.equal(run(ag, "task.create", { business_id: a }).status, "failed");
    H("run.flag", { run_id: p[0].id, note: "지우면 안 되는 업무였다" });
    H("agent.grant", { agent_id: id, action: "task.delete" });
    ok(ag, "task.delete", { id: task(a, "자율로 지울") });

    const n = H("note.create", { business_id: a, client_id: ca, title: "메모", body: "근거" }).refs[0].id;
    const props = [0, 1, 2, 3].map((i) => memId(ok(ag, "memory.propose", { statement: `한빛상사 지점 ${i + 1}호는 월말 정산을 선호한다`, kind: "preference", evidence: [`note:${n}`] })));
    H("memory.confirm", { id: props[0] });
    H("memory.confirm", { id: props[1] });
    H("memory.reject", { id: props[2], reason: "틀림" });
    H("memory.correct", { id: props[3], statement: "한빛상사 지점 4호는 월초 정산을 선호한다" });

    const t = agentTrust(db, id);
    const del = t.runs.byAction.find((x) => x.action === "task.delete")!;
    assert.equal(del.approved, 2);
    assert.equal(del.rejected, 1);
    assert.equal(del.granted, 1);
    assert.equal(del.flagged, 1);
    assert.equal(del.high, true);
    assert.equal(del.approvalRate, 2 / 3);
    const create = t.runs.byAction.find((x) => x.action === "task.create")!;
    assert.equal(create.direct, 3);
    assert.equal(create.failed, 1);
    assert.equal(t.runs.total.denied, 1);
    assert.equal(t.runs.total.flagged, 1);
    assert.equal(t.runs.approvalRate, 2 / 3);
    assert.deepEqual(
      { proposed: t.memory.proposed, confirmed: t.memory.confirmed, rejected: t.memory.rejected, corrected: t.memory.corrected, precision: t.memory.precision },
      { proposed: 4, confirmed: 2, rejected: 1, corrected: 1, precision: 0.5 },
    );
    assert.deepEqual(approvalHistory(db, id, "task.delete"), { approved: 2, rejected: 1, flagged: 1 });
    const au = autonomyStats(db, new Date(Date.now() - 86_400_000).toISOString());
    assert.equal(au.granted, 1);
    assert.equal(au.approved, 2);
    assert.equal(au.rejected, 1);
    assert.ok(au.direct >= 3 + 4);
    assert.equal(au.total, au.direct + au.granted + au.approved + au.rejected);
    // run.flag 규칙: 적용된 에이전트 실행만 · 중복 불가 · 해제
    assert.throws(() => executeAction(db, { actor: OPERATOR, action: "run.flag", params: { run_id: p[2].id, note: "x" } }), /적용된 실행만/);
    assert.throws(() => executeAction(db, { actor: OPERATOR, action: "run.flag", params: { run_id: p[0].id, note: "x" } }), /이미/);
    H("run.unflag", { run_id: p[0].id });
    assert.equal(getRun(db, p[0].id)!.flagged_at, null);
    assert.equal(agentTrust(db, id).runs.total.flagged, 0);
  });

  it("후보 신호: 승인 10건 · 거절 0 → trust.grant_candidate + suggested agent.grant, 기억 정밀도 → trust.memory_candidate", () => {
    const { db, a, run, H, register, ca, task, memId } = setup();
    const ag = register("운영");
    const id = Number(ag.id);
    const key = `trust.grant_candidate:${id}:task.delete`;
    const approveN = (n: number) => {
      for (let i = 0; i < n; i++) approveRun(db, run(ag, "task.delete", { id: task(a, `지울 ${i}`) }).id, OPERATOR);
    };
    approveN(9);
    assert.ok(!computeSignals(db, null).some((s) => s.key === key), "9건은 아직");
    approveN(1);
    const sig = computeSignals(db, null).find((s) => s.key === key);
    assert.ok(sig, "승인 10건 → 후보");
    assert.equal(sig!.severity, "info");
    assert.deepEqual(sig!.suggested[0], { action: "agent.grant", label: "자율 권한 부여 (30일)", params: { agent_id: id, action: "task.delete", days: 30 } });
    assert.ok(!computeSignals(db, a).some((s) => s.key === key), "사업 범위 신호에는 없다 (전체 범위 전용)");
    // 부여하면 후보에서 빠진다
    H(sig!.suggested[0].action, sig!.suggested[0].params);
    assert.ok(!computeSignals(db, null).some((s) => s.key === key));
    // 거절이 하나라도 있으면 후보 아님
    const other = register("다른");
    for (let i = 0; i < 10; i++) approveRun(db, run(other, "task.delete", { id: task(a, `o${i}`) }).id, OPERATOR);
    rejectRun(db, run(other, "task.delete", { id: task(a, "o-x") }).id, OPERATOR);
    assert.ok(!computeSignals(db, null).some((s) => s.key === `trust.grant_candidate:${other.id}:task.delete`));

    // 기억 등급 후보: 결정 20건 · 정밀도 ≥ 0.9
    const mkey = `trust.memory_candidate:${id}`;
    const n = H("note.create", { business_id: a, client_id: ca, title: "근거", body: "근거" }).refs[0].id;
    for (let i = 0; i < 20; i++) {
      const m = memId(executeAction(db, { actor: ag, action: "memory.propose", params: { statement: `한빛상사 지점 ${i + 1}호는 월말 정산을 선호한다`, kind: "preference", evidence: [`note:${n}`] }, reason: "t" }));
      if (i < 19) H("memory.confirm", { id: m });
      else H("memory.reject", { id: m, reason: "틀림" });
      if (i === 18) assert.ok(!computeSignals(db, null).some((s) => s.key === mkey), "결정 19건은 아직");
    }
    const ms = computeSignals(db, null).find((s) => s.key === mkey);
    assert.ok(ms, "결정 20 · 정밀도 0.95 → 후보");
    assert.deepEqual(ms!.suggested[0].params, { agent_id: id, level: "active" });
  });

  it("자동 강등: 문제 표시 → 권한 회수(SYSTEM), 활성 착지 기억 거절·정정 2건 → propose, 시간당 1회", () => {
    const { db, a, ok, H, register, ca, task, memId } = setup();
    const ag = register("운영");
    const id = Number(ag.id);
    const grantId = (H("agent.grant", { agent_id: id, action: "task.delete" }).result!.data as { grant_id: number }).grant_id;
    const r = ok(ag, "task.delete", { id: task(a, "자율로 지운 업무") });
    assert.equal(grantIdOf(r), grantId);
    assert.deepEqual(enforceTrust(db).revoked, [], "문제 표시 전에는 그대로");
    H("run.flag", { run_id: r.id, note: "지우면 안 되는 업무였다" });
    const out = enforceTrust(db);
    assert.equal(out.revoked.length, 1);
    assert.equal(out.revoked[0].run_id, r.id);
    const g = getGrant(db, grantId)!;
    assert.ok(g.revoked_at);
    assert.equal(g.revoked_by, SYSTEM.name);
    assert.match(g.revoked_reason!, /문제 표시된 실행 RUN-0+\d+ — 자동 회수/);
    const sysRun = listRuns(db, { actorType: "system", action: "agent.revoke_grant" })[0];
    assert.equal(sysRun.status, "applied");
    assert.ok(listEvents(db, { type: "trust.enforced" }).length >= 1);
    assert.equal(executeAction(db, { actor: ag, action: "task.delete", params: { id: task(a, "다음") }, reason: "t" }).status, "pending", "회수 뒤 승인 대기");

    // 기억 등급: 승급 이전의 거절은 세지 않는다
    const n1 = H("note.create", { business_id: a, client_id: ca, title: "근거1", body: "x" }).refs[0].id;
    const n2 = H("note.create", { business_id: a, client_id: ca, title: "근거2", body: "y" }).refs[0].id;
    const ev = [`note:${n1}`, `note:${n2}`];
    const propose = (i: number) => memId(ok(ag, "memory.propose", { statement: `한빛상사 지점 ${i}호는 월말 정산을 선호한다`, kind: "preference", evidence: ev }));
    H("agent.set_memory_trust", { agent_id: id, level: "active" });
    const m1 = propose(1);
    const m2 = propose(2);
    const m3 = propose(3);
    assert.deepEqual([m1, m2, m3].map((m) => getMemory(db, m)!.status), ["active", "active", "active"]);
    H("memory.reject", { id: m1, reason: "틀림" });
    assert.deepEqual(enforceTrust(db).demoted, [], "1건은 아직");
    H("memory.correct", { id: m2, statement: "한빛상사 지점 2호는 월초 정산을 선호한다" });
    const d = enforceTrust(db);
    assert.deepEqual(d.demoted, [{ agent_id: id, bad: 2 }]);
    assert.equal(getAgent(db, id)!.memory_trust, "propose");
    const sysMem = listRuns(db, { actorType: "system", action: "agent.set_memory_trust" })[0];
    assert.equal(sysMem.status, "applied");
    assert.match(sysMem.result!.summary, /자동 강등/);
    // 다시 올리면 이전 거절은 세지 않는다
    H("agent.set_memory_trust", { agent_id: id, level: "active" });
    assert.deepEqual(enforceTrust(db).demoted, []);
    assert.equal(propose(4) > 0, true);

    // 시간당 1회 (settings 점유)
    const t0 = new Date();
    assert.ok(maybeEnforceTrust(db, t0));
    assert.equal(maybeEnforceTrust(db, new Date(t0.getTime() + 30 * 60_000)), null);
    assert.ok(maybeEnforceTrust(db, new Date(t0.getTime() + 61 * 60_000)));
    setSetting(db, "trust", "off");
    assert.equal(maybeEnforceTrust(db, new Date(t0.getTime() + 180 * 60_000)), null);
    void m3;
  });
});

describe("신뢰 사다리 — whoami", () => {
  it("역할 · 허용 · 범위(이름) · 기억 등급 · 유효 권한 · AI 모드 · 요약", async () => {
    const { db, a, H, register } = setup();
    const ag = register("세무 전담", { role: "custom", allowed_actions: "task.*,memory.propose", business_scope: a });
    const id = Number(ag.id);
    H("agent.grant", { agent_id: id, action: "task.delete", days: 10 });
    const w = (await callTool(db, ag, "whoami", {})) as Record<string, unknown> & { grants: { action: string; expires_at: string }[]; business_scope: { id: number; name: string }; ai_mode: { mode: string }; summary: string };
    assert.equal(w.agent_id, id);
    assert.equal(w.role, "custom");
    assert.equal(w.allowed_actions, "task.*,memory.propose");
    assert.deepEqual(w.business_scope, { id: a, name: "세무사무소" });
    assert.equal(w.memory_trust, "propose");
    assert.deepEqual(w.grants.map((g) => g.action), ["task.delete"]);
    assert.equal(w.ai_mode.mode, "guarded");
    assert.match(w.summary, /세무사무소/);
    assert.match(w.summary, /task\.delete/);
    assert.match(w.summary, /제안됨/);
    await assert.rejects(callTool(db, OPERATOR, "whoami", {}), ToolError);
  });
});

describe("신뢰 사다리 — 리뷰 회귀", () => {
  it("list_episodes: 사업 범위를 LIMIT 전에 거른다 (다른 사업의 새 에피소드에 밀리지 않는다)", async () => {
    const { db, a, b, register } = setup();
    const ep = (business: number | null, title: string) =>
      createNote(db, { business_id: business, client_id: null, title, body: "요약", tags: "", pinned: false, kind: "episode", source_uri: `session:${title}` });
    for (let i = 0; i < 3; i++) ep(a, `세무 에피소드 ${i}`);
    ep(null, "공용 에피소드");
    for (let i = 0; i < 25; i++) ep(b, `SaaS 에피소드 ${i}`);
    const ag = register("세무 큐레이터", { business_scope: a });
    const out = (await callTool(db, ag, "list_episodes", {})) as { episodes: { title: string; business_id: number | null }[] };
    assert.equal(out.episodes.length, 4, JSON.stringify(out.episodes.map((e) => e.title)));
    assert.ok(out.episodes.every((e) => e.business_id === a || e.business_id === null));
  });

  it("자율 권한 후보: 허용 범위를 좁히면 후보가 사라진다 (부여가 실패할 제안은 띄우지 않는다)", () => {
    const { db, a, run, H, register, task } = setup();
    const ag = register("운영");
    const id = Number(ag.id);
    const key = `trust.grant_candidate:${id}:task.delete`;
    for (let i = 0; i < 10; i++) approveRun(db, run(ag, "task.delete", { id: task(a, `지울 ${i}`) }).id, OPERATOR);
    assert.ok(computeSignals(db, null).some((s) => s.key === key));
    H("agent.configure", { id, allowed_actions: "task.create" });
    assert.ok(!computeSignals(db, null).some((s) => s.key === key), "허용 범위 밖 액션은 후보 아님");
    assert.throws(() => executeAction(db, { actor: OPERATOR, action: "agent.grant", params: { agent_id: id, action: "task.delete" } }), /허용 범위/);
  });

  it("run.flag: 범위 밖 실행의 문제 표시(요약·메모)는 get_object 이력 · list_events 에 나오지 않는다", async () => {
    const { db, a, b, ok, H, register } = setup();
    const other = register("SaaS 운영");
    const scoped = register("세무 전담", { business_scope: a });
    const r = ok(other, "task.create", { business_id: b, title: "Acme 인수 협상" });
    H("run.flag", { run_id: r.id, note: "비공개 메모 — 협상가 이름 노출" });
    const inA = ok(other, "task.create", { business_id: a, title: "세무 업무" });
    H("run.flag", { run_id: inA.id, note: "범위 안 메모" });
    const got = (await callTool(db, scoped, "get_object", { type: "agent", id: Number(other.id) })) as { history: { action: string; summary: string | null }[] };
    assert.ok(got.history.every((h) => !(h.summary ?? "").includes("비공개 메모")), JSON.stringify(got.history));
    assert.ok(got.history.some((h) => (h.summary ?? "").includes("범위 안 메모")), "범위 안 실행의 표시는 보인다");
    const ev = (await callTool(db, scoped, "list_events", { limit: 200 })) as { events: { payload: Record<string, unknown> }[] };
    assert.ok(ev.events.every((e) => !JSON.stringify(e.payload).includes("비공개 메모")), "payload.refs 에 범위 밖 객체가 있으면 뺀다");
    assert.ok(ev.events.some((e) => JSON.stringify(e.payload).includes("범위 안 메모")));
  });

  it("signal.resolved: 대상·사업을 실어 범위 밖 신호 제목이 새지 않는다", async () => {
    const { db, a, b, H, register } = setup();
    const tb = H("task.create", { business_id: b, title: "Acme 인수 협상 마감", due_date: "2020-01-01" }).refs[0].id;
    const ta = H("task.create", { business_id: a, title: "세무 신고 마감", due_date: "2020-01-01" }).refs[0].id;
    detectSignals(db);
    H("task.set_status", { id: tb, status: "done" });
    H("task.set_status", { id: ta, status: "done" });
    assert.ok(detectSignals(db).resolved >= 2);
    const resolved = listEvents(db, { type: "signal.resolved" });
    const rb = resolved.find((e) => String(e.payload.title).includes("Acme"))!;
    assert.equal(rb.subject_type, "task");
    assert.equal(rb.subject_id, tb);
    assert.equal(rb.payload.business_id, b);
    const scoped = register("세무 전담", { business_scope: a });
    const ev = (await callTool(db, scoped, "list_events", { type: "signal.", limit: 200 })) as { events: { type: string; payload: Record<string, unknown> }[] };
    assert.ok(ev.events.every((e) => !String(e.payload.title).includes("Acme")), JSON.stringify(ev.events));
    assert.ok(ev.events.some((e) => e.type === "signal.resolved" && String(e.payload.title).includes("세무 신고")), "범위 안 해소는 보인다");
    // 위치를 기록하기 전의 행(마이그레이션 이전)에서 해소되면 범위를 모르는 이벤트 — 범위 에이전트에게는 뺀다
    db.prepare("INSERT INTO signal_state (key, kind, severity, title, first_seen, last_seen) VALUES ('legacy.x', 'task.overdue', 'warning', 'Acme 옛 신호', 'x', 'x')").run();
    detectSignals(db);
    const legacy = listEvents(db, { type: "signal.resolved" }).find((e) => e.payload.key === "legacy.x")!;
    assert.equal(legacy.payload.scope_unknown, true);
    const ev2 = (await callTool(db, scoped, "list_events", { type: "signal.", limit: 200 })) as { events: { payload: Record<string, unknown> }[] };
    assert.ok(!ev2.events.some((e) => e.payload.key === "legacy.x"));
    const all = (await callTool(db, register("전체"), "list_events", { type: "signal.", limit: 200 })) as { events: { payload: Record<string, unknown> }[] };
    assert.ok(all.events.some((e) => e.payload.key === "legacy.x"), "범위 없는 에이전트는 그대로");
  });

  it("사업 범위 거부 사유에 범위 밖 사업의 이름이 없다", () => {
    const { a, b, run, register, cb } = setup();
    const ag = register("세무 전담", { business_scope: a });
    for (const [action, params] of [
      ["task.create", { business_id: b, title: "x" }],
      ["link.create", { from: `client:${cb}`, link_type: "referred_by", to: `client:${cb}` }],
    ] as [string, Params][]) {
      const r = run(ag, action, params);
      assert.equal(r.status, "denied");
      assert.match(r.error!, /사업 범위\(세무사무소\) 밖/);
      assert.doesNotMatch(r.error!, /SaaS/, r.error!);
    }
  });

  it("IaC 스냅샷 수신: 허용 범위(iac.record_snapshot) 밖 에이전트는 403 + denied 감사", async () => {
    const { db } = setup();
    const g = globalThis as unknown as { __nowDb?: typeof db };
    const prev = g.__nowDb;
    g.__nowDb = db;
    try {
      const { POST } = await import("@/app/api/v1/iac/snapshots/route");
      const tokenOf = (params: Params) => (executeAction(db, { actor: OPERATOR, action: "agent.register", params }).out as { token: string }).token;
      const body = JSON.stringify({ captured_at: new Date().toISOString(), tool: "tofu", status: "in_sync", resources: [], changes: [] });
      const post = (token: string) => POST(new Request("http://x/api/v1/iac/snapshots", { method: "POST", headers: { authorization: `Bearer ${token}` }, body }));
      const narrow = await post(tokenOf({ name: "리서치", role: "researcher", allowed_actions: "note.*,memory.propose" }));
      assert.equal(narrow.status, 403);
      const denied = listRuns(db, { action: "iac.record_snapshot" })[0];
      assert.equal(denied.status, "denied");
      assert.match(denied.error!, /허용 범위 밖/);
      // 명시적으로 허용하면 (오타 검사가 이 이름을 안다) 기록된다
      const auditor = tokenOf({ name: "감사", allowed_actions: "iac.record_snapshot" });
      assert.equal((await post(auditor)).status, 201);
      assert.equal((await post(tokenOf({ name: "운영" }))).status, 201, "기본 '*' 는 그대로");
    } finally {
      g.__nowDb = prev;
    }
  });

  it("whoami · 신뢰 패널: 허용 범위를 좁힌 뒤 남은 권한은 유효 목록에서 빠진다", async () => {
    const { db, H, register } = setup();
    const ag = register("운영");
    const id = Number(ag.id);
    H("agent.grant", { agent_id: id, action: "task.delete" });
    H("agent.configure", { id, allowed_actions: "task.create,memory.propose" });
    const w = (await callTool(db, ag, "whoami", {})) as { grants: unknown[]; unusable_grants?: { action: string; why: string }[]; summary: string };
    assert.deepEqual(w.grants, []);
    assert.deepEqual(w.unusable_grants?.map((g) => g.action), ["task.delete"]);
    assert.doesNotMatch(w.summary, /자율 권한: task\.delete/);
  });

  it("grantsOverview: 오래 연장한 유효 권한이 회수·만료 이력에 밀려 가려지지 않는다", () => {
    const { db, H, register } = setup();
    const ag = register("운영");
    const id = Number(ag.id);
    const old = (H("agent.grant", { agent_id: id, action: "task.delete" }).result!.data as { grant_id: number }).grant_id;
    for (let i = 0; i < 9; i++) {
      const gid = (H("agent.grant", { agent_id: id, action: "invoice.void" }).result!.data as { grant_id: number }).grant_id;
      H("agent.revoke_grant", { grant_id: gid, reason: `r${i}` });
    }
    const shown = grantsOverview(db, id, { history: 6 });
    assert.equal(shown[0].id, old, "유효 권한이 먼저");
    assert.equal(shown.length, 7);
    assert.equal(listGrants(db, { agentId: id, limit: 8 }).some((g) => g.id === old), false, "id 순 8개로는 가려졌던 것");
  });

  it("trustSuggestions: 사람의 기억 결정은 에이전트 수와 무관하게 한 번만 읽는다 (결과는 에이전트별 계산과 같다)", () => {
    const { db, a, H, register, ca, memId } = setup();
    const n = H("note.create", { business_id: a, client_id: ca, title: "근거", body: "근거" }).refs[0].id;
    const agents = [register("운영"), register("리서치"), register("큐레이터")];
    agents.forEach((ag, k) => {
      for (let i = 0; i < 20; i++) {
        const m = memId(executeAction(db, { actor: ag, action: "memory.propose", params: { statement: `한빛상사 ${k + 1}지점 ${i + 1}호는 월말 정산을 선호한다`, kind: "preference", evidence: [`note:${n}`] }, reason: "t" }));
        if (k === 2 && i < 3) H("memory.reject", { id: m, reason: "틀림" });
        else H("memory.confirm", { id: m });
      }
    });
    const decisionSql = /actor_type = 'human'.*memory\.confirm/s;
    const orig = db.prepare.bind(db);
    let reads = 0;
    db.prepare = ((sql: string) => {
      if (decisionSql.test(sql)) reads++;
      return orig(sql);
    }) as typeof db.prepare;
    let keys: string[];
    try {
      keys = trustSuggestions(db).map((s) => s.key).filter((k) => k.startsWith("trust.memory_candidate:")).sort();
    } finally {
      db.prepare = orig;
    }
    assert.equal(reads, 1, "에이전트 3명 — 결정 질의 1회");
    assert.deepEqual(keys, [`trust.memory_candidate:${agents[0].id}`, `trust.memory_candidate:${agents[1].id}`].sort(), "정밀도 0.85 인 큐레이터는 후보 아님");
    // 공유한 결정 목록으로 계산해도 에이전트별로 따로 읽은 것과 같다
    const since = "2000-01-01T00:00:00.000Z";
    const until = new Date().toISOString();
    const shared = humanMemoryDecisions(db, since);
    for (const ag of agents) assert.deepEqual(memoryOutcomes(db, Number(ag.id), since, until, () => shared), memoryOutcomes(db, Number(ag.id), since, until));
  });

  it("runOut: 문제 표시 · 자율 권한 id 를 싣고 list_my_runs 는 flagged 로 거른다", async () => {
    const { db, a, ok, H, register, task } = setup();
    const ag = register("운영");
    const gid = (H("agent.grant", { agent_id: Number(ag.id), action: "task.delete" }).result!.data as { grant_id: number }).grant_id;
    const r = ok(ag, "task.delete", { id: task(a, "지울 업무") });
    ok(ag, "task.create", { business_id: a, title: "평범" });
    H("run.flag", { run_id: r.id, note: "지우면 안 됐다" });
    const got = (await callTool(db, ag, "get_run", { run_id: r.id })) as { grant_id: number | null; flagged: { note: string } | null };
    assert.equal(got.grant_id, gid);
    assert.equal(got.flagged?.note, "지우면 안 됐다");
    const mine = (await callTool(db, ag, "list_my_runs", { flagged: true })) as { run_id: number }[];
    assert.deepEqual(mine.map((x) => x.run_id), [r.id]);
  });
});
