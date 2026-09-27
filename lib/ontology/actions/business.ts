import { createBusiness, getBusiness, updateBusiness } from "@/lib/repos/businesses";
import { CURRENCIES } from "@/lib/labels";
import { defineAction } from "../action";
import { f } from "../fields";
import { displayId } from "../ids";
import { merge, must } from "./util";

const CUR = CURRENCIES as unknown as readonly [string, ...string[]];
const curLabels = Object.fromEntries(CURRENCIES.map((c) => [c, c])) as Record<string, string>;

export const businessActions = [
  defineAction({
    name: "business.create",
    title: "사업 등록",
    description: "새 사업(사업 단위)을 등록한다. 모든 고객·업무·재무 기록은 사업에 속한다.",
    objectType: "business",
    risk: "high",
    fields: {
      name: f.text("사업 이름", { required: true }),
      kind: f.text("업종 · 설명"),
      currency: f.enum("기본 통화", CUR, curLabels, { required: true }),
      color: f.text("색상", { help: "#RRGGBB", max: 7 }),
    },
    preview: (_db, i) => `사업 '${i.name}' 등록 (${i.currency})`,
    run({ db }, i) {
      const id = createBusiness(db, {
        name: i.name,
        kind: i.kind ?? "",
        currency: i.currency,
        color: /^#[0-9a-f]{6}$/i.test(i.color ?? "") ? i.color! : "#2D72D2",
      });
      return { summary: `사업 ${displayId("business", id)} '${i.name}' 등록`, refs: [{ type: "business", id }] };
    },
  }),
  defineAction({
    name: "business.update",
    title: "사업 정보 수정",
    description: "사업 이름·업종·색상·보관 여부를 바꾼다. 통화를 바꿔도 기존 금액은 환산되지 않는다.",
    objectType: "business",
    risk: "high",
    target: { type: "business", param: "id" },
    fields: {
      id: f.ref("사업", "business", { required: true }),
      name: f.text("사업 이름"),
      kind: f.text("업종 · 설명"),
      currency: f.enum("기본 통화", CUR, curLabels),
      color: f.text("색상", { help: "#RRGGBB", max: 7 }),
      archived: f.boolean("보관"),
    },
    prefill: (db, id) => {
      const b = getBusiness(db, id);
      return b && { ...b, archived: !!b.archived };
    },
    preview: (db, i) => `사업 '${getBusiness(db, i.id)?.name ?? i.id}' 정보 수정`,
    run({ db }, i) {
      const cur = must(getBusiness(db, i.id), "사업");
      const next = merge({ ...cur, archived: !!cur.archived }, i);
      updateBusiness(db, i.id, next);
      return { summary: `사업 ${displayId("business", i.id)} '${next.name}' 수정`, refs: [{ type: "business", id: i.id }] };
    },
  }),
];
