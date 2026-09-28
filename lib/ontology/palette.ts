// 객체 유형 색 — dataviz 검증 팔레트 (dark, 8 슬롯 · 표면 #1c2127 에서 CVD/대비 통과 — 최악 인접 CVD ΔE 8.4, 정상시 19.3, 대비 ≥3:1). 라벨과 함께 써서 색에만 의존하지 않는다.
export const TYPE_COLOR: Record<string, string> = {
  business: "#3987e5",
  client: "#d95926",
  task: "#199e70",
  invoice: "#c98500",
  note: "#d55181",
  expense: "#008300",
  agent: "#9085e9",
  memory: "#e66767",
};

export const TYPE_LABEL: Record<string, string> = { business: "사업", client: "고객", task: "업무", invoice: "청구서", note: "문서", expense: "지출", agent: "에이전트", memory: "기억" };
