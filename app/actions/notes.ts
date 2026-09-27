"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { checkbox, int, optInt, required, str, tags } from "@/lib/form";
import { createNote, deleteNote, updateNote } from "@/lib/repos/notes";
import { formAction } from "./util";

function parse(fd: FormData) {
  return {
    business_id: optInt(fd, "business_id"),
    client_id: optInt(fd, "client_id"),
    title: required(fd, "title", "제목"),
    body: str(fd, "body"),
    tags: tags(fd, "tags"),
    pinned: checkbox(fd, "pinned"),
  };
}

export const createNoteAction = formAction(async (fd) => {
  const id = createNote(db(), parse(fd));
  revalidatePath("/knowledge");
  redirect(`/knowledge/${id}`);
});

export const updateNoteAction = formAction(async (fd) => {
  const id = int(fd, "id");
  updateNote(db(), id, parse(fd));
  revalidatePath("/knowledge", "layout");
  redirect(`/knowledge/${id}`);
});

export const deleteNoteAction = formAction(async (fd) => {
  deleteNote(db(), int(fd, "id"));
  revalidatePath("/knowledge");
  redirect("/knowledge");
});
