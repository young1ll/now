// 온톨로지 스키마 — 객체 유형의 속성과 링크 유형을 "데이터"로 기술한다.
// 콘솔(스키마 화면·그래프), 에이전트(describe_ontology), Neo4j 내보내기가 모두 이 정의를 읽는다.
import type { DB } from "@/lib/db";
import type { ObjectType } from "./types";

export type PropType = "string" | "text" | "number" | "money" | "date" | "datetime" | "enum" | "boolean" | "tags";

export type PropertyDef = { key: string; label: string; type: PropType; description?: string };

export const PROPERTIES: Record<ObjectType, PropertyDef[]> = {
  business: [
    { key: "name", label: "이름", type: "string" },
    { key: "kind", label: "업종", type: "string" },
    { key: "currency", label: "기본 통화", type: "enum" },
    { key: "archived", label: "보관", type: "boolean" },
  ],
  client: [
    { key: "name", label: "이름", type: "string" },
    { key: "kind", label: "구분", type: "enum", description: "company | person" },
    { key: "status", label: "상태", type: "enum", description: "lead | active | paused | closed" },
    { key: "email", label: "이메일", type: "string" },
    { key: "phone", label: "전화", type: "string" },
    { key: "tags", label: "태그", type: "tags" },
    { key: "memo", label: "메모", type: "text" },
  ],
  task: [
    { key: "title", label: "업무명", type: "string" },
    { key: "status", label: "상태", type: "enum", description: "todo | doing | done" },
    { key: "priority", label: "우선순위", type: "number", description: "1 높음 · 2 보통 · 3 낮음" },
    { key: "due_date", label: "마감일", type: "date" },
    { key: "recurrence", label: "반복", type: "enum", description: "none | weekly | monthly | quarterly | yearly" },
    { key: "detail", label: "상세", type: "text" },
  ],
  invoice: [
    { key: "number", label: "번호", type: "string" },
    { key: "status", label: "상태", type: "enum", description: "draft | sent | paid | void" },
    { key: "issue_date", label: "발행일", type: "date" },
    { key: "due_date", label: "지급기한", type: "date" },
    { key: "total", label: "합계", type: "money", description: "통화 최소 단위 (파생)" },
    { key: "balance", label: "잔액", type: "money", description: "합계 - 입금 (파생)" },
  ],
  expense: [
    { key: "description", label: "내용", type: "string" },
    { key: "category", label: "분류", type: "enum" },
    { key: "amount", label: "금액", type: "money" },
    { key: "spent_at", label: "지출일", type: "date" },
  ],
  note: [
    { key: "title", label: "제목", type: "string" },
    { key: "body", label: "본문", type: "text", description: "마크다운" },
    { key: "tags", label: "태그", type: "tags" },
    { key: "pinned", label: "고정", type: "boolean" },
    { key: "kind", label: "종류", type: "enum", description: "note | playbook | episode | brief | source — playbook 은 AI 가 따르는 절차([[action:이름]] 참조), episode 는 워커가 만든 세션 요약, source 는 외부 자료" },
    { key: "source_uri", label: "출처", type: "string", description: "외부 원본 — session:12 (에피소드) · https://… · file:…" },
    { key: "tainted", label: "외부 출처(미검증)", type: "boolean", description: "비신뢰 입력에서 유래 — 이 문서를 근거로 한 기억도 미검증" },
    { key: "version", label: "버전", type: "number", description: "제목·본문이 바뀔 때마다 +1 (이전 내용은 note_versions)" },
  ],
  agent: [
    { key: "name", label: "이름", type: "string" },
    { key: "status", label: "상태", type: "enum", description: "active | suspended | revoked" },
    { key: "last_seen_at", label: "최근 접속", type: "datetime" },
  ],
  memory: [
    { key: "statement", label: "문장", type: "text", description: "자기완결적인 한 문장 (대상을 이름으로)" },
    { key: "kind", label: "종류", type: "enum", description: "fact | preference | lesson | procedure_hint | caution" },
    { key: "status", label: "상태", type: "enum", description: "proposed | active | verified | disputed | superseded | retired" },
    { key: "confidence", label: "신뢰도", type: "number", description: "0..1" },
    { key: "origin", label: "출처", type: "enum", description: "human | agent | consolidation | import" },
    { key: "tainted", label: "외부 출처(미검증)", type: "boolean", description: "비신뢰 입력(메일·웹훅)에서 유래 — 사람 확인 전에는 확정될 수 없다" },
    { key: "pinned", label: "고정", type: "boolean", description: "항상 컨텍스트 팩에 포함" },
    { key: "valid_from", label: "유효 시작", type: "date" },
    { key: "valid_to", label: "유효 종료", type: "date" },
    { key: "use_count", label: "사용 수", type: "number", description: "컨텍스트 포함·인용 횟수 (텔레메트리)" },
    { key: "last_used_at", label: "최근 사용", type: "datetime" },
  ],
};

export type LinkEnd = ObjectType | "*";

export type LinkTypeDef = {
  name: string;
  label: string;
  inverseLabel: string;
  fromType: ObjectType;
  toType: LinkEnd;
  cardinality: "one" | "many";
  description: string;
  /** intrinsic: 레코드의 외래키에서 파생 (수정은 해당 객체 액션으로) · derived: 감사 로그에서 파생 · custom: links 테이블 */
  source: "intrinsic" | "derived" | "custom";
};

/** 외래키 기반 링크: SQL 로 (from_id, to_id) 를 만든다 */
type FkLink = LinkTypeDef & { table: string; fk: string };

const fk = (name: string, fromType: ObjectType, toType: ObjectType, table: string, col: string, label: string, inverseLabel: string, description: string): FkLink => ({
  name, label, inverseLabel, fromType, toType, cardinality: "one", description, source: "intrinsic", table, fk: col,
});

export const INTRINSIC_LINKS: FkLink[] = [
  fk("client.business", "client", "business", "clients", "business_id", "소속 사업", "고객", "고객은 하나의 사업에 속한다"),
  fk("task.business", "task", "business", "tasks", "business_id", "소속 사업", "업무", "업무는 하나의 사업에 속한다"),
  fk("task.client", "task", "client", "tasks", "client_id", "고객", "업무", "업무의 대상 고객"),
  fk("invoice.business", "invoice", "business", "invoices", "business_id", "발행 사업", "청구서", "청구서를 발행한 사업"),
  fk("invoice.client", "invoice", "client", "invoices", "client_id", "청구 대상", "청구서", "청구서를 받는 고객"),
  fk("expense.business", "expense", "business", "expenses", "business_id", "사업", "지출", "지출이 발생한 사업"),
  fk("note.business", "note", "business", "notes", "business_id", "사업", "문서", "문서의 소속 사업 (없으면 공용)"),
  fk("note.client", "note", "client", "notes", "client_id", "관련 고객", "문서", "문서가 다루는 고객"),
];

export const DERIVED_LINKS: LinkTypeDef[] = [
  {
    name: "agent.touched",
    label: "변경한 객체",
    inverseLabel: "변경한 에이전트",
    fromType: "agent",
    toType: "*",
    cardinality: "many",
    description: "에이전트가 액션으로 변경(적용)한 객체 — 감사 로그에서 파생",
    source: "derived",
  },
];

/**
 * 시스템 링크 유형 — 기억 계층(마이그레이션 6)과 문서 계층(마이그레이션 7: mentions)이 의존한다. link_type.delete 로 지울 수 없다.
 * contradicts · promoted_to 는 기억 상태와 함께 움직이므로 memory.* 액션으로만 만든다 (link.create 거부).
 * mentions 는 document.record_episode 가 만든다 (문서 → 다루는 객체, link.create 도 가능).
 */
export const SYSTEM_LINK_TYPES = ["about", "evidenced_by", "contradicts", "promoted_to", "mentions"] as const;
export const ACTION_MANAGED_LINK_TYPES: readonly string[] = ["contradicts", "promoted_to"];

type CustomRow = {
  name: string;
  label: string;
  inverse_label: string;
  from_type: ObjectType;
  to_type: LinkEnd;
  cardinality: "one" | "many";
  description: string;
};

export function customLinkTypes(db: DB): LinkTypeDef[] {
  return (db.prepare("SELECT * FROM link_types ORDER BY name").all() as CustomRow[]).map((r) => ({
    name: r.name,
    label: r.label,
    inverseLabel: r.inverse_label,
    fromType: r.from_type,
    toType: r.to_type,
    cardinality: r.cardinality,
    description: r.description,
    source: "custom",
  }));
}

export function allLinkTypes(db: DB): LinkTypeDef[] {
  return [...INTRINSIC_LINKS, ...DERIVED_LINKS, ...customLinkTypes(db)];
}

export function getLinkType(db: DB, name: string): LinkTypeDef | undefined {
  return allLinkTypes(db).find((l) => l.name === name);
}
