import { BusinessSelect, ClientSelect } from "@/components/selects";
import { Field } from "@/components/ui";
import { addDays, today } from "@/lib/dates";
import { toMajor } from "@/lib/money";
import type { Business } from "@/lib/repos/businesses";
import type { Invoice, InvoiceItem } from "@/lib/repos/finance";

const BLANK_ROWS = 3;

/** 청구서 생성·수정 폼. 품목은 빈 줄을 무시한다 (JS 없이 동작). */
export function InvoiceForm({
  action,
  businesses,
  clients,
  invoice,
  items = [],
  defaults = {},
}: {
  action: (fd: FormData) => Promise<void>;
  businesses: Business[];
  clients: { id: number; name: string }[];
  invoice?: Invoice;
  items?: InvoiceItem[];
  defaults?: { business_id?: number | null; client_id?: number | null };
}) {
  const issue = invoice?.issue_date ?? today();
  const rows = [...items.map((it) => ({ ...it, price: String(toMajor(it.unit_price, invoice!.currency)) })), ...Array.from({ length: BLANK_ROWS }, () => null)];
  const defaultTax = invoice?.tax_rate ?? (businesses.find((b) => b.id === defaults.business_id)?.currency === "KRW" ? 10 : 0);

  return (
    <form action={action} className="grid gap-4">
      {invoice && <input type="hidden" name="id" value={invoice.id} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="사업 (통화는 사업 기본 통화)">
          <BusinessSelect businesses={businesses} defaultValue={invoice?.business_id ?? defaults.business_id} />
        </Field>
        <Field label="고객"><ClientSelect clients={clients} defaultValue={invoice?.client_id ?? defaults.client_id} /></Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="발행일"><input type="date" name="issue_date" defaultValue={issue} className="input" required /></Field>
        <Field label="지급기한"><input type="date" name="due_date" defaultValue={invoice ? invoice.due_date ?? "" : addDays(issue, 14)} className="input" /></Field>
        <Field label="부가세율 (%)"><input type="number" name="tax_rate" min={0} step="0.1" defaultValue={defaultTax} className="input" /></Field>
      </div>

      <div>
        <div className="mb-1 grid grid-cols-[1fr_5rem_9rem] gap-2 text-xs font-medium text-zinc-500">
          <span>품목</span><span>수량</span><span>단가</span>
        </div>
        <div className="grid gap-2">
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-[1fr_5rem_9rem] gap-2">
              <input name={`item_desc_${i}`} defaultValue={r?.description} className="input" placeholder={i === 0 ? "예: 9월 기장 대행" : ""} />
              <input name={`item_qty_${i}`} type="number" step="any" min="0" defaultValue={r?.quantity ?? 1} className="input" />
              <input name={`item_price_${i}`} inputMode="decimal" defaultValue={r?.price} className="input text-right" placeholder="0" />
            </div>
          ))}
        </div>
        <p className="muted mt-1 text-xs">빈 줄은 무시됩니다. 품목이 더 필요하면 저장 후 수정하면 빈 줄이 다시 생깁니다.</p>
      </div>

      <Field label="메모 (청구서에 표시)"><textarea name="memo" rows={2} defaultValue={invoice?.memo} className="input" placeholder="입금 계좌 등" /></Field>
      <div><button className="btn-primary">{invoice ? "저장" : "청구서 만들기"}</button></div>
    </form>
  );
}
