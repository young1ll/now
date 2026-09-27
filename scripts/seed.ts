// 예시 데이터. 빈 DB 에서만 실행된다: npm run db:seed
import { db, dbPath } from "@/lib/db";
import { addDays, addMonths, monthOf, today } from "@/lib/dates";
import { createBusiness, listBusinesses } from "@/lib/repos/businesses";
import { addInteraction, createClient } from "@/lib/repos/clients";
import { addExpense, addPayment, createInvoice, setInvoiceStatus } from "@/lib/repos/finance";
import { createConnection, recordCheck, upsertCost } from "@/lib/repos/infra";
import { createNote } from "@/lib/repos/notes";
import { createTask } from "@/lib/repos/tasks";

const d = db();
if (listBusinesses(d, { includeArchived: true }).length > 0) {
  console.error(`이미 데이터가 있습니다 (${dbPath()}). 초기화하려면 npm run db:reset 후 다시 실행하세요.`);
  process.exit(1);
}

const t = today();
const ago = (n: number) => addDays(t, -n);
const month = monthOf(t);

d.transaction(() => {
  const tax = createBusiness(d, { name: "한결 세무사무소", kind: "세무 대행", color: "#0ea5e9", currency: "KRW" });
  const saas = createBusiness(d, { name: "Ledgerly", kind: "B2B SaaS", color: "#f97316", currency: "USD" });

  const base = { kind: "company" as const, email: "", phone: "", memo: "" };
  const hanbit = createClient(d, { ...base, business_id: tax, name: "한빛상사", status: "active", tags: "법인, 기장", email: "cfo@hanbit.example" });
  const kim = createClient(d, { ...base, business_id: tax, name: "김민수", kind: "person", status: "active", tags: "개인, 양도세" });
  const cafe = createClient(d, { ...base, business_id: tax, name: "카페 온도", status: "lead", tags: "개인사업자" });
  const acme = createClient(d, { ...base, business_id: saas, name: "Acme Robotics", status: "active", tags: "enterprise", email: "ops@acme.example" });
  createClient(d, { ...base, business_id: saas, name: "Northwind", status: "lead", tags: "trial" });

  addInteraction(d, { client_id: hanbit, kind: "meeting", summary: "3분기 부가세 자료 요청, 법인카드 내역 누락분 확인", occurred_at: ago(3) });
  addInteraction(d, { client_id: kim, kind: "call", summary: "아파트 양도 시점 상담 — 1세대 1주택 비과세 요건 검토", occurred_at: ago(6) });
  addInteraction(d, { client_id: cafe, kind: "email", summary: "기장 견적 문의 회신", occurred_at: ago(1) });
  addInteraction(d, { client_id: acme, kind: "meeting", summary: "Q4 renewal — SSO 요구사항 논의", occurred_at: ago(2) });

  const task = (business_id: number, title: string, due: string | null, extra: Partial<Parameters<typeof createTask>[1]> = {}) =>
    createTask(d, { business_id, client_id: null, title, detail: "", priority: 2, due_date: due, recurrence: "none", ...extra });
  task(tax, "한빛상사 부가세 신고서 작성", addDays(t, 2), { client_id: hanbit, priority: 1 });
  task(tax, "원천세 신고", addDays(t, 5), { recurrence: "monthly", priority: 1 });
  task(tax, "김민수 양도세 계산서 발송", ago(1), { client_id: kim });
  task(tax, "카페 온도 기장 제안서", addDays(t, 10), { client_id: cafe, priority: 3 });
  task(saas, "Acme 갱신 계약서 초안", addDays(t, 4), { client_id: acme, priority: 1 });
  task(saas, "AWS 예약 인스턴스 검토", addDays(t, 20), { recurrence: "quarterly" });
  task(saas, "주간 지표 리뷰", addDays(t, 1), { recurrence: "weekly" });

  // 청구서 · 입금
  const inv = (business_id: number, client_id: number, currency: string, issue: string, items: { description: string; quantity: number; unit_price: number }[], tax_rate = 0) =>
    createInvoice(d, { business_id, client_id, issue_date: issue, due_date: addDays(issue, 14), currency, tax_rate, memo: "", items });
  for (let m = 5; m >= 0; m--) {
    const issue = addMonths(t, -m).slice(0, 8) + "05";
    const i = inv(tax, hanbit, "KRW", issue, [{ description: "월 기장 대행", quantity: 1, unit_price: 1_200_000 }], 10);
    setInvoiceStatus(d, i, "sent");
    if (m > 0) addPayment(d, { invoice_id: i, amount: 1_320_000, paid_at: addDays(issue, 7), method: "계좌이체" });
  }
  const kimInv = inv(tax, kim, "KRW", ago(30), [{ description: "양도소득세 신고 대행", quantity: 1, unit_price: 800_000 }], 10);
  setInvoiceStatus(d, kimInv, "sent");
  inv(tax, cafe, "KRW", t, [{ description: "기장 대행 (연간)", quantity: 12, unit_price: 200_000 }], 10);

  for (let m = 5; m >= 0; m--) {
    const issue = addMonths(t, -m).slice(0, 8) + "01";
    const i = inv(saas, acme, "USD", issue, [{ description: "Ledgerly Business plan", quantity: 40, unit_price: 2_900 }]);
    setInvoiceStatus(d, i, "sent");
    if (m > 0) addPayment(d, { invoice_id: i, amount: 116_000, paid_at: addDays(issue, 10), method: "Stripe" });
  }

  for (let m = 5; m >= 0; m--) {
    const day = addMonths(t, -m).slice(0, 8);
    addExpense(d, { business_id: tax, category: "임대료", description: "사무실 월세", amount: 700_000, spent_at: `${day}01` });
    addExpense(d, { business_id: tax, category: "소프트웨어", description: "세무 프로그램 구독", amount: 99_000, spent_at: `${day}03` });
    addExpense(d, { business_id: saas, category: "인프라", description: "AWS", amount: 38_000 + m * 1_500, spent_at: `${day}02` });
    addExpense(d, { business_id: saas, category: "인프라", description: "GCP BigQuery", amount: 9_000, spent_at: `${day}02` });
  }

  // 지식 · 문서
  createNote(d, {
    business_id: tax, client_id: null, pinned: true, tags: "SOP, 부가세",
    title: "부가세 신고 SOP",
    body: `# 부가세 확정신고 절차

1월 25일 · 7월 25일 마감 (예정신고: 4월 · 10월)

## 자료 수집 (D-14)
- [ ] 매출·매입 세금계산서 홈택스 조회
- [ ] 신용카드 매출전표 / 현금영수증
- [ ] 법인카드 사용내역 — 불공제 항목 분류

## 검토 (D-7)
- [ ] 전기 대비 매출 증감 **20% 이상**이면 사유 확인
- [ ] 의제매입세액 공제 대상 확인

## 신고 · 납부 (D-3)
- [ ] 홈택스 전자신고
- [ ] 납부서 고객 발송 → 업무 완료 처리

> 원천세·부가세 업무는 반복 업무로 등록해 두면 완료 시 다음 회차가 자동 생성됩니다.`,
  });
  createNote(d, {
    business_id: null, client_id: null, pinned: false, tags: "템플릿",
    title: "견적서 · 청구서 기본 문구",
    body: "입금 계좌: OO은행 000-000-000000 (예금주)\n\n지급기한 내 입금 부탁드립니다. 문의: hello@example.com",
  });
  createNote(d, {
    business_id: saas, client_id: acme, pinned: false, tags: "영업, 갱신",
    title: "Acme 갱신 협상 메모",
    body: "- 현재 40석, 60석 확장 논의\n- SSO(SAML) 필수 → Q4 로드맵 확인\n- 연 선결제 시 10% 할인 제안 가능",
  });
  createNote(d, {
    business_id: saas, client_id: null, pinned: false, tags: "SOP, 운영",
    title: "장애 대응 런북",
    body: "## 1. 확인\n- 인프라 화면에서 상태 확인\n- AWS 상태 페이지 확인\n\n## 2. 공지\n- 고객 상태 페이지 업데이트\n\n## 3. 사후\n- 포스트모템 문서 작성 (이 지식 베이스에)",
  });

  // 인프라
  const conn = (x: Partial<Parameters<typeof createConnection>[1]> & Pick<Parameters<typeof createConnection>[1], "provider" | "name">) =>
    createConnection(d, {
      business_id: saas, account_ref: "", region: "", console_url: "", health_url: "", credential_env: "",
      monthly_budget: null, currency: "USD", memo: "", ...x,
    });
  const aws = conn({ provider: "aws", name: "production", account_ref: "123456789012", region: "ap-northeast-2", console_url: "https://console.aws.amazon.com", credential_env: "AWS_PROD_ACCESS_KEY", monthly_budget: 40_000 });
  const gcp = conn({ provider: "gcp", name: "analytics", account_ref: "ledgerly-analytics", region: "asia-northeast3", console_url: "https://console.cloud.google.com", monthly_budget: 10_000 });
  const pal = conn({ provider: "palantir", name: "Foundry (파일럿)", account_ref: "example.palantirfoundry.com", credential_env: "PALANTIR_FOUNDRY_TOKEN" });
  const now = new Date();
  for (let h = 12; h >= 0; h--) {
    const at = new Date(now.getTime() - h * 3600_000).toISOString();
    recordCheck(d, { connection_id: aws, status: h === 5 ? "down" : "ok", latency_ms: 80 + h * 3, message: h === 5 ? "HTTP 503" : "HTTP 200", checked_at: at });
    recordCheck(d, { connection_id: gcp, status: "ok", latency_ms: 140, message: "HTTP 200", checked_at: at });
  }
  recordCheck(d, { connection_id: pal, status: "degraded", latency_ms: null, message: "헬스 URL 미설정 · 자격증명 PALANTIR_FOUNDRY_TOKEN 미설정", checked_at: now.toISOString() });
  for (let m = 5; m >= 0; m--) {
    upsertCost(d, aws, monthOf(addMonths(t, -m)), 38_000 + m * 1_500);
    upsertCost(d, gcp, monthOf(addMonths(t, -m)), 9_000);
  }
  upsertCost(d, aws, month, 43_200); // 이번 달 예산 초과 예시
})();

console.log(`예시 데이터를 넣었습니다 → ${dbPath()}`);
