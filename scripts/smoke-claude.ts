// Claude API 단독 스모크 테스트
// 사용: npx tsx scripts/smoke-claude.ts
// .env.local의 ANTHROPIC_API_KEY 필요.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractKeywords } from "../lib/claude";

try {
  const text = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  console.warn("⚠ .env.local 로드 실패 — 환경변수가 셸에 직접 설정되어 있어야 합니다.");
}

const question = process.argv[2] || "1세대 1주택 비과세 거주요건";

async function main() {
  console.log(`▶ 질문: "${question}"`);
  console.log(`  모델: ${process.env.CLAUDE_MODEL || "claude-sonnet-4-6"}`);
  const t = Date.now();
  const keywords = await extractKeywords(question);
  console.log(`  소요: ${Date.now() - t}ms`);
  console.log(`  추출 키워드: ${JSON.stringify(keywords, null, 2)}`);
  console.log("\n✓ Claude API 정상 동작");
}

main().catch((e) => {
  console.error("✗ 스모크 실패:", e?.message ?? e);
  process.exit(1);
});
