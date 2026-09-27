import type { DB } from "@/lib/db";
import { defineAction } from "../action";
import { f } from "../fields";
import { deleteLinksFor, nodeInfo, objectExists, parseRef } from "../graph";
import { displayId } from "../ids";
import { customLinkTypes } from "../schema";
import { ActionError, OBJECT_TYPES, type ObjectType, type Ref, refKey } from "../types";

function ref(db: DB, s: string, what: string): Ref {
  const r = parseRef(s);
  if (!r) throw new ActionError(`${what} 참조 형식이 올바르지 않습니다: ${s}`);
  if (!objectExists(db, r)) throw new ActionError(`${what} ${displayId(r.type, r.id)} 을(를) 찾을 수 없습니다`);
  return r;
}

const title = (db: DB, r: Ref) => nodeInfo(db, [r]).get(refKey(r))?.title ?? "";

const TYPE_LABELS = Object.fromEntries(OBJECT_TYPES.map((t) => [t, t])) as Record<ObjectType, string>;

export const linkActions = [
  defineAction({
    name: "link.create",
    title: "링크 연결",
    description: "두 객체를 사용자 정의 링크 유형으로 연결한다 (예: 고객 referred_by 고객, 업무 depends_on 업무). 링크 유형은 describe_ontology 로 확인.",
    objectType: "system",
    risk: "low",
    fields: {
      from: f.objref("출발 객체", { required: true }),
      link_type: f.choice("링크 유형", "link_types", { required: true }),
      to: f.objref("도착 객체", { required: true }),
      note: f.text("메모", { max: 500 }),
    },
    preview: (db, i) => `링크 ${i.from} —${i.link_type}→ ${i.to}`,
    run({ db }, i) {
      const lt = customLinkTypes(db).find((l) => l.name === i.link_type);
      if (!lt) throw new ActionError(`사용자 정의 링크 유형이 아닙니다: ${i.link_type} (외래키 링크는 해당 객체의 수정 액션으로 바꾼다)`);
      const from = ref(db, String(i.from), "출발");
      const to = ref(db, String(i.to), "도착");
      if (from.type !== lt.fromType || to.type !== lt.toType) {
        throw new ActionError(`${lt.name} 는 ${lt.fromType} → ${lt.toType} 링크입니다 (받은 값: ${from.type} → ${to.type})`);
      }
      if (refKey(from) === refKey(to)) throw new ActionError("자기 자신과는 연결할 수 없습니다");
      if (lt.cardinality === "one") {
        const has = db.prepare("SELECT 1 FROM links WHERE link_type = ? AND from_type = ? AND from_id = ?").get(lt.name, from.type, from.id);
        if (has) throw new ActionError(`${lt.label} 링크는 하나만 가질 수 있습니다 — 기존 링크를 먼저 삭제하세요`);
      }
      const r = db
        .prepare("INSERT OR IGNORE INTO links (link_type, from_type, from_id, to_type, to_id, note) VALUES (?, ?, ?, ?, ?, ?)")
        .run(lt.name, from.type, from.id, to.type, to.id, i.note ?? "");
      if (!r.changes) throw new ActionError("이미 같은 링크가 있습니다");
      return {
        summary: `${displayId(from.type, from.id)} ${title(db, from)} —${lt.label}→ ${displayId(to.type, to.id)} ${title(db, to)}`,
        refs: [from, to],
        data: { link_id: Number(r.lastInsertRowid) },
      };
    },
  }),
  defineAction({
    name: "link.delete",
    title: "링크 해제",
    description: "사용자 정의 링크를 삭제한다.",
    objectType: "system",
    risk: "low",
    fields: { link_id: f.number("링크 id", { required: true, int: true, min: 1 }) },
    run({ db }, i) {
      const l = db.prepare("SELECT * FROM links WHERE id = ?").get(i.link_id) as
        | { link_type: string; from_type: ObjectType; from_id: number; to_type: ObjectType; to_id: number }
        | undefined;
      if (!l) throw new ActionError("링크를 찾을 수 없습니다");
      db.prepare("DELETE FROM links WHERE id = ?").run(i.link_id);
      const from = { type: l.from_type, id: l.from_id };
      const to = { type: l.to_type, id: l.to_id };
      return { summary: `링크 해제: ${displayId(from.type, from.id)} —${l.link_type}→ ${displayId(to.type, to.id)}`, refs: [from, to] };
    },
  }),
  defineAction({
    name: "link_type.define",
    title: "링크 유형 정의",
    description: "온톨로지에 새 링크 유형을 추가한다 (스키마 변경). 예: client → client 'partner_of'.",
    objectType: "system",
    risk: "high",
    fields: {
      name: f.text("이름 (영문 snake_case)", { required: true, max: 40 }),
      label: f.text("라벨", { required: true, max: 40 }),
      inverse_label: f.text("역방향 라벨", { required: true, max: 40 }),
      from_type: f.enum("출발 유형", OBJECT_TYPES, TYPE_LABELS, { required: true }),
      to_type: f.enum("도착 유형", OBJECT_TYPES, TYPE_LABELS, { required: true }),
      cardinality: f.enum("다중성", ["one", "many"] as const, { one: "하나", many: "여럿" }),
      description: f.textarea("설명"),
    },
    preview: (_db, i) => `링크 유형 '${i.name}' (${i.from_type} → ${i.to_type}) 정의`,
    run({ db }, i) {
      if (!/^[a-z][a-z0-9_]{1,39}$/.test(i.name)) throw new ActionError("이름은 영문 소문자로 시작하는 snake_case 여야 합니다");
      if (customLinkTypes(db).some((l) => l.name === i.name)) throw new ActionError(`이미 있는 링크 유형: ${i.name}`);
      db.prepare(
        "INSERT INTO link_types (name, label, inverse_label, from_type, to_type, cardinality, description) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(i.name, i.label, i.inverse_label, i.from_type, i.to_type, i.cardinality ?? "many", i.description ?? "");
      return { summary: `링크 유형 '${i.name}' 정의 (${i.from_type} —${i.label}→ ${i.to_type})`, refs: [] };
    },
  }),
  defineAction({
    name: "link_type.delete",
    title: "링크 유형 삭제",
    description: "사용자 정의 링크 유형과 그 유형의 모든 링크를 삭제한다.",
    objectType: "system",
    risk: "high",
    humanOnly: true,
    fields: { name: f.choice("링크 유형", "link_types", { required: true }) },
    run({ db }, i) {
      const n = (db.prepare("SELECT COUNT(*) AS n FROM links WHERE link_type = ?").get(i.name) as { n: number }).n;
      const r = db.prepare("DELETE FROM link_types WHERE name = ?").run(i.name);
      if (!r.changes) throw new ActionError("링크 유형을 찾을 수 없습니다");
      return { summary: `링크 유형 '${i.name}' 삭제 (링크 ${n}개 함께 삭제)`, refs: [] };
    },
  }),
];

export { deleteLinksFor };
