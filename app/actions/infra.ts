"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { FormError, int, money, oneOf, optInt, optMoney, required, str } from "@/lib/form";
import { CURRENCIES } from "@/lib/labels";
import { probe } from "@/lib/infra/probe";
import {
  PROVIDERS, type Connection, createConnection, deleteConnection, getConnection, listConnections,
  recordCheck, updateConnection, upsertCost,
} from "@/lib/repos/infra";
import { monthOf, today } from "@/lib/dates";
import { currentScope } from "@/lib/context";
import { formAction } from "./util";

function parse(fd: FormData) {
  const currency = oneOf(fd, "currency", CURRENCIES, "USD");
  const url = (key: string) => {
    const v = str(fd, key);
    if (v && !/^https?:\/\//.test(v)) throw new FormError(`${key} 는 http(s):// 로 시작해야 합니다`);
    return v;
  };
  const credential_env = str(fd, "credential_env");
  if (credential_env && !/^[A-Z_][A-Z0-9_]*$/.test(credential_env)) {
    throw new FormError("자격증명에는 비밀값이 아니라 환경변수 이름(예: AWS_PROD_KEY)만 입력하세요");
  }
  return {
    business_id: optInt(fd, "business_id"),
    provider: oneOf(fd, "provider", PROVIDERS, "other"),
    name: required(fd, "name", "이름"),
    account_ref: str(fd, "account_ref"),
    region: str(fd, "region"),
    console_url: url("console_url"),
    health_url: url("health_url"),
    credential_env,
    monthly_budget: optMoney(fd, "monthly_budget", currency),
    currency,
    memo: str(fd, "memo"),
  };
}

async function runCheck(conn: Pick<Connection, "id" | "health_url" | "credential_env">) {
  const r = await probe(conn);
  recordCheck(db(), { connection_id: conn.id, ...r, checked_at: new Date().toISOString() });
}

export const createConnectionAction = formAction(async (fd) => {
  const id = createConnection(db(), parse(fd));
  await runCheck(getConnection(db(), id)!);
  revalidatePath("/", "layout");
  redirect(`/infra/${id}`);
});

export const updateConnectionAction = formAction(async (fd) => {
  const id = int(fd, "id");
  updateConnection(db(), id, parse(fd));
  revalidatePath("/", "layout");
});

export const deleteConnectionAction = formAction(async (fd) => {
  deleteConnection(db(), int(fd, "id"));
  revalidatePath("/", "layout");
  redirect("/infra");
});

export const checkConnectionAction = formAction(async (fd) => {
  const conn = getConnection(db(), int(fd, "id"));
  if (conn) await runCheck(conn);
  revalidatePath("/", "layout");
});

export const checkAllAction = formAction(async () => {
  const conns = listConnections(db(), await currentScope(), monthOf(today()));
  await Promise.all(conns.map(runCheck));
  revalidatePath("/", "layout");
});

export const recordCostAction = formAction(async (fd) => {
  const conn = getConnection(db(), int(fd, "id"));
  if (!conn) throw new FormError("연결을 찾을 수 없습니다");
  const month = str(fd, "month");
  if (!/^\d{4}-\d{2}$/.test(month)) throw new FormError("월을 선택하세요");
  upsertCost(db(), conn.id, month, money(fd, "amount", conn.currency, "비용"));
  revalidatePath("/", "layout");
});
