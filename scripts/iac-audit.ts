// IaC 현행 감사: 실제 인프라 상태와 코드(infra/)의 차이를 기록한다.
//   npm run iac:audit            → 로컬 DB(NOW_DB_PATH)에 직접 기록
//   NOW_URL=http://127.0.0.1:3000 NOW_AGENT_TOKEN=now_… npm run iac:audit
//                                → 배포된 앱에 API 로 전송 (컨테이너 볼륨 안의 DB 에 기록됨)
// 종료 코드: 0 일치 · 2 드리프트 · 1 오류 (cron/CI 에서 그대로 사용 가능)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { parseChanges, parseState } from "@/lib/iac";
import { type IacChange, type IacResource, type Snapshot, insertSnapshot } from "@/lib/repos/snapshots";

const dir = path.resolve(process.env.NOW_IAC_DIR ?? "infra");
const captured_at = new Date().toISOString();

type Result = { status: Snapshot["status"]; message: string; resources: IacResource[]; changes: IacChange[] };

function findTool(): string | undefined {
  const candidates = [process.env.NOW_IAC_BIN, "tofu", "terraform"].filter(Boolean) as string[];
  return candidates.find((c) => spawnSync(c, ["version"], { stdio: "ignore" }).status === 0);
}

function audit(tool: string | undefined): Result {
  const fail = (message: string, resources: IacResource[] = []): Result => ({ status: "error", message, resources, changes: [] });
  if (!tool) return fail("tofu 또는 terraform 을 찾을 수 없습니다 (NOW_IAC_BIN 으로 지정 가능)");
  if (!fs.existsSync(path.join(dir, ".terraform"))) return fail(`${dir} 에서 먼저 '${tool} init' 을 실행하세요`);

  const tf = (args: string[]) => spawnSync(tool, [`-chdir=${dir}`, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const lastLine = (s: string) => s.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";

  const state = tf(["show", "-json"]);
  if (state.status !== 0) return fail(`state 조회 실패: ${lastLine(state.stderr)}`);
  const resources = parseState(JSON.parse(state.stdout || "{}"));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "now-iac-"));
  try {
    const planFile = path.join(tmp, "audit.tfplan");
    const plan = tf(["plan", "-input=false", "-lock=false", "-refresh=true", "-detailed-exitcode", `-out=${planFile}`, "-no-color"]);
    if (plan.status !== 0 && plan.status !== 2) return fail(`plan 실패: ${lastLine(plan.stderr || plan.stdout)}`, resources);
    if (plan.status === 0) return { status: "in_sync", message: "", resources, changes: [] };
    const shown = tf(["show", "-json", planFile]);
    if (shown.status !== 0) return fail(`plan 해석 실패: ${lastLine(shown.stderr)}`, resources);
    const changes = parseChanges(JSON.parse(shown.stdout));
    if (changes.length === 0) return { status: "in_sync", message: "출력값만 다름", resources, changes };
    return {
      status: "drift",
      message: resources.length === 0 ? "아직 배포(apply)되지 않았습니다" : "코드와 실제 인프라가 다릅니다",
      resources,
      changes,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const tool = findTool();
  const r = audit(tool);
  const snap = { captured_at, tool: tool ? path.basename(tool) : "none", ...r };

  console.log(`[iac:audit] ${r.status} · 리소스 ${r.resources.length} · 변경 ${r.changes.length}${r.message ? ` · ${r.message}` : ""}`);
  for (const c of r.changes) console.log(`  ${c.actions.join("/")}\t${c.address}`);

  const url = process.env.NOW_URL;
  if (url) {
    const res = await fetch(`${url.replace(/\/$/, "")}/api/v1/iac/snapshots`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.NOW_AGENT_TOKEN ?? ""}` },
      body: JSON.stringify(snap),
    });
    if (!res.ok) throw new Error(`전송 실패 ${res.status}: ${await res.text()}`);
    console.log(`[iac:audit] → ${url} 에 기록`);
  } else {
    insertSnapshot(db(), snap);
  }
  return r.status === "in_sync" ? 0 : r.status === "drift" ? 2 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`[iac:audit] ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  },
);
