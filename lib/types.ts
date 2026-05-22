export type Citation = {
  lawName: string;
  article: string;
  excerpt: string;
  sourceUrl?: string;
};

export type AskResponse = {
  question: string;
  summary: string;
  detail: string;
  citations: Citation[];
  disclaimer: string;
  generatedAt: string;
  model: string;
};

export type AskError = {
  error: string;
  stage?: "keywords" | "lawSearch" | "lawBody" | "synthesize";
};

export type LawSearchHit = {
  id: string;           // 법령 마스터 일련번호 (MST)
  name: string;         // 법령명
  ministry?: string;    // 소관 부처
  promulgationDate?: string;
};

export type LawArticle = {
  number: string;       // 예: 제89조
  paragraph?: string;   // 예: 제1항 제3호
  body: string;         // 조문 본문
};

export type LawBody = {
  id: string;
  name: string;
  articles: LawArticle[];
  raw: unknown;         // 디버깅용 원본 일부
};

export const DISCLAIMER =
  "본 자료는 상담일 시점의 관련 법령을 기준으로 작성된 일반적 안내이며, " +
  "개별 사안에 대한 최종 판단은 담당 세무사와의 추가 상담을 통해 확인해 주시기 바랍니다. " +
  "인용된 법령은 발행일 이후 개정되었을 수 있습니다.";
