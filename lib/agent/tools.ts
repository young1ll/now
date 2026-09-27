// 에이전트 도구 — MCP 와 REST 가 같은 구현을 쓴다.
import { z } from "zod";
import type { DB } from "@/lib/db";
import { jsonSchemaOf } from "@/lib/ontology/action";
import { ACTION_LIST } from "@/lib/ontology/actions";
import { cancelRun, executeAction } from "@/lib/ontology/execute";
import { displayId, runId } from "@/lib/ontology/ids";
import { OBJECTS, objectDef, searchObjects } from "@/lib/ontology/objects";
import { opsOverview } from "@/lib/ontology/ops";
import { computeSignals } from "@/lib/ontology/signals";
import { ActionError, type Actor, OBJECT_TYPES } from "@/lib/ontology/types";
import { AI_MODE_LABEL } from "@/lib/ontology/actions/system";
import { type RunView, getRun, listRuns } from "@/lib/repos/runs";
import { getAiMode } from "@/lib/repos/settings";

export class ToolError extends Error {}

export type Tool = {
  name: string;
  description: string;
  input: z.ZodType<Record<string, unknown>>;
  run: (db: DB, actor: Actor, args: Record<string, unknown>) => unknown;
};

/** 감사 run → 에이전트에게 돌려줄 간결한 형태 */
export function runOut(r: RunView) {
  return {
    run_id: r.id,
    ref: runId(r.id),
    action: r.action,
    status: r.status,
    risk: r.risk,
    summary: r.result?.summary ?? null,
    error: r.error,
    objects: r.refs.map((x) => ({ type: x.type, id: x.id, display_id: displayId(x.type, x.id) })),
    reason: r.reason,
    created_at: r.created_at,
    decided_by: r.decided_by,
    decision_note: r.decision_note || null,
    note:
      r.status === "pending"
        ? "사람의 승인을 기다립니다. get_run 으로 결과를 확인하세요."
        : r.status === "denied"
          ? "정책에 의해 거부되었습니다. 사람에게 요청하거나 다른 방법을 찾으세요."
          : undefined,
  };
}

const scopeArg = z.number().int().positive().optional().describe("사업 id 로 범위 제한 (생략 시 전체)");

function def<S extends z.ZodRawShape>(name: string, description: string, shape: S, run: (db: DB, actor: Actor, args: z.infer<z.ZodObject<S>>) => unknown): Tool {
  return { name, description, input: z.object(shape) as unknown as Tool["input"], run: run as Tool["run"] };
}

export const TOOLS: Tool[] = [
  def(
    "get_overview",
    "운영 현황 요약: AI 운영 모드, 신호(주의 필요 상태) 수, 승인 대기, 업무 현황, 미수금, 이번 달 현금흐름. 작업을 시작할 때 먼저 호출하라.",
    { business_id: scopeArg },
    (db, _a, { business_id }) => {
      const o = opsOverview(db, business_id ?? null);
      return {
        date: o.on,
        ai_mode: { mode: o.aiMode, meaning: AI_MODE_LABEL[o.aiMode] },
        signals: { total: o.signals.length, critical: o.signals.filter((s) => s.severity === "critical").length, warning: o.signals.filter((s) => s.severity === "warning").length },
        pending_approvals: o.pending.count,
        tasks: o.tasks,
        receivables: o.receivables,
        cash_this_month: o.cash,
        runs_24h: o.runs24h,
      };
    },
  ),
  def(
    "describe_ontology",
    "객체 유형(고객·업무·청구서·지출·문서·사업·에이전트)과 각 유형에서 쓸 수 있는 액션 목록. 데이터 모델을 이해할 때 호출.",
    {},
    () => ({
      object_types: OBJECT_TYPES.map((t) => ({
        type: t,
        label: OBJECTS[t].label,
        description: OBJECTS[t].description,
        create_action: OBJECTS[t].createAction ?? null,
        actions: OBJECTS[t].actions,
        columns: OBJECTS[t].columns.map((c) => c.key),
      })),
      conventions: {
        money: "raw 금액은 통화 최소 단위 정수(KRW=원, USD=센트). 액션 입력 금액은 주 통화 단위 숫자/문자열.",
        dates: "YYYY-MM-DD",
        ids: "객체 id 는 정수. display_id(CLT-0003 등)는 사람용 표기.",
      },
    }),
  ),
  def(
    "search_objects",
    "객체 검색. type 을 주면 그 유형만, query 로 이름·내용 부분 일치 검색.",
    {
      type: z.enum(OBJECT_TYPES).optional().describe("객체 유형"),
      query: z.string().optional().describe("검색어"),
      business_id: scopeArg,
      limit: z.number().int().min(1).max(200).optional().describe("최대 개수 (기본 50)"),
    },
    (db, _a, { type, query, business_id, limit }) => {
      const scope = business_id ?? null;
      const rows = type ? OBJECTS[type].list(db, scope, query) : searchObjects(db, scope, query ?? "", 20);
      return rows.slice(0, limit ?? 50).map((r) => ({
        type: r.ref.type,
        id: r.ref.id,
        display_id: r.displayId,
        title: r.title,
        subtitle: r.subtitle,
        status: r.status?.label ?? null,
        business_id: r.businessId,
        props: r.props,
      }));
    },
  ),
  def(
    "get_object",
    "객체 하나의 전체 정보: 속성, 원본 값(raw), 연결된 객체, 최근 액션 이력.",
    { type: z.enum(OBJECT_TYPES).describe("객체 유형"), id: z.number().int().positive().describe("객체 id") },
    (db, _a, { type, id }) => {
      const d = objectDef(type)!.get(db, id);
      if (!d) throw new ToolError(`${type} ${id} 를 찾을 수 없습니다`);
      return {
        type,
        id,
        display_id: d.displayId,
        title: d.title,
        status: d.status?.label ?? null,
        properties: Object.fromEntries(d.properties.map((p) => [p.key, p.value])),
        raw: d.raw,
        links: d.links.map((l) => ({ type: l.ref.type, id: l.ref.id, display_id: l.displayId, title: l.title, relation: l.relation })),
        available_actions: OBJECTS[type].actionsFor?.(d.raw) ?? OBJECTS[type].actions,
        history: listRuns(db, { object: { type, id }, limit: 15 }).map(runOut),
      };
    },
  ),
  def(
    "list_signals",
    "주의가 필요한 상태 목록 (지연 업무, 미수금, 무응대 리드, 백업·인프라 문제). 각 신호에 해결용 suggested 액션과 파라미터가 있다. 에이전트의 기본 작업 큐.",
    {
      business_id: scopeArg,
      severity: z.enum(["critical", "warning", "info"]).optional().describe("이 심각도만"),
    },
    (db, _a, { business_id, severity }) =>
      computeSignals(db, business_id ?? null).filter((s) => !severity || s.severity === severity),
  ),
  def(
    "list_actions",
    "실행 가능한 액션 카탈로그와 입력 JSON Schema. risk=high 는 AI 운영 모드에 따라 사람 승인이 필요할 수 있다.",
    { object_type: z.string().optional().describe("이 객체 유형의 액션만 (client, task, invoice …)") },
    (db, _a, { object_type }) => ({
      ai_mode: getAiMode(db),
      actions: ACTION_LIST.filter((a) => !a.humanOnly && (!object_type || a.objectType === object_type)).map((a) => ({
        name: a.name,
        title: a.title,
        description: a.description,
        object_type: a.objectType,
        risk: typeof a.risk === "function" ? "dynamic" : a.risk,
        input_schema: jsonSchemaOf(a),
      })),
    }),
  ),
  def(
    "run_action",
    "액션 실행. 결과 status: applied(적용) / pending(사람 승인 대기) / failed(입력·규칙 오류) / denied(정책 거부). reason 에 왜 이 행동을 하는지 사람이 이해할 근거를 반드시 적어라.",
    {
      action: z.string().describe("액션 이름 (예: task.create)"),
      params: z.record(z.string(), z.unknown()).describe("액션 입력 (list_actions 의 input_schema)"),
      reason: z.string().min(1).describe("실행 근거 — 승인자와 감사 로그에 표시된다"),
    },
    (db, actor, { action, params, reason }) => runOut(executeAction(db, { actor, action, params, reason })),
  ),
  def("get_run", "내가 요청한 액션 실행 기록 조회 (승인 대기 요청의 결과 확인용).", { run_id: z.number().int().positive() }, (db, _a, { run_id }) => {
    const r = getRun(db, run_id);
    if (!r || r.actor_type !== "agent" || r.actor_id !== _a.id) throw new ToolError(`run ${run_id} 없음 (내가 요청한 실행만 조회 가능)`);
    return { ...runOut(r), params: r.params };
  }),
  def(
    "list_my_runs",
    "이 에이전트의 최근 실행 기록.",
    {
      status: z.enum(["applied", "pending", "rejected", "failed", "denied", "cancelled"]).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    (db, actor, { status, limit }) => listRuns(db, { actorType: "agent", actorId: actor.id, status, limit: limit ?? 20 }).map(runOut),
  ),
  def("cancel_run", "내가 요청한 승인 대기 run 을 철회.", { run_id: z.number().int().positive() }, (db, actor, { run_id }) => {
    try {
      return runOut(cancelRun(db, run_id, actor));
    } catch (e) {
      if (e instanceof ActionError) throw new ToolError(e.message);
      throw e;
    }
  }),
];

export const TOOL_MAP = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

export function callTool(db: DB, actor: Actor, name: string, args: unknown): unknown {
  const tool = TOOL_MAP[name];
  if (!tool) throw new ToolError(`알 수 없는 도구: ${name}`);
  const parsed = tool.input.safeParse(args ?? {});
  if (!parsed.success) throw new ToolError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return tool.run(db, actor, parsed.data);
}

export function toolJsonSchema(t: Tool) {
  const s = z.toJSONSchema(t.input) as Record<string, unknown>;
  delete s.$schema;
  return s;
}
