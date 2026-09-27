import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { probe } from "@/lib/infra/probe";

const respond = (status: number) => (async () => new Response(null, { status })) as typeof fetch;

describe("infra probe", () => {
  it("헬스 URL 이 없으면 unknown", async () => {
    const r = await probe({ health_url: "", credential_env: "" });
    assert.equal(r.status, "unknown");
  });

  it("HTTP 상태 코드로 판정한다", async () => {
    const conn = { health_url: "https://x.test/health", credential_env: "" };
    assert.equal((await probe(conn, { fetchImpl: respond(200) })).status, "ok");
    assert.equal((await probe(conn, { fetchImpl: respond(302) })).status, "ok");
    assert.equal((await probe(conn, { fetchImpl: respond(403) })).status, "degraded");
    assert.equal((await probe(conn, { fetchImpl: respond(503) })).status, "down");
  });

  it("네트워크 오류는 down", async () => {
    const fail = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    const r = await probe({ health_url: "https://x.test", credential_env: "" }, { fetchImpl: fail });
    assert.equal(r.status, "down");
    assert.match(r.message, /연결 실패/);
  });

  it("자격증명 환경변수가 없으면 ok 를 degraded 로 낮춘다 (값은 노출하지 않음)", async () => {
    const conn = { health_url: "https://x.test", credential_env: "AWS_KEY" };
    const missing = await probe(conn, { env: {}, fetchImpl: respond(200) });
    assert.equal(missing.status, "degraded");
    assert.match(missing.message, /AWS_KEY 미설정/);

    const present = await probe(conn, { env: { AWS_KEY: "secret-value" }, fetchImpl: respond(200) });
    assert.equal(present.status, "ok");
    assert.doesNotMatch(present.message, /secret-value/);

    const noUrl = await probe({ health_url: "", credential_env: "AWS_KEY" }, { env: {} });
    assert.equal(noUrl.status, "degraded");
  });
});
