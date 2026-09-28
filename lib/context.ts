import { cookies } from "next/headers";
import { cache } from "react";
import { db } from "@/lib/db";
import { computeSignals } from "@/lib/ontology/signals";
import { getBusiness, listBusinesses } from "@/lib/repos/businesses";
import type { Scope } from "@/lib/repos/scope";

export const SCOPE_COOKIE = "now_biz";
export const TOKEN_COOKIE = "now_new_token";

/** 현재 선택된 사업 범위 (쿠키). 없거나 유효하지 않으면 전체(null). */
export async function currentScope(): Promise<Scope> {
  const raw = (await cookies()).get(SCOPE_COOKIE)?.value;
  const id = Number(raw);
  if (!raw || !Number.isInteger(id)) return null;
  return getBusiness(db(), id) ? id : null;
}

/** 새 레코드의 기본 사업: 선택된 사업, 없으면 첫 번째 사업. */
export async function defaultBusinessId(): Promise<number | undefined> {
  return (await currentScope()) ?? listBusinesses(db())[0]?.id;
}

/** 요청 한 번 안에서 신호 계산은 한 번만 (레이아웃의 배지 수 + 홈 화면의 신호 표) */
export const requestSignals = cache((scope: Scope, on: string) => computeSignals(db(), scope, on));
