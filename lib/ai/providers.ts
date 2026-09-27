import { AnthropicAdapter, DEFAULT_CLAUDE_MODEL } from "./anthropic";
import { GeminiAdapter } from "./gemini";
import { OpenAICompatAdapter } from "./openai";
import { type AdapterInit, type ChatAdapter, ProviderError } from "./types";
import type { AiProfile, Provider } from "@/lib/repos/ai";

export const PROVIDER_INFO: Record<Provider, { label: string; defaultModel: string; defaultBaseUrl: string; keyEnv: string; local: boolean; note: string }> = {
  anthropic: { label: "Anthropic Claude", defaultModel: DEFAULT_CLAUDE_MODEL, defaultBaseUrl: "", keyEnv: "ANTHROPIC_API_KEY", local: false, note: "공식 SDK · adaptive thinking · 거부 시 서버 측 대체(fallbacks)" },
  openai: { label: "OpenAI", defaultModel: "gpt-5", defaultBaseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", local: false, note: "Chat Completions + function calling" },
  gemini: { label: "Google Gemini", defaultModel: "gemini-2.5-pro", defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta", keyEnv: "GEMINI_API_KEY", local: false, note: "generateContent + functionDeclarations" },
  openrouter: { label: "OpenRouter", defaultModel: "anthropic/claude-opus-5", defaultBaseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", local: false, note: "OpenAI 호환 · 수백 개 모델 라우팅" },
  ollama: { label: "Ollama (로컬)", defaultModel: "qwen3", defaultBaseUrl: "http://127.0.0.1:11434/v1", keyEnv: "", local: true, note: "로컬 모델 · tool calling 지원 모델 필요" },
  openai_compatible: { label: "OpenAI 호환 (LM Studio · vLLM · llama.cpp …)", defaultModel: "", defaultBaseUrl: "http://127.0.0.1:1234/v1", keyEnv: "", local: true, note: "임의의 /chat/completions 엔드포인트" },
  command: { label: "로컬 CLI 에이전트 (Claude Code · Codex · Gemini CLI …)", defaultModel: "", defaultBaseUrl: "", keyEnv: "", local: true, note: "명령을 실행하고 프롬프트를 stdin 으로 전달. MCP/CLI 로 이 OS 에 접속" },
};

export function makeAdapter(p: AiProfile, init: Omit<AdapterInit, "model" | "apiKey" | "baseUrl">, env: Record<string, string | undefined> = process.env): ChatAdapter {
  const info = PROVIDER_INFO[p.provider];
  const keyEnv = p.api_key_env || info.keyEnv;
  const apiKey = keyEnv ? env[keyEnv] : undefined;
  if (!info.local && !apiKey) throw new ProviderError(`API 키 환경변수 ${keyEnv} 가 설정되지 않았습니다`);
  const common = { ...init, model: p.model || info.defaultModel, apiKey, baseUrl: p.base_url || info.defaultBaseUrl || undefined };
  if (!common.model) throw new ProviderError("모델을 지정하세요");
  switch (p.provider) {
    case "anthropic":
      return new AnthropicAdapter({ ...common, baseUrl: p.base_url || undefined });
    case "gemini":
      return new GeminiAdapter(common);
    case "openrouter":
      return new OpenAICompatAdapter(common, { "X-Title": "Now Business OS" });
    case "openai":
    case "ollama":
    case "openai_compatible":
      return new OpenAICompatAdapter(common);
    default:
      throw new ProviderError(`${p.provider} 는 대화 어댑터가 아닙니다`);
  }
}
