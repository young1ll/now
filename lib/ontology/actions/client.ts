import { today } from "@/lib/dates";
import { CLIENT_KIND, CLIENT_STATUS, INTERACTION_KIND } from "@/lib/labels";
import { getBusiness } from "@/lib/repos/businesses";
import {
  CLIENT_STATUSES, INTERACTION_KINDS, addInteraction, createClient, deleteClient, getClient, updateClient,
} from "@/lib/repos/clients";
import { defineAction } from "../action";
import { f } from "../fields";
import { displayId } from "../ids";
import { checkBusiness, labels, merge, must, normTags } from "./util";

const KINDS = ["company", "person"] as const;

const clientFields = {
  name: f.text("이름", { nonEmpty: true }),
  kind: f.enum("구분", KINDS, CLIENT_KIND),
  status: f.enum("상태", CLIENT_STATUSES, labels(CLIENT_STATUS)),
  email: f.email("이메일"),
  phone: f.text("전화"),
  tags: f.tags("태그"),
  memo: f.textarea("메모"),
};

export const clientActions = [
  defineAction({
    name: "client.create",
    title: "고객 등록",
    description: "사업에 고객(거래처)을 등록한다. 새 리드는 status=lead 로.",
    objectType: "client",
    risk: "low",
    fields: {
      business_id: f.ref("사업", "business", { required: true }),
      ...clientFields,
      name: f.text("이름", { required: true }),
    },
    run({ db }, i) {
      must(getBusiness(db, i.business_id), "사업");
      const id = createClient(db, {
        business_id: i.business_id,
        name: i.name!,
        kind: i.kind ?? "company",
        status: i.status ?? "lead",
        email: i.email ?? "",
        phone: i.phone ?? "",
        tags: normTags(i.tags) ?? "",
        memo: i.memo ?? "",
      });
      return { summary: `고객 ${displayId("client", id)} '${i.name}' 등록`, refs: [{ type: "client", id }, { type: "business", id: i.business_id }] };
    },
  }),
  defineAction({
    name: "client.update",
    title: "고객 정보 수정",
    description: "고객 속성을 부분 수정한다. 넘긴 필드만 바뀐다.",
    objectType: "client",
    risk: "low",
    target: { type: "client", param: "id" },
    fields: { id: f.ref("고객", "client", { required: true }), business_id: f.ref("사업", "business"), ...clientFields },
    prefill: (db, id) => getClient(db, id),
    preview: (db, i) => `고객 '${getClient(db, i.id)?.name ?? i.id}' 정보 수정`,
    run({ db }, i) {
      const cur = must(getClient(db, i.id), "고객");
      checkBusiness(db, i.business_id);
      const next = merge(cur, { ...i, tags: normTags(i.tags) });
      updateClient(db, i.id, next);
      return { summary: `고객 ${displayId("client", i.id)} '${next.name}' 수정`, refs: [{ type: "client", id: i.id }] };
    },
  }),
  defineAction({
    name: "client.log_interaction",
    title: "접촉 기록",
    description: "고객과의 통화·미팅·이메일·메모를 이력에 남긴다.",
    objectType: "client",
    risk: "low",
    target: { type: "client", param: "client_id" },
    fields: {
      client_id: f.ref("고객", "client", { required: true }),
      kind: f.enum("유형", INTERACTION_KINDS, INTERACTION_KIND, { required: true }),
      summary: f.textarea("내용", { required: true }),
      occurred_at: f.date("일자"),
    },
    run({ db }, i) {
      const c = must(getClient(db, i.client_id), "고객");
      addInteraction(db, { client_id: c.id, kind: i.kind, summary: i.summary, occurred_at: i.occurred_at ?? today() });
      return { summary: `'${c.name}' ${INTERACTION_KIND[i.kind]} 기록: ${i.summary.slice(0, 60)}`, refs: [{ type: "client", id: c.id }] };
    },
  }),
  defineAction({
    name: "client.delete",
    title: "고객 삭제",
    description: "고객과 접촉 이력을 삭제한다. 업무·청구서·문서는 남고 고객 연결만 해제된다. 되돌릴 수 없다.",
    objectType: "client",
    risk: "high",
    target: { type: "client", param: "id" },
    fields: { id: f.ref("고객", "client", { required: true }) },
    preview: (db, i) => `고객 '${getClient(db, i.id)?.name ?? i.id}' 삭제`,
    run({ db }, i) {
      const c = must(getClient(db, i.id), "고객");
      deleteClient(db, i.id);
      return { summary: `고객 ${displayId("client", i.id)} '${c.name}' 삭제`, refs: [], data: { deleted: c } };
    },
  }),
];
