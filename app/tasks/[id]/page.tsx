import Link from "next/link";
import { notFound } from "next/navigation";
import { deleteTaskAction, setTaskStatusAction, updateTaskAction } from "@/app/actions/tasks";
import { ConfirmButton } from "@/components/ConfirmButton";
import { TaskFields } from "@/components/TaskForm";
import { Badge, Card, PageHeader } from "@/components/ui";
import { formatDate } from "@/lib/dates";
import { db } from "@/lib/db";
import { TASK_STATUS } from "@/lib/labels";
import { type SearchParams, idParam, one } from "@/lib/params";
import { listBusinesses } from "@/lib/repos/businesses";
import { clientOptions } from "@/lib/repos/clients";
import { TASK_STATUSES, getTask } from "@/lib/repos/tasks";

export default async function TaskPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const id = idParam((await params).id);
  const task = id ? getTask(db(), id) : undefined;
  if (!task) notFound();
  const sp = await searchParams;

  return (
    <>
      <PageHeader
        title={task.title}
        description={`등록 ${formatDate(task.created_at)}${task.completed_at ? ` · 완료 ${formatDate(task.completed_at)}` : ""}`}
        error={one(sp.error)}
        actions={<Link href="/tasks" className="btn">← 목록</Link>}
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="수정" className="lg:col-span-2">
          <form action={updateTaskAction} className="grid gap-3">
            <input type="hidden" name="id" value={task.id} />
            <TaskFields task={task} businesses={listBusinesses(db(), { includeArchived: true })} clients={clientOptions(db(), null)} />
            <button className="btn-primary">저장</button>
          </form>
        </Card>
        <div className="space-y-4">
          <Card title="상태">
            <div className="flex flex-wrap gap-2">
              {TASK_STATUSES.map((s) => (
                <form key={s} action={setTaskStatusAction}>
                  <input type="hidden" name="id" value={task.id} />
                  <input type="hidden" name="status" value={s} />
                  <button className={s === task.status ? "btn-primary" : "btn"} disabled={s === task.status}>
                    {TASK_STATUS[s].label}
                  </button>
                </form>
              ))}
            </div>
            {task.recurrence !== "none" && task.status !== "done" && (
              <p className="muted mt-3 text-xs">완료하면 다음 회차 업무가 자동으로 생성됩니다.</p>
            )}
            {task.status === "done" && <p className="mt-3"><Badge tone="green">완료됨</Badge></p>}
          </Card>
          <form action={deleteTaskAction}>
            <input type="hidden" name="id" value={task.id} />
            <ConfirmButton>업무 삭제</ConfirmButton>
          </form>
        </div>
      </div>
    </>
  );
}
