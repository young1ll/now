import { createNoteAction } from "@/app/actions/notes";
import { NoteForm } from "@/components/NoteForm";
import { Card, PageHeader } from "@/components/ui";
import { currentScope } from "@/lib/context";
import { db } from "@/lib/db";
import { type SearchParams, idParam, one } from "@/lib/params";
import { listBusinesses } from "@/lib/repos/businesses";
import { clientOptions, getClient } from "@/lib/repos/clients";

export const metadata = { title: "새 문서" };

export default async function NewNotePage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const scope = await currentScope();
  const clientId = idParam(one(sp.client) ?? "");
  const client = clientId ? getClient(db(), clientId) : undefined;
  return (
    <>
      <PageHeader title="새 문서" error={one(sp.error)} />
      <Card>
        <NoteForm
          action={createNoteAction}
          businesses={listBusinesses(db())}
          clients={clientOptions(db(), scope)}
          defaults={{ business_id: client?.business_id ?? scope, client_id: client?.id }}
        />
      </Card>
    </>
  );
}
