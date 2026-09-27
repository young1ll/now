import { createNote, deleteNote, getNote, updateNote } from "@/lib/repos/notes";
import { defineAction } from "../action";
import { f } from "../fields";
import { displayId } from "../ids";
import { checkBusiness, checkClient, merge, must, normTags } from "./util";

const noteFields = {
  business_id: f.ref("사업", "business", { nullable: true, help: "비우면 모든 사업 공용" }),
  client_id: f.ref("고객", "client", { nullable: true }),
  title: f.text("제목", { nonEmpty: true }),
  body: f.textarea("본문", { help: "마크다운: # 제목, - 목록, - [ ] 체크리스트, **굵게**, `코드`, [링크](url)" }),
  tags: f.tags("태그"),
  pinned: f.boolean("상단 고정"),
};

export const noteActions = [
  defineAction({
    name: "note.create",
    title: "문서 작성",
    description: "지식 베이스에 문서(SOP·체크리스트·리서치·회의록)를 만든다.",
    objectType: "note",
    risk: "low",
    fields: { ...noteFields, title: f.text("제목", { required: true }) },
    run({ db }, i) {
      checkBusiness(db, i.business_id);
      checkClient(db, i.client_id, i.business_id);
      const id = createNote(db, {
        business_id: i.business_id ?? null,
        client_id: i.client_id ?? null,
        title: i.title!,
        body: i.body ?? "",
        tags: normTags(i.tags) ?? "",
        pinned: i.pinned ?? false,
      });
      return { summary: `문서 ${displayId("note", id)} '${i.title}' 작성`, refs: [{ type: "note", id }] };
    },
  }),
  defineAction({
    name: "note.update",
    title: "문서 수정",
    description: "문서를 부분 수정한다. body 를 넘기면 본문 전체가 교체된다.",
    objectType: "note",
    risk: "low",
    target: { type: "note", param: "id" },
    fields: { id: f.ref("문서", "note", { required: true }), ...noteFields },
    prefill: (db, id) => {
      const n = getNote(db, id);
      return n && { ...n, pinned: !!n.pinned };
    },
    preview: (db, i) => `문서 '${getNote(db, i.id)?.title ?? i.id}' 수정`,
    run({ db }, i) {
      const cur = must(getNote(db, i.id), "문서");
      const next = merge({ ...cur, pinned: !!cur.pinned }, { ...i, tags: normTags(i.tags) });
      checkBusiness(db, next.business_id);
      checkClient(db, next.client_id, next.business_id);
      updateNote(db, i.id, next);
      return { summary: `문서 ${displayId("note", i.id)} '${next.title}' 수정`, refs: [{ type: "note", id: i.id }] };
    },
  }),
  defineAction({
    name: "note.delete",
    title: "문서 삭제",
    description: "문서를 삭제한다. 되돌릴 수 없다.",
    objectType: "note",
    risk: "high",
    target: { type: "note", param: "id" },
    fields: { id: f.ref("문서", "note", { required: true }) },
    preview: (db, i) => `문서 '${getNote(db, i.id)?.title ?? i.id}' 삭제`,
    run({ db }, i) {
      const n = must(getNote(db, i.id), "문서");
      deleteNote(db, i.id);
      return { summary: `문서 ${displayId("note", i.id)} '${n.title}' 삭제`, refs: [], data: { deleted: n } };
    },
  }),
];
