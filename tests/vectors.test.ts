import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { callTool } from "@/lib/agent/tools";
import { type DB, openDb } from "@/lib/db";
import { tick } from "@/lib/events/worker";
import { isLocalUrl, makeEmbedder } from "@/lib/knowledge/embed";
import { contentHash } from "@/lib/knowledge/cards";
import { embedPending, outageUntil } from "@/lib/knowledge/embedder";
import { INDEX_FORMAT, ensureIndexed, indexPending, reindexAll } from "@/lib/knowledge/indexer";
import { recall } from "@/lib/knowledge/recall";
import { REDACTED, redactSecrets } from "@/lib/knowledge/redact";
import { attachVectors, dot, gcVectors, knn, normalize, spaceCoverage, storeVectors, vecPathFor } from "@/lib/knowledge/vectors";
import { executeAction } from "@/lib/ontology/execute";
import { type Actor, ActionError, OPERATOR } from "@/lib/ontology/types";
import { createAgent } from "@/lib/repos/agents";
import { createBusiness } from "@/lib/repos/businesses";
import { activeSpace, getSpace } from "@/lib/repos/embeddings";
import { deleteSetting, getSetting, setSetting } from "@/lib/repos/settings";
import { freshDb } from "./helpers";

// ── 결정적 모의 임베더 ────────────────────────────────
// openai_compatible 응답을 흉내낸다: 문자 bigram 을 해시해 64차원에 ±1 로 더한 bag 벡터.
// 같은 bigram 을 많이 공유하는 텍스트끼리 가깝다 — 의미는 아니지만 결정적이고 순서가 분명하다.
const DIM = 64;

function bagVector(text: string, dim = DIM): number[] {
  const v = new Array(dim).fill(0);
  const s = text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
  for (let i = 0; i < s.length - 1; i++) {
    const h = crypto.createHash("md5").update(s.slice(i, i + 2)).digest();
    v[h[0] % dim] += h[1] & 1 ? 1 : -1;
  }
  return v;
}

type Mock = typeof fetch & { calls: { url: string; body: { model: string; input: string[] }; headers: Record<string, string> }[]; mode: "ok" | "500" | "401" | "down" | "hang" };

function mockFetch(dim = DIM): Mock {
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    f.calls.push({ url: String(url), body, headers: (init?.headers ?? {}) as Record<string, string> });
    if (f.mode === "down") throw new TypeError("fetch failed");
    // 연결은 받고 답하지 않는 공급자 (모델 적재 중 Ollama 등) — 시간 제한(signal)으로만 끝난다
    if (f.mode === "hang")
      return new Promise<Response>((_, reject) => {
        const sig = init?.signal;
        sig?.addEventListener("abort", () => reject(sig.reason));
      });
    if (f.mode === "500") return new Response("upstream overloaded", { status: 500 });
    // 서버가 받은 인증 헤더를 그대로 되비추는 최악의 공급자 — 오류 문구에 키가 새면 안 된다
    if (f.mode === "401") return new Response(`invalid key: ${(init?.headers as Record<string, string>).authorization}`, { status: 401 });
    return Response.json({ data: (body.input as string[]).map((t, index) => ({ index, embedding: bagVector(t, dim) })) });
  }) as Mock;
  f.calls = [];
  f.mode = "ok";
  return f;
}

const run = (db: DB, action: string, params: Record<string, unknown>, actor: Actor = OPERATOR) => {
  const r = executeAction(db, { actor, action, params, reason: "test" });
  assert.equal(r.status, "applied", r.error ?? "");
  return r;
};

function setup() {
  const { db, a, b } = freshDb();
  run(db, "client.create", { business_id: a, name: "하늘상사", memo: "전자세금계산서 월말 일괄 발행" });
  run(db, "note.create", { business_id: a, title: "클라우드 인프라 비용", body: "## 서버\nAWS EC2 인스턴스 요금과 S3 저장 비용 정리\n## 도메인\n가비아 갱신" });
  run(db, "note.create", { business_id: b, title: "SaaS 가격표", body: "Business plan 좌석당 29달러, 연 선결제 10% 할인" });
  run(db, "task.create", { business_id: a, title: "원천세 신고", due_date: "2026-10-10" });
  reindexAll(db);
  const fetchImpl = mockFetch();
  return { db, a, b, fetchImpl };
}

function createSpace(db: DB, extra: Record<string, unknown> = {}) {
  const r = run(db, "embedding.space_create", { name: "테스트 공간", provider: "openai_compatible", model: "bag64", base_url: "http://127.0.0.1:9/v1", ...extra });
  return Number((r.result!.data as { space_id: number }).space_id);
}

async function fillAll(db: DB, fetchImpl: Mock) {
  let n = 0;
  for (;;) {
    const r = await embedPending(db, { fetchImpl });
    assert.deepEqual(r.errors, []);
    if (!r.embedded) return n;
    n += r.embedded;
  }
}

const distinctHashes = (db: DB) => (db.prepare("SELECT COUNT(DISTINCT content_hash) AS n FROM chunks").get() as { n: number }).n;
const vecCount = (db: DB, spaceId: number) => (db.prepare("SELECT COUNT(*) AS n FROM vec.vectors WHERE space_id = ?").get(spaceId) as { n: number }).n;
const hasKnn = (db: DB, spaceId: number) => !!db.prepare("SELECT 1 FROM vec.sqlite_master WHERE name = ?").get(`knn_${spaceId}`);

describe("벡터 저장소 · 임베딩 워커", () => {
  it("벡터 파일 경로: 본 DB 옆 <이름>-vec.db, 메모리는 메모리", () => {
    assert.equal(vecPathFor("/srv/data/now.db", {}), "/srv/data/now-vec.db");
    assert.equal(vecPathFor(":memory:", { NOW_VEC_PATH: "/x/y.db" }), ":memory:");
    assert.equal(vecPathFor("/srv/data/now.db", { NOW_VEC_PATH: "/x/y.db" }), "/x/y.db");
  });

  it("embedPending 이 모든 고유 해시를 채우고, 두 번째 실행은 0 · 차원 자동 확정", async () => {
    const { db, fetchImpl } = setup();
    const id = createSpace(db);
    assert.equal(getSpace(db, id)!.dim, 0);
    const n = await fillAll(db, fetchImpl);
    assert.equal(n, distinctHashes(db));
    assert.equal(getSpace(db, id)!.dim, DIM);
    assert.equal(spaceCoverage(db, id).pct, 100);
    const calls = fetchImpl.calls.length;
    assert.equal((await embedPending(db, { fetchImpl })).embedded, 0);
    assert.equal(fetchImpl.calls.length, calls, "채워진 공간은 공급자를 부르지 않는다");
    // 같은 텍스트(같은 해시)는 한 번만 — 내용이 같은 청크를 하나 더 만들어도 새 임베딩 없음
    db.prepare("INSERT INTO chunks (owner_type, owner_id, business_id, seq, head, text, tokens, content_hash) SELECT 'synthetic', 1, NULL, 0, head, text, tokens, content_hash FROM chunks LIMIT 1").run();
    assert.equal((await embedPending(db, { fetchImpl })).embedded, 0);
    // 요청 형식: openai 호환 /embeddings, 배치
    assert.match(fetchImpl.calls[0].url, /\/v1\/embeddings$/);
    assert.equal(fetchImpl.calls[0].body.model, "bag64");
  });

  it("knn: 작은 집합에서 bit 후보 → float 재정렬 결과가 정확한 내적 순서와 같다", () => {
    const { db } = freshDb();
    assert.ok(attachVectors(db));
    const id = Number(db.prepare("INSERT INTO embedding_spaces (name, provider, model, dim) VALUES ('k', 'ollama', 'x', ?)").run(DIM).lastInsertRowid);
    const texts = Array.from({ length: 60 }, (_, i) => `문서 ${i} ${"가나다라마바사아자차카타파하".slice(i % 7, (i % 7) + 5)} ${i * 37}`);
    const items = texts.map((t, i) => ({ hash: `h${i}`, vec: normalize(bagVector(t)) }));
    assert.equal(storeVectors(db, { id, dim: DIM }, items), 60);
    assert.equal(storeVectors(db, { id, dim: DIM }, items), 0, "멱등");
    for (const qt of ["문서 3 라마바", "파하 999", "사아자차"]) {
      const q = normalize(bagVector(qt));
      const exact = items.map((it) => ({ hash: it.hash, score: dot(q, it.vec) })).sort((a, b) => b.score - a.score || a.hash.localeCompare(b.hash)).slice(0, 10);
      const got = knn(db, { id, dim: DIM }, q, 10);
      assert.deepEqual(got.map((g) => g.hash), exact.map((e) => e.hash));
      assert.ok(Math.abs(got[0].score - exact[0].score) < 1e-5);
    }
  });

  it("recall: hybrid 에 의미 목록이 들어가고 why 에 semantic · similarity, mode vector 는 의미만", async () => {
    const { db, fetchImpl } = setup();
    const id = createSpace(db);
    await fillAll(db, fetchImpl);
    run(db, "embedding.activate", { id });
    const r = await recall(db, { query: "클라우드 인프라 비용", k: 5 }, { fetchImpl });
    assert.deepEqual(r.vector, { space: "테스트 공간", model: "bag64" });
    assert.equal(r.degraded, undefined);
    const top = r.hits[0];
    assert.equal(top.title, "클라우드 인프라 비용");
    assert.ok(top.why.includes("semantic") && top.why.includes("lexical"), top.why.join(","));
    assert.ok(typeof top.similarity === "number" && top.similarity > 0.5);

    const v = await recall(db, { query: "인프라 요금 정리", k: 5, mode: "vector" }, { fetchImpl });
    assert.ok(v.hits.length > 0);
    assert.ok(v.hits.every((h) => h.why.length === 1 && h.why[0] === "semantic" && h.similarity !== undefined));
    // 질의 임베딩만 요청 경로에서 — kind=query 1회, 같은 질의는 캐시
    const before = fetchImpl.calls.length;
    await recall(db, { query: "인프라 요금 정리", k: 5, mode: "vector" }, { fetchImpl });
    assert.equal(fetchImpl.calls.length, before, "질의 임베딩 캐시");
    // 어휘 모드는 임베딩하지 않는다
    const lex = await recall(db, { query: "새로운 질의 문장", mode: "lexical" }, { fetchImpl });
    assert.equal(fetchImpl.calls.length, before);
    assert.ok(lex.hits.every((h) => !h.why.includes("semantic")));

    // 에이전트 도구: 같은 질의(캐시됨)의 similarity · vector 정보
    const agentId = createAgent(db, { name: "봇" }).id;
    const out = (await callTool(db, { type: "agent", id: String(agentId), name: "봇" }, "recall", { query: "클라우드 인프라 비용" })) as { vector: unknown; hits: { why: string[]; similarity?: number }[] };
    assert.deepEqual(out.vector, { space: "테스트 공간", model: "bag64" });
    assert.ok(out.hits.some((h) => h.why.includes("semantic") && typeof h.similarity === "number"));
  });

  it("공간 교체: 새 공간 building → 채움 → 활성화 → 이전 공간 retired → gc 로 이전 벡터·knn 삭제", async () => {
    const { db, fetchImpl } = setup();
    const a = createSpace(db, { name: "A" });
    await fillAll(db, fetchImpl);
    run(db, "embedding.activate", { id: a });
    const b = createSpace(db, { name: "B", model: "bag64-v2" });
    // 채우기 전에는 활성화 거부 (force 없이)
    assert.throws(() => executeAction(db, { actor: OPERATOR, action: "embedding.activate", params: { id: b } }), ActionError);
    await fillAll(db, fetchImpl);
    assert.equal(activeSpace(db)!.id, a, "채우는 동안에도 검색은 이전 공간으로");
    const r = run(db, "embedding.activate", { id: b });
    assert.match(r.result!.summary, /이전 'A' 폐기/);
    assert.equal(getSpace(db, a)!.status, "retired");
    assert.equal(activeSpace(db)!.id, b);
    assert.ok(vecCount(db, a) > 0 && hasKnn(db, a));
    const gc = gcVectors(db);
    assert.equal(gc.dropped, 1);
    assert.equal(vecCount(db, a), 0);
    assert.ok(!hasKnn(db, a));
    assert.ok(vecCount(db, b) > 0 && hasKnn(db, b), "활성 공간은 그대로");
    // 폐기 공간은 더 채우지 않는다
    run(db, "note.create", { title: "새 문서", body: "새 본문" });
    indexPending(db);
    await embedPending(db, { fetchImpl });
    assert.equal(vecCount(db, a), 0);
  });

  it("auto_activate: 활성 공간이 없을 때 다 차면 시스템 액션으로 활성화 (감사 기록)", async () => {
    const { db, fetchImpl } = setup();
    const id = createSpace(db, { auto_activate: true });
    let activated: number[] = [];
    for (;;) {
      const r = await embedPending(db, { fetchImpl });
      activated = [...activated, ...r.activated];
      if (!r.embedded) break;
    }
    assert.deepEqual(activated, [id]);
    assert.equal(getSpace(db, id)!.status, "active");
    const audit = db.prepare("SELECT actor_type, status, reason FROM action_runs WHERE action = 'embedding.activate'").all() as { actor_type: string; status: string; reason: string }[];
    assert.deepEqual(audit, [{ actor_type: "system", status: "applied", reason: "자동 활성화: 임베딩 완료" }]);
    // 이미 활성 공간이 있으면 다른 auto 공간은 자동 활성화하지 않는다
    const other = createSpace(db, { name: "두 번째", auto_activate: true });
    await fillAll(db, fetchImpl);
    assert.equal(getSpace(db, other)!.status, "building");
  });

  it("워커 틱이 색인 다음에 임베딩한다 (끌 수 있다)", async () => {
    const { db, fetchImpl } = setup();
    createSpace(db);
    assert.equal((await tick(db, { signals: false, schedules: false, embed: false, fetchImpl })).embedded, 0);
    const r = await tick(db, { signals: false, schedules: false, fetchImpl });
    assert.equal(r.embedded, distinctHashes(db));
  });

  it("공급자 오류 → last_error 기록 · 백오프, 질의는 degraded 로 어휘 결과", async () => {
    const { db, fetchImpl } = setup();
    const id = createSpace(db);
    await fillAll(db, fetchImpl);
    run(db, "embedding.activate", { id });
    run(db, "note.create", { title: "장애 중 추가된 문서", body: "본문" });
    indexPending(db);

    fetchImpl.mode = "500";
    const now = new Date("2026-09-28T00:00:00Z");
    const r = await embedPending(db, { fetchImpl, now });
    assert.equal(r.embedded, 0);
    assert.equal(r.errors.length, 1);
    assert.match(getSpace(db, id)!.last_error!, /HTTP 500/);
    assert.equal(getSetting(db, `embed_backoff:${id}`), "2026-09-28T00:01:00.000Z", "1분 백오프");
    const calls = fetchImpl.calls.length;
    await embedPending(db, { fetchImpl, now: new Date("2026-09-28T00:00:30Z") });
    assert.equal(fetchImpl.calls.length, calls, "백오프 중에는 호출하지 않는다");
    await embedPending(db, { fetchImpl, now: new Date("2026-09-28T00:01:01Z") });
    assert.equal(getSetting(db, `embed_backoff:${id}`), "2026-09-28T00:03:01.000Z", "두 번째 실패는 2분");

    const q = await recall(db, { query: "하늘상사 세금계산서" }, { fetchImpl });
    assert.match(q.degraded ?? "", /질의 임베딩 실패/);
    assert.equal(q.hits[0].title, "하늘상사");
    assert.deepEqual(q.hits[0].why.filter((w) => w === "semantic"), []);

    // 복구되면 오류·백오프를 지운다
    fetchImpl.mode = "ok";
    const ok = await embedPending(db, { fetchImpl, now: new Date("2026-09-28T01:00:00Z") });
    assert.ok(ok.embedded >= 1);
    assert.equal(getSpace(db, id)!.last_error, null);
    assert.equal(getSetting(db, `embed_backoff:${id}`), undefined);
  });

  it("오류 문구: 키 값을 담지 않고, Ollama 연결 실패는 행동 가능한 문구", async () => {
    const f = mockFetch();
    f.mode = "401";
    const secret = "sk-test-0123456789abcdefghij";
    const e1 = makeEmbedder({ provider: "openai", model: "text-embedding-3-small", dim: 0, base_url: "", api_key_env: "TEST_EMBED_KEY", query_prefix: "", passage_prefix: "" }, { fetchImpl: f, env: { TEST_EMBED_KEY: secret } });
    await assert.rejects(e1.embed(["x"], "query"), (err: Error) => !err.message.includes(secret) && /TEST_EMBED_KEY/.test(err.message));
    assert.equal(f.calls[0].headers.authorization, `Bearer ${secret}`);
    // openai 는 키 필수 (요청 전에 거부)
    const e2 = makeEmbedder({ provider: "openai", model: "m", dim: 0, base_url: "", api_key_env: "", query_prefix: "", passage_prefix: "" }, { fetchImpl: f, env: {} });
    await assert.rejects(e2.embed(["x"], "query"), /OPENAI_API_KEY/);
    f.mode = "down";
    const e3 = makeEmbedder({ provider: "ollama", model: "bge-m3", dim: 0, base_url: "", api_key_env: "", query_prefix: "", passage_prefix: "" }, { fetchImpl: f, env: {} });
    await assert.rejects(e3.embed(["x"], "passage"), /Ollama\(http:\/\/127\.0\.0\.1:11434\)에 연결할 수 없습니다 — `ollama pull bge-m3`/);
    // 접두사 · 차원 불일치
    f.mode = "ok";
    const e4 = makeEmbedder({ provider: "openai_compatible", model: "m", dim: 32, base_url: "http://127.0.0.1:9/v1", api_key_env: "", query_prefix: "query: ", passage_prefix: "passage: " }, { fetchImpl: f, env: {} });
    await assert.rejects(e4.embed(["안녕"], "query"), /차원 64 ≠ 공간 차원 32/);
    assert.equal(f.calls.at(-1)!.body.input[0], "query: 안녕");
  });

  it("청크가 삭제되면 gc 가 그 벡터를 지운다", async () => {
    const { db, fetchImpl } = setup();
    const id = createSpace(db);
    await fillAll(db, fetchImpl);
    const before = vecCount(db, id);
    const note = db.prepare("SELECT id FROM notes WHERE title = 'SaaS 가격표'").get() as { id: number };
    const hashes = (db.prepare("SELECT content_hash FROM chunks WHERE owner_type = 'note' AND owner_id = ?").all(note.id) as { content_hash: string }[]).map((r) => r.content_hash);
    run(db, "note.delete", { id: note.id });
    indexPending(db);
    const gc = gcVectors(db);
    assert.equal(gc.removed, hashes.length);
    assert.equal(vecCount(db, id), before - hashes.length);
    assert.equal(spaceCoverage(db, id).pct, 100);
  });

  it("NOW_VECTORS=off 면 어휘 + 관계로만 (공급자 호출 없음)", async () => {
    const { db, fetchImpl } = setup();
    const id = createSpace(db);
    await fillAll(db, fetchImpl);
    run(db, "embedding.activate", { id });
    const calls = fetchImpl.calls.length;
    const off = { NOW_VECTORS: "off" };
    const r = await recall(db, { query: "완전히 새로운 클라우드 질의" }, { fetchImpl, env: off });
    assert.equal(r.vector, null);
    assert.ok(r.hits.every((h) => !h.why.includes("semantic")));
    assert.equal((await embedPending(db, { fetchImpl, env: off })).embedded, 0);
    assert.equal(fetchImpl.calls.length, calls);
  });
});

describe("임베딩 공간 액션", () => {
  it("위험도: 외부 공급자는 high, 로컬은 low · 에이전트는 거부(humanOnly) · 입력 검증", () => {
    const { db } = freshDb();
    const ext = executeAction(db, { actor: OPERATOR, action: "embedding.space_create", params: { name: "OpenAI", provider: "openai", model: "text-embedding-3-small" } });
    assert.equal(ext.risk, "high");
    assert.match(ext.result!.summary, /외부 전송 — 사업 데이터 본문이 api\.openai\.com 로 나감/);
    assert.equal(getSpace(db, (ext.result!.data as { space_id: number }).space_id)!.local_only, 0);
    const loc = executeAction(db, { actor: OPERATOR, action: "embedding.space_create", params: { name: "로컬", provider: "ollama", model: "bge-m3" } });
    assert.equal(loc.risk, "low");
    assert.match(loc.result!.summary, /로컬 — 본문이 이 기기\/사설망을 떠나지 않음/);
    // OpenAI 호환이라도 외부 주소면 외부
    const compat = executeAction(db, { actor: OPERATOR, action: "embedding.space_create", params: { name: "원격 vLLM", provider: "openai_compatible", model: "e5", base_url: "https://embed.example.com/v1", query_prefix: "query:", passage_prefix: "passage:" } });
    assert.equal(compat.risk, "high");
    const sp = getSpace(db, (compat.result!.data as { space_id: number }).space_id)!;
    assert.equal(sp.query_prefix, "query: ", "콜론으로 끝나는 접두사에는 공백 한 칸");
    // 활성화 위험도도 공간의 전송 여부를 따른다
    assert.equal(executeAction(db, { actor: OPERATOR, action: "embedding.retire", params: { id: sp.id } }).risk, "low");

    const { id: agentId } = createAgent(db, { name: "봇" });
    const agent: Actor = { type: "agent", id: String(agentId), name: "봇" };
    for (const [action, params] of [
      ["embedding.space_create", { name: "x", provider: "ollama", model: "bge-m3" }],
      ["embedding.activate", { id: 1, force: true }],
      ["embedding.retire", { id: 1 }],
    ] as const) {
      assert.equal(executeAction(db, { actor: agent, action, params, reason: "시도" }).status, "denied", action);
    }
    assert.throws(() => executeAction(db, { actor: OPERATOR, action: "embedding.space_create", params: { name: "x", provider: "openai", model: "m", api_key_env: "sk-abcdef" } }), /환경변수 이름만/);
    assert.throws(() => executeAction(db, { actor: OPERATOR, action: "embedding.space_create", params: { name: "x", provider: "ollama", model: "m", base_url: "ftp://nas" } }), /http\(s\)/);
    assert.throws(() => executeAction(db, { actor: OPERATOR, action: "embedding.space_create", params: { name: "x", provider: "openai_compatible", model: "m" } }), /Base URL 이 필요/);
  });

  it("isLocalUrl: 루프백 · 사설망 · .local · host.docker.internal", () => {
    for (const u of ["http://localhost:11434", "http://127.0.0.1:8088/v1", "http://[::1]:8080", "http://10.0.0.5", "http://172.20.1.1", "http://192.168.0.10:1234/v1", "http://nas.local:11434", "http://host.docker.internal:11434"]) assert.ok(isLocalUrl(u), u);
    for (const u of ["https://api.openai.com/v1", "http://172.32.0.1", "http://8.8.8.8", "http://example.com", "not a url"]) assert.ok(!isLocalUrl(u), u);
  });
});

describe("비밀값 가림", () => {
  it("redactSecrets: 토큰 · 키 · 개인 키 · 할당문", () => {
    const s = redactSecrets(
      "토큰 nows_AbCdEf123456 와 now_abcdefgh1234\nOpenAI sk-proj-abcdefghijklmnop1234 AWS AKIAABCDEFGHIJKLMNOP\nAuthorization: Bearer abc.def-ghi_jklmnopqrs\npassword: hunter2hunter2\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\nrisk-free 업무는 그대로",
    );
    for (const secret of ["nows_AbCdEf123456", "now_abcdefgh1234", "sk-proj-abcdefghijklmnop1234", "AKIAABCDEFGHIJKLMNOP", "abc.def-ghi_jklmnopqrs", "hunter2hunter2", "MIIE"]) assert.ok(!s.includes(secret), secret);
    assert.match(s, /password: \[비밀값 가림\]/);
    assert.match(s, /risk-free 업무는 그대로/);
    assert.equal(redactSecrets("평범한 문장"), "평범한 문장");
  });

  it("redactSecrets: .env 형태(밑줄 접두 키 이름)도 가린다 — 키 이름은 남긴다", () => {
    const cases: [string, string][] = [
      ["DB_PASSWORD=hunter2hunter2", "DB_PASSWORD="],
      ["STRIPE_SECRET=rk_live_abcdef123456", "STRIPE_SECRET="],
      ["GITHUB_TOKEN=ghp_abcdef1234567890", "GITHUB_TOKEN="],
      ["MY_API_KEY: abcdef123456", "MY_API_KEY: "],
      ["OPENAI_API_KEY=abcdefgh1234", "OPENAI_API_KEY="],
      ["client_secret=abcdef123456", "client_secret="],
      ["access_token: abcdef123456", "access_token: "],
      ["db-password=abcdef123456", "db-password="],
    ];
    for (const [input, key] of cases) assert.equal(redactSecrets(input), `${key}${REDACTED}`, input);
    // 붙은 이름도 가린다 (덜 가리는 쪽이 더 나쁘다) · 할당이 아니면 그대로
    assert.equal(redactSecrets("mysecret=abcdefgh"), `mysecret=${REDACTED}`);
    for (const plain of ["tokens: 1234567 used", "password: 짧음", "비밀번호 없음"]) assert.equal(redactSecrets(plain), plain);
  });

  it("청크와 임베딩 공급자에 원문 비밀이 가지 않는다", async () => {
    const { db, a, fetchImpl } = setup();
    run(db, "note.create", { business_id: a, title: "서버 접속 정보", body: "에이전트 토큰 nows_Zx9Yw8Vu7Ts6 · OpenAI sk-live-ZZZZZZZZZZZZZZZZZZZZ 는 금고에" });
    indexPending(db);
    const text = (db.prepare("SELECT GROUP_CONCAT(text, '\n') AS t FROM chunks").get() as { t: string }).t;
    assert.ok(!text.includes("nows_Zx9Yw8Vu7Ts6") && !text.includes("sk-live-ZZZZ"));
    assert.ok(text.includes(REDACTED));
    createSpace(db);
    await fillAll(db, fetchImpl);
    const sent = fetchImpl.calls.flatMap((c) => c.body.input).join("\n");
    assert.ok(sent.includes("서버 접속 정보"));
    assert.ok(!sent.includes("nows_Zx9Yw8Vu7Ts6") && !sent.includes("sk-live-ZZZZ"));
    // 가린 뒤에도 제목으로는 찾을 수 있다
    assert.equal((await recall(db, { query: "서버 접속 정보", mode: "lexical" })).hits[0].title, "서버 접속 정보");
  });
});

describe("업그레이드 · 장애 경로", () => {
  it("M1 에서 가리지 않고 색인된 청크: 색인 형식이 바뀌면 임베딩보다 먼저 전체 재색인한다", async () => {
    const { db, a, fetchImpl } = setup();
    run(db, "note.create", { business_id: a, title: "배포 메모", body: "배포 키" });
    reindexAll(db);
    // M1 상태를 흉내: 원문 비밀이 든 청크(원문 해시) · 형식 표식 없음 · 스윕은 방금 (주기 스윕 안 함)
    const raw = "배포 메모\napi_key: sk-abcdefghijklmnopqrstuvwxyz0123 · DB_PASSWORD=hunter2hunter2";
    const row = db.prepare("SELECT c.id FROM chunks c JOIN notes n ON c.owner_type = 'note' AND c.owner_id = n.id WHERE n.title = '배포 메모' AND c.seq = 0").get() as { id: number };
    db.prepare("UPDATE chunks SET text = ?, content_hash = ? WHERE id = ?").run(raw, contentHash(raw), row.id);
    deleteSetting(db, "index_format");
    assert.equal(getSetting(db, "index_swept_at") !== undefined, true);
    createSpace(db, { provider: "openai", base_url: "", api_key_env: "TEST_KEY" });
    const r = await tick(db, { signals: false, schedules: false, fetchImpl, env: { TEST_KEY: "k-123456" } });
    assert.ok(r.embedded > 0);
    const sent = fetchImpl.calls.flatMap((c) => c.body.input).join("\n");
    assert.ok(!sent.includes("sk-abcdefghijklmnopqrstuvwxyz0123") && !sent.includes("hunter2hunter2"), "외부 공급자로 원문 비밀이 가지 않는다");
    const text = (db.prepare("SELECT GROUP_CONCAT(text, '\n') AS t FROM chunks").get() as { t: string }).t;
    assert.ok(!text.includes("sk-abcdefghijklmnopqrstuvwxyz0123"), "FTS 청크도 다시 쓰였다");
    assert.equal(getSetting(db, "index_format"), INDEX_FORMAT);
    // 요청 경로(워커 없이)도 같은 규칙
    deleteSetting(db, "index_format");
    ensureIndexed(db);
    assert.equal(getSetting(db, "index_format"), INDEX_FORMAT);
  });

  it("embedPending 은 보내기 직전에 한 번 더 가린다 (재색인 전 청크가 남아 있어도)", async () => {
    const { db, fetchImpl } = setup();
    const raw = "남은 청크 GITHUB_TOKEN=ghp_abcdef1234567890 nows_Zx9Yw8Vu7Ts6";
    db.prepare("INSERT INTO chunks (owner_type, owner_id, business_id, seq, head, text, tokens, content_hash) VALUES ('note', 999, NULL, 0, 'x', ?, 10, ?)").run(raw, contentHash(raw));
    const id = createSpace(db);
    await fillAll(db, fetchImpl);
    const sent = fetchImpl.calls.flatMap((c) => c.body.input).join("\n");
    assert.ok(sent.includes("남은 청크"));
    assert.ok(!sent.includes("ghp_abcdef1234567890") && !sent.includes("nows_Zx9Yw8Vu7Ts6"));
    // 해시는 청크의 것 그대로 — 다시 보내지 않는다
    assert.ok(db.prepare("SELECT 1 FROM vec.vectors WHERE space_id = ? AND content_hash = ?").get(id, contentHash(raw)));
  });

  it("본 DB 만 새로 만들면: 벡터 파일에 남은 같은 id 공간의 벡터·knn 을 버리고 새로 채운다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "now-vec-"));
    const file = path.join(dir, "now.db");
    const saved = process.env.NOW_VEC_PATH;
    delete process.env.NOW_VEC_PATH;
    const seed = (d: DB) => {
      const biz = createBusiness(d, { name: "사업", kind: "기타", color: "#0ea5e9", currency: "KRW" });
      run(d, "note.create", { business_id: biz, title: "클라우드 인프라 비용", body: "AWS EC2 인스턴스 요금" });
      run(d, "note.create", { business_id: biz, title: "SaaS 가격표", body: "좌석당 29달러" });
      reindexAll(d);
    };
    try {
      const db1 = openDb(file);
      seed(db1);
      const s1 = createSpace(db1);
      await fillAll(db1, mockFetch(64));
      run(db1, "embedding.activate", { id: s1 });
      db1.close();
      for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
      assert.ok(fs.existsSync(path.join(dir, "now-vec.db")), "벡터 파일은 남아 있다");

      const db2 = openDb(file);
      seed(db2);
      const f32 = mockFetch(32);
      const s2 = createSpace(db2, { model: "bag32" });
      assert.equal(s2, s1, "같은 id 가 되풀이된다");
      const n = await fillAll(db2, f32);
      assert.equal(n, distinctHashes(db2), "옛 모델 벡터를 '이미 임베딩됨'으로 보지 않는다");
      assert.equal(getSpace(db2, s2)!.dim, 32);
      assert.equal(getSpace(db2, s2)!.last_error, null);
      run(db2, "embedding.activate", { id: s2 });
      run(db2, "note.create", { title: "새 문서", body: "새 본문" });
      indexPending(db2);
      assert.deepEqual((await embedPending(db2, { fetchImpl: f32 })).errors, [], "옛 차원 knn 테이블로 실패하지 않는다");
      const r = await recall(db2, { query: "클라우드 인프라 비용", k: 5 }, { fetchImpl: f32 });
      assert.equal(r.degraded, undefined);
      assert.ok(r.hits.some((h) => h.why.includes("semantic")));
      db2.close();
    } finally {
      if (saved !== undefined) process.env.NOW_VEC_PATH = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("벡터 저장소 오류는 recall 을 죽이지 않고 degraded 로 강등한다", async () => {
    const { db, fetchImpl } = setup();
    const id = createSpace(db);
    await fillAll(db, fetchImpl);
    run(db, "embedding.activate", { id });
    db.exec("DROP TABLE vec.vectors");
    const r = await recall(db, { query: "하늘상사 세금계산서" }, { fetchImpl });
    assert.match(r.degraded ?? "", /벡터 검색 실패/);
    assert.equal(r.hits[0].title, "하늘상사");
  });

  it("공급자가 멈추면 질의 임베딩은 짧은 시간 제한 뒤 강등하고, 잠시 다시 묻지 않는다", async (t) => {
    const { db, fetchImpl } = setup();
    const id = createSpace(db, { name: "멈춤 공간" });
    await fillAll(db, fetchImpl);
    run(db, "embedding.activate", { id });
    fetchImpl.mode = "hang";
    // AbortSignal.timeout 의 타이머는 unref 다 — 실제 fetch 는 소켓이 루프를 붙잡지만 모의 fetch 는 아니므로 테스트가 붙잡는다
    const keepAlive = setInterval(() => {}, 1000);
    t.after(() => clearInterval(keepAlive));
    const t0 = Date.now();
    const r1 = await recall(db, { query: "하늘상사 세금계산서" }, { fetchImpl, queryTimeoutMs: 50 });
    assert.ok(Date.now() - t0 < 2000);
    assert.match(r1.degraded ?? "", /시간 초과/);
    assert.equal(r1.hits[0].title, "하늘상사");
    const calls = fetchImpl.calls.length;
    const r2 = await recall(db, { query: "다른 질의 원천세" }, { fetchImpl, queryTimeoutMs: 50 });
    assert.equal(fetchImpl.calls.length, calls, "최근 실패는 기억한다");
    assert.match(r2.degraded ?? "", /최근 실패/);
  });

  it("워커가 공급자 장애를 확인하면 recall 은 공급자를 부르지 않고 바로 강등한다 (4xx 는 해당 없음)", async () => {
    const { db, fetchImpl } = setup();
    const id = createSpace(db, { name: "장애 공간" });
    await fillAll(db, fetchImpl);
    run(db, "embedding.activate", { id });
    run(db, "note.create", { title: "장애 중 문서", body: "본문" });
    indexPending(db);
    fetchImpl.mode = "down";
    await embedPending(db, { fetchImpl });
    assert.ok(outageUntil(db, id));
    const calls = fetchImpl.calls.length;
    const r = await recall(db, { query: "하늘상사 세금계산서" }, { fetchImpl });
    assert.equal(fetchImpl.calls.length, calls);
    assert.match(r.degraded ?? "", /공급자 장애/);
    assert.equal(r.hits[0].title, "하늘상사");
    // 인증 실패(401)는 공급자 장애가 아니다 — 백오프는 하되 질의는 시도한다
    setSetting(db, `embed_backoff:${id}`, "2000-01-01T00:00:00.000Z");
    fetchImpl.mode = "401";
    await embedPending(db, { fetchImpl });
    assert.equal(outageUntil(db, id), undefined);
    fetchImpl.mode = "ok";
    const ok = await recall(db, { query: "클라우드 인프라 비용" }, { fetchImpl });
    assert.equal(ok.degraded, undefined);
  });

  it("한 글자 질의도 의미 검색 — 식별자만 있는 질의는 건너뛰되 활성 공간은 알린다", async () => {
    const { db, fetchImpl } = setup();
    const id = createSpace(db);
    await fillAll(db, fetchImpl);
    run(db, "embedding.activate", { id });
    const before = fetchImpl.calls.length;
    const r = await recall(db, { query: "돈", mode: "vector" }, { fetchImpl });
    assert.equal(fetchImpl.calls.length, before + 1, "질의를 임베딩했다");
    assert.deepEqual(r.vector, { space: "테스트 공간", model: "bag64" });
    const clt = db.prepare("SELECT id FROM clients LIMIT 1").get() as { id: number };
    const idOnly = await recall(db, { query: `CLT-${String(clt.id).padStart(4, "0")}` }, { fetchImpl });
    assert.equal(fetchImpl.calls.length, before + 1, "식별자만 있는 질의는 임베딩하지 않는다");
    assert.deepEqual(idOnly.vector, { space: "테스트 공간", model: "bag64" });
    assert.equal(idOnly.hits[0].title, "하늘상사");
  });
});
