import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addMonths, daysBetween } from "@/lib/dates";
import { formatMoney, parseMoney } from "@/lib/money";
import { migrations } from "@/lib/db/migrations";
import { migrate, openDb } from "@/lib/db";

describe("dates", () => {
  it("월 이동 시 말일을 보정한다", () => {
    assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
    assert.equal(addMonths("2028-01-31", 1), "2028-02-29");
    assert.equal(addMonths("2026-11-15", 3), "2027-02-15");
  });
  it("일수 차이", () => {
    assert.equal(daysBetween("2026-09-27", "2026-10-04"), 7);
  });
});

describe("money", () => {
  it("통화별 최소 단위로 파싱한다", () => {
    assert.equal(parseMoney("1,500,000", "KRW"), 1_500_000);
    assert.equal(parseMoney("12.34", "USD"), 1234);
    assert.equal(parseMoney("$ 99", "USD"), 9900);
    assert.equal(parseMoney("abc", "KRW"), null);
    assert.equal(parseMoney("", "KRW"), null);
  });
  it("포맷", () => {
    assert.equal(formatMoney(1_500_000, "KRW"), "₩1,500,000");
    assert.equal(formatMoney(1234, "USD"), "US$12.34");
  });
});

describe("migrations", () => {
  it("재실행해도 안전하다 (user_version 추적)", () => {
    const db = openDb(":memory:");
    assert.equal(db.pragma("user_version", { simple: true }), migrations.length);
    migrate(db); // 두 번째 실행은 no-op
    assert.equal(db.pragma("user_version", { simple: true }), migrations.length);
  });
});
