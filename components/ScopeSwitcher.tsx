"use client";

import { switchScopeAction } from "@/app/actions/businesses";

export function ScopeSwitcher({
  businesses,
  current,
}: {
  businesses: { id: number; name: string }[];
  current: number | null;
}) {
  return (
    <form action={switchScopeAction}>
      <label className="muted mb-1 block text-xs">사업 범위</label>
      <select
        name="scope"
        className="input"
        defaultValue={current ?? "all"}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
      >
        <option value="all">전체 사업</option>
        {businesses.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
    </form>
  );
}
