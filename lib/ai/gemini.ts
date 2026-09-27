// Google Gemini — generateContent + functionDeclarations.
import { type AdapterInit, type ChatAdapter, ProviderError, type StepResult, type ToolResult } from "./types";

type Part = { text?: string; functionCall?: { id?: string; name: string; args?: Record<string, unknown> }; functionResponse?: unknown; thoughtSignature?: string; thought?: boolean };
type Content = { role: "user" | "model"; parts: Part[] };

const KEEP = new Set(["type", "description", "properties", "required", "items", "enum", "nullable", "minimum", "maximum", "format", "minItems", "maxItems"]);

/** JSON Schema → Gemini 가 받는 OpenAPI 부분집합 */
export function toGeminiSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(toGeminiSchema);
  if (!s || typeof s !== "object") return s;
  const src = { ...(s as Record<string, unknown>) };
  // anyOf [X, {type:null}] → X + nullable
  if (Array.isArray(src.anyOf)) {
    const opts = src.anyOf as Record<string, unknown>[];
    const nonNull = opts.filter((o) => o.type !== "null");
    const merged = { ...(nonNull[0] ?? {}), ...(opts.length > nonNull.length ? { nullable: true } : {}), ...(src.description ? { description: src.description } : {}) };
    return toGeminiSchema(merged);
  }
  if (Array.isArray(src.type)) {
    const types = src.type as string[];
    src.type = types.find((t) => t !== "null") ?? "string";
    if (types.includes("null")) src.nullable = true;
  }
  if (src.exclusiveMinimum !== undefined && src.minimum === undefined) src.minimum = src.exclusiveMinimum;
  if (src.const !== undefined) src.enum = [src.const];
  if (src.format && !["date-time", "enum"].includes(String(src.format))) delete src.format;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (!KEEP.has(k)) continue;
    if (k === "properties" && v && typeof v === "object") {
      out.properties = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
    } else if (k === "items") out.items = toGeminiSchema(v);
    else if (k === "enum") out.enum = (v as unknown[]).map(String);
    else out[k] = v;
  }
  if (typeof out.type === "string") out.type = (out.type as string).toUpperCase();
  return out;
}

export class GeminiAdapter implements ChatAdapter {
  private contents: Content[];
  private base: string;

  constructor(private init: AdapterInit) {
    this.base = (init.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
    this.contents = [{ role: "user", parts: [{ text: init.prompt }] }];
  }

  async step(): Promise<StepResult> {
    const f = this.init.fetchImpl ?? fetch;
    const res = await f(`${this.base}/models/${encodeURIComponent(this.init.model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.init.apiKey ? { "x-goog-api-key": this.init.apiKey } : {}) },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: this.init.system }] },
        contents: this.contents,
        // 전체 JSON Schema 를 그대로 전달 (OpenAPI 부분집합으로 줄이면 run_action.params 같은 자유 객체가 비어 버린다)
        tools: [{ functionDeclarations: this.init.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.schema })) }],
      }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) throw new ProviderError(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const data = (await res.json()) as {
      candidates?: { content?: Content; finishReason?: string }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      promptFeedback?: { blockReason?: string };
    };
    const content = data.candidates?.[0]?.content;
    if (!content) throw new ProviderError(`응답 없음${data.promptFeedback?.blockReason ? ` (차단: ${data.promptFeedback.blockReason})` : ""}`);
    // thoughtSignature 등 파트를 그대로 보존해야 다음 턴이 유효하다
    this.contents.push({ role: "model", parts: content.parts ?? [] });
    const parts = content.parts ?? [];
    const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("\n");
    const toolCalls = parts
      .filter((p) => p.functionCall)
      .map((p, i) => ({ id: p.functionCall!.id ?? `call_${this.contents.length}_${i}`, name: p.functionCall!.name, args: p.functionCall!.args ?? {} }));
    return { text, toolCalls, usage: { input: data.usageMetadata?.promptTokenCount, output: data.usageMetadata?.candidatesTokenCount } };
  }

  addToolResults(results: ToolResult[]) {
    this.contents.push({
      role: "user",
      parts: results.map((r) => {
        let response: unknown;
        try {
          response = { result: JSON.parse(r.content) };
        } catch {
          response = { result: r.content };
        }
        return { functionResponse: { name: r.name, ...(r.id.startsWith("call_") ? {} : { id: r.id }), response: r.isError ? { error: r.content } : response } };
      }),
    });
  }
}
