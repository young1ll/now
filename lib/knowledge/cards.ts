// 객체 카드 — 온톨로지 객체를 검색 가능한 한국어 텍스트로 렌더한다.
// 카드는 "그 객체를 찾을 때 사람이 떠올릴 단어"만 담는다. 개수·잔액처럼 자주 바뀌는 파생값은 넣지 않는다
// (바뀔 때마다 재색인·재임베딩 비용이 들고, 검색 신호로는 잡음이다).
import crypto from "node:crypto";
import type { DB } from "@/lib/db";
import { CLIENT_KIND, CLIENT_STATUS, INTERACTION_KIND, INVOICE_STATUS, PRIORITY, RECURRENCE, TASK_STATUS } from "@/lib/labels";
import { displayId } from "@/lib/ontology/ids";
import { OBJECTS } from "@/lib/ontology/objects";
import { OBJECT_TYPES, type ObjectType, type Ref } from "@/lib/ontology/types";

export type OwnerDoc = { ref: Ref; businessId: number | null; chunks: string[] };

/** 문서 구획 목표 길이(문자). 한국어 기준 약 350 토큰. */
const SECTION_CHARS = 700;
const MAX_INTERACTIONS = 20;

export function estimateTokens(text: string): number {
  // 한글은 음절당 ~1 토큰, 라틴 문자는 ~4자당 1 토큰 — 예산 계산용 근사치
  let hangul = 0;
  for (const ch of text) if (ch >= "가" && ch <= "힣") hangul++;
  return Math.ceil(hangul + (text.length - hangul) / 4);
}

export function contentHash(text: string): string {
  return crypto.createHash("sha256").update(text.normalize("NFKC")).digest("hex");
}

/** 마크다운 본문을 제목 경로가 붙은 구획으로 나눈다. 구획이 목표 길이를 넘으면 문단 경계에서 자른다. */
export function splitSections(title: string, body: string, max = SECTION_CHARS): string[] {
  const out: string[] = [];
  let path: (string | undefined)[] = [];
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join("\n").trim();
    buf = [];
    if (!text) return;
    out.push(`${[title, ...path.filter(Boolean)].join(" > ")}\n${text}`);
  };
  for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      const level = h[1].length;
      path = path.slice(0, level - 1);
      path[level - 1] = h[2].trim();
      continue;
    }
    buf.push(line);
    if (buf.join("\n").length >= max && line.trim() === "") flush();
    else if (buf.join("\n").length >= max * 1.5) flush();
  }
  flush();
  return out;
}

/** 부모 객체 이름 + 식별자 — 식별자는 부모가 삭제됐을 때 이 카드를 다시 찾는 열쇠이기도 하다 */
const named = (name: unknown, type: ObjectType, id: unknown) => (name ? `${name} (${displayId(type, Number(id))})` : null);
const line = (label: string, v: unknown) => (v === null || v === undefined || v === "" ? null : `${label}: ${v}`);
const join = (xs: (string | null | undefined | false)[]) => xs.filter(Boolean).join("\n");

type CustomLink = { label: string; other: string; note: string };

/** 사용자 정의 링크를 카드에 "소개자: CLT-0001 한빛상사" 형태로 넣는다 (양방향) */
function customLinks(db: DB, type: ObjectType): Map<number, CustomLink[]> {
  const rows = db
    .prepare(
      `SELECT l.*, t.label, t.inverse_label FROM links l JOIN link_types t ON t.name = l.link_type
       WHERE l.from_type = ? OR l.to_type = ?`,
    )
    .all(type, type) as { from_type: ObjectType; from_id: number; to_type: ObjectType; to_id: number; label: string; inverse_label: string; note: string }[];
  const refs: Ref[] = rows.flatMap((r) => [{ type: r.from_type, id: r.from_id }, { type: r.to_type, id: r.to_id }]);
  const titles = titlesOf(db, refs);
  const out = new Map<number, CustomLink[]>();
  const push = (id: number, l: CustomLink) => out.set(id, [...(out.get(id) ?? []), l]);
  for (const r of rows) {
    const name = (x: Ref) => `${displayId(x.type, x.id)} ${titles.get(`${x.type}:${x.id}`) ?? ""}`.trim();
    if (r.from_type === type) push(r.from_id, { label: r.label, other: name({ type: r.to_type, id: r.to_id }), note: r.note });
    if (r.to_type === type) push(r.to_id, { label: r.inverse_label, other: name({ type: r.from_type, id: r.from_id }), note: r.note });
  }
  return out;
}

const TITLE_SQL: Record<ObjectType, string> = {
  business: "SELECT id, name AS t FROM businesses",
  client: "SELECT id, name AS t FROM clients",
  task: "SELECT id, title AS t FROM tasks",
  invoice: "SELECT id, number AS t FROM invoices",
  expense: "SELECT id, description AS t FROM expenses",
  note: "SELECT id, title AS t FROM notes",
  agent: "SELECT id, name AS t FROM agents",
};

function titlesOf(db: DB, refs: Ref[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const type of new Set(refs.map((r) => r.type))) {
    const ids = [...new Set(refs.filter((r) => r.type === type).map((r) => r.id))];
    if (!ids.length) continue;
    for (const r of db.prepare(`SELECT * FROM (${TITLE_SQL[type]}) WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as { id: number; t: string }[]) {
      out.set(`${type}:${r.id}`, r.t);
    }
  }
  return out;
}

function header(type: ObjectType, id: number, title: string, status?: string) {
  return `[${OBJECTS[type].label}] ${displayId(type, id)} ${title}${status ? ` · ${status}` : ""}`;
}

const inClause = (ids?: number[]) => (ids ? `WHERE x.id IN (${ids.map(() => "?").join(",") || "NULL"})` : "");

type Row = Record<string, unknown> & { id: number };

/**
 * 유형별 카드 렌더. ids 를 주면 그 객체만 (없는 id 는 결과에서 빠진다 → 호출자가 색인에서 지운다).
 */
export function renderOwners(db: DB, type: ObjectType, ids?: number[]): Map<number, OwnerDoc> {
  const out = new Map<number, OwnerDoc>();
  const links = customLinks(db, type);
  const q = (sql: string) => db.prepare(`${sql} ${inClause(ids)}`).all(...(ids ?? [])) as Row[];
  const linkLines = (id: number) => (links.get(id) ?? []).map((l) => `${l.label}: ${l.other}${l.note ? ` (${l.note})` : ""}`);
  const put = (id: number, businessId: number | null, chunks: string[]) => out.set(id, { ref: { type, id }, businessId, chunks });

  switch (type) {
    case "business":
      for (const b of q("SELECT x.* FROM businesses x")) {
        put(b.id, b.id, [join([header(type, b.id, String(b.name), b.archived ? "보관" : undefined), line("업종", b.kind), line("기본 통화", b.currency), ...linkLines(b.id)])]);
      }
      break;
    case "client": {
      const inter = db.prepare("SELECT kind, summary, occurred_at FROM interactions WHERE client_id = ? ORDER BY occurred_at DESC LIMIT ?");
      for (const c of q("SELECT x.*, b.name AS business FROM clients x JOIN businesses b ON b.id = x.business_id")) {
        const its = inter.all(c.id, MAX_INTERACTIONS) as { kind: keyof typeof INTERACTION_KIND; summary: string; occurred_at: string }[];
        put(c.id, c.business_id as number, [
          join([
            header(type, c.id, String(c.name), CLIENT_STATUS[c.status as keyof typeof CLIENT_STATUS]?.label),
            line("사업", c.business),
            line("구분", CLIENT_KIND[c.kind as keyof typeof CLIENT_KIND]),
            line("이메일", c.email),
            line("전화", c.phone),
            line("태그", c.tags),
            line("메모", c.memo),
            ...linkLines(c.id),
            its.length ? "접촉 이력:" : null,
            ...its.map((i) => `- ${i.occurred_at.slice(0, 10)} ${INTERACTION_KIND[i.kind] ?? i.kind}: ${i.summary}`),
          ]),
        ]);
      }
      break;
    }
    case "task":
      for (const t of q("SELECT x.*, b.name AS business, c.name AS client FROM tasks x JOIN businesses b ON b.id = x.business_id LEFT JOIN clients c ON c.id = x.client_id")) {
        put(t.id, t.business_id as number, [
          join([
            header(type, t.id, String(t.title), TASK_STATUS[t.status as keyof typeof TASK_STATUS]?.label),
            line("사업", t.business),
            line("고객", named(t.client, "client", t.client_id)),
            line("마감", t.due_date),
            line("우선순위", PRIORITY[t.priority as keyof typeof PRIORITY]),
            t.recurrence !== "none" ? line("반복", RECURRENCE[t.recurrence as keyof typeof RECURRENCE]) : null,
            line("상세", t.detail),
            ...linkLines(t.id),
          ]),
        ]);
      }
      break;
    case "invoice": {
      const items = db.prepare("SELECT description FROM invoice_items WHERE invoice_id = ? ORDER BY id");
      const pays = db.prepare("SELECT DISTINCT method FROM payments WHERE invoice_id = ? AND method != ''");
      for (const i of q("SELECT x.*, b.name AS business, c.name AS client FROM invoices x JOIN businesses b ON b.id = x.business_id LEFT JOIN clients c ON c.id = x.client_id")) {
        const its = (items.all(i.id) as { description: string }[]).map((r) => r.description);
        const methods = (pays.all(i.id) as { method: string }[]).map((r) => r.method);
        put(i.id, i.business_id as number, [
          join([
            header(type, i.id, `${i.number}${i.client ? ` · ${i.client}` : ""}`, INVOICE_STATUS[i.status as keyof typeof INVOICE_STATUS]?.label),
            line("사업", i.business),
            line("청구 대상", named(i.client, "client", i.client_id)),
            line("발행일", i.issue_date),
            line("지급기한", i.due_date),
            line("품목", its.join(", ")),
            line("입금 방법", methods.join(", ")),
            line("메모", i.memo),
            ...linkLines(i.id),
          ]),
        ]);
      }
      break;
    }
    case "expense":
      for (const e of q("SELECT x.*, b.name AS business FROM expenses x JOIN businesses b ON b.id = x.business_id")) {
        put(e.id, e.business_id as number, [join([header(type, e.id, String(e.description)), line("사업", e.business), line("분류", e.category), line("지출일", e.spent_at), ...linkLines(e.id)])]);
      }
      break;
    case "note":
      for (const n of q("SELECT x.*, b.name AS business, c.name AS client FROM notes x LEFT JOIN businesses b ON b.id = x.business_id LEFT JOIN clients c ON c.id = x.client_id")) {
        const title = String(n.title);
        put(n.id, (n.business_id as number | null) ?? null, [
          join([header(type, n.id, title, n.pinned ? "고정" : undefined), line("사업", n.business ?? "공용"), line("고객", named(n.client, "client", n.client_id)), line("태그", n.tags), ...linkLines(n.id)]),
          ...splitSections(title, String(n.body)),
        ]);
      }
      break;
    case "agent":
      for (const a of q("SELECT x.id, x.name, x.description, x.status FROM agents x")) {
        put(a.id, null, [join([header(type, a.id, String(a.name)), line("설명", a.description), line("상태", a.status)])]);
      }
      break;
  }
  return out;
}

export const INDEXED_TYPES: readonly ObjectType[] = OBJECT_TYPES;
