import Link from "next/link";
import { ActionForm } from "@/components/ActionForm";
import { Icon } from "@/components/icons";
import { db } from "@/lib/db";
import { getAction } from "@/lib/ontology/execute";
import type { Scope } from "@/lib/repos/scope";

type SP = Record<string, string | string[] | undefined>;

/** ?act=<액션>&p.<필드>=<값> 으로 어느 화면에서든 여는 우측 액션 패널. p.* 는 고정(locked)된다. */
export function ActionDrawer({ sp, path, scope, next }: { sp: SP; path: string; scope: Scope; next?: string }) {
  const name = typeof sp.act === "string" ? sp.act : undefined;
  const def = name ? getAction(name) : undefined;
  if (!def) return null;

  const fixed: Record<string, unknown> = {};
  const soft: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v !== "string") continue;
    const key = k.startsWith("p.") ? k.slice(2) : k.startsWith("d.") ? k.slice(2) : null;
    if (!key || !def.fields[key]) continue;
    const kind = def.fields[key].spec.kind;
    const val = kind === "ref" || kind === "number" ? Number(v) : v;
    (k.startsWith("p.") ? fixed : soft)[key] = val;
  }
  const targetId = def.target ? Number(fixed[def.target.param] ?? soft[def.target.param]) : NaN;
  const prefill = def.prefill && targetId ? (def.prefill(db(), targetId) ?? {}) : {};
  const values = { ...prefill, ...soft, ...fixed };

  const close = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && k !== "act" && k !== "error" && !k.startsWith("p.") && !k.startsWith("d.")) close.set(k, v);
  const closeHref = `${path}${close.size ? `?${close}` : ""}`;

  return (
    <>
      <Link href={closeHref} aria-label="닫기" className="no-print fixed inset-0 z-40 bg-void/60" />
      <aside className="no-print fixed top-0 right-0 bottom-0 z-50 flex w-full max-w-[560px] flex-col border-l border-line-strong bg-panel shadow-2xl">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
          <div className="flex items-center gap-2">
            <Icon name="bolt" className="text-primary-fg" />
            <span className="font-semibold">{def.title}</span>
          </div>
          <Link href={closeHref} className="btn-minimal btn-sm" aria-label="닫기"><Icon name="close" size={12} /></Link>
        </div>
        {typeof sp.error === "string" && (
          <div role="alert" className="border-b border-danger/50 bg-danger/15 px-4 py-2 text-[12.5px] text-danger-fg">{sp.error}</div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <ActionForm def={def} db={db()} scope={scope} values={values} locked={Object.keys(fixed)} next={next ?? (def.target ? undefined : "created")} cancelHref={closeHref} />
        </div>
      </aside>
    </>
  );
}

/** 액션 패널을 여는 링크 href 생성 */
export function actHref(path: string, action: string, fixed: Record<string, unknown> = {}, soft: Record<string, unknown> = {}) {
  const q = new URLSearchParams({ act: action });
  for (const [k, v] of Object.entries(fixed)) if (v !== undefined && v !== null) q.set(`p.${k}`, String(v));
  for (const [k, v] of Object.entries(soft)) if (v !== undefined && v !== null) q.set(`d.${k}`, String(v));
  return `${path}?${q}`;
}
