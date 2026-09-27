import Link from "next/link";
import { notFound } from "next/navigation";
import { deleteNoteAction, updateNoteAction } from "@/app/actions/notes";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Markdown } from "@/components/Markdown";
import { NoteForm } from "@/components/NoteForm";
import { Card, PageHeader } from "@/components/ui";
import { formatDate } from "@/lib/dates";
import { db } from "@/lib/db";
import { type SearchParams, idParam, one } from "@/lib/params";
import { getBusiness, listBusinesses } from "@/lib/repos/businesses";
import { clientOptions, getClient } from "@/lib/repos/clients";
import { getNote, splitTags } from "@/lib/repos/notes";

export default async function NotePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const id = idParam((await params).id);
  const note = id ? getNote(db(), id) : undefined;
  if (!note) notFound();
  const sp = await searchParams;

  if (one(sp.edit)) {
    return (
      <>
        <PageHeader title="문서 수정" error={one(sp.error)} actions={<Link href={`/knowledge/${note.id}`} className="btn">취소</Link>} />
        <Card>
          <NoteForm action={updateNoteAction} businesses={listBusinesses(db(), { includeArchived: true })} clients={clientOptions(db(), null)} note={note} />
        </Card>
      </>
    );
  }

  const business = note.business_id ? getBusiness(db(), note.business_id) : undefined;
  const client = note.client_id ? getClient(db(), note.client_id) : undefined;

  return (
    <>
      <PageHeader
        title={note.title}
        description={
          <>
            {business?.name ?? "공용"}
            {client && <> · <Link href={`/clients/${client.id}`} className="link">{client.name}</Link></>}
            {" · "}수정 {formatDate(note.updated_at)}
            {splitTags(note.tags).map((t) => <Link key={t} href={`/knowledge?tag=${encodeURIComponent(t)}`} className="link ml-2">#{t}</Link>)}
          </>
        }
        actions={
          <>
            <Link href="/knowledge" className="btn">← 목록</Link>
            <Link href={`/knowledge/${note.id}?edit=1`} className="btn-primary">수정</Link>
          </>
        }
      />
      <Card>{note.body.trim() ? <Markdown source={note.body} /> : <p className="muted text-sm">본문이 비어 있습니다.</p>}</Card>
      <form action={deleteNoteAction} className="no-print mt-6">
        <input type="hidden" name="id" value={note.id} />
        <ConfirmButton>문서 삭제</ConfirmButton>
      </form>
    </>
  );
}
