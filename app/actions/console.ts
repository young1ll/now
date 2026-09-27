"use server";

import { cookies, headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { SCOPE_COOKIE, TOKEN_COOKIE } from "@/lib/context";
import { db } from "@/lib/db";
import { approveRun, cancelRun, executeAction, getAction, rejectRun } from "@/lib/ontology/execute";
import { parseActionForm } from "@/lib/ontology/form";
import { ActionError, OPERATOR } from "@/lib/ontology/types";


async function back(extra: Record<string, string | null> = {}, dropAct = false): Promise<string> {
  const ref = (await headers()).get("referer");
  const url = new URL(ref ?? "/", "http://local");
  if (dropAct) {
    for (const k of [...url.searchParams.keys()]) if (k === "act" || k.startsWith("p.")) url.searchParams.delete(k);
  }
  url.searchParams.delete("error");
  for (const [k, v] of Object.entries(extra)) {
    if (v === null) url.searchParams.delete(k);
    else url.searchParams.set(k, v);
  }
  const qs = url.searchParams.toString();
  return `${url.pathname}${qs ? `?${qs}` : ""}`;
}

/**
 * 사람의 모든 쓰기는 이 서버 액션 하나로 — 에이전트와 같은 executeAction 관문을 지난다.
 * 폼 필드: __action (액션 이름), __next ("created" | 경로 | 생략=현재 화면), 나머지는 액션 파라미터.
 */
export async function runActionForm(fd: FormData) {
  const name = String(fd.get("__action") ?? "");
  const def = getAction(name);
  let target: string;
  try {
    if (!def) throw new ActionError(`알 수 없는 액션: ${name}`);
    const run = executeAction(db(), { actor: OPERATOR, action: name, params: parseActionForm(def, fd), reason: String(fd.get("__reason") ?? "") });
    if (run.status === "failed") throw new ActionError(run.error ?? "실패");
    if (name === "agent.register" && run.out?.token) {
      (await cookies()).set(TOKEN_COOKIE, `${run.refs[0]?.id}:${run.out.token}`, { path: "/", httpOnly: true, sameSite: "strict", maxAge: 600 });
    }
    const next = String(fd.get("__next") ?? "");
    const created = run.refs[0];
    if (next === "created" && created) target = `/o/${created.type}/${created.id}`;
    else if (next.startsWith("/")) target = next;
    else target = await back({}, true);
  } catch (e) {
    if (!(e instanceof ActionError)) throw e;
    target = await back({ error: e.message });
  }
  revalidatePath("/", "layout");
  redirect(target);
}

export async function decideRun(fd: FormData) {
  const id = Number(fd.get("run_id"));
  const decision = String(fd.get("decision"));
  const note = String(fd.get("note") ?? "").trim();
  let target: string;
  try {
    if (decision === "approve") approveRun(db(), id, OPERATOR, note);
    else if (decision === "reject") rejectRun(db(), id, OPERATOR, note);
    else if (decision === "cancel") cancelRun(db(), id, OPERATOR);
    target = await back();
  } catch (e) {
    if (!(e instanceof ActionError)) throw e;
    target = await back({ error: e.message });
  }
  revalidatePath("/", "layout");
  redirect(target);
}

export async function switchScope(fd: FormData) {
  const v = String(fd.get("scope") ?? "");
  const jar = await cookies();
  if (v === "all" || !v) jar.delete(SCOPE_COOKIE);
  else jar.set(SCOPE_COOKIE, v, { path: "/", maxAge: 60 * 60 * 24 * 365 });
  revalidatePath("/", "layout");
}

export async function dismissToken() {
  (await cookies()).delete(TOKEN_COOKIE);
  revalidatePath("/agents");
}
