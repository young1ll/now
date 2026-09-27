import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addInteraction, createClient, listClients } from "@/lib/repos/clients";
import { dashboard } from "@/lib/repos/dashboard";
import {
  addExpense, addPayment, createInvoice, deletePayment, getInvoice, listInvoices,
  monthlyPnl, receivables, setInvoiceStatus,
} from "@/lib/repos/finance";
import { createConnection, listConnections, recordCheck, upsertCost } from "@/lib/repos/infra";
import { createNote, listNotes, noteTags, updateNote } from "@/lib/repos/notes";
import { createTask, dueTasks, listTasks, nextDueDate, setTaskStatus } from "@/lib/repos/tasks";
import { freshDb } from "./helpers";

const client = (business_id: number, name: string, status: "lead" | "active" = "active") => ({
  business_id, name, kind: "company" as const, status, email: "", phone: "", tags: "", memo: "",
});

describe("CRM", () => {
  it("사업 범위로 고객을 분리하고 마지막 접촉일을 계산한다", () => {
    const { db, a, b } = freshDb();
    const c1 = createClient(db, client(a, "한빛상사"));
    createClient(db, client(b, "Acme Inc", "lead"));
    addInteraction(db, { client_id: c1, kind: "call", summary: "부가세 상담", occurred_at: "2026-09-01" });
    addInteraction(db, { client_id: c1, kind: "meeting", summary: "계약", occurred_at: "2026-09-20" });

    assert.equal(listClients(db, null).length, 2);
    const onlyA = listClients(db, a);
    assert.deepEqual(onlyA.map((c) => c.name), ["한빛상사"]);
    assert.equal(onlyA[0].last_contact, "2026-09-20");
    assert.equal(listClients(db, null, { q: "acme" }).length, 1);
    assert.equal(listClients(db, null, { status: "lead" })[0].name, "Acme Inc");
  });
});

describe("업무", () => {
  it("반복 업무는 완료 시 다음 회차를 생성한다", () => {
    const { db, a } = freshDb();
    const id = createTask(db, {
      business_id: a, client_id: null, title: "부가세 신고", detail: "",
      priority: 1, due_date: "2026-01-25", recurrence: "quarterly",
    });
    const next = setTaskStatus(db, id, "done");
    assert.ok(next);
    const open = listTasks(db, a);
    assert.equal(open.length, 1);
    assert.equal(open[0].due_date, "2026-04-25");
    assert.equal(listTasks(db, a, { view: "done" }).length, 1);
    // 이미 완료된 업무를 다시 완료해도 중복 생성하지 않는다
    assert.equal(setTaskStatus(db, id, "done"), null);
  });

  it("nextDueDate", () => {
    assert.equal(nextDueDate("2026-09-27", "weekly"), "2026-10-04");
    assert.equal(nextDueDate("2026-05-31", "yearly"), "2027-05-31");
    assert.equal(nextDueDate("2026-05-31", "none"), null);
    assert.equal(nextDueDate(null, "monthly"), null);
  });

  it("dueTasks 는 지난 마감을 포함하고 마감 없는 업무는 제외한다", () => {
    const { db, a } = freshDb();
    const base = { business_id: a, client_id: null, detail: "", priority: 2 as const, recurrence: "none" as const };
    createTask(db, { ...base, title: "지난 것", due_date: "2026-09-01" });
    createTask(db, { ...base, title: "이번 주", due_date: "2026-09-30" });
    createTask(db, { ...base, title: "먼 미래", due_date: "2026-12-31" });
    createTask(db, { ...base, title: "마감 없음", due_date: null });
    assert.deepEqual(dueTasks(db, a, "2026-10-04").map((t) => t.title), ["지난 것", "이번 주"]);
  });
});

describe("매출 · 청구 · 정산", () => {
  it("청구서 합계·부가세·일련번호·입금에 따른 상태 전환", () => {
    const { db, a } = freshDb();
    const c = createClient(db, client(a, "한빛상사"));
    const input = {
      business_id: a, client_id: c, issue_date: "2026-09-01", due_date: "2026-09-15",
      currency: "KRW", tax_rate: 10, memo: "",
      items: [
        { description: "기장 대행 (9월)", quantity: 1, unit_price: 300_000 },
        { description: "조정료", quantity: 2, unit_price: 100_000 },
      ],
    };
    const id = createInvoice(db, input);
    const id2 = createInvoice(db, input);
    const inv = getInvoice(db, id)!.invoice;
    assert.equal(inv.number, "2026-001");
    assert.equal(getInvoice(db, id2)!.invoice.number, "2026-002");
    assert.equal(inv.subtotal, 500_000);
    assert.equal(inv.tax, 50_000);
    assert.equal(inv.total, 550_000);

    setInvoiceStatus(db, id, "sent");
    assert.equal(receivables(db, a, "2026-09-20")[0].overdue, true);

    const p1 = addPayment(db, { invoice_id: id, amount: 300_000, paid_at: "2026-09-10", method: "계좌이체" });
    assert.equal(getInvoice(db, id)!.invoice.status, "sent");
    addPayment(db, { invoice_id: id, amount: 250_000, paid_at: "2026-09-18", method: "계좌이체" });
    assert.equal(getInvoice(db, id)!.invoice.status, "paid");
    assert.equal(receivables(db, a).length, 0);

    deletePayment(db, p1);
    assert.equal(getInvoice(db, id)!.invoice.status, "sent");
    assert.equal(getInvoice(db, id)!.invoice.balance, 300_000);
    // draft 청구서는 입금이 있어도 상태를 바꾸지 않는다
    addPayment(db, { invoice_id: id2, amount: 550_000, paid_at: "2026-09-18", method: "" });
    assert.equal(getInvoice(db, id2)!.invoice.status, "draft");
    // …발행하는 순간 잔액이 0 이면 바로 paid
    setInvoiceStatus(db, id2, "sent");
    assert.equal(getInvoice(db, id2)!.invoice.status, "paid");
  });

  it("월별 손익은 통화별로 분리 집계한다", () => {
    const { db, a, b } = freshDb();
    const i1 = createInvoice(db, {
      business_id: a, client_id: null, issue_date: "2026-09-01", due_date: null, currency: "KRW",
      tax_rate: 0, memo: "", items: [{ description: "x", quantity: 1, unit_price: 1_000_000 }],
    });
    const i2 = createInvoice(db, {
      business_id: b, client_id: null, issue_date: "2026-09-01", due_date: null, currency: "USD",
      tax_rate: 0, memo: "", items: [{ description: "sub", quantity: 1, unit_price: 4900 }],
    });
    addPayment(db, { invoice_id: i1, amount: 1_000_000, paid_at: "2026-09-05", method: "" });
    addPayment(db, { invoice_id: i2, amount: 4900, paid_at: "2026-09-06", method: "" });
    addExpense(db, { business_id: a, category: "임대료", description: "사무실", amount: 400_000, spent_at: "2026-09-01" });
    addExpense(db, { business_id: b, category: "인프라", description: "AWS", amount: 1200, spent_at: "2026-09-02" });

    const all = monthlyPnl(db, null, ["2026-08", "2026-09"]);
    const krw = all.find((r) => r.currency === "KRW" && r.month === "2026-09")!;
    const usd = all.find((r) => r.currency === "USD" && r.month === "2026-09")!;
    assert.deepEqual([krw.income, krw.expense, krw.net], [1_000_000, 400_000, 600_000]);
    assert.deepEqual([usd.income, usd.expense, usd.net], [4900, 1200, 3700]);
    assert.equal(all.find((r) => r.currency === "KRW" && r.month === "2026-08")!.net, 0);
    assert.equal(monthlyPnl(db, a, ["2026-09"]).length, 1);
    assert.equal(listInvoices(db, b).length, 1);
  });
});

describe("지식 · 문서", () => {
  it("전문 검색(3자 이상 FTS, 짧은 검색어 LIKE)과 공용 노트", () => {
    const { db, a, b } = freshDb();
    createNote(db, { business_id: a, client_id: null, title: "종합소득세 신고 체크리스트", body: "5월 마감", tags: "세무, 체크리스트", pinned: true });
    const n2 = createNote(db, { business_id: b, client_id: null, title: "배포 절차", body: "blue/green deploy", tags: "운영", pinned: false });
    createNote(db, { business_id: null, client_id: null, title: "공용 템플릿", body: "견적서 문구", tags: "템플릿", pinned: false });

    assert.equal(listNotes(db, null, { q: "소득세" }).length, 1);
    assert.equal(listNotes(db, null, { q: "배포" }).length, 1); // 2글자 → LIKE
    assert.equal(listNotes(db, null, { q: "deploy" })[0].title, "배포 절차");
    assert.deepEqual(listNotes(db, a).map((n) => n.title), ["종합소득세 신고 체크리스트", "공용 템플릿"]);
    assert.equal(listNotes(db, null, { tag: "체크리스트" }).length, 1);
    assert.ok(noteTags(db, null).includes("세무"));

    updateNote(db, n2, { business_id: b, client_id: null, title: "릴리스 절차", body: "canary", tags: "운영", pinned: false });
    assert.equal(listNotes(db, null, { q: "deploy" }).length, 0);
    assert.equal(listNotes(db, null, { q: "canary" }).length, 1);
  });
});

describe("인프라 · 대시보드", () => {
  it("최근 점검 상태와 예산 초과를 집계한다", () => {
    const { db, a } = freshDb();
    const base = {
      business_id: a, account_ref: "", region: "", console_url: "", health_url: "",
      credential_env: "", currency: "USD", memo: "",
    };
    const aws = createConnection(db, { ...base, provider: "aws", name: "prod", monthly_budget: 10_000 });
    const gcp = createConnection(db, { ...base, provider: "gcp", name: "data", monthly_budget: null, business_id: null });
    recordCheck(db, { connection_id: aws, status: "down", latency_ms: null, message: "", checked_at: "2026-09-27T00:00:00Z" });
    recordCheck(db, { connection_id: aws, status: "ok", latency_ms: 120, message: "", checked_at: "2026-09-27T01:00:00Z" });
    recordCheck(db, { connection_id: gcp, status: "degraded", latency_ms: 90, message: "", checked_at: "2026-09-27T01:00:00Z" });
    upsertCost(db, aws, "2026-09", 8_000);
    upsertCost(db, aws, "2026-09", 12_500); // 덮어쓰기

    const rows = listConnections(db, a, "2026-09");
    assert.equal(rows.length, 2); // 공용 연결 포함
    assert.equal(rows.find((r) => r.id === aws)!.last_status, "ok");
    assert.equal(rows.find((r) => r.id === aws)!.month_cost, 12_500);

    const d = dashboard(db, a, "2026-09-27");
    assert.deepEqual(d.infra.counts, { ok: 1, issues: 1, unchecked: 0 });
    assert.equal(d.infra.overBudget.length, 1);
    assert.deepEqual(d.infra.cost, [{ currency: "USD", amount: 12_500 }]);
  });
});
