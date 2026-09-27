"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { SCOPE_COOKIE } from "@/lib/context";
import { checkbox, int, oneOf, required, str } from "@/lib/form";
import { CURRENCIES } from "@/lib/labels";
import { createBusiness, updateBusiness } from "@/lib/repos/businesses";
import { formAction } from "./util";

function parse(fd: FormData) {
  return {
    name: required(fd, "name", "사업 이름"),
    kind: str(fd, "kind"),
    color: /^#[0-9a-f]{6}$/i.test(str(fd, "color")) ? str(fd, "color") : "#6366f1",
    currency: oneOf(fd, "currency", CURRENCIES, "KRW"),
  };
}

export const createBusinessAction = formAction(async (fd) => {
  const id = createBusiness(db(), parse(fd));
  (await cookies()).set(SCOPE_COOKIE, String(id), { path: "/", maxAge: 60 * 60 * 24 * 365 });
  revalidatePath("/", "layout");
  redirect(str(fd, "next") || "/settings");
});

export const updateBusinessAction = formAction(async (fd) => {
  updateBusiness(db(), int(fd, "id"), { ...parse(fd), archived: checkbox(fd, "archived") });
  revalidatePath("/", "layout");
});

/** 사이드바의 사업 전환. value 가 "all" 이면 전체 보기. */
export async function switchScopeAction(fd: FormData) {
  const v = str(fd, "scope");
  const jar = await cookies();
  if (v === "all" || !v) jar.delete(SCOPE_COOKIE);
  else jar.set(SCOPE_COOKIE, v, { path: "/", maxAge: 60 * 60 * 24 * 365 });
  revalidatePath("/", "layout");
}
