// 검색 품질·지연 평가 (docs/MEMORY.md §7.4)
//   npm run eval:recall                      예시 데이터 + 골든셋으로 모드별 recall@k · MRR · 지연
//   npm run eval:recall -- --load 50000      합성 청크를 더해 규모별 지연 측정
//   npm run eval:recall -- --verbose         질의별 순위
import { openDb } from "@/lib/db";
import { contentHash, estimateTokens } from "@/lib/knowledge/cards";
import { type EvalSummary, evaluate, loadGolden } from "@/lib/knowledge/eval";
import { indexStats, reindexAll } from "@/lib/knowledge/indexer";
import { seedDemo } from "./demo-data";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const val = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const db = openDb(":memory:");
seedDemo(db);
reindexAll(db);
const cases = loadGolden(val("file") ?? "tests/fixtures/recall.jsonl");

const f = (x: number) => x.toFixed(2);
function print(s: EvalSummary) {
  const kinds = Object.entries(s.byKind).map(([k, v]) => `${k} ${f(v.recallAt5)}(${v.n})`).join(" · ");
  console.log(`${s.mode.padEnd(8)} R@1 ${f(s.recallAt1)}  R@5 ${f(s.recallAt5)}  MRR ${f(s.mrr)}  p50 ${s.p50.toFixed(1)}ms  p95 ${s.p95.toFixed(1)}ms   [${kinds}]`);
  if (flag("verbose")) {
    for (const c of s.cases) console.log(`   ${c.rank === null ? " ✗" : String(c.rank).padStart(2)}  ${c.kind.padEnd(8)} ${c.q}  →  ${c.top.join(" | ")}`);
  }
}

const st = indexStats(db);
console.log(`[eval:recall] 골든셋 ${cases.length}건 · 색인 ${st.owners}개 객체 / ${st.chunks}개 청크 / 약 ${st.tokens} 토큰\n`);
print(evaluate(db, cases, "lexical"));
print(evaluate(db, cases, "hybrid"));

const load = Number(val("load") ?? 0);
if (load > 0) {
  // 합성 청크: 실제 카드와 비슷한 길이의 한국어 문장. 존재하지 않는 소유자라 결과에는 안 나오지만 스캔 비용은 그대로 든다.
  const words = "고객 계약 청구 입금 세금 신고 부가세 원천세 급여 매출 매입 견적 미팅 통화 메일 갱신 할인 제안 자료 요청 검토 마감 일정 보고 정산 지출 법인 개인 사업자 카드 영수증 증빙 홈택스 전자 발송 확인 누락 수정 승인 거절 보류 진행 완료 문의 상담 서비스 구독 요금 인프라 서버 배포 장애 지표 리뷰".split(" ");
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const ins = db.prepare("INSERT INTO chunks (owner_type, owner_id, business_id, seq, head, text, tokens, content_hash) VALUES ('synthetic', ?, NULL, 0, ?, ?, ?, ?)");
  const t = performance.now();
  db.transaction(() => {
    for (let i = 1; i <= load; i++) {
      const w = () => words[Math.floor(rnd() * words.length)];
      const head = `[합성] SYN-${i} ${w()} ${w()}`;
      const text = `${head}\n${Array.from({ length: 40 + Math.floor(rnd() * 80) }, w).join(" ")}`;
      ins.run(i, head, text, estimateTokens(text), contentHash(text));
    }
  })();
  console.log(`\n+ 합성 청크 ${load.toLocaleString()}개 (${Math.round(performance.now() - t)}ms) — 품질 수치는 idf 가 바뀌므로 참고용, 지연을 볼 것`);
  print(evaluate(db, cases, "lexical"));
  print(evaluate(db, cases, "hybrid"));
}
