"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { int, oneOf, optDate, optInt, required, str } from "@/lib/form";
import { RECURRENCES, TASK_STATUSES, createTask, deleteTask, setTaskStatus, updateTask } from "@/lib/repos/tasks";
import { formAction } from "./util";

function parse(fd: FormData) {
  const priority = Number(str(fd, "priority"));
  return {
    business_id: int(fd, "business_id"),
    client_id: optInt(fd, "client_id"),
    title: required(fd, "title", "업무명"),
    detail: str(fd, "detail"),
    priority: (priority === 1 || priority === 3 ? priority : 2) as 1 | 2 | 3,
    due_date: optDate(fd, "due_date"),
    recurrence: oneOf(fd, "recurrence", RECURRENCES, "none"),
  };
}

function refresh() {
  revalidatePath("/", "layout");
}

export const createTaskAction = formAction(async (fd) => {
  createTask(db(), parse(fd));
  refresh();
});

export const updateTaskAction = formAction(async (fd) => {
  updateTask(db(), int(fd, "id"), parse(fd));
  refresh();
  redirect(str(fd, "next") || "/tasks");
});

export const setTaskStatusAction = formAction(async (fd) => {
  setTaskStatus(db(), int(fd, "id"), oneOf(fd, "status", TASK_STATUSES, "todo"));
  refresh();
});

export const deleteTaskAction = formAction(async (fd) => {
  deleteTask(db(), int(fd, "id"));
  refresh();
  redirect("/tasks");
});
