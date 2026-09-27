import { BusinessSelect, ClientSelect, EnumSelect } from "@/components/selects";
import { Field } from "@/components/ui";
import { PRIORITY, RECURRENCE } from "@/lib/labels";
import type { Business } from "@/lib/repos/businesses";
import type { Task } from "@/lib/repos/tasks";

/** 업무 생성·수정 공용 필드. <form> 은 호출하는 쪽에서 감싼다. */
export function TaskFields({
  task,
  businesses,
  clients,
  defaultBusinessId,
}: {
  task?: Task;
  businesses: Business[];
  clients: { id: number; name: string }[];
  defaultBusinessId?: number | null;
}) {
  return (
    <>
      <Field label="업무명"><input name="title" defaultValue={task?.title} className="input" required /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="사업"><BusinessSelect businesses={businesses} defaultValue={task?.business_id ?? defaultBusinessId} /></Field>
        <Field label="고객"><ClientSelect clients={clients} defaultValue={task?.client_id} /></Field>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="마감일"><input type="date" name="due_date" defaultValue={task?.due_date ?? ""} className="input" /></Field>
        <Field label="우선순위"><EnumSelect name="priority" options={PRIORITY} defaultValue={task?.priority ?? 2} /></Field>
        <Field label="반복"><EnumSelect name="recurrence" options={RECURRENCE} defaultValue={task?.recurrence ?? "none"} /></Field>
      </div>
      <Field label="상세"><textarea name="detail" rows={3} defaultValue={task?.detail} className="input" /></Field>
    </>
  );
}
