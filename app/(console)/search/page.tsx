import Link from "next/link";
import { Empty, ObjectLink, PageHeader, Panel, Tag } from "@/components/ui";
import { currentScope } from "@/lib/context";
import { db } from "@/lib/db";
import { OBJECTS, searchObjects } from "@/lib/ontology/objects";
import { type SearchParams, one } from "@/lib/params";

export const metadata = { title: "검색" };

export default async function SearchPage({ searchParams }: { searchParams: SearchParams }) {
  const q = one((await searchParams).q)?.trim() ?? "";
  const scope = await currentScope();
  const rows = q ? searchObjects(db(), scope, q, 20) : [];
  const groups = Object.entries(Object.groupBy(rows, (r) => r.ref.type));
  return (
    <>
      <PageHeader icon="search" eyebrow="검색" title={q ? `“${q}”` : "객체 검색"} meta={q ? `${rows.length}건` : "상단 검색창 또는 / 키"} />
      <div className="flex flex-col gap-px bg-void p-px">
        {q && rows.length === 0 && <Panel><Empty icon="search">결과가 없습니다.</Empty></Panel>}
        {groups.map(([type, list]) => (
          <Panel key={type} title={OBJECTS[type as keyof typeof OBJECTS].plural} count={list!.length} flush action={<Link href={`/o/${type}?q=${encodeURIComponent(q)}`} className="btn-minimal btn-sm">탐색기에서 보기</Link>}>
            <table className="grid-table">
              <tbody>
                {list!.map((r) => (
                  <tr key={r.displayId}>
                    <td className="w-[40%]"><ObjectLink type={r.ref.type} id={r.ref.id} title={r.title} /></td>
                    <td className="max-w-[300px] truncate text-fg-3">{r.subtitle}</td>
                    <td className="text-right">{r.status && <Tag tone={r.status.tone}>{r.status.label}</Tag>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        ))}
      </div>
    </>
  );
}
