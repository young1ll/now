import Link from "next/link";
import { createTaskAction, setTaskStatusAction } from "@/app/actions/tasks";
import { TaskFields } from "@/components/TaskForm";
import { Badge, BizTag, Card, Empty, PageHeader, Tabs } from "@/components/ui";
import { currentScope } from "@/lib/context";
import { daysBetween, formatDate, today } from "@/lib/dates";
import { db } from "@/lib/db";
import { PRIORITY, RECURRENCE, TASK_STATUS } from "@/lib/labels";
import { type SearchParams, one } from "@/lib/params";
import { listBusinesses } from "@/lib/repos/businesses";
import { clientOptions } from "@/lib/repos/clients";
import { type TaskRow, listTasks } from "@/lib/repos/tasks";

export const metadata = { title: "업무 · 마감" };

type View = "open" | "done" | "all";

export default async function TasksPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const view: View = (["open", "done", "all"] as const).find((v) => v === one(sp.view)) ?? "open";
  const scope = await currentScope();
  const tasks = listTasks(db(), scope, { view });
  const on = today();

  // 열린 업무는 마감 구간별로 묶어서 보여준다
  const groups: [string, TaskRow[]][] =
    view === "open"
      ? [
          ["지연", tasks.filter((t) => t.due_date && t.due_date < on)],
          ["오늘 · 이번 주", tasks.filter((t) => t.due_date && t.due_date >= on && daysBetween(on, t.due_date) <= 7)],
          ["이후", tasks.filter((t) => t.due_date && daysBetween(on, t.due_date) > 7)],
          ["마감 없음", tasks.filter((t) => !t.due_date)],
        ]
      : [["", tasks]];

  return (
    <>
      <PageHeader title="업무 · 마감" description="반복 업무(신고·정산 등)는 완료하면 다음 회차가 자동으로 생깁니다." error={one(sp.error)} />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Tabs
            current={view}
            items={[
              { key: "open", label: "진행 중", href: "/tasks" },
              { key: "done", label: "완료", href: "/tasks?view=done" },
              { key: "all", label: "전체", href: "/tasks?view=all" },
            ]}
          />
          {tasks.length === 0 ? (
            <Card><Empty>업무가 없습니다.</Empty></Card>
          ) : (
            <div className="space-y-5">
              {groups
                .filter(([, list]) => list.length > 0)
                .map(([label, list]) => (
                  <section key={label}>
                    {label && <h2 className={`mb-2 text-xs font-semibold ${label === "지연" ? "text-red-600" : "muted"}`}>{label} · {list.length}</h2>}
                    <Card flush>
                      <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                        {list.map((t) => <TaskItem key={t.id} task={t} on={on} />)}
                      </ul>
                    </Card>
                  </section>
                ))}
            </div>
          )}
        </div>

        <Card title="새 업무">
          <form action={createTaskAction} className="grid gap-3">
            <TaskFields
              businesses={listBusinesses(db())}
              clients={clientOptions(db(), scope)}
              defaultBusinessId={scope ?? listBusinesses(db())[0]?.id}
            />
            <button className="btn-primary">추가</button>
          </form>
        </Card>
      </div>
    </>
  );
}

function TaskItem({ task: t, on }: { task: TaskRow; on: string }) {
  const days = t.due_date ? daysBetween(on, t.due_date) : null;
  const next = t.status === "todo" ? "doing" : t.status === "doing" ? "done" : "todo";
  return (
    <li className="flex items-start gap-3 px-4 py-2.5">
      <form action={setTaskStatusAction} className="pt-0.5">
        <input type="hidden" name="id" value={t.id} />
        <input type="hidden" name="status" value={next} />
        <button title={`→ ${TASK_STATUS[next].label}`}>
          <Badge tone={TASK_STATUS[t.status].tone}>{TASK_STATUS[t.status].label}</Badge>
        </button>
      </form>
      <div className="min-w-0 flex-1">
        <Link href={`/tasks/${t.id}`} className={`text-sm hover:underline ${t.status === "done" ? "muted line-through" : ""}`}>
          {t.priority === 1 && <span className="mr-1 text-red-600">!</span>}
          {t.title}
        </Link>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs">
          <BizTag name={t.business_name} color={t.business_color} />
          {t.client_name && <Link href={`/clients/${t.client_id}`} className="muted hover:underline">· {t.client_name}</Link>}
          {t.recurrence !== "none" && <span className="muted">· ↻ {RECURRENCE[t.recurrence]}</span>}
          {t.priority !== 2 && <span className="muted">· {PRIORITY[t.priority]}</span>}
        </div>
      </div>
      <div className="text-right text-xs tabular-nums">
        {t.status === "done" ? (
          <span className="muted">{formatDate(t.completed_at)} 완료</span>
        ) : t.due_date ? (
          <>
            <div>{formatDate(t.due_date)}</div>
            <div className={days! < 0 ? "text-red-600" : days! <= 2 ? "text-amber-600" : "muted"}>
              {days! < 0 ? `${-days!}일 지남` : days === 0 ? "오늘" : `D-${days}`}
            </div>
          </>
        ) : null}
      </div>
    </li>
  );
}
