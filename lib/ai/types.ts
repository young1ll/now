export type ToolSpec = { name: string; description: string; schema: Record<string, unknown> };
export type ToolCall = { id: string; name: string; args: unknown; parseError?: string };
export type ToolResult = { id: string; name: string; content: string; isError: boolean };

export type StepResult = {
  text: string;
  toolCalls: ToolCall[];
  /** 서버가 턴을 멈췄을 뿐이라 같은 대화로 다시 호출해야 함 (Anthropic pause_turn) */
  again?: boolean;
  usage?: { input?: number; output?: number };
};

/** 공급자별 대화 상태를 내부에 들고 한 단계씩 진행하는 어댑터 (네이티브 메시지 형식 보존) */
export interface ChatAdapter {
  step(): Promise<StepResult>;
  addToolResults(results: ToolResult[]): void;
}

export type AdapterInit = {
  model: string;
  system: string;
  prompt: string;
  tools: ToolSpec[];
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

export class ProviderError extends Error {}
