// MCP stdio 서버 — Claude Code / Claude Desktop 이 로컬 프로세스로 실행한다.
//   NOW_AGENT_TOKEN=now_xxx npx tsx scripts/mcp-stdio.ts
// stdout 은 프로토콜 전용. 로그는 stderr 로만.
import readline from "node:readline";
import { authenticate } from "@/lib/agent/auth";
import { type JsonRpcRequest, handleMcp } from "@/lib/agent/mcp";
import { db, dbPath } from "@/lib/db";

const auth = authenticate(db(), `Bearer ${process.env.NOW_AGENT_TOKEN ?? ""}`);
if (!auth.ok) {
  console.error(`[now-mcp] ${auth.error} (NOW_AGENT_TOKEN 확인)`);
  process.exit(1);
}
console.error(`[now-mcp] ${auth.actor.name} 로 연결 · DB ${dbPath()}`);

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg: JsonRpcRequest | JsonRpcRequest[];
  try {
    msg = JSON.parse(line);
  } catch {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
    return;
  }
  // 요청마다 재인증 — 콘솔에서 정지·폐기하면 즉시 끊긴다
  const again = authenticate(db(), `Bearer ${process.env.NOW_AGENT_TOKEN ?? ""}`);
  const batch = Array.isArray(msg) ? msg : [msg];
  const out = batch
    .map((m) =>
      again.ok
        ? handleMcp(db(), again.actor, m)
        : m.id === undefined
          ? null
          : { jsonrpc: "2.0" as const, id: m.id, error: { code: -32001, message: again.error } },
    )
    .filter((r) => r !== null);
  if (out.length) process.stdout.write(JSON.stringify(Array.isArray(msg) ? out : out[0]) + "\n");
});
