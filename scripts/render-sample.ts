// 샘플 답변으로 보고서 HTML 미리보기 파일 생성.
// 사용: npx tsx scripts/render-sample.ts
// 출력: ./sample-report.html (브라우저로 열어 Ctrl+P → 인쇄 미리보기 확인)

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DISCLAIMER, type AskResponse } from "../lib/types";

const sample: AskResponse = {
  question: "1세대 1주택 비과세 거주요건은 어떻게 되나요?",
  summary:
    "1세대가 양도일 현재 국내에 1주택을 보유하고 보유기간이 2년 이상이면 비과세 대상입니다. 다만 취득 당시 조정대상지역에 있던 주택은 보유기간 중 거주기간이 2년 이상이어야 합니다.",
  detail:
    "소득세법 제89조 제1항 제3호는 1세대 1주택의 양도에 대해 일정 요건을 충족하는 경우 양도소득세를 비과세한다고 규정합니다.\n\n구체적인 요건은 다음과 같습니다.\n- 1세대가 양도일 현재 국내에 1주택을 보유\n- 해당 주택의 보유기간이 2년 이상\n- 취득 당시 조정대상지역에 있는 주택의 경우, 보유기간 중 거주기간이 2년 이상\n\n조정대상지역 여부는 취득 시점 기준으로 판단하며, 양도 시점에 해제되었더라도 거주 요건은 그대로 적용됩니다.",
  citations: [
    {
      lawName: "소득세법",
      article: "제89조 제1항 제3호",
      excerpt:
        "1세대가 양도일 현재 국내에 1주택을 보유하고 있는 경우로서 해당 주택의 보유기간이 2년 이상이고, 취득 당시 조정대상지역에 있는 주택의 경우 보유기간 중 거주기간이 2년 이상인 것",
      sourceUrl: "https://www.law.go.kr/lsInfoP.do?lsiSeq=242350",
    },
  ],
  disclaimer: DISCLAIMER,
  generatedAt: new Date().toISOString(),
  model: "claude-sonnet-4-6",
};

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const today = new Date().toLocaleDateString("ko-KR", {
  year: "numeric",
  month: "long",
  day: "numeric",
});

const html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <title>샘플 세무 상담 보고서</title>
  <style>
    body {
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto,
        "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif;
      background: #f7f7f8;
      color: #111;
      margin: 0;
      padding: 2rem 1rem;
    }
    main { max-width: 720px; margin: 0 auto; }
    .card {
      background: white; border: 1px solid #e5e7eb; border-radius: 8px;
      padding: 24px; box-shadow: 0 1px 2px rgba(0,0,0,.04);
    }
    .pdf-header { border-bottom: 1px solid #d1d5db; padding-bottom: 16px; margin-bottom: 24px; }
    h1 { font-size: 20px; font-weight: 700; margin: 0 0 4px; }
    .meta { color: #6b7280; font-size: 12px; }
    section { margin-bottom: 20px; }
    section h2 { font-size: 13px; color: #6b7280; font-weight: 600; margin: 0 0 4px; }
    .body { white-space: pre-wrap; line-height: 1.6; }
    .citation {
      border: 1px solid #e5e7eb; background: #f9fafb;
      padding: 12px; border-radius: 6px; font-size: 14px;
      margin-bottom: 10px;
    }
    .citation .name { font-weight: 600; }
    .citation .excerpt { margin-top: 6px; color: #374151; white-space: pre-wrap; }
    .citation a { font-size: 12px; color: #2563eb; }
    .disclaimer-block { border-top: 1px solid #e5e7eb; margin-top: 24px; padding-top: 16px; }
    .disclaimer-block p { font-size: 12px; color: #4b5563; line-height: 1.6; }
    @media print {
      @page { size: A4; margin: 18mm 16mm; }
      body { background: white !important; padding: 0; }
      main { max-width: none; }
      .card { box-shadow: none !important; border: none !important; padding: 0 !important; }
      .no-print { display: none !important; }
      a { color: #000; text-decoration: none; }
    }
  </style>
</head>
<body>
<main>
  <p class="no-print" style="font-size:12px;color:#6b7280;margin-bottom:8px;">
    ▾ 이 파일은 보고서 시각 레이아웃 미리보기용 샘플입니다. 브라우저에서 Ctrl/Cmd+P로 인쇄 미리보기를 확인하세요.
  </p>
  <article class="card">
    <div class="pdf-header">
      <h1>세무 상담 요약 보고서</h1>
      <p class="meta">상담일자: ${escape(today)}</p>
      <p class="meta">발행: TaxBrief · 생성 모델: ${escape(sample.model)}</p>
    </div>
    <section>
      <h2>질문</h2>
      <p>${escape(sample.question)}</p>
    </section>
    <section>
      <h2>요약</h2>
      <p class="body">${escape(sample.summary)}</p>
    </section>
    <section>
      <h2>상세 설명</h2>
      <div class="body">${escape(sample.detail)}</div>
    </section>
    <section>
      <h2>적용 법령 (출처)</h2>
      ${sample.citations
        .map(
          (c) => `
        <div class="citation">
          <div class="name">${escape(c.lawName)} ${escape(c.article)}</div>
          <div class="excerpt">"${escape(c.excerpt)}"</div>
          ${c.sourceUrl ? `<a class="no-print" href="${escape(c.sourceUrl)}" target="_blank" rel="noreferrer">법령 원문 보기 →</a>` : ""}
        </div>`,
        )
        .join("")}
    </section>
    <div class="disclaimer-block">
      <h2>면책</h2>
      <p>${escape(sample.disclaimer)}</p>
    </div>
  </article>
</main>
</body>
</html>`;

const out = resolve(process.cwd(), "sample-report.html");
writeFileSync(out, html, "utf8");
console.log(`✓ 샘플 보고서 생성: ${out}`);
console.log("  브라우저로 열어 Ctrl/Cmd+P → '대상: PDF로 저장' 으로 인쇄 결과를 확인하세요.");
