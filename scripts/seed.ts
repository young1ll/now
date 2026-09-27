// 예시 데이터 — 모든 기록을 액션으로 만든다 (사람·에이전트 활동이 감사 로그에 그대로 남음).
//   npm run db:seed        (빈 DB 에서만)
import { db, dbPath } from "@/lib/db";
import { addDays, addMonths, today } from "@/lib/dates";
import { executeAction } from "@/lib/ontology/execute";
import { type Actor, OPERATOR } from "@/lib/ontology/types";
import { listBusinesses } from "@/lib/repos/businesses";
import { insertSnapshot } from "@/lib/repos/snapshots";

const d = db();
if (listBusinesses(d, { includeArchived: true }).length > 0) {
  console.error(`이미 데이터가 있습니다 (${dbPath()}). 초기화: npm run db:reset -- --yes`);
  process.exit(1);
}

const t = today();
const ago = (n: number) => addDays(t, -n);
let agent: Actor = OPERATOR;

function run(actor: Actor, action: string, params: Record<string, unknown>, reason = "") {
  const r = executeAction(d, { actor, action, params, reason });
  if (r.status === "failed" || r.status === "denied") throw new Error(`${action}: ${r.error}`);
  return r;
}
const id = (r: ReturnType<typeof run>, type = r.refs[0]?.type) => r.refs.find((x) => x.type === type)!.id;
const H = (action: string, params: Record<string, unknown>) => run(OPERATOR, action, params);
const A = (action: string, params: Record<string, unknown>, reason: string) => run(agent, action, params, reason);

let token = "";
d.transaction(() => {
  // ── 사람: 기본 구조 ─────────────────────────────
  const tax = id(H("business.create", { name: "한결 세무사무소", kind: "세무 대행", currency: "KRW", color: "#2D72D2" }));
  const saas = id(H("business.create", { name: "Ledgerly", kind: "B2B SaaS", currency: "USD", color: "#C87619" }));

  const reg = H("agent.register", { name: "Claude · 운영 에이전트", description: "신호 처리, 고객 후속 조치, 청구·정산 준비" });
  token = String(reg.out?.token);
  agent = { type: "agent", id: String(reg.refs[0].id), name: "Claude · 운영 에이전트" };
  H("agent.register", { name: "Claude · 리서치", description: "세법·시장 리서치 문서화" });

  const hanbit = id(H("client.create", { business_id: tax, name: "한빛상사", status: "active", tags: "법인, 기장", email: "cfo@hanbit.example" }));
  const kim = id(H("client.create", { business_id: tax, name: "김민수", kind: "person", status: "active", tags: "개인, 양도세" }));
  const acme = id(H("client.create", { business_id: saas, name: "Acme Robotics", status: "active", tags: "enterprise", email: "ops@acme.example" }));

  // 6개월 청구·입금 이력
  for (let m = 5; m >= 1; m--) {
    const issue = `${addMonths(t, -m).slice(0, 8)}05`;
    const inv = id(H("invoice.create", { business_id: tax, client_id: hanbit, issue_date: issue, items: [{ description: "월 기장 대행", unit_price: 1_200_000 }] }));
    H("invoice.issue", { id: inv });
    H("payment.record", { invoice_id: inv, paid_at: addDays(issue, 7), method: "계좌이체" });
    const s = `${addMonths(t, -m).slice(0, 8)}01`;
    const inv2 = id(H("invoice.create", { business_id: saas, client_id: acme, issue_date: s, items: [{ description: "Ledgerly Business plan", quantity: 40, unit_price: 29 }] }));
    H("invoice.issue", { id: inv2 });
    H("payment.record", { invoice_id: inv2, paid_at: addDays(s, 10), method: "Stripe" });
    H("expense.record", { business_id: tax, category: "임대료", description: "사무실 월세", amount: 700_000, spent_at: s });
    H("expense.record", { business_id: tax, category: "소프트웨어", description: "세무 프로그램 구독", amount: 99_000, spent_at: addDays(s, 2) });
    H("expense.record", { business_id: saas, category: "인프라", description: "AWS", amount: 380 + m * 15, spent_at: addDays(s, 1) });
  }
  const monthStart = `${t.slice(0, 8)}01`;
  H("expense.record", { business_id: tax, category: "임대료", description: "사무실 월세", amount: 700_000, spent_at: monthStart });
  const hanbitNow = id(H("invoice.create", { business_id: tax, client_id: hanbit, issue_date: `${t.slice(0, 8)}05`, items: [{ description: "월 기장 대행", unit_price: 1_200_000 }] }));
  H("invoice.issue", { id: hanbitNow });
  const kimInv = id(H("invoice.create", { business_id: tax, client_id: kim, issue_date: ago(40), due_date: ago(26), items: [{ description: "양도소득세 신고 대행", unit_price: 800_000 }] }));
  H("invoice.issue", { id: kimInv });

  H("task.create", { business_id: tax, title: "원천세 신고", due_date: addDays(t, 5), recurrence: "monthly", priority: "1" });
  H("task.create", { business_id: tax, title: "부가세 확정신고 준비", due_date: addDays(t, 12), recurrence: "quarterly", priority: "1" });
  H("task.create", { business_id: saas, title: "주간 지표 리뷰", due_date: addDays(t, 1), recurrence: "weekly" });
  H("task.create", { business_id: tax, client_id: kim, title: "김민수 양도세 계산서 발송", due_date: ago(4), priority: "1" });

  H("note.create", {
    business_id: tax, title: "부가세 신고 SOP", pinned: true, tags: "SOP, 부가세",
    body: `# 부가세 확정신고 절차\n\n1월 25일 · 7월 25일 마감 (예정신고: 4월 · 10월)\n\n## 자료 수집 (D-14)\n- [ ] 매출·매입 세금계산서 홈택스 조회\n- [ ] 신용카드 매출전표 / 현금영수증\n- [ ] 법인카드 사용내역 — 불공제 항목 분류\n\n## 검토 (D-7)\n- [ ] 전기 대비 매출 증감 **20% 이상**이면 사유 확인\n\n## 신고 (D-3)\n- [ ] 홈택스 전자신고 → 납부서 고객 발송\n\n> 에이전트: 이 SOP 의 각 단계를 업무(task)로 만들어 추적한다.`,
  });
  H("note.create", { title: "에이전트 운영 원칙", pinned: true, tags: "거버넌스", body: "- 고객에게 나가는 모든 것은 사람 승인\n- 금액이 불확실하면 실행하지 말고 문서로 제안\n- 모든 액션에 근거(reason)를 남긴다" });

  // ── 에이전트: 운영 활동 ─────────────────────────
  const cafe = id(A("client.create", { business_id: tax, name: "카페 온도", status: "lead", tags: "개인사업자, 인바운드", email: "hello@ondo.example" }, "홈페이지 문의 메일에서 신규 리드 확인"));
  A("client.log_interaction", { client_id: cafe, kind: "email", summary: "기장 견적 문의 — 월 매출 약 3천만원, 직원 2명", occurred_at: ago(9) }, "문의 메일 내용 요약 기록");
  A("client.log_interaction", { client_id: hanbit, kind: "meeting", summary: "3분기 부가세 자료 요청, 법인카드 내역 누락분 확인", occurred_at: ago(3) }, "회의록(캘린더 메모) 반영");
  A("client.log_interaction", { client_id: acme, kind: "email", summary: "Q4 갱신 — SSO(SAML) 요구, 60석 확장 검토", occurred_at: ago(2) }, "고객 메일 요약");
  A("task.create", { business_id: tax, client_id: hanbit, title: "한빛상사 법인카드 누락분 수령", due_date: addDays(t, 2), priority: "1" }, "3분기 부가세 준비에 필요한 자료");
  A("task.create", { business_id: saas, client_id: acme, title: "Acme 갱신 제안서 (60석 · SSO)", due_date: addDays(t, 4), priority: "1" }, "갱신 협상 일정");
  A("note.create", { business_id: saas, client_id: acme, title: "Acme 갱신 협상 메모", tags: "영업, 갱신", body: "- 현재 40석 → 60석 확장\n- SSO(SAML) 필수\n- 연 선결제 시 10% 할인 제안 가능 (사람 결정 필요)" }, "협상 포인트 정리");
  const draft = id(A("invoice.create", { business_id: tax, client_id: cafe, items: [{ description: "기장 대행 (월)", unit_price: 250_000 }, { description: "초기 세팅", unit_price: 300_000 }] }, "견적 합의 전 초안 — 발행은 승인 후"));
  A("invoice.issue", { id: draft }, "고객이 견적 수락 회신 (메일 확인)");
  A("payment.record", { invoice_id: hanbitNow, amount: 1_320_000, method: "계좌이체" }, "은행 알림 문자: 한빛상사 1,320,000원 입금");
  A("expense.record", { business_id: saas, category: "인프라", description: "AWS (이번 달 청구서)", amount: 431.2 }, "AWS 청구 메일 금액");
  A("task.delete", { id: 3 }, "주간 지표 리뷰는 대시보드 자동화로 대체되어 불필요");
})();

// 최근 24시간에 에이전트 활동이 분포하도록 시각을 흩뜨린다 (예시 데이터 전용)
const runs = d.prepare("SELECT id, actor_type FROM action_runs ORDER BY id").all() as { id: number; actor_type: string }[];
const now = Date.now();
runs.forEach((r, i) => {
  const hoursAgo = r.actor_type === "agent" ? 1 + ((i * 7) % 22) : 24 + (runs.length - i) * 0.5;
  d.prepare("UPDATE action_runs SET created_at = ? WHERE id = ?").run(new Date(now - hoursAgo * 3600_000).toISOString(), r.id);
});

insertSnapshot(d, {
  captured_at: new Date(now - 3 * 3600_000).toISOString(),
  tool: "tofu",
  status: "in_sync",
  message: "",
  resources: [
    { address: "docker_container.app", type: "docker_container", name: "app", provider: "docker", attributes: { name: "now", restart: "unless-stopped", ports: "127.0.0.1:3000→3000", volumes: "now-data:/app/data", env_keys: "NODE_ENV, NOW_DB_PATH, NOW_OPERATOR_NAME" } },
    { address: "docker_network.app", type: "docker_network", name: "app", provider: "docker", attributes: { name: "now-net", driver: "bridge" } },
    { address: "docker_volume.data", type: "docker_volume", name: "data", provider: "docker", attributes: { name: "now-data", driver: "local" } },
  ],
  changes: [],
});

console.log(`예시 데이터 → ${dbPath()}`);
console.log(`\n운영 에이전트 토큰 (MCP 연결용, 다시 표시되지 않음):\nNOW_AGENT_TOKEN=${token}`);
