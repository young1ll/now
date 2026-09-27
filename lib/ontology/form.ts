// 사람용 폼(FormData) → 액션 파라미터. 필드 명세(kind)에 따라 타입을 맞춘다.
import type { AnyAction } from "./action";

export const ITEM_ROWS = 6;

export function parseActionForm(def: AnyAction, fd: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(def.fields)) {
    const { kind, nullable } = field.spec;
    if (kind === "boolean") {
      if (fd.has(`__bool_${key}`)) out[key] = fd.get(key) === "on";
      continue;
    }
    if (kind === "items") {
      const items = [];
      for (let i = 0; fd.has(`${key}.${i}.description`); i++) {
        const description = String(fd.get(`${key}.${i}.description`) ?? "").trim();
        if (!description) continue;
        const q = String(fd.get(`${key}.${i}.quantity`) ?? "").trim();
        items.push({ description, quantity: q ? Number(q) : 1, unit_price: String(fd.get(`${key}.${i}.unit_price`) ?? "").trim() });
      }
      if (fd.has(`${key}.0.description`)) out[key] = items;
      continue;
    }
    if (!fd.has(key)) continue;
    const raw = String(fd.get(key) ?? "");
    const v = raw.trim();
    switch (kind) {
      case "ref":
      case "number":
        out[key] = v === "" ? (nullable ? null : undefined) : Number(v);
        break;
      case "date":
      case "month":
        out[key] = v === "" ? (nullable ? null : undefined) : v;
        break;
      case "choice":
        out[key] = v === "" ? undefined : field.spec.optionsFrom === "ai_profiles" ? Number(v) : v;
        break;
      case "objref":
      case "enum":
      case "money":
        out[key] = v === "" ? undefined : v;
        break;
      case "textarea":
        out[key] = raw;
        break;
      default:
        out[key] = v;
    }
    if (out[key] === undefined) delete out[key];
  }
  return out;
}
