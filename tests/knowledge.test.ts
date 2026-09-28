import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openDb } from "@/lib/db";
import { callTool } from "@/lib/agent/tools";
import { tick } from "@/lib/events/worker";
import { splitSections } from "@/lib/knowledge/cards";
import { evaluate, loadGolden } from "@/lib/knowledge/eval";
import { indexPending, indexStats, reindexAll } from "@/lib/knowledge/indexer";
import { analyze, recall } from "@/lib/knowledge/recall";
import { executeAction } from "@/lib/ontology/execute";
import { type Actor, OPERATOR } from "@/lib/ontology/types";
import { createAgent } from "@/lib/repos/agents";
import { seedDemo } from "../scripts/demo-data";
import { freshDb } from "./helpers";

function setup() {
  const { db, a, b } = freshDb();
  const run = (action: string, params: Record<string, unknown>) => {
    const r = executeAction(db, { actor: OPERATOR, action, params, reason: "test" });
    assert.equal(r.status, "applied", r.error ?? "");
    return r.refs[0].id;
  };
  return { db, a, b, run };
}

const chunkOf = (db: ReturnType<typeof openDb>, type: string, id: number) =>
  (db.prepare("SELECT text FROM chunks WHERE owner_type = ? AND owner_id = ? AND seq = 0").get(type, id) as { text: string } | undefined)?.text;

describe("검색 색인", () => {
  it("문서 본문은 제목 경로가 붙은 구획으로 나뉜다", () => {
    const s = splitSections("SOP", "머리말\n\n# 절차\n## 수집\n- 자료 A\n## 신고\n- 전자신고\n### 세부\n본문");
    assert.deepEqual(s, ["SOP\n머리말", "SOP > 절차 > 수집\n- 자료 A", "SOP > 절차 > 신고\n- 전자신고", "SOP > 절차 > 신고 > 세부\n본문"]);
    // 긴 구획은 문단 경계에서 잘린다
    const long = splitSections("T", Array.from({ length: 30 }, (_, i) => `문단 ${i} ${"가".repeat(60)}\n`).join("\n"), 300);
    assert.ok(long.length > 3 && long.every((c) => c.startsWith("T\n")));
  });

  it("전체 색인은 멱등이고, 액션 이벤트를 따라 증분 반영 · 의존 카드 갱신 · 삭제", async () => {
    const { db, a, run } = setup();
    const c = run("client.create", { business_id: a, name: "하늘상사", memo: "전자세금계산서 월말 일괄" });
    const t = run("task.create", { business_id: a, client_id: c, title: "원천세 신고" });
    const first = reindexAll(db);
    assert.ok(first.changed >= 4);
    assert.equal(reindexAll(db).changed, 0, "내용이 같으면 쓰지 않는다");
    assert.match(chunkOf(db, "task", t)!, /고객: 하늘상사/);

    // 이름 변경 → 고객 카드 + 그 고객을 가리키는 업무 카드까지
    run("client.update", { id: c, name: "푸른상사" });
    const inc = indexPending(db);
    assert.equal(inc.mode, "incremental");
    assert.equal(inc.changed, 2);
    assert.match(chunkOf(db, "client", c)!, /푸른상사/);
    assert.match(chunkOf(db, "task", t)!, /고객: 푸른상사/);
    assert.equal(indexPending(db).mode, "none");

    // 접촉 이력도 고객 카드에 들어간다
    run("client.log_interaction", { client_id: c, kind: "call", summary: "SSO 요구사항 문의" });
    indexPending(db);
    assert.match(chunkOf(db, "client", c)!, /통화: SSO 요구사항 문의/);

    run("client.delete", { id: c });
    indexPending(db);
    assert.equal(chunkOf(db, "client", c), undefined);
    assert.doesNotMatch(chunkOf(db, "task", t) ?? "", /푸른상사/);
  });

  it("사용자 정의 링크가 양쪽 카드에 들어간다", async () => {
    const { db, a, run } = setup();
    const x = run("client.create", { business_id: a, name: "소개자상사" });
    const y = run("client.create", { business_id: a, name: "신규카페" });
    run("link.create", { from: `client:${y}`, link_type: "referred_by", to: `client:${x}`, note: "대표 지인" });
    reindexAll(db);
    assert.match(chunkOf(db, "client", y)!, /소개자: CLT-\d+ 소개자상사 \(대표 지인\)/);
    assert.match(chunkOf(db, "client", x)!, /소개한 고객: CLT-\d+ 신규카페/);
  });

  it("워커 틱이 색인을 유지한다", async () => {
    const { db, a, run } = setup();
    await tick(db, { signals: false, schedules: false });
    run("note.create", { business_id: a, title: "급여 이체 절차", body: "## 매월 10일\n- 급여 대장 확인" });
    const r = await tick(db, { signals: false, schedules: false });
    assert.equal(r.indexed, 1);
    assert.equal(indexStats(db).lag, 0);
  });
});

describe("회상 검색 (recall)", () => {
  it("검색어 분석: 조사·어미를 떼고, 원형도 남기고, 끝 명사를 유형 힌트로", async () => {
    const { terms, refs, typeHint } = analyze("누가 카페 온도를 소개했나 CLT-0003");
    assert.deepEqual(terms.map((t) => t.text), ["카페", "온도", "소개"]);
    assert.deepEqual(terms[1].forms, ["온도를", "온도"]);
    assert.deepEqual(refs, [{ type: "client", id: 3 }]);
    assert.equal(typeHint, undefined);
    assert.equal(analyze("Acme 담당 업무").typeHint, "task");
    assert.equal(analyze("에이전트가 지켜야 할 규칙").typeHint, undefined, "끝 명사만 힌트");
  });

  it("2글자 한국어 · 조사 붙은 검색어 · 본문 구획 · 범위 제한", async () => {
    const { db, a, b, run } = setup();
    run("note.create", { business_id: a, title: "부가세 SOP", body: "# 절차\n## 검토\n매출 증감 20% 이상이면 사유 확인" });
    run("note.create", { business_id: b, title: "SaaS 가격표", body: "부가세 별도" });
    const r = await recall(db, { query: "부가세를 검토할 때 매출 증감", k: 5 });
    assert.equal(r.hits[0].title, "부가세 SOP");
    assert.ok(r.hits[0].why.includes("lexical"));
    assert.match(r.hits[0].snippet, /증감/);
    assert.ok(r.hits[0].matched.includes("증감"));
    // 범위: 다른 사업의 문서는 빠진다
    const scoped = await recall(db, { query: "부가세", scope: a });
    assert.ok(scoped.hits.every((h) => h.businessId === a || h.businessId === null));
    assert.ok(!scoped.hits.some((h) => h.title === "SaaS 가격표"));
  });

  it("필드 이름은 일치로 치지 않는다", async () => {
    const { db, a, run } = setup();
    run("task.create", { business_id: a, title: "장부 정리", due_date: "2026-10-01" });
    // "마감" 은 모든 업무 카드에 필드 이름으로 있지만 내용이 아니다
    assert.equal((await recall(db, { query: "마감" })).hits.length, 0);
  });

  it("관계: 직접 참조와 기준 객체 주변", async () => {
    const { db, a, run } = setup();
    const c = run("client.create", { business_id: a, name: "김민수" });
    const t = run("task.create", { business_id: a, client_id: c, title: "양도세 계산서 발송" });
    const byRef = await recall(db, { query: `CLT-${String(c).padStart(4, "0")}` });
    assert.equal(byRef.hits[0].key, `client:${c}`);
    assert.deepEqual(byRef.hits[0].why, ["ref"]);
    const g = byRef.hits.find((h) => h.key === `task:${t}`);
    assert.ok(g && g.why.includes("graph") && g.via, "참조한 고객의 업무가 관계로 따라온다");
    const around = await recall(db, { query: "계산서", about: { type: "client", id: c } });
    assert.equal(around.hits[0].key, `task:${t}`);
  });

  it("에이전트 도구 recall", async () => {
    const { db, a, run } = setup();
    run("client.create", { business_id: a, name: "Acme", memo: "SSO(SAML) 필수" });
    const { id } = createAgent(db, { name: "봇" });
    const agent: Actor = { type: "agent", id: String(id), name: "봇" };
    const out = await callTool(db, agent, "recall", { query: "SSO 요구하는 고객" }) as { hits: { ref: string; why: string[]; snippet: string }[] };
    assert.equal(out.hits[0].ref.split(":")[0], "client");
    assert.match(out.hits[0].snippet, /SSO/);
    await assert.rejects(() => callTool(db, agent, "recall", { query: "x", about: "client:999" }), /찾을 수 없습니다/);
  });

  it("골든셋 회귀: 예시 데이터에서 어휘·관계 질의는 모두 상위 5위 안", async () => {
    const db = openDb(":memory:");
    seedDemo(db);
    reindexAll(db);
    const cases = loadGolden("tests/fixtures/recall.jsonl");
    const s = await evaluate(db, cases, "hybrid");
    for (const kind of ["lexical", "relation", "ref"]) {
      assert.equal(s.byKind[kind].recallAt5, 1, `${kind}: ${s.cases.filter((c) => c.kind === kind && (c.rank ?? 99) > 5).map((c) => c.q).join(", ")}`);
    }
    assert.ok(s.mrr >= 0.8, `MRR ${s.mrr}`);
  });
});
