// 화면 표시용 한국어 라벨과 색상.

export const CLIENT_STATUS = {
  lead: { label: "잠재", tone: "amber" },
  active: { label: "진행", tone: "green" },
  paused: { label: "보류", tone: "slate" },
  closed: { label: "종료", tone: "zinc" },
} as const;

export const CLIENT_KIND = { company: "법인·단체", person: "개인" } as const;

export const INTERACTION_KIND = { call: "통화", meeting: "미팅", email: "이메일", memo: "메모" } as const;

export const TASK_STATUS = {
  todo: { label: "할 일", tone: "slate" },
  doing: { label: "진행 중", tone: "blue" },
  done: { label: "완료", tone: "green" },
} as const;

export const PRIORITY = { 1: "높음", 2: "보통", 3: "낮음" } as const;

export const RECURRENCE = {
  none: "반복 없음",
  weekly: "매주",
  monthly: "매월",
  quarterly: "분기마다",
  yearly: "매년",
} as const;

export const INVOICE_STATUS = {
  draft: { label: "작성 중", tone: "slate" },
  sent: { label: "발행", tone: "blue" },
  paid: { label: "입금 완료", tone: "green" },
  void: { label: "취소", tone: "zinc" },
} as const;

export const MEMORY_STATUS = {
  proposed: { label: "제안됨", tone: "amber" },
  active: { label: "활성(미확인)", tone: "blue" },
  verified: { label: "확인됨", tone: "green" },
  disputed: { label: "충돌", tone: "red" },
  superseded: { label: "대체됨", tone: "zinc" },
  retired: { label: "보관", tone: "zinc" },
} as const;

export const MEMORY_KIND = { fact: "사실", preference: "선호", lesson: "교훈", procedure_hint: "절차 힌트", caution: "주의" } as const;

export const MEMORY_ORIGIN = { human: "사람", agent: "에이전트", consolidation: "통합", import: "가져오기" } as const;

export const CHECK_STATUS = {
  ok: { label: "정상", tone: "green" },
  degraded: { label: "주의", tone: "amber" },
  down: { label: "장애", tone: "red" },
  unknown: { label: "미확인", tone: "zinc" },
} as const;

export const EXPENSE_CATEGORIES = ["인건비", "임대료", "인프라", "소프트웨어", "마케팅", "외주", "세금·공과", "기타"];

export const CURRENCIES = ["KRW", "USD", "EUR", "JPY"];

export type Tone = "green" | "amber" | "slate" | "zinc" | "blue" | "red";
