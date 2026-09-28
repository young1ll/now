// AI 세션 실행: 프로필(공급자·모델)로 에이전트 루프를 돌리고, 도구 호출은 에이전트 신원으로 같은 관문을 지난다.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DB } from "@/lib/db";
import { INSTRUCTIONS } from "@/lib/agent/mcp";
import { TOOLS, ToolError, callTool, toolJsonSchema } from "@/lib/agent/tools";
import type { Actor } from "@/lib/ontology/types";
import { getAgent } from "@/lib/repos/agents";
import {
  type AiProfile, type TranscriptEntry, claimSession, getProfile, getSession, issueSessionToken, revokeSessionToken, saveSession,
} from "@/lib/repos/ai";
import { makeAdapter } from "./providers";
import type { ToolResult } from "./types";

export type RunOpts = { fetchImpl?: typeof fetch; env?: Record<string, string | undefined>; publicUrl?: string };

const MAX_RESULT = 12_000;
const clip = (s: string, n = MAX_RESULT) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n}자 생략)` : s);

export function systemPrompt(p: AiProfile) {
  return [INSTRUCTIONS, p.system_prompt.trim()].filter(Boolean).join("\n\n");
}

/** 큐에 있는 세션 하나를 실행한다. 다른 프로세스가 이미 가져갔으면 아무것도 하지 않는다. */
export async function executeSession(db: DB, sessionId: number, opts: RunOpts = {}): Promise<void> {
  if (!claimSession(db, sessionId)) return;
  const session = getSession(db, sessionId)!;
  const profile = getProfile(db, session.profile_id);
  const transcript: TranscriptEntry[] = [{ role: "user", text: session.prompt }];
  const fail = (error: string) => saveSession(db, sessionId, { status: "failed", error, transcript, finished: true });

  if (!profile) return fail("프로필이 삭제되었습니다");
  if (!profile.enabled) return fail("비활성 프로필입니다");
  const agent = getAgent(db, profile.agent_id);
  if (!agent || agent.status !== "active") return fail("프로필의 에이전트가 정지·폐기 상태입니다");
  const actor: Actor = { type: "agent", id: String(agent.id), name: agent.name };

  if (profile.provider === "command") return runCommand(db, sessionId, profile, agent.id, transcript, opts);

  let steps = 0;
  let toolCalls = 0;
  const usage = { input: 0, output: 0 };
  try {
    const adapter = makeAdapter(
      profile,
      { system: systemPrompt(profile), prompt: session.prompt, tools: TOOLS.map((t) => ({ name: t.name, description: t.description, schema: toolJsonSchema(t) })), fetchImpl: opts.fetchImpl },
      opts.env,
    );
    let finalText = "";
    while (steps < profile.max_steps) {
      // 사람이 도중에 에이전트를 정지·폐기했으면 즉시 멈춘다 (정책도 쓰기를 거부하지만 LLM 호출 자체를 끊는다)
      if (getAgent(db, agent.id)?.status !== "active") {
        saveSession(db, sessionId, { status: "failed", error: "실행 중 에이전트가 정지·폐기되어 중단했습니다", final_text: finalText, transcript, steps, tool_calls: toolCalls, usage, finished: true });
        return;
      }
      steps++;
      const r = await adapter.step();
      usage.input += r.usage?.input ?? 0;
      usage.output += r.usage?.output ?? 0;
      transcript.push({ role: "assistant", text: r.text, ...(r.toolCalls.length ? { tool_calls: r.toolCalls.map(({ id, name, args }) => ({ id, name, args })) } : {}) });
      if (r.text) finalText = r.text;
      saveSession(db, sessionId, { transcript, steps, tool_calls: toolCalls, usage });
      if (r.again) continue;
      if (r.toolCalls.length === 0) {
        saveSession(db, sessionId, { status: "succeeded", final_text: finalText, transcript, steps, tool_calls: toolCalls, usage, finished: true });
        return;
      }
      // 도구는 순서대로 (앞 호출의 쓰기를 뒤 호출이 본다)
      const results: ToolResult[] = [];
      for (const c of r.toolCalls) {
        toolCalls++;
        if (c.parseError) {
          results.push({ id: c.id, name: c.name, content: c.parseError, isError: true });
          continue;
        }
        try {
          results.push({ id: c.id, name: c.name, content: clip(JSON.stringify(await callTool(db, actor, c.name, c.args), null, 1)), isError: false });
        } catch (e) {
          const msg = e instanceof ToolError ? e.message : `내부 오류: ${e instanceof Error ? e.message : String(e)}`;
          results.push({ id: c.id, name: c.name, content: msg, isError: true });
        }
      }
      for (const res of results) transcript.push({ role: "tool", id: res.id, name: res.name, result: res.content, is_error: res.isError });
      adapter.addToolResults(results);
    }
    saveSession(db, sessionId, { status: "failed", error: `최대 단계(${profile.max_steps})에 도달했습니다`, final_text: finalText, transcript, steps, tool_calls: toolCalls, usage, finished: true });
  } catch (e) {
    saveSession(db, sessionId, { status: "failed", error: e instanceof Error ? e.message : String(e), transcript, steps, tool_calls: toolCalls, usage, finished: true });
  }
}

/** 로컬 CLI 에이전트에 넘기는 환경변수 허용 목록 — 서버의 API 키·웹훅 비밀·DB 경로는 넘기지 않는다 */
const PASS_ENV = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "TZ", "TMPDIR", "SHELL"];

export function commandEnv(p: AiProfile, base: Record<string, string | undefined>, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of PASS_ENV) if (base[k]) env[k] = base[k]!;
  // 프로필이 지정한 키 하나만 (예: Claude Code 가 쓸 ANTHROPIC_API_KEY)
  if (p.api_key_env && base[p.api_key_env]) env[p.api_key_env] = base[p.api_key_env]!;
  return { ...env, ...extra };
}

/**
 * 로컬 CLI 에이전트 실행 (Claude Code · Codex · Gemini CLI · aider …).
 * 셸 명령을 서버 권한으로 실행하므로 NOW_ALLOW_COMMAND_PROVIDER=1 일 때만 허용한다.
 * 환경변수는 허용 목록만, 작업 디렉터리는 세션별 임시 폴더, 시간 초과 시 프로세스 그룹 전체 종료.
 * 프롬프트는 stdin, 접속 정보는 NOW_URL · NOW_MCP_URL · NOW_AGENT_TOKEN(세션 동안만 유효한 단기 토큰).
 */
async function runCommand(db: DB, sessionId: number, p: AiProfile, agentId: number, transcript: TranscriptEntry[], opts: RunOpts) {
  const baseEnv = opts.env ?? process.env;
  if (baseEnv.NOW_ALLOW_COMMAND_PROVIDER !== "1" && process.env.NOW_ALLOW_COMMAND_PROVIDER !== "1") {
    saveSession(db, sessionId, { status: "failed", error: "로컬 CLI 에이전트는 NOW_ALLOW_COMMAND_PROVIDER=1 일 때만 실행됩니다 (서버 권한으로 셸을 실행하므로)", transcript, finished: true });
    return;
  }
  if (!p.command.trim()) {
    saveSession(db, sessionId, { status: "failed", error: "명령이 비어 있습니다", transcript, finished: true });
    return;
  }
  const timeoutMs = Number(baseEnv.NOW_COMMAND_TIMEOUT_SEC ?? process.env.NOW_COMMAND_TIMEOUT_SEC ?? 900) * 1000;
  const token = issueSessionToken(db, agentId, Math.ceil(timeoutMs / 1000) + 60);
  const base = opts.publicUrl ?? baseEnv.NOW_PUBLIC_URL ?? process.env.NOW_PUBLIC_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `now-agent-${sessionId}-`));
  const env = commandEnv(p, { ...process.env, ...opts.env }, { NOW_URL: base, NOW_MCP_URL: `${base}/api/mcp`, NOW_AGENT_TOKEN: token, NOW_SESSION_ID: String(sessionId) });
  transcript.push({ role: "system", text: `$ ${p.command}` });
  try {
    const { code, stdout, stderr, timedOut } = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
      const child = spawn("/bin/sh", ["-c", p.command], { env: env as NodeJS.ProcessEnv, cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let done = false;
      const finish = (c: number | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(hard);
        resolve({ code: c, stdout, stderr, timedOut });
      };
      const killGroup = () => {
        try {
          process.kill(-child.pid!, "SIGKILL"); // 셸이 띄운 하위 프로세스까지
        } catch {
          /* 이미 종료 */
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup();
      }, timeoutMs);
      // 하위 프로세스가 출력을 붙잡고 있어도 반드시 끝난다
      const hard = setTimeout(() => finish(null), timeoutMs + 5000);
      child.stdout.on("data", (d) => (stdout = clip(stdout + d, 200_000)));
      child.stderr.on("data", (d) => (stderr = clip(stderr + d, 50_000)));
      child.on("exit", (c) => {
        killGroup(); // 남은 하위 프로세스 정리
        setTimeout(() => finish(c), 200);
      });
      child.on("close", (c) => finish(c));
      child.on("error", (e) => {
        stderr += `\n${e.message}`;
        finish(-1);
      });
      child.stdin.on("error", () => {});
      child.stdin.end(transcript[0].role === "user" ? transcript[0].text : "");
    });
    transcript.push({ role: "assistant", text: clip(stdout) });
    if (stderr.trim()) transcript.push({ role: "system", text: `stderr:\n${clip(stderr, 4000)}` });
    const ok = code === 0 && !timedOut;
    saveSession(db, sessionId, {
      status: ok ? "succeeded" : "failed",
      final_text: stdout.trim().slice(-4000),
      error: ok ? null : timedOut ? `시간 초과 (${timeoutMs / 1000}초)` : `종료 코드 ${code}`,
      transcript,
      steps: 1,
      finished: true,
    });
  } finally {
    revokeSessionToken(db, token);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}
