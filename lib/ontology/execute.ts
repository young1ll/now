import crypto from "node:crypto";
import { z } from "zod";
import type { DB } from "@/lib/db";
import { type RunView, completeRun, getRun, insertRun } from "@/lib/repos/runs";
import { type AnyAction, resolveRisk, targetRef } from "./action";
import { ACTIONS } from "./actions";
import { formatZodError } from "./fields";
import { getObject } from "./objects";
import { decide } from "./policy";
import { getAgent } from "@/lib/repos/agents";
import { ActionError, type Actor, type Ref } from "./types";

export type ExecuteRequest = {
  actor: Actor;
  action: string;
  params: unknown;
  /** 에이전트의 실행 근거 — 승인자와 감사 로그에 보인다 */
  reason?: string;
};

/** 대상 객체의 현재 상태 지문. 승인 대기 중 대상이 바뀌면 승인 시 거부하기 위해 쓴다. */
export function fingerprint(db: DB, ref: Ref | undefined): string | null {
  if (!ref) return null;
  const raw = getObject(db, ref)?.raw ?? null;
  return crypto.createHash("sha256").update(JSON.stringify(raw)).digest("hex").slice(0, 16);
}

/** 요청 이후 대상 객체가 바뀌었는지 (승인 화면 경고·승인 거부용) */
export function isStale(db: DB, run: RunView): boolean {
  const fp = (run.result?.data as { fingerprint?: string } | undefined)?.fingerprint;
  const def = getAction(run.action);
  if (!fp || !def) return false;
  return fingerprint(db, targetRef(def, run.params)) !== fp;
}

export function getAction(name: string): AnyAction | undefined {
  return Object.hasOwn(ACTIONS, name) ? ACTIONS[name] : undefined;
}

function parse(def: AnyAction, params: unknown): Record<string, unknown> {
  const r = def.schema.safeParse(params ?? {});
  if (!r.success) throw new ActionError(formatZodError(r.error as z.ZodError, def.fields));
  return r.data;
}

function apply(db: DB, def: AnyAction, actor: Actor, input: Record<string, unknown>, out: Record<string, unknown> = {}) {
  if (def.noTransaction) return def.run({ db, actor, out }, input as never);
  return db.transaction(() => def.run({ db, actor, out }, input as never))();
}

export type ExecuteResult = RunView & { out?: Record<string, unknown> };

/**
 * 모든 쓰기의 단일 관문. 검증 → 위험도 → 정책 → 실행/승인대기/거부 → 감사 기록.
 *
 * 사람: 입력 오류·규칙 위반은 ActionError 로 던져 폼에 되돌린다 (감사 기록 안 함).
 * 에이전트: 모든 시도(실패·거부 포함)를 감사에 남기고 run 을 반환한다.
 */
export function executeAction(db: DB, req: ExecuteRequest): ExecuteResult {
  const { actor } = req;
  const isAgent = actor.type === "agent";
  const def = getAction(req.action);
  const record = (fields: Parameters<typeof insertRun>[1]) => getRun(db, insertRun(db, fields))!;

  if (!def) {
    if (!isAgent) throw new ActionError(`알 수 없는 액션: ${req.action}`);
    return record({ action: req.action, actor, risk: "high", status: "failed", params: req.params, reason: req.reason, error: `알 수 없는 액션: ${req.action}` });
  }

  let input: Record<string, unknown>;
  let risk: "low" | "high";
  try {
    input = parse(def, req.params);
    risk = resolveRisk(def, db, input);
  } catch (e) {
    if (!isAgent || !(e instanceof ActionError)) throw e;
    return record({ action: def.name, actor, risk: "low", status: "failed", params: req.params, reason: req.reason, error: e.message });
  }

  const target = targetRef(def, input);
  // 존재하지 않는 대상에 대한 요청은 승인 대기로 보내지 않는다
  if (target && !getObject(db, target)) {
    const msg = `대상 ${target.type} ${target.id} 을(를) 찾을 수 없습니다`;
    if (!isAgent) throw new ActionError(msg);
    return record({ action: def.name, actor, risk: "low", status: "failed", params: input, reason: req.reason, error: msg });
  }
  const base = { action: def.name, actor, risk, params: input, reason: req.reason, refs: target ? [target] : [] };
  const decision = decide(db, actor, def, risk);

  if (decision.kind === "deny") return record({ ...base, status: "denied", error: decision.why });
  if (decision.kind === "approval") {
    const summary = def.preview?.(db, input as never) ?? def.title;
    return record({ ...base, status: "pending", result: { summary, refs: [], data: { fingerprint: fingerprint(db, target) } }, error: null });
  }

  try {
    const out: Record<string, unknown> = {};
    const result = apply(db, def, actor, input, out);
    return { ...record({ ...base, status: "applied", result }), out };
  } catch (e) {
    if (!isAgent && e instanceof ActionError) throw e;
    const run = record({ ...base, status: "failed", error: e instanceof Error ? e.message : String(e) });
    if (!isAgent && !(e instanceof ActionError)) throw e;
    return run;
  }
}

/** 승인 대기 run 을 사람이 승인 → 지금 시점의 데이터로 다시 검증하고 실행한다. */
export function approveRun(db: DB, runId: number, human: Actor, note = ""): RunView {
  const run = getRun(db, runId);
  if (!run) throw new ActionError("실행 기록을 찾을 수 없습니다");
  if (run.status !== "pending") throw new ActionError(`이미 처리된 요청입니다 (${run.status})`);
  const def = getAction(run.action);
  if (!def) throw new ActionError(`알 수 없는 액션: ${run.action}`);
  const actor: Actor = { type: run.actor_type, id: run.actor_id, name: run.actor_name };
  const refuse = (why: string) => {
    completeRun(db, runId, { status: "failed", error: why, decided_by: human.name, decision_note: note });
    return getRun(db, runId)!;
  };
  if (actor.type === "agent" && getAgent(db, Number(actor.id))?.status !== "active") {
    return refuse("요청한 에이전트가 정지·폐기되어 실행하지 않았습니다");
  }
  if (isStale(db, run)) return refuse("요청 이후 대상 객체가 변경되어 실행하지 않았습니다 — 다시 요청해야 합니다");
  try {
    const result = apply(db, def, actor, parse(def, run.params));
    completeRun(db, runId, { status: "applied", result, decided_by: human.name, decision_note: note });
  } catch (e) {
    completeRun(db, runId, { status: "failed", error: e instanceof Error ? e.message : String(e), decided_by: human.name, decision_note: note });
  }
  return getRun(db, runId)!;
}

export function rejectRun(db: DB, runId: number, human: Actor, note = ""): RunView {
  const run = getRun(db, runId);
  if (!run) throw new ActionError("실행 기록을 찾을 수 없습니다");
  if (run.status !== "pending") throw new ActionError(`이미 처리된 요청입니다 (${run.status})`);
  completeRun(db, runId, { status: "rejected", decided_by: human.name, decision_note: note });
  return getRun(db, runId)!;
}

/** 요청자 본인(에이전트) 또는 사람이 대기 중인 요청을 철회. */
export function cancelRun(db: DB, runId: number, by: Actor): RunView {
  const run = getRun(db, runId);
  if (!run) throw new ActionError("실행 기록을 찾을 수 없습니다");
  if (run.status !== "pending") throw new ActionError(`이미 처리된 요청입니다 (${run.status})`);
  if (by.type === "agent" && !(run.actor_type === "agent" && run.actor_id === by.id)) {
    throw new ActionError("다른 행위자의 요청은 철회할 수 없습니다");
  }
  completeRun(db, runId, { status: "cancelled", decided_by: by.name });
  return getRun(db, runId)!;
}
