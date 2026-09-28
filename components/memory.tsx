// 기억(memory) 화면 조각 — /memory · 객체 화면의 "AI 가 아는 것" · 세션 상세가 함께 쓴다 (서버 컴포넌트).
import Link from "next/link";
import { runActionForm } from "@/app/actions/console";
import { actHref } from "@/components/ActionDrawer";
import { Icon } from "@/components/icons";
import { Actor, Tag } from "@/components/ui";
import { MEMORY_KIND, MEMORY_STATUS } from "@/lib/labels";
import { displayId } from "@/lib/ontology/ids";
import type { Memory } from "@/lib/repos/memories";

/** 기억 화면으로 가는 링크 (객체 화면 대신 /memory 열 기반 화면) */
export const memoryHref = (id: number, extra: Record<string, string> = {}) => `/memory?${new URLSearchParams({ tab: "all", ...extra, sel: String(id) })}`;

export function MemoryStatusTag({ m }: { m: Pick<Memory, "status" | "tainted"> }) {
  const st = MEMORY_STATUS[m.status];
  return (
    <>
      <Tag tone={st.tone}>{st.label}</Tag>
      {!!m.tainted && m.status !== "verified" && <Tag tone="amber" title="외부 비신뢰 입력(메일·웹훅)에서 유래 — 사람 확인 전에는 확정되지 않는다">외부 출처</Tag>}
    </>
  );
}

export function MemoryKind({ kind }: { kind: Memory["kind"] }) {
  return <span className="text-[11px] text-fg-3">{MEMORY_KIND[kind]}</span>;
}

/** created_by ('agent:3' · 'human:operator') → 행위자 표시 (에이전트는 ai 색) */
export function MemoryOrigin({ createdBy, name }: { createdBy: string; name: string }) {
  const type = createdBy.split(":")[0];
  return <Actor type={type === "agent" ? "agent" : type === "system" ? "system" : "human"} name={name} />;
}

/** 기억 식별자 링크: MEM-0003 문장 */
export function MemoryLink({ id, statement, href }: { id: number; statement?: string; href?: string }) {
  return (
    <Link href={href ?? memoryHref(id)} className="group inline-flex max-w-full min-w-0 items-center gap-1.5 align-middle">
      <Icon name="memory" size={12} className="shrink-0 text-fg-3" />
      <span className="mono shrink-0 text-primary-fg group-hover:underline">{displayId("memory", id)}</span>
      {statement && <span className="truncate text-fg group-hover:underline">{statement}</span>}
    </Link>
  );
}

/** 즉시 실행 버튼 (확인 · 거절 · 고정) — 폼 하나 = 액션 하나, 같은 executeAction 관문 */
export function QuickAction({
  action,
  params,
  next,
  label,
  tone = "btn",
}: {
  action: string;
  params: Record<string, string | number | boolean>;
  next: string;
  label: string;
  tone?: "btn" | "btn-primary" | "btn-success" | "btn-danger" | "btn-minimal";
}) {
  return (
    <form action={runActionForm}>
      <input type="hidden" name="__action" value={action} />
      <input type="hidden" name="__next" value={next} />
      {Object.entries(params).map(([k, v]) =>
        typeof v === "boolean" ? (
          <span key={k}>
            <input type="hidden" name={`__bool_${k}`} value="1" />
            {v && <input type="hidden" name={k} value="on" />}
          </span>
        ) : (
          <input key={k} type="hidden" name={k} value={String(v)} />
        ),
      )}
      <button className={`${tone} btn-sm`}>{label}</button>
    </form>
  );
}

/** 상태별 액션 버튼 줄: 확인·거절·고정은 즉시, 나머지는 드로어 */
export function MemoryActions({ m, actions, path, query, next, contradicts = [] }: { m: Memory; actions: string[]; path: string; query: Record<string, string>; next: string; contradicts?: number[] }) {
  const drawer = (action: string, fixed: Record<string, unknown>, soft: Record<string, unknown> = {}) => {
    const u = new URLSearchParams(query);
    const q = new URL(actHref(path, action, fixed, soft), "http://x").searchParams;
    for (const [k, v] of q) u.set(k, v);
    return `${path}?${u}`;
  };
  return (
    <div className="flex flex-wrap gap-1">
      {actions.map((a) => {
        switch (a) {
          case "memory.confirm":
            return <QuickAction key={a} action={a} params={{ id: m.id }} next={next} label="확인" tone="btn-success" />;
          case "memory.reject":
            return <QuickAction key={a} action={a} params={{ id: m.id }} next={next} label="거절" tone="btn-danger" />;
          case "memory.pin":
            return <QuickAction key={a} action={a} params={{ id: m.id, pinned: !m.pinned }} next={next} label={m.pinned ? "고정 해제" : "고정"} />;
          case "memory.correct":
            return <Link key={a} href={drawer(a, { id: m.id }, { statement: m.statement })} className="btn btn-sm">정정</Link>;
          case "memory.resolve":
            return <Link key={a} href={drawer(a, { id: m.id }, { other_id: contradicts[0], keep: "this" })} className="btn btn-sm">충돌 해결</Link>;
          case "memory.retire":
            return <Link key={a} href={drawer(a, { id: m.id })} className="btn btn-sm">보관</Link>;
          case "memory.merge":
            return <Link key={a} href={drawer(a, { id: m.id })} className="btn btn-sm">합치기</Link>;
          case "memory.promote":
            return <Link key={a} href={drawer(a, { id: m.id })} className="btn btn-sm">승격</Link>;
          default:
            return null;
        }
      })}
    </div>
  );
}
