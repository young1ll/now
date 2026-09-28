import crypto from "node:crypto";
import { z } from "zod";
import type { DB } from "@/lib/db";
import { type RunView, completeRun, getRun, insertRun } from "@/lib/repos/runs";
import { type AnyAction, resolveRisk, targetRef } from "./action";
import { ACTIONS } from "./actions";
import { formatZodError } from "./fields";
import { getObject } from "./objects";
import { businessesOf, decide, scopeDenial } from "./policy";
import { objectExists } from "./graph";
import { getAgent } from "@/lib/repos/agents";
import { redactSecrets } from "@/lib/knowledge/redact";
import { ActionError, type Actor, type Ref } from "./types";

export type ExecuteRequest = {
  actor: Actor;
  action: string;
  params: unknown;
  /** 에이전트의 실행 근거 — 승인자와 감사 로그에 보인다 */
  reason?: string;
};

/** 대상 객체의 현재 상태 지문. 승인 대기 중 대상이 바뀌면 승인 시 거부하기 위해 쓴다. */
/** 사용 기록(텔레메트리)은 지문에서 뺀다 — 기억이 컨텍스트에 쓰였다고 승인 대기 요청이 "대상 변경"으로 거부되면 안 된다 */
const TELEMETRY_KEYS = new Set(["use_count", "last_used_at"]);

export function fingerprint(db: DB, ref: Ref | undefined): string | null {
  if (!ref) return null;
  const obj = getObject(db, ref)?.raw ?? null;
  const raw = obj && Object.fromEntries(Object.entries(obj).filter(([k]) => !TELEMETRY_KEYS.has(k)));
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

/** def.secretFields 의 문자열 값에서 비밀값을 가린다 — 감사·승인 대기·실행 모두 이 값을 쓴다 (CLAUDE.md: 비밀값은 감사 결과에 남기지 않는다) */
export function scrubSecrets(def: AnyAction, params: unknown): unknown {
  const keys = def.secretFields;
  if (!keys?.length || !params || typeof params !== "object" || Array.isArray(params)) return params;
  return Object.fromEntries(Object.entries(params as Record<string, unknown>).map(([k, v]) => [k, keys.includes(k) && typeof v === "string" ? redactSecrets(v) : v]));
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

function withGrant(data: unknown, grantId: number): unknown {
  if (data === undefined || data === null) return { grant_id: grantId };
  if (typeof data === "object" && !Array.isArray(data)) return { ...(data as Record<string, unknown>), grant_id: grantId };
  return { value: data, grant_id: grantId };
}

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

  const params = scrubSecrets(def, req.params);
  let input: Record<string, unknown>;
  let risk: "low" | "high";
  try {
    input = parse(def, params);
    risk = resolveRisk(def, db, input, actor);
  } catch (e) {
    if (!isAgent || !(e instanceof ActionError)) throw e;
    return record({ action: def.name, actor, risk: "low", status: "failed", params, reason: req.reason, error: e.message });
  }

  const target = targetRef(def, input);
  // 이 요청이 닿는 사업들 — 감사 run·이벤트에 싣는다 (사업 범위 에이전트의 이벤트 필터: 대상 없는 요청·나중에 지워진 대상도 거를 수 있게).
  // 새 사업을 만드는 요청은 어떤 범위에도 들지 않는다 → 모름(null)
  const touched = businessesOf(db, def, input, target);
  const businessIds = touched === "new_business" ? null : touched;
  // 존재하지 않는 대상에 대한 요청은 승인 대기로 보내지 않는다 (존재 확인은 가볍게 — 객체 전체를 만들지 않는다)
  if (target && !objectExists(db, target)) {
    const msg = `대상 ${target.type} ${target.id} 을(를) 찾을 수 없습니다`;
    if (!isAgent) throw new ActionError(msg);
    return record({ action: def.name, actor, risk: "low", status: "failed", params: input, reason: req.reason, error: msg, businessIds });
  }
  const stored = def.redact?.length && def.humanOnly ? Object.fromEntries(Object.entries(input).map(([k, v]) => [k, def.redact!.includes(k) && v ? "[redacted]" : v])) : input;
  const base = { action: def.name, actor, risk, params: stored, reason: req.reason, refs: target ? [target] : [], businessIds };
  const decision = decide(db, actor, def, risk, input, target);

  if (decision.kind === "deny") return record({ ...base, status: "denied", error: decision.why });
  if (decision.kind === "approval") {
    const summary = def.preview?.(db, input as never) ?? def.title;
    return record({ ...base, status: "pending", result: { summary, refs: [], data: { fingerprint: fingerprint(db, target) } }, error: null });
  }

  try {
    const out: Record<string, unknown> = {};
    const result = apply(db, def, actor, input, out);
    // 자율 권한으로 실행됐으면 어느 권한인지 감사 결과에 남긴다 (신뢰 지표 · 자동 회수의 근거)
    const recorded = decision.grantId ? { ...result, data: withGrant(result.data, decision.grantId) } : result;
    return { ...record({ ...base, status: "applied", result: recorded }), out };
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
  const agent = actor.type === "agent" ? getAgent(db, Number(actor.id)) : undefined;
  if (actor.type === "agent" && agent?.status !== "active") {
    return refuse("요청한 에이전트가 정지·폐기되어 실행하지 않았습니다");
  }
  if (isStale(db, run)) return refuse("요청 이후 대상 객체가 변경되어 실행하지 않았습니다 — 다시 요청해야 합니다");
  let input: Record<string, unknown>;
  try {
    input = parse(def, run.params);
  } catch (e) {
    return refuse(e instanceof Error ? e.message : String(e));
  }
  // 정책은 다시 보지 않는다(사람의 승인이 곧 결정) — 단, 요청 이후 에이전트의 허용 범위·사업 범위가 줄었으면 실행하지 않는다
  const lost = agent ? scopeDenial(db, agent, def, input, targetRef(def, input)) : null;
  if (lost) return refuse(`요청 이후 에이전트의 권한 범위가 바뀌어 실행하지 않았습니다 — ${lost}`);
  try {
    const result = apply(db, def, actor, input);
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
