// 국가법령정보센터 API 단독 스모크 테스트
// 사용: npx tsx scripts/smoke-law.ts "소득세법"
// .env.local의 LAW_OC 필요.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { searchLaws, getLawBody, lawBodyToContext } from "../lib/law";

// .env.local 로드
try {
  const text = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  console.warn("⚠ .env.local 로드 실패 — 환경변수가 셸에 직접 설정되어 있어야 합니다.");
}

const keyword = process.argv[2] || "소득세법";

async function main() {
  console.log(`▶ 검색: "${keyword}"`);
  const hits = await searchLaws(keyword, 3);
  console.log(`  검색 결과 ${hits.length}건:`);
  for (const h of hits) {
    console.log(`   - ${h.name} (MST=${h.id}) ${h.ministry ?? ""}`);
  }
  if (hits.length === 0) {
    console.error("✗ 검색 결과 없음");
    process.exit(1);
  }

  const first = hits[0];
  console.log(`\n▶ 본문 조회: ${first.name} (MST=${first.id})`);
  const body = await getLawBody(first.id);
  console.log(`  조문 ${body.articles.length}개`);
  console.log(`\n--- LLM 컨텍스트 미리보기 (앞 500자) ---`);
  console.log(lawBodyToContext(body, 6000).slice(0, 500));
  console.log("---");
  console.log("\n✓ 법령 API 정상 동작");
}

main().catch((e) => {
  console.error("✗ 스모크 실패:", e?.message ?? e);
  process.exit(1);
});
