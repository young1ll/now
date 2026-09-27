import type { Business } from "@/lib/repos/businesses";

export function BusinessSelect({
  businesses,
  defaultValue,
  allowShared = false,
  name = "business_id",
}: {
  businesses: Business[];
  defaultValue?: number | null;
  allowShared?: boolean;
  name?: string;
}) {
  return (
    <select name={name} className="input" defaultValue={defaultValue ?? ""} required={!allowShared}>
      {allowShared && <option value="">공용 (모든 사업)</option>}
      {businesses.map((b) => (
        <option key={b.id} value={b.id}>
          {b.name}
        </option>
      ))}
    </select>
  );
}

export function ClientSelect({
  clients,
  defaultValue,
  name = "client_id",
}: {
  clients: { id: number; name: string }[];
  defaultValue?: number | null;
  name?: string;
}) {
  return (
    <select name={name} className="input" defaultValue={defaultValue ?? ""}>
      <option value="">— 없음 —</option>
      {clients.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );
}

export function EnumSelect<K extends string | number>({
  name,
  options,
  defaultValue,
}: {
  name: string;
  options: Record<K, string | { label: string }>;
  defaultValue?: K;
}) {
  return (
    <select name={name} className="input" defaultValue={defaultValue as string | number | undefined}>
      {(Object.entries(options) as [string, string | { label: string }][]).map(([k, v]) => (
        <option key={k} value={k}>
          {typeof v === "string" ? v : v.label}
        </option>
      ))}
    </select>
  );
}
