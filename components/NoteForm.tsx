import { BusinessSelect, ClientSelect } from "@/components/selects";
import { Field } from "@/components/ui";
import type { Business } from "@/lib/repos/businesses";
import type { Note } from "@/lib/repos/notes";

export function NoteForm({
  action,
  businesses,
  clients,
  note,
  defaults = {},
}: {
  action: (fd: FormData) => Promise<void>;
  businesses: Business[];
  clients: { id: number; name: string }[];
  note?: Note;
  defaults?: { business_id?: number | null; client_id?: number | null };
}) {
  return (
    <form action={action} className="grid gap-3">
      {note && <input type="hidden" name="id" value={note.id} />}
      <Field label="제목"><input name="title" defaultValue={note?.title} className="input text-base font-medium" required /></Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="사업"><BusinessSelect businesses={businesses} allowShared defaultValue={note ? note.business_id : defaults.business_id} /></Field>
        <Field label="고객"><ClientSelect clients={clients} defaultValue={note?.client_id ?? defaults.client_id} /></Field>
        <Field label="태그 (쉼표 구분)"><input name="tags" defaultValue={note?.tags} className="input" placeholder="SOP, 템플릿" /></Field>
      </div>
      <Field label="본문 (마크다운: # 제목, - 목록, - [ ] 체크리스트, **굵게**, `코드`, [링크](url))">
        <textarea name="body" rows={20} defaultValue={note?.body} className="input font-mono text-[13px] leading-relaxed" />
      </Field>
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="pinned" defaultChecked={!!note?.pinned} /> 상단 고정
        </label>
        <button className="btn-primary">저장</button>
      </div>
    </form>
  );
}
