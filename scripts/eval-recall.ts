// 검색 품질·지연 평가 (docs/MEMORY.md §7.4)
//   npm run eval:recall                      예시 데이터 + 골든셋으로 모드별 recall@k · MRR · 지연
//   npm run eval:recall -- --load 50000      합성 청크를 더해 규모별 지연 측정 (공간이 있으면 합성 청크도 임베딩)
//   npm run eval:recall -- --verbose         질의별 순위
//   npm run eval:recall -- --embed-url http://127.0.0.1:11434 --embed-provider ollama --embed-model bge-m3
//   npm run eval:recall -- --embed-url http://127.0.0.1:8088/v1 --embed-model wordllama [--query-prefix "query: " --passage-prefix "passage: "]
//                                            메모리 DB 에 임베딩 공간을 만들어 다 채우고 활성화한 뒤 lexical · vector · hybrid 비교
//   npm run eval:recall -- --vec-bench 50000 [--dim 1024]
//                                            임베딩 서버 없이 벡터 저장소만: KNN 지연(p50/p95)과 bit→float 재정렬 정확도(recall@10)
import { openDb } from "@/lib/db";
import { contentHash, estimateTokens } from "@/lib/knowledge/cards";
import { embedPending } from "@/lib/knowledge/embedder";
import { type EvalSummary, evaluate, loadGolden } from "@/lib/knowledge/eval";
import { indexStats, reindexAll } from "@/lib/knowledge/indexer";
import type { RecallMode } from "@/lib/knowledge/recall";
import { attachVectors, dot, gcVectors, knn, normalize, spaceCoverage, storeVectors, vectorStoreInfo, vectorsEnabled } from "@/lib/knowledge/vectors";
import { executeAction } from "@/lib/ontology/execute";
import { OPERATOR } from "@/lib/ontology/types";
import { type EmbedProvider, activeSpace, confirmSpaceDim, getSpace } from "@/lib/repos/embeddings";
import { seedDemo } from "./demo-data";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const val = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const f = (x: number) => x.toFixed(2);
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
};

function print(s: EvalSummary) {
  const kinds = Object.entries(s.byKind).map(([k, v]) => `${k} ${f(v.recallAt5)}(${v.n})`).join(" · ");
  console.log(`${s.mode.padEnd(8)} R@1 ${f(s.recallAt1)}  R@5 ${f(s.recallAt5)}  MRR ${f(s.mrr)}  p50 ${s.p50.toFixed(1)}ms  p95 ${s.p95.toFixed(1)}ms   [${kinds}]${s.degraded ? `  ⚠ 강등 ${s.degraded}건` : ""}`);
  if (flag("verbose")) {
    for (const c of s.cases) console.log(`   ${c.rank === null ? " ✗" : String(c.rank).padStart(2)}  ${c.kind.padEnd(8)} ${c.q}  →  ${c.top.join(" | ")}`);
  }
}

// ── 벡터 저장소 벤치 (임베딩 서버 없이) ─────────────────────

function gauss(rnd: () => number) {
  // Box–Muller
  const u = Math.max(rnd(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

async function vecBench(n: number, dim: number) {
  const db = openDb(":memory:");
  if (!attachVectors(db)) {
    console.error(`[vec-bench] ${vectorStoreInfo(db).error}`);
    process.exit(1);
  }
  // mulberry32 — 선형 합동(×1103515245)은 JS 배정밀도에서 주기가 짧아져 같은 벡터가 반복된다 (그러면 정확도가 부풀려진다)
  let seed = 7;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const K = 10;
  const Q = 100;
  console.log(`[vec-bench] ${n.toLocaleString()}개 × ${dim}차원 · 질의 ${Q}개 · k=${K} · 1차 후보 bit 해밍 → float 내적 재정렬\n`);

  const run = (label: string, make: () => Float32Array, makeQuery: () => Float32Array) => {
    const r = executeAction(db, { actor: OPERATOR, action: "embedding.space_create", params: { name: label, provider: "openai_compatible", model: "bench", base_url: "http://127.0.0.1:1/v1" } });
    const id = Number((r.result?.data as { space_id: number }).space_id);
    const space = { id, dim: confirmSpaceDim(db, id, dim) };
    const all = new Float32Array(n * dim);
    let t = performance.now();
    for (let off = 0; off < n; off += 2000) {
      const items = [];
      for (let i = off; i < Math.min(n, off + 2000); i++) {
        const v = make();
        all.set(v, i * dim);
        items.push({ hash: `h${i}`, vec: v });
      }
      storeVectors(db, space, items);
    }
    const insertMs = performance.now() - t;
    const exactTop = (q: Float32Array) => {
      const scores: { i: number; s: number }[] = [];
      for (let i = 0; i < n; i++) scores.push({ i, s: dot(q, all.subarray(i * dim, (i + 1) * dim)) });
      return scores.sort((a, b) => b.s - a.s).slice(0, K).map((x) => `h${x.i}`);
    };
    const queries = Array.from({ length: Q }, makeQuery);
    const truth: string[][] = [];
    const bruteMs: number[] = [];
    for (const q of queries) {
      t = performance.now();
      truth.push(exactTop(q));
      bruteMs.push(performance.now() - t);
    }
    console.log(`${label}  (저장 ${Math.round(insertMs)}ms · float 전수 내적(JS) p50 ${pct(bruteMs, 0.5).toFixed(1)}ms)`);
    for (const cand of [200, 1000, 4000]) {
      const ms: number[] = [];
      let hit = 0;
      queries.forEach((q, qi) => {
        const t0 = performance.now();
        const got = knn(db, space, q, K, { candidates: cand });
        ms.push(performance.now() - t0);
        hit += got.filter((g) => truth[qi].includes(g.hash)).length;
      });
      const def = cand === Math.max(K * 20, 200) ? " (기본)" : "";
      console.log(`   후보 ${String(cand).padStart(4)}${def.padEnd(5)}  knn p50 ${pct(ms, 0.5).toFixed(1)}ms  p95 ${pct(ms, 0.95).toFixed(1)}ms   recall@${K} ${f(hit / (Q * K))}`);
    }
    // 다음 측정을 위해 비운다 (메모리) — 폐기 → 정리, 실제 경로 그대로
    executeAction(db, { actor: OPERATOR, action: "embedding.retire", params: { id } });
    gcVectors(db);
    console.log("");
  };

  const unit = () => normalize(Array.from({ length: dim }, () => gauss(rnd)));
  run("① 무작위 단위 벡터", unit, unit);
  console.log("   ↑ 무작위 벡터는 bit 양자화의 최악 조건: 가장 가까운 이웃과 나머지의 코사인 차이가 거의 없어 부호 비트로는 구별이 어렵다.\n     실제 임베딩은 군집 구조가 있어 ②에 가깝다.\n");

  const centers = Array.from({ length: 200 }, unit);
  const noisy = () => {
    const c = centers[Math.floor(rnd() * centers.length)];
    // 군집 안 코사인 ≈ 0.7 (잡음 노름 ≈ 1)
    return normalize(Array.from({ length: dim }, (_, i) => c[i] + gauss(rnd) / Math.sqrt(dim)));
  };
  run("② 군집 벡터 (중심 200개 + 잡음)", noisy, noisy);
}

// ── 본 평가 ─────────────────────────────────────────

async function fill(db: ReturnType<typeof openDb>, label: string) {
  const space = activeSpace(db) ?? (db.prepare("SELECT * FROM embedding_spaces WHERE status = 'building' ORDER BY id DESC LIMIT 1").get() as { id: number; name: string } | undefined);
  if (!space) return;
  const t = performance.now();
  let total = 0;
  for (;;) {
    const r = await embedPending(db, { maxTexts: 512 });
    if (r.errors.length) {
      console.error(`\n[eval:recall] 임베딩 실패: ${r.errors.join(" / ")}`);
      process.exit(1);
    }
    total += r.embedded;
    if (!r.embedded) break;
    const c = spaceCoverage(db, space.id);
    process.stderr.write(`\r  임베딩 ${label} ${c.embedded}/${c.total} (${c.pct}%)   `);
  }
  process.stderr.write("\n");
  const s = getSpace(db, space.id)!;
  console.log(`  ${label}: ${total.toLocaleString()}개 임베딩 · ${Math.round(performance.now() - t)}ms · ${s.model} ${s.dim}차원`);
}

async function main() {
  const bench = Number(val("vec-bench") ?? 0);
  if (bench > 0) return vecBench(bench, Number(val("dim") ?? 1024));

  const db = openDb(":memory:");
  seedDemo(db, { embeddingSpace: false });
  reindexAll(db);
  const cases = loadGolden(val("file") ?? "tests/fixtures/recall.jsonl");
  const modes = (): RecallMode[] => (activeSpace(db) && vectorsEnabled() ? ["lexical", "vector", "hybrid"] : ["lexical", "hybrid"]);

  const embedUrl = val("embed-url");
  if (embedUrl) {
    const provider = (val("embed-provider") ?? "openai_compatible") as EmbedProvider;
    const model = val("embed-model") ?? (provider === "ollama" ? "bge-m3" : "");
    const r = executeAction(db, {
      actor: OPERATOR,
      action: "embedding.space_create",
      params: { name: `eval ${model}`, provider, model, base_url: embedUrl, query_prefix: val("query-prefix") ?? "", passage_prefix: val("passage-prefix") ?? "" },
    });
    const id = Number((r.result?.data as { space_id: number }).space_id);
    if (!vectorsEnabled()) console.log("[eval:recall] NOW_VECTORS=off — 공간을 만들었지만 임베딩하지 않는다");
    else {
      await fill(db, "예시 데이터");
      executeAction(db, { actor: OPERATOR, action: "embedding.activate", params: { id } });
    }
  }

  const st = indexStats(db);
  const space = activeSpace(db);
  console.log(`[eval:recall] 골든셋 ${cases.length}건 · 색인 ${st.owners}개 객체 / ${st.chunks}개 청크 / 약 ${st.tokens} 토큰${space ? ` · 공간 ${space.model} (${space.dim}차원)` : " · 벡터 없음"}\n`);
  for (const m of modes()) print(await evaluate(db, cases, m));

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
    if (space && vectorsEnabled()) await fill(db, "합성 청크");
    for (const m of modes()) print(await evaluate(db, cases, m));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
