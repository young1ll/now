import Link from "next/link";
import { runActionForm } from "@/app/actions/console";
import { ActionDrawer, actHref } from "@/components/ActionDrawer";
import { Icon } from "@/components/icons";
import { Empty, PageHeader, Panel, Tag } from "@/components/ui";
import { currentScope } from "@/lib/context";
import { addDays, daysBetween, formatDate, parseYmd, today } from "@/lib/dates";
import { db } from "@/lib/db";
import { PRIORITY, RECURRENCE, TASK_STATUS } from "@/lib/labels";
import type { SearchParams } from "@/lib/params";
import { type TaskRow, listTasks } from "@/lib/repos/tasks";

export const metadata = { title: "일정 · 마감" };

const WEEK = ["일", "월", "화", "수", "목", "금", "토"];

export default async function SchedulePage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const scope = await currentScope();
  const on = today();
  const tasks = listTasks(db(), scope, { view: "open" });
  const days = Array.from({ length: 14 }, (_, i) => addDays(on, i));
  const groups: [string, TaskRow[], "red" | "amber" | "slate"][] = [
    ["지연", tasks.filter((t) => t.due_date && t.due_date < on), "red"],
    ["오늘", tasks.filter((t) => t.due_date === on), "amber"],
    ["7일 이내", tasks.filter((t) => t.due_date && t.due_date > on && daysBetween(on, t.due_date) <= 7), "slate"],
    ["이후", tasks.filter((t) => t.due_date && daysBetween(on, t.due_date) > 7), "slate"],
    ["마감 없음", tasks.filter((t) => !t.due_date), "slate"],
  ];

  return (
    <>
      <PageHeader
        icon="calendar"
        eyebrow="운영"
        title="일정 · 마감"
        meta="반복 업무(신고·정산·구독)는 완료하면 다음 회차가 자동 생성됩니다."
        actions={<Link href={actHref("/schedule", "task.create", {}, { business_id: scope ?? undefined })} className="btn-primary"><Icon name="plus" size={12} /> 업무</Link>}
      />
      {/* 14일 타임라인 */}
      <div className="grid grid-cols-7 border-b border-line bg-panel lg:grid-cols-14">
        {days.map((d) => {
          const list = tasks.filter((t) => t.due_date === d);
          const dow = parseYmd(d).getDay();
          return (
            <div key={d} className={`min-h-24 border-r border-b border-line-soft p-1.5 lg:border-b-0 ${d === on ? "bg-primary/10" : ""}`}>
              <div className={`mono mb-1 flex justify-between text-[11px] ${dow === 0 || dow === 6 ? "text-fg-4" : "text-fg-3"}`}>
                <span>{d.slice(5).replace("-", ".")}</span><span>{WEEK[dow]}</span>
              </div>
              {list.slice(0, 3).map((t) => (
                <Link key={t.id} href={`/o/task/${t.id}`} className="mb-0.5 block truncate border-l-2 bg-raised px-1 text-[11px] hover:bg-hover" style={{ borderColor: t.business_color }} title={t.title}>
                  {t.title}
                </Link>
              ))}
              {list.length > 3 && <div className="text-[10.5px] text-fg-4">+{list.length - 3}</div>}
            </div>
          );
        })}
      </div>
      <div className="flex flex-col gap-px bg-void p-px">
        {tasks.length === 0 && <Panel><Empty>열린 업무가 없습니다.</Empty></Panel>}
        {groups.filter(([, l]) => l.length).map(([label, list, tone]) => (
          <Panel key={label} title={<><Tag tone={tone}>{label}</Tag></>} count={list.length} flush>
            <table className="grid-table">
              <thead><tr><th className="w-[36px]" /><th>업무</th><th>마감</th><th>우선순위</th><th>고객</th><th>사업</th><th>반복</th><th>상태</th></tr></thead>
              <tbody>
                {list.map((t) => {
                  const d = t.due_date ? daysBetween(on, t.due_date) : null;
                  return (
                    <tr key={t.id}>
                      <td>
                        <form action={runActionForm}>
                          <input type="hidden" name="__action" value="task.set_status" />
                          <input type="hidden" name="id" value={t.id} />
                          <input type="hidden" name="status" value="done" />
                          <button className="flex size-4 items-center justify-center border border-line-strong hover:border-success hover:bg-success/30" title="완료" />
                        </form>
                      </td>
                      <td className="max-w-[360px] truncate"><Link href={`/o/task/${t.id}`} className="hover:underline">{t.title}</Link></td>
                      <td className="mono whitespace-nowrap">{formatDate(t.due_date)} {d !== null && <span className={d < 0 ? "text-danger-fg" : d <= 1 ? "text-warning-fg" : "text-fg-4"}>{d < 0 ? `${d}d` : d === 0 ? "오늘" : `D-${d}`}</span>}</td>
                      <td className={t.priority === 1 ? "text-danger-fg" : "text-fg-3"}>{PRIORITY[t.priority]}</td>
                      <td>{t.client_name ? <Link href={`/o/client/${t.client_id}`} className="hover:underline">{t.client_name}</Link> : "—"}</td>
                      <td className="text-fg-3"><span className="mr-1.5 inline-block size-2" style={{ background: t.business_color }} />{t.business_name}</td>
                      <td className="text-fg-3">{t.recurrence === "none" ? "—" : `↻ ${RECURRENCE[t.recurrence]}`}</td>
                      <td><Tag tone={TASK_STATUS[t.status].tone}>{TASK_STATUS[t.status].label}</Tag></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>
        ))}
      </div>
      <ActionDrawer sp={sp} path="/schedule" scope={scope} next="/schedule" />
    </>
  );
}
