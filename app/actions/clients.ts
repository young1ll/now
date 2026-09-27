"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { date, int, oneOf, required, str, tags } from "@/lib/form";
import {
  CLIENT_STATUSES, INTERACTION_KINDS, addInteraction, createClient, deleteClient,
  deleteInteraction, updateClient,
} from "@/lib/repos/clients";
import { formAction } from "./util";

function parse(fd: FormData) {
  return {
    business_id: int(fd, "business_id"),
    name: required(fd, "name", "이름"),
    kind: oneOf(fd, "kind", ["company", "person"] as const, "company"),
    status: oneOf(fd, "status", CLIENT_STATUSES, "lead"),
    email: str(fd, "email"),
    phone: str(fd, "phone"),
    tags: tags(fd, "tags"),
    memo: str(fd, "memo"),
  };
}

export const createClientAction = formAction(async (fd) => {
  const id = createClient(db(), parse(fd));
  revalidatePath("/clients");
  redirect(`/clients/${id}`);
});

export const updateClientAction = formAction(async (fd) => {
  const id = int(fd, "id");
  updateClient(db(), id, parse(fd));
  revalidatePath(`/clients/${id}`);
  revalidatePath("/clients");
});

export const deleteClientAction = formAction(async (fd) => {
  deleteClient(db(), int(fd, "id"));
  revalidatePath("/clients");
  redirect("/clients");
});

export const addInteractionAction = formAction(async (fd) => {
  const clientId = int(fd, "client_id");
  addInteraction(db(), {
    client_id: clientId,
    kind: oneOf(fd, "kind", INTERACTION_KINDS, "memo"),
    summary: required(fd, "summary", "내용"),
    occurred_at: date(fd, "occurred_at", "일자"),
  });
  revalidatePath(`/clients/${clientId}`);
});

export const deleteInteractionAction = formAction(async (fd) => {
  deleteInteraction(db(), int(fd, "id"));
  revalidatePath(`/clients/${int(fd, "client_id")}`);
});
