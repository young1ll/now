import Anthropic from "@anthropic-ai/sdk";
import { DISCLAIMER, type AskResponse, type Citation } from "./types";

const DEFAULT_MODEL = "claude-sonnet-4-6";

function client(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.");
  // globalThis.fetch(Node 22 네이티브)를 명시 주입.
  // 테스트에서 fetch 패치만으로 SDK 호출까지 가로챌 수 있게 함.
  return new Anthropic({
    apiKey,
    fetch: globalThis.fetch as any,
  });
}

function modelId(): string {
  return process.env.CLAUDE_MODEL || DEFAULT_MODEL;
}

// JSON 응답에서 코드펜스/잡문 제거 후 파싱
function parseJson<T>(text: string): T {
  const trimmed = text.trim();
  // ```json ... ``` 블록 제거
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenced ? fenced[1] : trimmed;
  // 첫 { 부터 마지막 } 까지
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  const slice = start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate;
  return JSON.parse(slice) as T;
}

async function callJson<T>(opts: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<T> {
  const c = client();
  const msg = await c.messages.create({
    model: modelId(),
    max_tokens: opts.maxTokens ?? 2048,
    system: opts.system,
    messages: [{ role: "user", content: opts.user }],
  });
  const text = msg.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
  return parseJson<T>(text);
}

// 1단계: 질문 → 법령 검색용 키워드 추출
export async function extractKeywords(question: string): Promise<string[]> {
  const system = [
    "너는 한국 세법 상담 보조 도우미다.",
    "사용자 질문에서 국가법령정보센터에서 검색할 한국어 키워드를 1~3개 추출한다.",
    "각 키워드는 법령명(예: 소득세법, 부가가치세법, 상속세 및 증여세법)이나",
    "법령 검색에 효과적인 단일 명사구여야 한다.",
    "반드시 다음 JSON 형식만 출력하라:",
    '{ "keywords": ["키워드1", "키워드2"] }',
  ].join("\n");

  const user = `질문: ${question}`;
  const out = await callJson<{ keywords: string[] }>({ system, user, maxTokens: 256 });
  const cleaned = (out.keywords ?? [])
    .map((k) => String(k).trim())
    .filter(Boolean)
    .slice(0, 3);
  return cleaned.length > 0 ? cleaned : [question];
}

// 2단계: 질문 + 법령 본문 → 근거 인용 답변
export async function synthesizeAnswer(args: {
  question: string;
  lawContext: string;
  lawSources: { name: string; id: string; url: string }[];
}): Promise<AskResponse> {
  const system = [
    "너는 한국 세무사의 상담을 보조하는 어시스턴트다.",
    "사용자가 제공한 '관련 법령 본문'에 근거해서만 답한다.",
    "본문에 명시되지 않은 내용은 추측하지 말고 '제공된 본문에서 확인되지 않음'이라고 표시한다.",
    "모든 인용(citation)의 excerpt는 제공된 법령 본문에 실제로 등장하는 문구에서만 가져온다.",
    "답변은 한국어로 작성한다.",
    "",
    "반드시 다음 JSON 스키마로만 응답하라. 추가 텍스트, 코드펜스, 설명을 붙이지 마라:",
    "{",
    '  "summary": "3~5문장 요약",',
    '  "detail": "상세 설명 (마크다운 가능, 8~20문장)",',
    '  "citations": [',
    '    { "lawName": "법령명", "article": "제○○조 제○항 제○호", "excerpt": "원문 발췌 (1~3문장)" }',
    "  ]",
    "}",
    "",
    "citations는 반드시 1개 이상 포함하되, 제공된 법령 본문에 해당 조문이 실제로 있을 때만 추가하라.",
  ].join("\n");

  const user = [
    `세무사 질문:\n${args.question}`,
    "",
    "관련 법령 본문 (이 안에 있는 내용만 인용 가능):",
    "----",
    args.lawContext,
    "----",
  ].join("\n");

  const parsed = await callJson<{
    summary: string;
    detail: string;
    citations: Citation[];
  }>({ system, user, maxTokens: 3000 });

  // 출처 URL 자동 매칭 (lawName으로 추측)
  const citations: Citation[] = (parsed.citations ?? [])
    .filter((c) => c && c.lawName && c.excerpt)
    .map((c) => {
      const source = args.lawSources.find((s) => s.name.includes(c.lawName) || c.lawName.includes(s.name));
      return { ...c, sourceUrl: source?.url };
    });

  return {
    question: args.question,
    summary: parsed.summary ?? "",
    detail: parsed.detail ?? "",
    citations,
    disclaimer: DISCLAIMER,
    generatedAt: new Date().toISOString(),
    model: modelId(),
  };
}
