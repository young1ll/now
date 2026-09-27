import { PRIORITY, RECURRENCE, TASK_STATUS } from "@/lib/labels";
import { getBusiness } from "@/lib/repos/businesses";
import { RECURRENCES, TASK_STATUSES, createTask, deleteTask, getTask, setTaskStatus, updateTask } from "@/lib/repos/tasks";
import { defineAction } from "../action";
import { f } from "../fields";
import { displayId } from "../ids";
import { ActionError } from "../types";
import { checkBusiness, checkClient, labels, merge, must } from "./util";

const PRIORITIES = ["1", "2", "3"] as const;
const prioLabels = { "1": PRIORITY[1], "2": PRIORITY[2], "3": PRIORITY[3] };

const taskFields = {
  title: f.text("업무명", { nonEmpty: true }),
  detail: f.textarea("상세"),
  client_id: f.ref("고객", "client", { nullable: true }),
  priority: f.enum("우선순위", PRIORITIES, prioLabels),
  due_date: f.date("마감일", { nullable: true }),
  recurrence: f.enum("반복", RECURRENCES, RECURRENCE),
};

export const taskActions = [
  defineAction({
    name: "task.create",
    title: "업무 생성",
    description: "업무를 만든다. 반복(recurrence)을 지정하면 완료 시 다음 회차가 자동 생성된다.",
    objectType: "task",
    risk: "low",
    fields: { business_id: f.ref("사업", "business", { required: true }), ...taskFields, title: f.text("업무명", { required: true }) },
    run({ db }, i) {
      must(getBusiness(db, i.business_id), "사업");
      checkClient(db, i.client_id, i.business_id);
      const id = createTask(db, {
        business_id: i.business_id,
        client_id: i.client_id ?? null,
        title: i.title!,
        detail: i.detail ?? "",
        priority: Number(i.priority ?? "2") as 1 | 2 | 3,
        due_date: i.due_date ?? null,
        recurrence: i.recurrence ?? "none",
      });
      const refs = [{ type: "task" as const, id }, ...(i.client_id ? [{ type: "client" as const, id: i.client_id }] : [])];
      return { summary: `업무 ${displayId("task", id)} '${i.title}' 생성${i.due_date ? ` (마감 ${i.due_date})` : ""}`, refs };
    },
  }),
  defineAction({
    name: "task.update",
    title: "업무 수정",
    description: "업무 속성을 부분 수정한다.",
    objectType: "task",
    risk: "low",
    target: { type: "task", param: "id" },
    fields: { id: f.ref("업무", "task", { required: true }), business_id: f.ref("사업", "business"), ...taskFields },
    prefill: (db, id) => {
      const t = getTask(db, id);
      return t && { ...t, priority: String(t.priority) };
    },
    preview: (db, i) => `업무 '${getTask(db, i.id)?.title ?? i.id}' 수정`,
    run({ db }, i) {
      const cur = must(getTask(db, i.id), "업무");
      const next = merge(cur, { ...i, priority: i.priority === undefined ? undefined : Number(i.priority) });
      checkBusiness(db, next.business_id);
      checkClient(db, next.client_id, next.business_id);
      updateTask(db, i.id, next);
      return { summary: `업무 ${displayId("task", i.id)} '${next.title}' 수정`, refs: [{ type: "task", id: i.id }] };
    },
  }),
  defineAction({
    name: "task.set_status",
    title: "업무 상태 변경",
    description: "todo / doing / done. 반복 업무를 done 으로 바꾸면 다음 회차가 생성된다.",
    objectType: "task",
    risk: "low",
    target: { type: "task", param: "id" },
    fields: {
      id: f.ref("업무", "task", { required: true }),
      status: f.enum("상태", TASK_STATUSES, labels(TASK_STATUS), { required: true }),
    },
    preview: (db, i) => `업무 '${getTask(db, i.id)?.title ?? i.id}' → ${TASK_STATUS[i.status].label}`,
    run({ db }, i) {
      const t = must(getTask(db, i.id), "업무");
      if (t.status === i.status) throw new ActionError(`이미 '${TASK_STATUS[i.status].label}' 상태입니다`);
      const next = setTaskStatus(db, i.id, i.status);
      const refs = [{ type: "task" as const, id: i.id }, ...(next ? [{ type: "task" as const, id: next }] : [])];
      return {
        summary: `업무 '${t.title}' → ${TASK_STATUS[i.status].label}${next ? ` · 다음 회차 ${displayId("task", next)} 생성` : ""}`,
        refs,
      };
    },
  }),
  defineAction({
    name: "task.delete",
    title: "업무 삭제",
    description: "업무를 삭제한다. 되돌릴 수 없다.",
    objectType: "task",
    risk: "high",
    target: { type: "task", param: "id" },
    fields: { id: f.ref("업무", "task", { required: true }) },
    preview: (db, i) => `업무 '${getTask(db, i.id)?.title ?? i.id}' 삭제`,
    run({ db }, i) {
      const t = must(getTask(db, i.id), "업무");
      deleteTask(db, i.id);
      return { summary: `업무 ${displayId("task", i.id)} '${t.title}' 삭제`, refs: [], data: { deleted: t } };
    },
  }),
];
