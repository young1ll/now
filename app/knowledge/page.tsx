import Link from "next/link";
import { BizTag, Card, Empty, PageHeader } from "@/components/ui";
import { currentScope } from "@/lib/context";
import { formatDate } from "@/lib/dates";
import { db } from "@/lib/db";
import { type SearchParams, one } from "@/lib/params";
import { listNotes, noteTags, splitTags } from "@/lib/repos/notes";

export const metadata = { title: "지식 · 문서" };

export default async function KnowledgePage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const scope = await currentScope();
  const q = one(sp.q)?.trim() || undefined;
  const tag = one(sp.tag) || undefined;
  const notes = listNotes(db(), scope, { q, tag });
  const tags = noteTags(db(), scope);

  return (
    <>
      <PageHeader
        title="지식 · 문서"
        description="SOP, 체크리스트, 템플릿, 리서치 메모. 사업을 지정하지 않은 문서는 모든 사업에서 보입니다."
        actions={<Link href="/knowledge/new" className="btn-primary">+ 새 문서</Link>}
      />
      <form className="mb-3 flex gap-2" action="/knowledge">
        {tag && <input type="hidden" name="tag" value={tag} />}
        <input name="q" defaultValue={q} placeholder="제목·본문·태그 전문 검색" className="input" />
        <button className="btn">검색</button>
      </form>
      {tags.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          <Link href={q ? `/knowledge?q=${encodeURIComponent(q)}` : "/knowledge"} className={!tag ? "btn-primary btn-sm" : "btn btn-sm"}>모든 태그</Link>
          {tags.map((t) => (
            <Link key={t} href={`/knowledge?${new URLSearchParams({ tag: t, ...(q && { q }) })}`} className={tag === t ? "btn-primary btn-sm" : "btn btn-sm"}>
              #{t}
            </Link>
          ))}
        </div>
      )}
      {notes.length === 0 ? (
        <Card><Empty>{q || tag ? "검색 결과가 없습니다." : "문서가 없습니다. 자주 반복하는 절차부터 SOP 로 적어 보세요."}</Empty></Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {notes.map((n) => (
            <Link key={n.id} href={`/knowledge/${n.id}`} className="block rounded-lg border border-zinc-200 bg-white p-4 hover:border-indigo-300 dark:border-zinc-800 dark:bg-zinc-900/60 dark:hover:border-indigo-700">
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-medium">{n.pinned ? "📌 " : ""}{n.title}</h2>
              </div>
              <p className="muted mt-1 line-clamp-3 text-xs whitespace-pre-line">{n.body.replace(/[#*`>\[\]]/g, "").slice(0, 200)}</p>
              <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
                <BizTag name={n.business_name} color={n.business_color} />
                {n.client_name && <span className="muted text-xs">· {n.client_name}</span>}
                {splitTags(n.tags).map((t) => <span key={t} className="text-xs text-indigo-600 dark:text-indigo-400">#{t}</span>)}
                <span className="muted ml-auto text-xs">{formatDate(n.updated_at)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
