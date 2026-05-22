/**
 * 통합 테스트 - 외부 의존성(국가법령정보센터·Anthropic) 모두 mock.
 * 컨테이너의 네트워크 정책으로 실제 호출이 불가능한 환경에서
 * 파이프라인 전체 흐름이 의도대로 작동하는지 검증한다.
 *
 * 실행: npm test
 */

// 환경변수는 모듈 로드보다 먼저 세팅
process.env.LAW_OC = process.env.LAW_OC || "test-oc";
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { POST } from "../app/api/ask/route";
import { searchLaws, getLawBody } from "../lib/law";
import { extractKeywords, synthesizeAnswer } from "../lib/claude";

// ── fetch 가로채기 ──────────────────────────────────────────────────────────
const originalFetch = globalThis.fetch;
const lawSearchFixture = readFileSync(
  resolve(process.cwd(), "tests/fixtures/law-search.json"),
  "utf8",
);
const lawBodyFixture = readFileSync(
  resolve(process.cwd(), "tests/fixtures/law-body.json"),
  "utf8",
);

const callLog: { url: string; method: string }[] = [];

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

let claudeCallIndex = 0;
const claudeResponses: string[] = [
  // 1번째 호출: extractKeywords
  JSON.stringify({ keywords: ["소득세법", "1세대 1주택 비과세"] }),
  // 2번째 호출: synthesizeAnswer
  JSON.stringify({
    summary:
      "조정대상지역 내 1세대 1주택이 양도소득세 비과세를 받으려면 2년 이상 보유에 더해 2년 이상 거주 요건을 충족해야 합니다.",
    detail:
      "소득세법 제89조 제1항 제3호는 1세대 1주택의 양도에 대해 일정 요건을 충족하는 경우 양도소득세를 비과세한다고 규정합니다. 취득 당시 조정대상지역에 있는 주택은 보유기간 2년 + 거주기간 2년 요건을 모두 충족해야 합니다.",
    citations: [
      {
        lawName: "소득세법",
        article: "제89조 제1항 제3호",
        excerpt:
          "1세대가 양도일 현재 국내에 1주택을 보유하고 있는 경우로서 해당 주택의 보유기간이 2년 이상이고, 취득 당시 조정대상지역에 있는 주택의 경우 보유기간 중 거주기간이 2년 이상인 것",
      },
    ],
  }),
];

globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  callLog.push({ url, method });

  if (url.includes("/DRF/lawSearch.do")) {
    return jsonResponse(lawSearchFixture);
  }
  if (url.includes("/DRF/lawService.do")) {
    return jsonResponse(lawBodyFixture);
  }
  if (url.includes("api.anthropic.com")) {
    const text = claudeResponses[claudeCallIndex] ?? claudeResponses.at(-1)!;
    claudeCallIndex++;
    const body = {
      id: `msg_test_${claudeCallIndex}`,
      type: "message",
      role: "assistant",
      model: process.env.CLAUDE_MODEL,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 50 },
    };
    return jsonResponse(JSON.stringify(body));
  }
  // 알 수 없는 호출 → 즉시 실패시켜 누설 탐지
  throw new Error(`Unexpected fetch in test: ${method} ${url}`);
}) as typeof fetch;

// ── 테스트 ─────────────────────────────────────────────────────────────────

test("law.searchLaws: fixture를 파싱해서 hit 1건을 반환", async () => {
  const hits = await searchLaws("소득세법");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, "242350");
  assert.equal(hits[0].name, "소득세법");
  assert.equal(hits[0].ministry, "기획재정부");
});

test("law.getLawBody: 조문 2건 추출, 조문번호 0패딩 제거", async () => {
  const body = await getLawBody("242350");
  assert.equal(body.name, "소득세법");
  assert.equal(body.articles.length, 2);
  assert.match(body.articles[0].number, /^제89조/);
  assert.ok(body.articles[0].body.includes("1세대"));
  assert.match(body.articles[1].number, /^제95조/);
});

test("claude.extractKeywords: JSON 스키마 강제 + 코드펜스 파싱", async () => {
  claudeCallIndex = 0;
  const keywords = await extractKeywords("1세대 1주택 비과세 거주요건은?");
  assert.deepEqual(keywords, ["소득세법", "1세대 1주택 비과세"]);
});

test("claude.synthesizeAnswer: 인용 + 출처 URL 매칭", async () => {
  claudeCallIndex = 1; // synthesize 응답 사용
  const out = await synthesizeAnswer({
    question: "1세대 1주택 비과세 거주요건은?",
    lawContext: "# 소득세법 (MST=242350)\n## 제89조...",
    lawSources: [
      { name: "소득세법", id: "242350", url: "https://www.law.go.kr/lsInfoP.do?lsiSeq=242350" },
    ],
  });
  assert.ok(out.summary.length > 10);
  assert.equal(out.citations.length, 1);
  assert.equal(out.citations[0].lawName, "소득세법");
  assert.equal(
    out.citations[0].sourceUrl,
    "https://www.law.go.kr/lsInfoP.do?lsiSeq=242350",
  );
  assert.ok(out.disclaimer.includes("일반적 안내"));
  assert.equal(out.model, process.env.CLAUDE_MODEL);
});

test("API /api/ask: 전체 오케스트레이션 end-to-end", async () => {
  claudeCallIndex = 0;
  callLog.length = 0;

  const req = new Request("http://localhost/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "1세대 1주택 비과세 거주요건은?" }),
  });
  const res = await POST(req);
  assert.equal(res.status, 200);

  const data: any = await res.json();
  assert.equal(typeof data.summary, "string");
  assert.equal(typeof data.detail, "string");
  assert.ok(Array.isArray(data.citations));
  assert.equal(data.citations.length, 1);
  assert.equal(data.citations[0].lawName, "소득세법");
  assert.match(data.citations[0].article, /제89조/);
  assert.ok(data.citations[0].sourceUrl?.includes("242350"));
  assert.equal(data.question, "1세대 1주택 비과세 거주요건은?");
  assert.ok(data.generatedAt);
  assert.equal(data.model, process.env.CLAUDE_MODEL);

  // 호출 순서·횟수 검증
  const lawSearch = callLog.filter((c) => c.url.includes("lawSearch.do"));
  const lawBody = callLog.filter((c) => c.url.includes("lawService.do"));
  const claude = callLog.filter((c) => c.url.includes("api.anthropic.com"));
  assert.ok(lawSearch.length >= 1, "lawSearch 최소 1회 호출");
  assert.ok(lawBody.length >= 1, "lawService 최소 1회 호출");
  assert.equal(claude.length, 2, "Claude 정확히 2회 호출 (키워드 + 합성)");
});

test("API /api/ask: 빈 질문 → 400", async () => {
  const req = new Request("http://localhost/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "  " }),
  });
  const res = await POST(req);
  assert.equal(res.status, 400);
});

test("API /api/ask: 비-JSON 본문 → 400", async () => {
  const req = new Request("http://localhost/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not json",
  });
  const res = await POST(req);
  assert.equal(res.status, 400);
});

// 정리
test("teardown: fetch 복구", () => {
  globalThis.fetch = originalFetch;
});
