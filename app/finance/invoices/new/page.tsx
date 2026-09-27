import { createInvoiceAction } from "@/app/actions/finance";
import { InvoiceForm } from "@/components/InvoiceForm";
import { Card, PageHeader } from "@/components/ui";
import { currentScope } from "@/lib/context";
import { db } from "@/lib/db";
import { type SearchParams, idParam, one } from "@/lib/params";
import { listBusinesses } from "@/lib/repos/businesses";
import { clientOptions, getClient } from "@/lib/repos/clients";

export const metadata = { title: "새 청구서" };

export default async function NewInvoicePage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const scope = await currentScope();
  const clientId = idParam(one(sp.client) ?? "");
  const client = clientId ? getClient(db(), clientId) : undefined;
  const businesses = listBusinesses(db());
  return (
    <>
      <PageHeader title="새 청구서" error={one(sp.error)} />
      <Card>
        <InvoiceForm
          action={createInvoiceAction}
          businesses={businesses}
          clients={clientOptions(db(), scope)}
          defaults={{ business_id: client?.business_id ?? scope ?? businesses[0]?.id, client_id: client?.id }}
        />
      </Card>
    </>
  );
}
