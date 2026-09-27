import { notFound } from "next/navigation";
import { formatDate } from "@/lib/dates";
import { db } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { idParam } from "@/lib/params";
import { getBusiness } from "@/lib/repos/businesses";
import { getClient } from "@/lib/repos/clients";
import { getInvoice } from "@/lib/repos/finance";

export const dynamic = "force-dynamic";

/** 고객에게 보내는 인쇄용 청구서 — 콘솔 테마와 분리된 밝은 문서. Ctrl/Cmd+P → PDF. */
export default async function PrintInvoice({ params }: { params: Promise<{ id: string }> }) {
  const id = idParam((await params).id);
  const d = id ? getInvoice(db(), id) : undefined;
  if (!d) notFound();
  const { invoice: inv, items } = d;
  const b = getBusiness(db(), inv.business_id)!;
  const c = inv.client_id ? getClient(db(), inv.client_id) : undefined;
  const m = (n: number) => formatMoney(n, inv.currency);
  return (
    <div style={{ background: "#fff", color: "#1c2127", minHeight: "100vh", colorScheme: "light" }}>
      <article className="mx-auto max-w-[780px] px-10 py-12 text-[13px]" style={{ fontFamily: "var(--font-sans)" }}>
        <div className="flex justify-between border-b-2 pb-4" style={{ borderColor: "#1c2127" }}>
          <div>
            <div className="text-[26px] font-bold tracking-tight">청구서</div>
            <div className="font-mono text-[12px]" style={{ color: "#5f6b7c" }}>INVOICE No. {inv.number}</div>
          </div>
          <div className="text-right">
            <div className="text-[15px] font-semibold">{b.name}</div>
            <div style={{ color: "#5f6b7c" }}>{b.kind}</div>
          </div>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-6">
          <div>
            <div className="text-[10.5px] font-semibold tracking-[0.08em] uppercase" style={{ color: "#5f6b7c" }}>청구 대상</div>
            <div className="mt-1 text-[15px] font-semibold">{c?.name ?? "—"}</div>
            {c?.email && <div style={{ color: "#5f6b7c" }}>{c.email}</div>}
          </div>
          <div className="text-right">
            <div><span style={{ color: "#5f6b7c" }}>발행일</span> <span className="font-mono">{formatDate(inv.issue_date)}</span></div>
            {inv.due_date && <div><span style={{ color: "#5f6b7c" }}>지급기한</span> <span className="font-mono">{formatDate(inv.due_date)}</span></div>}
            <div className="mt-2 text-[20px] font-bold">{m(inv.total)}</div>
          </div>
        </div>
        <table className="mt-8 w-full border-collapse">
          <thead>
            <tr style={{ borderBottom: "1px solid #1c2127" }}>
              {["품목", "수량", "단가", "금액"].map((h, i) => (
                <th key={h} className={`py-2 text-[10.5px] font-semibold tracking-[0.08em] uppercase ${i ? "text-right" : "text-left"}`} style={{ color: "#5f6b7c" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id} style={{ borderBottom: "1px solid #d3d8de" }}>
                <td className="py-2">{it.description}</td>
                <td className="py-2 text-right font-mono">{it.quantity}</td>
                <td className="py-2 text-right font-mono">{m(it.unit_price)}</td>
                <td className="py-2 text-right font-mono">{m(Math.round(it.quantity * it.unit_price))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="mt-4 ml-auto grid max-w-[300px] grid-cols-2 gap-y-1 font-mono">
          <dt style={{ color: "#5f6b7c" }}>공급가액</dt><dd className="text-right">{m(inv.subtotal)}</dd>
          {inv.tax_rate > 0 && <><dt style={{ color: "#5f6b7c" }}>부가세 {inv.tax_rate}%</dt><dd className="text-right">{m(inv.tax)}</dd></>}
          <dt className="border-t pt-1 font-bold" style={{ borderColor: "#1c2127" }}>합계</dt>
          <dd className="border-t pt-1 text-right font-bold" style={{ borderColor: "#1c2127" }}>{m(inv.total)}</dd>
        </dl>
        {inv.memo && <p className="mt-10 border-t pt-4 whitespace-pre-wrap" style={{ borderColor: "#d3d8de" }}>{inv.memo}</p>}
      </article>
    </div>
  );
}
