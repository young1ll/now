import { NextResponse } from "next/server";
import { extractKeywords, synthesizeAnswer } from "@/lib/claude";
import { getLawBody, lawBodyToContext, lawSourceUrl, searchLaws } from "@/lib/law";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let question = "";
  try {
    const body = await req.json();
    question = String(body?.question ?? "").trim();
  } catch {
    return NextResponse.json({ error: "요청 본문이 JSON이 아닙니다." }, { status: 400 });
  }
  if (!question) {
    return NextResponse.json({ error: "질문이 비어 있습니다." }, { status: 400 });
  }

  // 1단계: 키워드 추출
  let keywords: string[];
  try {
    keywords = await extractKeywords(question);
  } catch (e: any) {
    return NextResponse.json(
      { error: `키워드 추출 실패: ${e?.message ?? e}`, stage: "keywords" },
      { status: 500 },
    );
  }

  // 2단계: 법령 검색 (키워드별 상위 2건, 합쳐서 중복 제거, 최대 3건)
  let hits: { id: string; name: string }[] = [];
  try {
    const all = await Promise.all(keywords.map((k) => searchLaws(k, 2)));
    const seen = new Set<string>();
    for (const list of all) {
      for (const h of list) {
        if (!seen.has(h.id)) {
          seen.add(h.id);
          hits.push({ id: h.id, name: h.name });
        }
      }
    }
    hits = hits.slice(0, 3);
  } catch (e: any) {
    return NextResponse.json(
      { error: `법령 검색 실패: ${e?.message ?? e}`, stage: "lawSearch", keywords },
      { status: 502 },
    );
  }

  if (hits.length === 0) {
    return NextResponse.json(
      {
        error: "관련 법령을 찾지 못했습니다. 질문을 더 구체적으로 작성해 주세요.",
        stage: "lawSearch",
        keywords,
      },
      { status: 404 },
    );
  }

  // 3단계: 법령 본문 병렬 조회
  let bodies: { id: string; name: string; context: string; url: string }[] = [];
  try {
    const fetched = await Promise.all(hits.map((h) => getLawBody(h.id)));
    bodies = fetched.map((b) => ({
      id: b.id,
      name: b.name,
      context: lawBodyToContext(b, 6000),
      url: lawSourceUrl(b.id),
    }));
  } catch (e: any) {
    return NextResponse.json(
      { error: `법령 본문 조회 실패: ${e?.message ?? e}`, stage: "lawBody" },
      { status: 502 },
    );
  }

  // 합쳐서 LLM 컨텍스트로
  const lawContext = bodies.map((b) => b.context).join("\n\n---\n\n");

  // 4단계: 답변 합성
  try {
    const answer = await synthesizeAnswer({
      question,
      lawContext,
      lawSources: bodies.map((b) => ({ name: b.name, id: b.id, url: b.url })),
    });
    return NextResponse.json(answer);
  } catch (e: any) {
    return NextResponse.json(
      { error: `답변 생성 실패: ${e?.message ?? e}`, stage: "synthesize" },
      { status: 502 },
    );
  }
}
