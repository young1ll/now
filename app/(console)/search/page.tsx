import Link from "next/link";
import { Callout, Empty, ObjectLink, PageHeader, Panel, Tabs, Tag } from "@/components/ui";
import { currentScope } from "@/lib/context";
import { db } from "@/lib/db";
import { ensureIndexed, indexStats } from "@/lib/knowledge/indexer";
import { type Why, recall } from "@/lib/knowledge/recall";
import { spaceCoverage, vectorsEnabled } from "@/lib/knowledge/vectors";
import type { Tone } from "@/lib/labels";
import { parseRef } from "@/lib/ontology/graph";
import { OBJECTS } from "@/lib/ontology/objects";
import { OBJECT_TYPES, type ObjectType } from "@/lib/ontology/types";
import { type SearchParams, one } from "@/lib/params";
import { activeSpace } from "@/lib/repos/embeddings";

export const metadata = { title: "검색" };

const WHY: Record<Why, { label: string; tone: Tone | "none"; title: string }> = {
  ref: { label: "참조", tone: "none", title: "검색어가 객체 식별자" },
  lexical: { label: "내용", tone: "blue", title: "이름·속성·접촉 이력·본문에 검색어가 있음" },
  semantic: { label: "의미", tone: "green", title: "뜻이 비슷함 (임베딩 코사인 유사도)" },
  graph: { label: "관계", tone: "slate", title: "상위 결과와 링크로 연결됨" },
  about: { label: "주변", tone: "zinc", title: "기준 객체와 연결됨" },
};

/** semantic = 같은 낱말이 없어 의미 검색(활성 임베딩 공간)이 있어야 찾는 예시 */
const EXAMPLES: { q: string; semantic?: boolean }[] = [
  { q: "SSO 요구하는 고객" },
  { q: "부가세 마감 절차" },
  { q: "누가 카페 온도를 소개했나" },
  { q: "법인카드 누락" },
  { q: "클라우드 서버 비용", semantic: true },
];

/** 일치한 검색어를 강조 (서버에서 문자열 분할) */
function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return (
    <>
      {text.split(re).map((part, i) =>
        i % 2 ? (
          <mark key={i} className="bg-primary/25 text-fg">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

export default async function SearchPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const q = one(sp.q)?.trim() ?? "";
  const typeParam = one(sp.type);
  const type = (OBJECT_TYPES as readonly string[]).includes(typeParam ?? "") ? (typeParam as ObjectType) : undefined;
  const about = parseRef(one(sp.about) ?? "");
  const scope = await currentScope();
  const d = db();
  ensureIndexed(d);
  const r = q ? await recall(d, { query: q, scope, types: type ? [type] : undefined, about, k: 30 }) : null;
  const st = indexStats(d);
  const space = vectorsEnabled() ? activeSpace(d) : undefined;
  const cov = space ? spaceCoverage(d, space.id) : null;
  const href = (t?: string) => `/search?${new URLSearchParams({ q, ...(t ? { type: t } : {}), ...(about ? { about: `${about.type}:${about.id}` } : {}) })}`;

  return (
    <>
      <PageHeader
        icon="search"
        eyebrow="회상 검색"
        title={q ? `“${q}”` : "무엇이든 찾기"}
        meta={
          r ? (
            <>
              <span className="mono">{r.hits.length}</span>건 · <span className="mono">{r.tookMs}ms</span>
              {r.terms.length > 0 && <> · 검색어 {r.terms.map((t) => <span key={t} className="mono ml-1 text-fg-2">{t}</span>)}</>}
            </>
          ) : (
            "이름·속성·접촉 이력·문서 본문, 뜻이 비슷한 표현, 객체 사이의 관계를 함께 봅니다. 상단 검색창 또는 / 키"
          )
        }
      />
      {q && (
        <Tabs
          current={type ?? "all"}
          items={[{ key: "all", label: "전체", href: href() }, ...OBJECT_TYPES.map((t) => ({ key: t, label: OBJECTS[t].label, href: href(t) }))]}
        />
      )}
      <div className="flex flex-col gap-px bg-void p-px">
        {r?.degraded && (
          <div className="bg-panel p-3">
            <Callout tone="amber" title="의미 검색 없이 찾았습니다 — 어휘 + 관계">
              {r.degraded} · <a href="/system" className="text-primary-fg hover:underline">시스템 › 검색 색인</a>에서 임베딩 공간 상태를 확인하세요.
            </Callout>
          </div>
        )}
        {!q && (
          <Panel title="예시">
            <div className="flex flex-wrap gap-1.5 p-3">
              {EXAMPLES.map((e) => (
                <Link
                  key={e.q}
                  href={`/search?q=${encodeURIComponent(e.q)}`}
                  className="btn btn-sm"
                  title={e.semantic && !space ? "뜻이 비슷한 표현을 찾는 예시 — 활성 임베딩 공간이 있어야 결과가 나옵니다" : undefined}
                >
                  {e.q}
                  {e.semantic && !space && <span className="text-[11px] text-fg-4">의미 검색 필요</span>}
                </Link>
              ))}
            </div>
          </Panel>
        )}
        {r && r.hits.length === 0 && (
          <Panel>
            <Empty icon="search">
              <div>결과가 없습니다. 다른 표현이나 고유명사(고객명·번호)로 찾아보세요.</div>
              {r.vector === null && !r.degraded && (
                <div>
                  의미 검색이 꺼져 있어 뜻이 비슷한 표현은 찾지 못합니다 —{" "}
                  <a href="/system" className="text-primary-fg hover:underline">
                    시스템 › 검색 색인
                  </a>
                  에서 임베딩 공간을 켜세요.
                </div>
              )}
            </Empty>
          </Panel>
        )}
        {r && r.hits.length > 0 && (
          <Panel flush>
            <table className="grid-table">
              <thead>
                <tr>
                  <th className="w-10 text-right">#</th>
                  <th>객체</th>
                  <th className="w-[150px] max-md:hidden">근거</th>
                  <th className="w-[90px] text-right max-md:hidden">상태</th>
                </tr>
              </thead>
              <tbody>
                {r.hits.map((h, i) => (
                  <tr key={h.key}>
                    <td className="mono text-right align-top text-fg-4">{i + 1}</td>
                    <td className="max-w-0">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <ObjectLink type={h.ref.type} id={h.ref.id} title={h.title} />
                        <span className="text-[11px] whitespace-nowrap text-fg-4">{OBJECTS[h.ref.type].label}</span>
                        <span className="flex gap-1 md:hidden">
                          {h.why.map((w) => (
                            <Tag key={w} tone={WHY[w].tone}>{WHY[w].label}</Tag>
                          ))}
                          {h.similarity !== undefined && <span className="mono text-[11px] text-fg-3">{h.similarity.toFixed(2)}</span>}
                        </span>
                      </div>
                      {h.snippet && (
                        <div className="mt-0.5 line-clamp-2 text-[12px] text-fg-3">
                          <Highlight text={h.snippet} terms={h.matched} />
                        </div>
                      )}
                      {h.via && (
                        <div className="mt-0.5 text-[11.5px] text-fg-4">
                          ← <span className="mono">{h.via.from}</span> · {h.via.label}
                        </div>
                      )}
                    </td>
                    <td className="align-top max-md:hidden">
                      <div className="flex flex-wrap gap-1">
                        {h.why.map((w) => (
                          <Tag key={w} tone={WHY[w].tone} title={WHY[w].title}>
                            {WHY[w].label}
                          </Tag>
                        ))}
                        {h.similarity !== undefined && (
                          <span className="mono self-center text-[11px] text-fg-3" title="의미 유사도 (코사인)">
                            {h.similarity.toFixed(2)}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="text-right align-top max-md:hidden">{h.status && <Tag tone={h.status.tone as Tone}>{h.status.label}</Tag>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
        <div className="bg-canvas px-3 py-1.5 text-[11.5px] text-fg-4">
          색인 <span className="mono">{st.owners}</span>개 객체 · <span className="mono">{st.chunks}</span>개 구획 · 약 <span className="mono">{st.tokens.toLocaleString()}</span> 토큰
          {st.lag > 0 && <> · 반영 대기 이벤트 <span className="mono">{st.lag}</span></>}
          {space && cov ? (
            <>
              {" · 의미 검색 "}
              <span className="mono text-fg-3">{space.model}</span> · <span className="mono">{space.dim}</span>차원 · 임베딩 <span className="mono">{cov.pct}%</span>
              {space.local_only ? "" : " · 외부 공급자"}
            </>
          ) : (
            " · 벡터 없음 — 어휘 + 관계"
          )}
        </div>
      </div>
    </>
  );
}
