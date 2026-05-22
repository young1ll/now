import type { LawArticle, LawBody, LawSearchHit } from "./types";

const BASE = "https://www.law.go.kr/DRF";

function oc(): string {
  const v = process.env.LAW_OC;
  if (!v) throw new Error("LAW_OC 환경변수가 설정되지 않았습니다. .env.local 확인 필요.");
  return v;
}

// 국가법령정보센터 lawSearch.do
// docs: https://open.law.go.kr/LSO/openApi/guideList.do
export async function searchLaws(keyword: string, display = 5): Promise<LawSearchHit[]> {
  const url = new URL(`${BASE}/lawSearch.do`);
  url.searchParams.set("OC", oc());
  url.searchParams.set("target", "law");
  url.searchParams.set("type", "JSON");
  url.searchParams.set("query", keyword);
  url.searchParams.set("display", String(display));
  url.searchParams.set("search", "1"); // 법령명 검색

  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) throw new Error(`법령 검색 실패 (${res.status}) - ${keyword}`);

  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`법령 검색 응답을 JSON으로 파싱 실패: ${text.slice(0, 200)}`);
  }

  // 응답 구조: { LawSearch: { law: [...] } } 또는 단건일 때 객체
  const root = data?.LawSearch ?? data?.lawSearch ?? data;
  const raw = root?.law;
  const arr: any[] = Array.isArray(raw) ? raw : raw ? [raw] : [];

  return arr.map((l) => ({
    id: String(l["법령일련번호"] ?? l.MST ?? l.id ?? ""),
    name: String(l["법령명한글"] ?? l.법령명 ?? l.name ?? ""),
    ministry: l["소관부처명"] ?? l.소관부처 ?? undefined,
    promulgationDate: l["공포일자"] ?? undefined,
  })).filter((h) => h.id && h.name);
}

// 국가법령정보센터 lawService.do - 법령 본문 조회 (JSON)
export async function getLawBody(id: string): Promise<LawBody> {
  const url = new URL(`${BASE}/lawService.do`);
  url.searchParams.set("OC", oc());
  url.searchParams.set("target", "law");
  url.searchParams.set("type", "JSON");
  url.searchParams.set("MST", id);

  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) throw new Error(`법령 본문 조회 실패 (${res.status}) - MST=${id}`);

  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`법령 본문 응답을 JSON으로 파싱 실패: ${text.slice(0, 200)}`);
  }

  // 응답: 보통 { 법령: { 기본정보: {...}, 조문: { 조문단위: [...] } } }
  const lawRoot = data?.법령 ?? data?.Law ?? data;
  const basic = lawRoot?.기본정보 ?? {};
  const name = String(basic["법령명_한글"] ?? basic["법령명"] ?? lawRoot?.법령명 ?? "법령");
  const articlesRoot = lawRoot?.조문?.조문단위 ?? lawRoot?.조문 ?? [];
  const rawArticles: any[] = Array.isArray(articlesRoot) ? articlesRoot : [articlesRoot];

  const articles: LawArticle[] = rawArticles
    .filter(Boolean)
    .map((a: any) => {
      const rawNo = a["조문번호"] ?? a.number ?? "";
      const numText = String(rawNo).replace(/^0+/, "") || String(rawNo);
      const subNo = a["조문가지번호"] ? `의${String(a["조문가지번호"]).replace(/^0+/, "")}` : "";
      const numberLabel = numText ? `제${numText}${subNo}조` : "";
      const title = a["조문제목"] ? ` (${a["조문제목"]})` : "";
      // 본문은 조문내용 + 항/호를 우선 추출, 없으면 전체 텍스트 수집
      const main = String(a["조문내용"] ?? "").trim();
      const paragraphs = collectText(a["항"] ?? "").trim();
      const composed = [main, paragraphs].filter(Boolean).join("\n");
      const body = composed || collectText(a).trim();
      return {
        number: numberLabel + title,
        paragraph: undefined,
        body,
      };
    })
    .filter((a) => a.body.length > 0);

  return {
    id,
    name,
    articles,
    raw: { keys: Object.keys(lawRoot ?? {}) },
  };
}

// 응답 노드의 모든 텍스트를 재귀적으로 수집 (구조 변동에 robust)
function collectText(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number" || typeof node === "boolean") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join("\n");
  if (typeof node === "object") {
    return Object.values(node as Record<string, unknown>)
      .map(collectText)
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

// 사람이 읽을 수 있는 형태로 법령 본문을 압축 (LLM 컨텍스트용)
export function lawBodyToContext(law: LawBody, maxChars = 8000): string {
  const header = `# ${law.name} (MST=${law.id})\n`;
  const body = law.articles
    .map((a) => `## ${a.number}\n${a.body}`)
    .join("\n\n");
  const all = header + body;
  return all.length > maxChars ? all.slice(0, maxChars) + "\n…(이하 생략)" : all;
}

export function lawSourceUrl(id: string): string {
  return `https://www.law.go.kr/lsInfoP.do?lsiSeq=${id}`;
}
