"use client";

import { useState, useEffect } from "react";
import type { AskResponse } from "@/lib/types";

export default function HomePage() {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<AskResponse | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!loading) return;
    setElapsed(0);
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [loading]);

  async function submit() {
    const q = question.trim();
    if (!q || loading) return;
    setLoading(true);
    setError(null);
    setAnswer(null);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || `요청 실패 (${res.status})`);
      } else {
        setAnswer(data as AskResponse);
      }
    } catch (e: any) {
      setError(e?.message || "알 수 없는 오류");
    } finally {
      setLoading(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  }

  function printPdf() {
    window.print();
  }

  const today = new Date().toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <header className="no-print mb-6">
        <h1 className="text-2xl font-bold">TaxBrief</h1>
        <p className="text-sm text-gray-500">
          국가법령정보센터 기반 세무 상담 보고서 생성기
        </p>
      </header>

      <section className="no-print mb-6 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <label htmlFor="q" className="mb-2 block text-sm font-medium">
          상담 질문
        </label>
        <textarea
          id="q"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="예: 1세대 1주택 비과세 거주요건은 어떻게 되나요?"
          rows={3}
          className="w-full resize-y rounded-md border border-gray-300 px-3 py-2 text-base focus:border-gray-900 focus:outline-none"
          disabled={loading}
        />
        <div className="mt-3 flex items-center justify-between">
          <span className="text-xs text-gray-500">
            Ctrl/Cmd + Enter 로 바로 실행
          </span>
          <button
            onClick={submit}
            disabled={loading || question.trim().length === 0}
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-gray-700 disabled:cursor-not-allowed disabled:bg-gray-400"
          >
            {loading ? `생성 중… ${elapsed}s` : "상담 보고서 생성"}
          </button>
        </div>
        {loading && (
          <p className="mt-3 text-xs text-gray-500">
            법령 조회 + 답변 생성에 보통 10~25초 정도 소요됩니다.
          </p>
        )}
      </section>

      {error && (
        <div className="no-print mb-6 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800">
          <p className="font-medium">생성 실패</p>
          <p className="mt-1">{error}</p>
        </div>
      )}

      {answer && (
        <article className="report-card rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          <div className="print-only mb-6 border-b border-gray-300 pb-4">
            <h1 className="text-xl font-bold">세무 상담 요약 보고서</h1>
            <p className="text-sm text-gray-700">상담일자: {today}</p>
            <p className="text-xs text-gray-500">
              발행: TaxBrief · 생성 모델: {answer.model}
            </p>
          </div>

          <section className="mb-5">
            <h2 className="mb-1 text-sm font-semibold text-gray-500">질문</h2>
            <p className="text-base">{answer.question}</p>
          </section>

          <section className="mb-5">
            <h2 className="mb-1 text-sm font-semibold text-gray-500">요약</h2>
            <p className="whitespace-pre-wrap text-base leading-relaxed">
              {answer.summary}
            </p>
          </section>

          <section className="mb-5">
            <h2 className="mb-1 text-sm font-semibold text-gray-500">상세 설명</h2>
            <div className="markdown whitespace-pre-wrap text-base leading-relaxed">
              {answer.detail}
            </div>
          </section>

          <section className="mb-5">
            <h2 className="mb-2 text-sm font-semibold text-gray-500">
              적용 법령 (출처)
            </h2>
            {answer.citations.length === 0 ? (
              <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-800">
                ⚠️ 인용 조문이 없습니다. 답변 내용을 신중히 검토하세요.
              </p>
            ) : (
              <ul className="space-y-3">
                {answer.citations.map((c, i) => (
                  <li
                    key={i}
                    className="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-sm"
                  >
                    <div className="font-medium">
                      {c.lawName} {c.article}
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-gray-700">
                      "{c.excerpt}"
                    </p>
                    {c.sourceUrl && (
                      <a
                        href={c.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 inline-block text-xs text-blue-600 underline no-print"
                      >
                        법령 원문 보기 →
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="mt-6 border-t border-gray-200 pt-4">
            <h2 className="mb-1 text-sm font-semibold text-gray-500">면책</h2>
            <p className="text-xs leading-relaxed text-gray-600">
              {answer.disclaimer}
            </p>
          </section>

          <div className="no-print mt-6 flex items-center justify-end gap-2">
            <button
              onClick={printPdf}
              className="rounded-md border border-gray-900 px-4 py-2 text-sm font-medium text-gray-900 hover:bg-gray-900 hover:text-white"
            >
              PDF로 저장 (인쇄)
            </button>
          </div>
        </article>
      )}

      <footer className="no-print mt-10 text-center text-xs text-gray-400">
        TaxBrief MVP · 법령 데이터 © 국가법령정보센터
      </footer>
    </main>
  );
}
