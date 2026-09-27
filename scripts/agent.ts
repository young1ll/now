// 에이전트 관리 CLI (운영자용)
//   npm run agent -- create "Claude Code (운영)" ["설명"]
//   npm run agent -- list
//   npm run agent -- suspend <id> | resume <id> | revoke <id>
import { db } from "@/lib/db";
import { executeAction } from "@/lib/ontology/execute";
import { OPERATOR } from "@/lib/ontology/types";
import { listAgents } from "@/lib/repos/agents";

const [cmd, ...args] = process.argv.slice(2);
const d = db();

function run(action: string, params: Record<string, unknown>) {
  const r = executeAction(d, { actor: { ...OPERATOR, name: `${OPERATOR.name} (CLI)` }, action, params });
  console.log(r.result?.summary ?? r.status);
  return r;
}

switch (cmd) {
  case "create": {
    if (!args[0]) throw new Error('이름이 필요합니다: npm run agent -- create "이름"');
    const r = run("agent.register", { name: args[0], description: args[1] ?? "" });
    console.log(`\nNOW_AGENT_TOKEN=${r.out?.token}\n\n이 토큰은 다시 표시되지 않습니다.`);
    break;
  }
  case "list":
    for (const a of listAgents(d, new Date(Date.now() - 86_400_000).toISOString())) {
      console.log(`${a.id}\t${a.status}\t${a.token_prefix}…\t${a.name}\t24h 실행 ${a.runs_24h}`);
    }
    break;
  case "suspend":
  case "resume":
  case "revoke":
    run("agent.set_status", { id: Number(args[0]), status: { suspend: "suspended", resume: "active", revoke: "revoked" }[cmd] });
    break;
  default:
    console.error("사용법: npm run agent -- create <이름> [설명] | list | suspend <id> | resume <id> | revoke <id>");
    process.exit(1);
}
