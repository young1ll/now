import Link from "next/link";
import { runActionForm } from "@/app/actions/console";
import { Icon } from "@/components/icons";
import { Field, Tag } from "@/components/ui";
import type { DB } from "@/lib/db";
import type { AnyAction } from "@/lib/ontology/action";
import type { FieldSpec } from "@/lib/ontology/fields";
import { ITEM_ROWS } from "@/lib/ontology/form";
import { displayId } from "@/lib/ontology/ids";
import { OBJECTS } from "@/lib/ontology/objects";
import type { ObjectType } from "@/lib/ontology/types";
import type { Scope } from "@/lib/repos/scope";
import { customLinkTypes } from "@/lib/ontology/schema";
import { listProfiles } from "@/lib/repos/ai";
import { PROVIDER_INFO } from "@/lib/ai/providers";

type Values = Record<string, unknown>;

function refOptions(db: DB, type: ObjectType, scope: Scope) {
  return OBJECTS[type].list(db, type === "business" ? null : scope).map((r) => ({ value: r.ref.id, label: `${r.displayId} · ${r.title}` }));
}

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(String).join(", ");
  return String(v);
}

/** "client:3" → "CLT-0003" (표시용) */
const showRef = (s: string) => s.replace(/^([a-z]+):(\d+)$/, (m, t, id) => (t in OBJECTS ? displayId(t as ObjectType, Number(id)) : m));

function Input({ name, spec, value, db, scope, locked }: { name: string; spec: FieldSpec; value: unknown; db: DB; scope: Scope; locked: boolean }) {
  const common = { name, id: `f-${name}`, required: spec.required && spec.kind !== "boolean", disabled: false };
  if (locked) {
    return (
      <>
        <input type="hidden" name={name} value={str(value)} />
        <div className="field flex items-center text-fg-2">
          {spec.kind === "ref" && spec.ref && value ? (
            <span className="mono">{displayId(spec.ref, Number(value))}</span>
          ) : (spec.kind === "objref" || spec.kind === "refs") && value ? (
            <span className="mono">{str(value).split(/[\s,]+/).filter(Boolean).map(showRef).join(", ")}</span>
          ) : spec.kind === "ids" && spec.ref && value ? (
            <span className="mono">{str(value).split(/[\s,]+/).filter(Boolean).map((x) => displayId(spec.ref!, Number(x))).join(", ")}</span>
          ) : (
            str(value) || "—"
          )}
        </div>
      </>
    );
  }
  switch (spec.kind) {
    case "textarea":
      return <textarea {...common} className="field font-mono text-[12.5px]" rows={name === "body" ? 14 : 3} defaultValue={str(value)} placeholder={spec.placeholder} />;
    case "date":
      return <input {...common} type="date" className="field mono" defaultValue={str(value)} />;
    case "month":
      return <input {...common} type="month" className="field mono" defaultValue={str(value)} />;
    case "number":
      return <input {...common} type="number" step="any" className="field mono" defaultValue={str(value)} />;
    case "money":
      return <input {...common} inputMode="decimal" className="field mono text-right" defaultValue={str(value)} placeholder="0" />;
    case "email":
      return <input {...common} type="email" className="field" defaultValue={str(value)} />;
    case "boolean":
      return (
        <label className="flex h-7 items-center gap-2 text-fg-2">
          <input type="hidden" name={`__bool_${name}`} value="1" />
          <input type="checkbox" name={name} defaultChecked={!!value} className="size-3.5 accent-primary" /> 예
        </label>
      );
    case "enum":
      return (
        <select {...common} className="field" defaultValue={str(value)}>
          {!spec.required && <option value="">—</option>}
          {spec.options!.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      );
    case "ref":
      return (
        <select {...common} className="field" defaultValue={str(value)}>
          {(!spec.required || spec.nullable) && <option value="">— 없음 —</option>}
          {refOptions(db, spec.ref!, scope).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      );
    case "choice": {
      const opts =
        spec.optionsFrom === "link_types"
          ? customLinkTypes(db).map((l) => ({ value: l.name, label: `${l.label} · ${l.name} (${l.fromType} → ${l.toType})` }))
          : listProfiles(db).map((p) => ({ value: String(p.id), label: `${p.name} · ${PROVIDER_INFO[p.provider].label}${p.model ? ` · ${p.model}` : ""}` }));
      return (
        <select {...common} className="field" defaultValue={str(value)}>
          {!spec.required && <option value="">—</option>}
          {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    }
    case "refs":
    case "ids":
      return <input {...common} className="field mono" defaultValue={str(value)} placeholder={spec.placeholder ?? (spec.kind === "ids" ? "12, MEM-0015" : undefined)} />;
    case "objref": {
      const types = spec.refTypes ?? (["client", "task", "invoice", "note", "business", "expense", "agent", "memory"] as ObjectType[]);
      return (
        <select {...common} className="field" defaultValue={str(value)}>
          {!spec.required && <option value="">—</option>}
          {types.map((t) => (
            <optgroup key={t} label={OBJECTS[t].plural}>
              {OBJECTS[t].list(db, t === "business" || t === "agent" ? null : scope).map((r) => (
                <option key={r.displayId} value={`${t}:${r.ref.id}`}>{r.displayId} · {r.title}</option>
              ))}
            </optgroup>
          ))}
        </select>
      );
    }
    case "items": {
      const rows = [...((value as { description: string; quantity: number; unit_price: unknown }[] | undefined) ?? [])];
      while (rows.length < ITEM_ROWS) rows.push({ description: "", quantity: 1, unit_price: "" });
      return (
        <div className="border border-line">
          <div className="grid grid-cols-[1fr_4.5rem_7.5rem] bg-raised">
            {["품목", "수량", "단가"].map((h) => <span key={h} className="label-caps px-2 py-1">{h}</span>)}
          </div>
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-[1fr_4.5rem_7.5rem] border-t border-line-soft">
              <input name={`${name}.${i}.description`} defaultValue={r.description} className="field border-0" placeholder={i === 0 ? "예: 9월 기장 대행" : ""} />
              <input name={`${name}.${i}.quantity`} type="number" step="any" min="0" defaultValue={r.quantity} className="field mono border-0 border-l border-line-soft" />
              <input name={`${name}.${i}.unit_price`} inputMode="decimal" defaultValue={str(r.unit_price)} className="field mono border-0 border-l border-line-soft text-right" placeholder="0" />
            </div>
          ))}
        </div>
      );
    }
    default:
      return <input {...common} className="field" defaultValue={str(value)} placeholder={spec.placeholder} />;
  }
}

/**
 * 액션 정의에서 자동 생성되는 폼. 에이전트가 보는 JSON Schema 와 같은 정의를 쓴다.
 * locked: 문맥상 고정된 파라미터 (대상 id 등) — 보여주되 바꿀 수 없다.
 */
export function ActionForm({
  def,
  db,
  scope,
  values,
  locked = [],
  next,
  cancelHref,
}: {
  def: AnyAction;
  db: DB;
  scope: Scope;
  values: Values;
  locked?: string[];
  next?: string;
  cancelHref?: string;
}) {
  const risk = typeof def.risk === "function" ? "변동" : def.risk === "high" ? "고위험" : "저위험";
  const wide = new Set(["textarea", "items", "refs"]);
  return (
    <form action={runActionForm} className="flex flex-col gap-3">
      <input type="hidden" name="__action" value={def.name} />
      {next && <input type="hidden" name="__next" value={next} />}
      <div className="flex flex-wrap items-center gap-1.5">
        <Tag tone="none"><span className="mono">{def.name}</span></Tag>
        <Tag tone={risk === "고위험" ? "amber" : risk === "변동" ? "slate" : "green"}>{risk}</Tag>
        {def.humanOnly && <Tag tone="blue">사람 전용</Tag>}
      </div>
      <p className="text-[12px] text-fg-3">{def.description}</p>
      <div className="grid grid-cols-2 gap-3">
        {Object.entries(def.fields).map(([name, field]) => (
          <Field
            key={name}
            label={`${field.spec.label}${field.spec.required ? " *" : ""}`}
            hint={field.spec.kind === "money" || field.spec.kind === "tags" || field.spec.kind === "refs" ? (field.spec.kind === "refs" ? "쉼표로 구분 — client:3 또는 CLT-0003" : field.spec.help) : undefined}
            className={wide.has(field.spec.kind) || field.spec.kind === "ref" && !locked.includes(name) ? "col-span-2" : ""}
          >
            <Input name={name} spec={field.spec} value={values[name]} db={db} scope={def.target ? null : scope} locked={locked.includes(name)} />
          </Field>
        ))}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-line pt-3">
        {cancelHref && <Link href={cancelHref} className="btn-minimal">취소</Link>}
        <button className={def.risk === "high" ? "btn-danger" : "btn-primary"}>
          <Icon name="bolt" size={12} /> 실행 · {def.title}
        </button>
      </div>
      <p className="text-[11px] text-fg-4">사람이 실행한 액션은 즉시 적용되며 활동 로그에 기록됩니다.</p>
    </form>
  );
}
