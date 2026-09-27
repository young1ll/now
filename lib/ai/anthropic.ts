// Claude — 공식 SDK(@anthropic-ai/sdk) 로 수동 tool-use 루프.
import Anthropic from "@anthropic-ai/sdk";
import { type AdapterInit, type ChatAdapter, ProviderError, type StepResult, type ToolResult } from "./types";

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5";

/** adaptive thinking 을 받는 세대 (4.6 이상). Haiku 4.5 등은 thinking 파라미터 생략. */
function supportsAdaptive(model: string) {
  return /^claude-(opus|sonnet|fable|mythos)-(5|4-[6-9])/.test(model);
}

/** 서버 측 거부 대체(fallbacks: "default") — Claude API 직통일 때만 (프록시 base URL 제외) */
function supportsFallbacks(model: string, baseUrl?: string) {
  return !baseUrl && /^claude-(opus-5|fable-5)/.test(model);
}

export class AnthropicAdapter implements ChatAdapter {
  private client: Anthropic;
  private messages: Anthropic.Beta.BetaMessageParam[];
  private tools: Anthropic.Beta.BetaTool[];

  constructor(private init: AdapterInit) {
    this.client = new Anthropic({
      apiKey: init.apiKey,
      baseURL: init.baseUrl || undefined,
      fetch: init.fetchImpl,
      maxRetries: 2,
    });
    this.messages = [{ role: "user", content: init.prompt }];
    this.tools = init.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.schema as Anthropic.Beta.BetaTool.InputSchema,
    }));
  }

  async step(): Promise<StepResult> {
    const { model } = this.init;
    const fallback = supportsFallbacks(model, this.init.baseUrl);
    const params = {
      model,
      max_tokens: 16000,
      system: this.init.system,
      tools: this.tools,
      messages: this.messages,
      ...(supportsAdaptive(model) ? { thinking: { type: "adaptive" as const } } : {}),
      ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
    };
    const res = (await this.client.beta.messages.create(params as Anthropic.Beta.MessageCreateParamsNonStreaming)) as Anthropic.Beta.BetaMessage;
    if (res.stop_reason === "refusal") throw new ProviderError("모델이 요청을 거부했습니다 (refusal)");
    // thinking 블록 등 응답 전체를 그대로 이어 붙인다 (다음 요청에서 필요)
    this.messages.push({ role: "assistant", content: res.content as Anthropic.Beta.BetaContentBlockParam[] });
    const text = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n");
    const toolCalls = res.content
      .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, args: b.input }));
    return {
      text,
      toolCalls,
      again: res.stop_reason === "pause_turn",
      usage: { input: res.usage.input_tokens, output: res.usage.output_tokens },
    };
  }

  addToolResults(results: ToolResult[]) {
    // 병렬 호출 결과는 하나의 user 메시지로
    this.messages.push({
      role: "user",
      content: results.map((r) => ({ type: "tool_result" as const, tool_use_id: r.id, content: r.content, is_error: r.isError })),
    });
  }
}
