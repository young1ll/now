import { createBusinessAction, updateBusinessAction } from "@/app/actions/businesses";
import { Card, Field, PageHeader } from "@/components/ui";
import { db, dbPath } from "@/lib/db";
import { CURRENCIES } from "@/lib/labels";
import { type SearchParams, one } from "@/lib/params";
import { listBusinesses } from "@/lib/repos/businesses";

export const metadata = { title: "설정" };

export default async function SettingsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const businesses = listBusinesses(db(), { includeArchived: true });
  return (
    <>
      <PageHeader title="설정" description="운영 중인 사업을 관리합니다." error={one(sp.error)} />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {businesses.map((b) => (
            <Card key={b.id}>
              <form action={updateBusinessAction} className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_6rem_4rem_auto]">
                <input type="hidden" name="id" value={b.id} />
                <Field label="이름"><input name="name" defaultValue={b.name} className="input" required /></Field>
                <Field label="업종 · 설명"><input name="kind" defaultValue={b.kind} className="input" /></Field>
                <Field label="통화">
                  <select name="currency" defaultValue={b.currency} className="input">{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select>
                </Field>
                <Field label="색상"><input type="color" name="color" defaultValue={b.color} className="input h-9 p-1" /></Field>
                <div className="flex items-center gap-3 pb-1.5">
                  <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" name="archived" defaultChecked={!!b.archived} /> 보관</label>
                  <button className="btn">저장</button>
                </div>
              </form>
            </Card>
          ))}
          <p className="muted text-xs">
            보관한 사업은 목록·선택지에서 숨겨지지만 데이터는 그대로 남습니다. 통화를 바꾸면 기존 금액의 단위는 바뀌지 않으니 주의하세요.
          </p>
        </div>
        <div className="space-y-4">
          <Card title="사업 추가">
            <form action={createBusinessAction} className="grid gap-3">
              <Field label="이름"><input name="name" className="input" required /></Field>
              <Field label="업종 · 설명"><input name="kind" className="input" /></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="통화">
                  <select name="currency" defaultValue="KRW" className="input">{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select>
                </Field>
                <Field label="색상"><input type="color" name="color" defaultValue="#10b981" className="input h-9 p-1" /></Field>
              </div>
              <button className="btn-primary">추가</button>
            </form>
          </Card>
          <Card title="데이터">
            <p className="text-sm">모든 데이터는 이 컴퓨터의 SQLite 파일 하나에 저장됩니다.</p>
            <code className="mt-2 block rounded bg-zinc-100 p-2 text-xs break-all dark:bg-zinc-800">{dbPath()}</code>
            <p className="muted mt-2 text-xs">백업은 이 파일을 복사하면 됩니다 (<code>npm run db:backup</code>).</p>
          </Card>
        </div>
      </div>
    </>
  );
}
