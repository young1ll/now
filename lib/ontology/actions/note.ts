// 문서 액션 — 지식 베이스 (docs/MEMORY.md §4). 문서 종류: note · playbook(절차 — AI 행동을 바꾼다) · episode(세션 요약 — 워커 전용)
// · brief(AI 산출물) · source(외부 자료 — 비신뢰 입력). 제목·본문이 바뀌면 이전 내용이 note_versions 에 쌓인다.
import { buildEpisode } from "@/lib/knowledge/episodes";
import { REDACTED, redactSecrets } from "@/lib/knowledge/redact";
import { NOTE_KIND } from "@/lib/labels";
import { getSession } from "@/lib/repos/ai";
import { actorKey } from "@/lib/repos/memories";
import {
  AUTHORED_NOTE_KINDS, createNote, deleteNote, episodeUri, findNoteBySource, getNote, getNoteVersion, updateNote,
} from "@/lib/repos/notes";
import { defineAction } from "../action";
import { f } from "../fields";
import { deleteLinksFor } from "../graph";
import { displayId } from "../ids";
import { ActionError, type Actor, type Ref } from "../types";
import { checkBusiness, checkClient, merge, must, normTags } from "./util";

const DOC = (id: number) => displayId("note", id);
const isAgent = (a: Actor) => a.type === "agent";
const AUTHORED_LABELS = Object.fromEntries(AUTHORED_NOTE_KINDS.map((k) => [k, NOTE_KIND[k]])) as Record<(typeof AUTHORED_NOTE_KINDS)[number], string>;

/** 가져온 본문 상한 (문서 가져오기) — 색인이 ~700자 구획으로 나눈다 */
export const IMPORT_MAX_CHARS = 200_000;

const noteFields = {
  business_id: f.ref("사업", "business", { nullable: true, help: "비우면 모든 사업 공용" }),
  client_id: f.ref("고객", "client", { nullable: true }),
  title: f.text("제목", { nonEmpty: true }),
  // 가져온 외부 자료(20만 자)도 편집 드로어로 고칠 수 있게 가져오기 한도와 같게
  body: f.textarea("본문", { max: IMPORT_MAX_CHARS, help: "마크다운: # 제목, - 목록, - [ ] 체크리스트, **굵게**, `코드`, [링크](url). 플레이북은 [[action:task.create]] 로 액션을 참조" }),
  tags: f.tags("태그"),
  pinned: f.boolean("상단 고정"),
  kind: f.enum("종류", AUTHORED_NOTE_KINDS, AUTHORED_LABELS, {
    help: "note=문서 · playbook=플레이북(AI 가 따르는 절차 — 에이전트가 만들거나 고치면 승인 필요) · brief=브리프(AI 산출물) · source=외부 자료(비신뢰 입력). 에피소드는 워커만 만든다",
  }),
  source_uri: f.text("출처", { max: 500, help: "외부 원본 — https://… · file:… (선택)" }),
  tainted: f.boolean("외부 출처(미검증)", { help: "메일·웹페이지 같은 비신뢰 입력에서 유래 — 이 문서를 근거로 한 기억도 미검증이 된다" }),
};

/** 출처 URI 검사 — 'session:' 은 에피소드 전용 */
function checkSource(uri: string | undefined) {
  if (uri && /^session:/i.test(uri.trim())) throw new ActionError("'session:' 출처는 에피소드(워커)만 쓸 수 있습니다");
}

/**
 * 에이전트가 만드는 외부 자료는 항상 tainted. 에이전트는 이미 붙은 오염을 지울 수 없다 (사람만 끌 수 있다).
 * 사람은 입력대로 (생략하면 새 외부 자료는 1 · 그 밖의 새 문서는 0 · 수정은 그대로).
 */
function taintOf(actor: Actor, kind: string, input: boolean | undefined, current?: number): boolean | undefined {
  if (isAgent(actor)) return kind === "source" || !!current || !!input ? true : undefined;
  // 사람이 새로 만드는 외부 자료는 document.import 처럼 기본 미검증 (끄려면 명시)
  if (input === undefined && current === undefined && kind === "source") return true;
  return input;
}

export const noteActions = [
  defineAction({
    name: "note.create",
    title: "문서 작성",
    description:
      "지식 베이스에 문서(SOP·체크리스트·리서치·회의록)를 만든다. kind: note(기본) · playbook(AI 가 따르는 절차 — 본문에 [[action:이름]] 으로 액션 참조, 에이전트가 만들면 고위험) · brief(보고·브리핑) · source(외부 자료 — 에이전트가 만들면 항상 외부 출처로 표시).",
    objectType: "note",
    // 플레이북은 AI 행동을 바꾸는 문서 — 에이전트가 만들면 high
    risk: (_db, i, actor) => (isAgent(actor) && i.kind === "playbook" ? "high" : "low"),
    fields: { ...noteFields, title: f.text("제목", { required: true }) },
    preview: (_db, i) => `${NOTE_KIND[i.kind ?? "note"]} '${i.title}' 작성`,
    run({ db, actor }, i) {
      checkBusiness(db, i.business_id);
      checkClient(db, i.client_id, i.business_id);
      checkSource(i.source_uri);
      const kind = i.kind ?? "note";
      const id = createNote(db, {
        business_id: i.business_id ?? null,
        client_id: i.client_id ?? null,
        title: i.title!,
        body: i.body ?? "",
        tags: normTags(i.tags) ?? "",
        pinned: i.pinned ?? false,
        kind,
        source_uri: i.source_uri?.trim() ?? "",
        tainted: !!taintOf(actor, kind, i.tainted),
      });
      return { summary: `${NOTE_KIND[kind]} ${DOC(id)} '${i.title}' 작성`, refs: [{ type: "note", id }] };
    },
  }),
  defineAction({
    name: "note.update",
    title: "문서 수정",
    description:
      "문서를 부분 수정한다. body 를 넘기면 본문 전체가 교체된다. 제목·본문이 바뀌면 이전 내용은 버전 이력에 남는다 (note.revert 로 되돌림). 에이전트가 플레이북을 고치거나 플레이북으로 바꾸면 고위험. 에피소드는 사람만 고칠 수 있다.",
    objectType: "note",
    risk: (db, i, actor) => (isAgent(actor) && (i.kind === "playbook" || getNote(db, i.id)?.kind === "playbook") ? "high" : "low"),
    target: { type: "note", param: "id" },
    fields: { id: f.ref("문서", "note", { required: true }), ...noteFields },
    prefill: (db, id) => {
      const n = getNote(db, id);
      return n && { ...n, pinned: !!n.pinned, tainted: !!n.tainted, kind: n.kind === "episode" ? undefined : n.kind };
    },
    preview: (db, i) => `문서 '${getNote(db, i.id)?.title ?? i.id}' 수정`,
    run({ db, actor }, i) {
      const cur = must(getNote(db, i.id), "문서");
      if (cur.kind === "episode") {
        if (isAgent(actor)) throw new ActionError("에피소드는 워커가 만든 세션 기록입니다 — 에이전트는 고칠 수 없습니다");
        if (i.kind) throw new ActionError("에피소드의 종류는 바꿀 수 없습니다");
      }
      // 출처: 에피소드의 'session:<id>' 는 세션과의 연결이자 워커 멱등 키 — 바꿀 수 없다 (드로어가 같은 값을 다시 보내는 것은 허용).
      // 그 밖의 문서는 값이 실제로 바뀔 때만 검사한다.
      const uri = i.source_uri?.trim();
      if (cur.kind === "episode") {
        if (uri !== undefined && uri !== cur.source_uri) throw new ActionError("에피소드의 출처(세션 연결)는 바꿀 수 없습니다");
      } else if (uri !== undefined && uri !== cur.source_uri) checkSource(uri);
      const kind = cur.kind === "episode" ? "episode" : (i.kind ?? cur.kind);
      const { tainted: _t, ...base } = cur;
      const { tainted: _in, ...patch } = i;
      const next = merge({ ...base, pinned: !!cur.pinned }, { ...patch, kind, tags: normTags(i.tags), source_uri: cur.kind === "episode" ? cur.source_uri : uri });
      checkBusiness(db, next.business_id);
      checkClient(db, next.client_id, next.business_id);
      const tainted = taintOf(actor, kind, i.tainted, cur.tainted);
      updateNote(db, i.id, { ...next, kind, tainted }, actorKey(actor));
      const after = getNote(db, i.id)!;
      const versioned = after.version !== cur.version ? ` (v${after.version})` : "";
      return { summary: `${NOTE_KIND[kind]} ${DOC(i.id)} '${next.title}' 수정${versioned}`, refs: [{ type: "note", id: i.id }], data: { version: after.version } };
    },
  }),
  defineAction({
    name: "note.revert",
    title: "문서 되돌리기",
    description: "문서의 제목·본문을 이전 버전 내용으로 되돌린다. 되돌림 자체도 새 버전이 된다 (지금 내용은 이력에 남는다).",
    objectType: "note",
    risk: "low",
    humanOnly: true,
    target: { type: "note", param: "id" },
    fields: { id: f.ref("문서", "note", { required: true }), version: f.number("버전", { required: true, int: true, min: 1 }) },
    preview: (db, i) => `문서 '${getNote(db, i.id)?.title ?? i.id}' v${i.version} 로 되돌리기`,
    run({ db, actor }, i) {
      const cur = must(getNote(db, i.id), "문서");
      if (i.version === cur.version) throw new ActionError(`v${i.version} 은(는) 지금 버전입니다`);
      const v = getNoteVersion(db, i.id, i.version);
      if (!v) throw new ActionError(`${DOC(i.id)} 에 v${i.version} 이 없습니다`);
      updateNote(db, i.id, { ...cur, pinned: !!cur.pinned, tainted: !!cur.tainted, title: v.title, body: v.body }, actorKey(actor));
      const after = getNote(db, i.id)!;
      return { summary: `문서 ${DOC(i.id)} v${i.version} 내용으로 되돌림 → v${after.version}`, refs: [{ type: "note", id: i.id }], data: { version: after.version, from: i.version } };
    },
  }),
  defineAction({
    name: "note.delete",
    title: "문서 삭제",
    description: "문서를 삭제한다. 되돌릴 수 없다 (버전 이력도 함께 삭제).",
    objectType: "note",
    risk: "high",
    target: { type: "note", param: "id" },
    fields: { id: f.ref("문서", "note", { required: true }) },
    preview: (db, i) => `문서 '${getNote(db, i.id)?.title ?? i.id}' 삭제`,
    run({ db }, i) {
      const n = must(getNote(db, i.id), "문서");
      deleteNote(db, i.id);
      deleteLinksFor(db, { type: "note", id: i.id });
      return { summary: `문서 ${DOC(i.id)} '${n.title}' 삭제`, refs: [], data: { deleted: n } };
    },
  }),
  defineAction({
    name: "document.import",
    title: "외부 자료 가져오기",
    description:
      "외부 자료(웹페이지·파일·메일 본문 등 마크다운/텍스트, 20만 자 이하)를 문서(kind source)로 저장한다. 외부로 fetch 하지 않는다 — 받은 본문을 저장만. 비밀값은 저장 전에 가린다. 기본적으로 외부 출처(미검증) — 에이전트가 가져오면 항상. 이 문서를 근거로 한 기억도 미검증이 된다.",
    objectType: "note",
    risk: "low",
    // 본문·제목·출처의 비밀값은 검증 전에 가린다 — 감사 기록(action_runs.params)과 승인 대기에도 원문이 남지 않게
    secretFields: ["title", "body", "source_uri"],
    fields: {
      title: f.text("제목", { required: true }),
      body: f.textarea("본문", { required: true, max: IMPORT_MAX_CHARS, help: "마크다운 또는 텍스트 (최대 20만 자) — 긴 본문은 색인이 구획으로 나눈다" }),
      source_uri: f.text("출처", { max: 500, help: "https://… · file:… (선택)" }),
      business_id: f.ref("사업", "business", { nullable: true, help: "비우면 공용" }),
      client_id: f.ref("고객", "client", { nullable: true }),
      tainted: f.boolean("외부 출처(미검증)", { checked: true, help: "기본 켜짐. 직접 쓴 신뢰할 수 있는 자료면 끈다 (사람만 — 에이전트가 가져오면 항상 켜짐)" }),
    },
    preview: (_db, i) => `외부 자료 '${i.title}' 가져오기`,
    run({ db, actor }, i) {
      checkBusiness(db, i.business_id);
      checkClient(db, i.client_id, i.business_id);
      checkSource(i.source_uri);
      const tainted = isAgent(actor) ? true : i.tainted !== false;
      // 입력은 executeAction 이 이미 가렸다 (secretFields) — 직접 호출에 대비해 한 번 더 (가린 값에는 다시 걸리지 않는다)
      const body = redactSecrets(i.body);
      const title = redactSecrets(i.title);
      const redacted = body.includes(REDACTED) || title.includes(REDACTED);
      const id = createNote(db, {
        business_id: i.business_id ?? null,
        client_id: i.client_id ?? null,
        title,
        body,
        tags: "",
        pinned: false,
        kind: "source",
        source_uri: redactSecrets(i.source_uri?.trim() ?? ""),
        tainted,
      });
      return {
        summary: `외부 자료 ${DOC(id)} '${title}' 가져오기 (${body.length.toLocaleString("ko-KR")}자${tainted ? " · 미검증" : ""}${redacted ? " · 비밀값 가림" : ""})`,
        refs: [{ type: "note", id }],
        data: { note_id: id, chars: body.length, tainted, redacted },
      };
    },
  }),
  defineAction({
    name: "document.record_episode",
    title: "에피소드 기록",
    description:
      "끝난 AI 세션 하나를 에피소드 문서(kind episode)로 요약한다 (LLM 없이 결정적). 실행한 액션·참고/인용한 기억이 본문에, 실행한 액션이 건드린 객체가 mentions 링크로 붙는다. 워커가 자동으로 부른다 — 이미 기록된 세션이면 기존 문서를 돌려준다(멱등). 사람이 지운 에피소드는 워커가 다시 만들지 않는다 — 이 액션을 직접 실행하면 다시 기록한다.",
    objectType: "note",
    risk: "low",
    humanOnly: true,
    fields: { session_id: f.number("세션 id", { required: true, int: true, min: 1 }) },
    preview: (_db, i) => `세션 #${i.session_id} 에피소드 기록`,
    run({ db }, i) {
      const s = must(getSession(db, i.session_id), "세션");
      const uri = episodeUri(s.id);
      const existing = findNoteBySource(db, uri, "episode");
      // 기록 표식 — 워커는 표식이 없는 세션만 고른다 (사람이 지운 에피소드를 다시 만들지 않게)
      const mark = () => db.prepare("UPDATE agent_sessions SET episode_recorded_at = COALESCE(episode_recorded_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id = ?").run(s.id);
      if (existing) mark();
      if (existing) return { summary: `세션 #${s.id} 에피소드 이미 기록됨 — ${DOC(existing.id)}`, refs: [{ type: "note", id: existing.id }], data: { note_id: existing.id, existed: true } };
      if (s.status !== "succeeded" && s.status !== "failed") throw new ActionError(`세션 #${s.id} 은(는) 아직 끝나지 않았습니다 (${s.status})`);
      const ep = buildEpisode(db, s);
      mark();
      const id = createNote(db, { business_id: ep.businessId, client_id: null, title: ep.title, body: ep.body, tags: "", pinned: false, kind: "episode", source_uri: uri, tainted: ep.tainted });
      const ins = db.prepare("INSERT OR IGNORE INTO links (link_type, from_type, from_id, to_type, to_id) VALUES ('mentions', 'note', ?, ?, ?)");
      for (const r of ep.mentions) if (!(r.type === "note" && r.id === id)) ins.run(id, r.type, r.id);
      const profileAgent = db.prepare("SELECT agent_id FROM ai_profiles WHERE id = ?").pluck().get(s.profile_id) as number | undefined;
      const refs: Ref[] = [{ type: "note", id }, ...(profileAgent ? [{ type: "agent" as const, id: profileAgent }] : [])];
      return {
        summary: `세션 #${s.id} 에피소드 ${DOC(id)} 기록 (액션 ${ep.runIds.length} · 언급 ${ep.mentions.length}${ep.tainted ? " · 미검증" : ""})`,
        refs,
        data: { note_id: id, existed: false, session_id: s.id, runs: ep.runIds, mentions: ep.mentions.length, tainted: ep.tainted, taint_reason: ep.taintReason },
      };
    },
  }),
];

/** 문서 종류별 액션 (OBJECTS.note.actionsFor) */
export function noteActionsFor(raw: Record<string, unknown>): string[] {
  const version = Number(raw.version ?? 1);
  return ["note.update", ...(version > 1 ? ["note.revert"] : []), "note.delete"];
}
