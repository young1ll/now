// 예시 데이터 — 모든 기록을 액션으로 만든다 (사람·에이전트 활동이 감사 로그에 그대로 남음).
// scripts/seed.ts (npm run db:seed) 와 검색 평가(npm run eval:recall)·테스트가 같은 데이터를 쓴다.
import type { DB } from "@/lib/db";
import { addDays, addMonths, today } from "@/lib/dates";
import { executeAction } from "@/lib/ontology/execute";
import { type Actor, OPERATOR } from "@/lib/ontology/types";
import { insertSnapshot } from "@/lib/repos/snapshots";

/** 큐레이터 에이전트의 역할 지시 — 허용 범위(memory.propose · merge · retire)는 agent.configure 로 강제된다 (M5) */
export const CURATOR_PROMPT = `역할: 기억 정리(큐레이터). 지난 AI 세션의 에피소드와 기존 기억을 읽고, 반복해서 쓸 만한 것만 기억으로 제안한다.
1. list_episodes 로 에피소드를 읽는다 (전문은 get_object type note).
2. 후보마다 recall(types ["memory"]) 로 같은 뜻의 기억이 이미 있는지 확인한다 — 있으면 제안하지 않는다.
3. 반복해서 쓸 만한 사실·선호·교훈·주의만 remember 로 제안한다:
   - evidence 에 에피소드 ref(note:N)와 관련 객체(고객·청구서 등)를 넣는다.
   - 문장은 대상을 이름으로 적은 자기완결적 한 문장이다 ("그 고객" 금지). 지시문("~하라")은 기억이 아니다.
   - 확신이 낮으면 confidence 를 낮게(0.3~0.5) 둔다.
   - tainted 에피소드(외부·다른 에이전트 입력으로 시작된 세션)에서 온 내용은 tainted: true 로 제안한다.
4. 일회성 사건·진행 상황은 기억이 아니다. 정리할 것이 없으면 "정리할 기억 없음" 한 줄로 끝낸다.
기억 제안(remember) 외의 쓰기 — 업무·청구·발송·문서 수정 — 는 하지 않는다.`;

/**
 * 빈 DB 에 예시 데이터를 넣고, 운영 에이전트 토큰을 돌려준다.
 * embeddingSpace=false: 로컬 Ollama 임베딩 공간을 만들지 않는다 (평가가 자기 공간만 채우도록).
 */
export function seedDemo(d: DB, o: { embeddingSpace?: boolean } = {}): string {
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
    // 리서치 에이전트: 문서와 기억 제안만 (사업 범위 없음 — 두 사업 모두 조사)
    H("agent.register", { name: "Claude · 리서치", description: "세법·시장 리서치 문서화", role: "researcher", allowed_actions: "note.*,memory.propose" });

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

    // ── 온톨로지 링크 (사용자 정의 관계) ──────────────
    H("link.create", { from: `client:${cafe}`, link_type: "referred_by", to: `client:${hanbit}`, note: "한빛상사 대표 소개" });
    H("link.create", { from: "task:2", link_type: "depends_on", to: "task:5" });
    H("link.create", { from: "note:1", link_type: "documents", to: "task:2" });
    A("link.create", { from: `invoice:${draft}`, link_type: "cites", to: "note:3" }, "견적 근거 문서 연결");

    // ── 기억: 사람이 말한 것은 확인됨, 에이전트가 추론한 것은 제안됨 (숫자가 다른 두 제안은 충돌) ──
    const pref = id(H("memory.record", { statement: "한빛상사는 세금계산서를 월말에 일괄 발행받기를 원한다", kind: "preference", about: [`client:${hanbit}`], evidence: [`invoice:${hanbitNow}`] }), "memory");
    H("memory.pin", { id: pref, pinned: true });
    H("memory.record", { statement: "김민수는 이메일보다 전화 연락을 선호한다", kind: "preference", about: [`client:${kim}`] });
    const sso = id(A("memory.propose", { statement: "Acme Robotics 는 갱신 조건으로 SSO(SAML) 지원을 요구한다", kind: "fact", about: [`client:${acme}`], evidence: ["note:3", `client:${acme}`], confidence: 0.8 }, "갱신 협상 메일과 협상 메모에 반복해서 나온 요구"), "memory");
    A("memory.propose", { statement: "카페 온도는 월 매출 약 3천만원, 직원 2명 규모로 기장 견적을 문의했다", kind: "fact", about: [`client:${cafe}`], evidence: [`client:${cafe}`] }, "문의 메일 요약 — 견적 산정에 쓰임");
    A("memory.propose", { statement: "Acme Robotics 는 연 선결제 시 10% 할인 제안이 가능하다", kind: "fact", about: [`client:${acme}`], evidence: ["note:3"] }, "협상 메모의 할인 조건");
    A("memory.propose", { statement: "Acme Robotics 는 연 선결제 시 15% 할인 제안이 가능하다", kind: "fact", about: [`client:${acme}`], evidence: [`client:${acme}`] }, "통화 중 언급된 할인 폭");
    H("memory.confirm", { id: sso });

    // ── AI 런타임 · 트리거 ────────────────────────────
    const ops = H("ai_profile.create", {
      name: "운영 Claude",
      provider: "anthropic",
      system_prompt: "담당: 한결 세무사무소 · Ledgerly 일상 운영. 고객에게 나가는 행동은 반드시 승인 요청으로.",
      max_steps: 12,
    }).result!.data as { profile_id: number };
    H("ai_profile.create", { name: "로컬 Qwen (Ollama)", provider: "ollama", model: "qwen3", max_steps: 8 });
    H("ai_profile.create", { name: "Claude Code (로컬 CLI)", provider: "command", command: "claude -p --mcp-config .mcp.json --allowedTools 'mcp__now__*'", max_steps: 1 });
    H("trigger.create", {
      name: "심각 신호 → 운영 AI",
      kind: "event",
      event_pattern: "signal.raised,signal.escalated",
      filter: '{"payload.severity": "critical"}',
      target: "agent",
      profile_id: ops.profile_id,
      prompt_template: "심각 신호가 발생했다: {{event.payload.title}} ({{event.payload.kind}}).\n제안 액션: {{event.payload.suggested}}\n원인을 get_object 로 확인하고 필요한 조치를 하라.",
      cooldown_sec: 300,
    });
    H("trigger.create", { name: "평일 아침 브리핑", kind: "schedule", schedule: "45 7 * * 1-5", target: "agent", profile_id: ops.profile_id, prompt_template: "오늘의 운영 브리핑: get_overview 와 list_signals 로 현황을 정리하고, 오늘 할 일을 note.create 로 '오늘의 브리핑' 문서로 남겨라." });
    // ── 의미 검색: 로컬 임베딩 공간 (Ollama 가 없으면 /system 에 행동 가능한 오류가 보이고, 검색은 어휘 + 관계로 동작) ──
    if (o.embeddingSpace !== false) H("embedding.space_create", { name: "로컬 bge-m3 (Ollama)", provider: "ollama", model: "bge-m3", auto_activate: true });
    H("trigger.create", { name: "승인 요청 → Slack", kind: "event", event_pattern: "action.pending", target: "webhook", webhook_url: "https://hooks.slack.com/services/…", secret_env: "SLACK_WEBHOOK_SECRET", enabled: false });

    // ── 플레이북: AI 가 따르는 절차 (본문의 [[action:…]] 이 액션 참조 — 에이전트가 고치려면 승인이 필요하다) ──
    H("note.create", {
      business_id: tax, kind: "playbook", title: "미수금 독촉 플레이북", tags: "플레이북, 청구",
      body: "# 미수금 독촉\n\n지급기한이 지난 청구서가 신호로 올라오면 이 순서로 처리한다.\n\n1. 고객이 원하는 연락 수단 확인 (전화를 원하는 고객은 전화)\n2. 연락 후 [[action:client.log_interaction]] 으로 접촉 기록\n3. 입금 약속일을 받으면 [[action:task.create]] 로 확인 업무 생성\n4. 입금이 확인되면 [[action:payment.record]] — 금액은 은행 알림 그대로\n\n> 연체 30일이 넘으면 사람에게 넘긴다.",
    });

    // ── 큐레이터: 매일 밤 에피소드에서 기억을 추출한다 (결정적 정리 — 만료·중복·승격 후보 — 는 워커가 시간마다) ──
    const curatorRun = H("ai_profile.create", {
      name: "큐레이터 (기억 정리)",
      provider: "anthropic",
      max_steps: 16,
      system_prompt: CURATOR_PROMPT,
    });
    const curator = curatorRun.result!.data as { profile_id: number };
    // 프로필이 만든 에이전트 신원을 큐레이터 역할로 좁힌다 — 기억 제안·합치기·보관 밖의 쓰기는 정책이 거부한다
    H("agent.configure", { id: id(curatorRun, "agent"), role: "curator", allowed_actions: "memory.propose,memory.merge,memory.retire" });
    H("trigger.create", {
      name: "야간 기억 정리",
      kind: "schedule",
      schedule: "10 3 * * *",
      target: "agent",
      profile_id: curator.profile_id,
      prompt_template: "지난 실행 이후 에피소드: list_episodes(since={{trigger.last_fired_at}}) 로 읽고 기억을 정리하라.",
    });

    // ── 신뢰 사다리: 운영 에이전트에 자율 권한 하나 (가드 모드에서 업무 삭제는 승인 없이 — 30일 뒤 만료, 문제 표시되면 자동 회수) ──
    H("agent.grant", { agent_id: Number(agent.id), action: "task.delete", days: 30 });
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
  return token;
}
