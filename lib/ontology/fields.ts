// 액션 파라미터 정의 DSL.
// 필드 하나가 (1) zod 검증 스키마 (2) AI 용 JSON Schema 설명 (3) 사람용 폼 UI 명세를 동시에 만든다.
import { z } from "zod";
import type { ObjectType } from "./types";

export type FieldKind =
  | "text"
  | "textarea"
  | "email"
  | "date"
  | "month"
  | "number"
  | "money"
  | "enum"
  | "ref"
  | "boolean"
  | "tags"
  | "items";

export type FieldSpec = {
  kind: FieldKind;
  label: string;
  help?: string;
  required: boolean;
  /** null 로 비우기 허용 (ref/date) */
  nullable?: boolean;
  options?: { value: string; label: string }[];
  ref?: ObjectType;
  placeholder?: string;
};

export type Field<T = unknown> = { schema: z.ZodType<T>; spec: FieldSpec };

type Opts = { required?: boolean; help?: string; placeholder?: string };

function describe(spec: FieldSpec) {
  return [spec.label, spec.help].filter(Boolean).join(" — ");
}

function make<T>(base: z.ZodType<T>, spec: FieldSpec): Field<T> {
  let s: z.ZodType = base;
  if (spec.nullable) s = (s as z.ZodType).nullable();
  if (!spec.required) s = s.optional();
  return { schema: s.describe(describe(spec)) as z.ZodType<T>, spec };
}

export const f = {
  /** nonEmpty: 생략은 허용하되 넘기면 빈 값 금지 (부분 수정의 이름·제목) */
  text(label: string, o: Opts & { max?: number; nonEmpty?: boolean } = {}) {
    const base = o.required || o.nonEmpty ? z.string().trim().min(1, `${label}을(를) 비울 수 없습니다`) : z.string().trim();
    return make(base.max(o.max ?? 200), { kind: "text", label, required: !!o.required, help: o.help, placeholder: o.placeholder });
  },
  textarea(label: string, o: Opts = {}) {
    const base = o.required ? z.string().trim().min(1, `${label}을(를) 입력하세요`) : z.string();
    return make(base.max(50_000), { kind: "textarea", label, required: !!o.required, help: o.help, placeholder: o.placeholder });
  },
  email(label: string, o: Opts = {}) {
    return make(z.union([z.email(), z.literal("")]), { kind: "email", label, required: !!o.required, help: o.help });
  },
  date(label: string, o: Opts & { nullable?: boolean } = {}) {
    return make(z.iso.date(), { kind: "date", label, required: !!o.required, nullable: o.nullable, help: o.help ?? "YYYY-MM-DD" });
  },
  month(label: string, o: Opts = {}) {
    return make(z.string().regex(/^\d{4}-\d{2}$/, "YYYY-MM 형식"), { kind: "month", label, required: !!o.required, help: o.help ?? "YYYY-MM" });
  },
  number(label: string, o: Opts & { min?: number; max?: number; int?: boolean } = {}) {
    let n = o.int ? z.number().int() : z.number();
    if (o.min !== undefined) n = n.min(o.min);
    if (o.max !== undefined) n = n.max(o.max);
    return make(n, { kind: "number", label, required: !!o.required, help: o.help });
  },
  /** 금액: 주 통화 단위(원, 달러)의 숫자 또는 "1,500,000" 같은 문자열. 통화는 대상 사업/청구서에서 결정. */
  money(label: string, o: Opts = {}) {
    return make(z.union([z.number(), z.string().trim().min(1)]), {
      kind: "money",
      label,
      required: !!o.required,
      help: o.help ?? "주 통화 단위 금액 (예: 1500000 원, 12.5 달러)",
    });
  },
  enum<const V extends readonly [string, ...string[]]>(label: string, values: V, labels: Record<V[number], string>, o: Opts = {}) {
    return make(z.enum(values), {
      kind: "enum",
      label,
      required: !!o.required,
      help: o.help ?? values.map((v) => `${v}=${labels[v as V[number]]}`).join(", "),
      options: values.map((v) => ({ value: v, label: labels[v as V[number]] })),
    });
  },
  ref(label: string, ref: ObjectType, o: Opts & { nullable?: boolean } = {}) {
    return make(z.number().int().positive(), {
      kind: "ref",
      label,
      ref,
      required: !!o.required,
      nullable: o.nullable,
      help: o.help ?? `${ref} 객체 id`,
    });
  },
  boolean(label: string, o: Opts = {}) {
    return make(z.boolean(), { kind: "boolean", label, required: !!o.required, help: o.help });
  },
  tags(label: string, o: Opts = {}) {
    return make(z.string().max(500), { kind: "tags", label, required: !!o.required, help: o.help ?? "쉼표로 구분" });
  },
  items(label: string) {
    const item = z.object({
      description: z.string().trim().min(1).describe("품목명"),
      quantity: z.number().positive().default(1).describe("수량"),
      unit_price: z.union([z.number(), z.string().trim().min(1)]).describe("단가 (주 통화 단위)"),
    });
    return make(z.array(item).min(1, "품목을 한 개 이상 입력하세요").max(50), {
      kind: "items",
      label,
      required: true,
      help: "[{description, quantity, unit_price}]",
    });
  },
};

export type Fields = Record<string, Field<any>>;
export type InputOf<S extends Fields> = { [K in keyof S]: z.infer<S[K]["schema"]> };

export function objectSchema<S extends Fields>(fields: S) {
  const shape = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.schema]));
  return z.strictObject(shape) as unknown as z.ZodType<InputOf<S>>;
}

/** zod 오류를 사람이 읽을 한 줄로. */
export function formatZodError(err: z.ZodError, fields: Fields): string {
  return err.issues
    .map((i) => {
      const key = String(i.path[0] ?? "");
      const label = fields[key]?.spec.label ?? key;
      return label ? `${label}: ${i.message}` : i.message;
    })
    .join(" · ");
}
