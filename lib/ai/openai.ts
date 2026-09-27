// OpenAI Chat Completions 호환 — OpenAI · OpenRouter · Ollama · LM Studio · vLLM 등.
import { type AdapterInit, type ChatAdapter, ProviderError, type StepResult, type ToolResult } from "./types";

type Msg =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

export class OpenAICompatAdapter implements ChatAdapter {
  private messages: Msg[];

  constructor(
    private init: AdapterInit,
    private extraHeaders: Record<string, string> = {},
  ) {
    if (!init.baseUrl) throw new ProviderError("base URL 이 필요합니다");
    this.messages = [
      { role: "system", content: init.system },
      { role: "user", content: init.prompt },
    ];
  }

  async step(): Promise<StepResult> {
    const f = this.init.fetchImpl ?? fetch;
    const res = await f(`${this.init.baseUrl!.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.init.apiKey ? { authorization: `Bearer ${this.init.apiKey}` } : {}),
        ...this.extraHeaders,
      },
      body: JSON.stringify({
        model: this.init.model,
        messages: this.messages,
        tools: this.init.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } })),
        tool_choice: "auto",
      }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) throw new ProviderError(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const data = (await res.json()) as {
      choices: { message: { content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }; finish_reason: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new ProviderError("응답에 choices 가 없습니다");
    this.messages.push({ role: "assistant", content: msg.content ?? null, ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
    const toolCalls = (msg.tool_calls ?? []).map((c) => {
      try {
        return { id: c.id, name: c.function.name, args: c.function.arguments ? JSON.parse(c.function.arguments) : {} };
      } catch {
        return { id: c.id, name: c.function.name, args: {}, parseError: `인자 JSON 파싱 실패: ${c.function.arguments.slice(0, 200)}` };
      }
    });
    return { text: msg.content ?? "", toolCalls, usage: { input: data.usage?.prompt_tokens, output: data.usage?.completion_tokens } };
  }

  addToolResults(results: ToolResult[]) {
    for (const r of results) this.messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
  }
}
