// 임베딩 공급자 어댑터 — 전부 HTTP. 결과는 L2 정규화된 Float32Array.
// 키는 환경변수에서 호출 시점에 읽고, 오류 메시지·로그에 절대 넣지 않는다 (URL 에도 넣지 않는다 — Gemini 는 헤더).
import type { EmbedProvider, EmbeddingSpace } from "@/lib/repos/embeddings";
import { normalize } from "./vectors";

type Env = Record<string, string | undefined>;
export type EmbedKind = "query" | "passage";
export type Embedder = { embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]> };
export type EmbedderOpts = { fetchImpl?: typeof fetch; env?: Env; timeoutMs?: number };

/**
 * 공급자 오류. outage = 공급자 자체가 응답하지 않음(연결 실패·시간 초과·5xx·429) — 질의 임베딩도 실패할 것이므로
 * recall 은 이 동안 공급자를 부르지 않고 바로 강등한다. 입력·설정 문제(4xx·형식·차원)는 outage 가 아니다.
 */
export class EmbedError extends Error {
  constructor(
    message: string,
    readonly outage: boolean,
  ) {
    super(message);
    this.name = "EmbedError";
  }
}

export const EMBED_PROVIDER_INFO: Record<EmbedProvider, { label: string; baseUrl: string; keyEnv: string; example: string }> = {
  ollama: { label: "Ollama (로컬)", baseUrl: "http://127.0.0.1:11434", keyEnv: "", example: "bge-m3" },
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", example: "text-embedding-3-small" },
  gemini: { label: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", keyEnv: "GEMINI_API_KEY", example: "gemini-embedding-001" },
  voyage: { label: "Voyage AI", baseUrl: "https://api.voyageai.com/v1", keyEnv: "VOYAGE_API_KEY", example: "voyage-3.5" },
  openai_compatible: { label: "OpenAI 호환 (LM Studio · vLLM · llama.cpp · TEI)", baseUrl: "https://api.openai.com/v1", keyEnv: "", example: "bge-m3" },
};

const BATCH = 32;
/** 문서 배치(워커)의 기본 시간 제한. 요청 경로의 질의 임베딩은 훨씬 짧게 쓴다 (embedder.ts QUERY_TIMEOUT_MS). */
const TIMEOUT_MS = 60_000;
/** 한 청크를 공급자에 보낼 때 상한 (카드·구획은 이보다 짧다 — 비정상 입력 방어) */
const MAX_CHARS = 4000;

// ── 로컬 판정 ─────────────────────────────────────────

/** 본문이 이 기기/사설망을 떠나지 않는 주소인가 */
export function isLocalUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  host = host.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "host.docker.internal" || host === "::1") return true;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function defaultBaseUrl(provider: EmbedProvider): string {
  return EMBED_PROVIDER_INFO[provider].baseUrl;
}

/** 외부 API(OpenAI·Gemini·Voyage)는 항상 외부. Ollama·OpenAI 호환은 주소로 판정. */
export function isLocalSpace(provider: EmbedProvider, baseUrl: string): boolean {
  return (provider === "ollama" || provider === "openai_compatible") && isLocalUrl(baseUrl.trim() || defaultBaseUrl(provider));
}

// ── 어댑터 ───────────────────────────────────────────

type SpaceConf = Pick<EmbeddingSpace, "provider" | "model" | "dim" | "base_url" | "api_key_env" | "query_prefix" | "passage_prefix">;

const trimSlash = (u: string) => u.replace(/\/+$/, "");

export function makeEmbedder(space: SpaceConf, o: EmbedderOpts = {}): Embedder {
  const env = o.env ?? process.env;
  const timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
  const doFetch = o.fetchImpl ?? fetch;
  const info = EMBED_PROVIDER_INFO[space.provider];
  const base = trimSlash(space.base_url.trim() || info.baseUrl);
  const keyEnv = space.api_key_env || info.keyEnv;
  const key = keyEnv ? env[keyEnv] : undefined;
  /** 오류 문구에서 키 값을 확실히 지운다 (서버가 요청을 되비추는 경우 대비) */
  const scrub = (s: string) => (key && key.length >= 4 ? s.split(key).join("***") : s);

  async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const secs = `${Math.round(timeoutMs / 100) / 10}초`;
      if (e instanceof Error && e.name === "TimeoutError") {
        // 연결은 됐지만 답이 없다 — 모델 적재 중·과부하. "연결할 수 없다"로 안내하면 원인을 잘못 짚는다
        if (space.provider === "ollama") throw new EmbedError(`Ollama(${base}) 응답 시간 초과 (${secs}) — 모델(${space.model})을 불러오는 중이거나 과부하일 수 있습니다`, true);
        throw new EmbedError(`${info.label}(${new URL(url).host}) 응답 시간 초과 (${secs})`, true);
      }
      const cause = e instanceof Error ? (e.cause as { code?: string; message?: string } | undefined) : undefined;
      const why = e instanceof Error ? `${e.message}${cause ? ` · ${cause.code ?? cause.message}` : ""}` : String(e);
      if (space.provider === "ollama") throw new EmbedError(`Ollama(${base})에 연결할 수 없습니다 — \`ollama pull ${space.model}\` 후 \`ollama serve\` 로 실행하세요 (${scrub(why)})`, true);
      throw new EmbedError(`${info.label}(${new URL(url).host}) 연결 실패: ${scrub(why)}`, true);
    }
    const text = await res.text();
    if (!res.ok) {
      const detail = scrub(text.replace(/\s+/g, " ").slice(0, 200));
      if (space.provider === "ollama" && res.status === 404) throw new Error(`Ollama 에 모델 ${space.model} 이 없습니다 — \`ollama pull ${space.model}\` 을 실행하세요 (${detail})`);
      if (res.status === 401 || res.status === 403) throw new Error(`${info.label} 인증 실패 (HTTP ${res.status}) — 환경변수 ${keyEnv || "(없음)"} 를 확인하세요`);
      throw new EmbedError(`${info.label} 임베딩 HTTP ${res.status}: ${detail}`, res.status >= 500 || res.status === 429);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${info.label} 응답이 JSON 이 아닙니다: ${scrub(text.slice(0, 120))}`);
    }
  }

  const needKey = (required: boolean): Record<string, string> => {
    if (key) return { authorization: `Bearer ${key}` };
    if (required) throw new Error(`${info.label} API 키 환경변수 ${keyEnv || "(이름 없음)"} 가 설정되지 않았습니다`);
    return {};
  };

  const pickData = (j: unknown): number[][] => {
    const data = (j as { data?: { index?: number; embedding: number[] }[] }).data;
    if (!Array.isArray(data)) throw new Error(`${info.label} 응답에 data 가 없습니다`);
    return [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
  };

  async function batch(texts: string[], kind: EmbedKind): Promise<number[][]> {
    switch (space.provider) {
      case "ollama": {
        const j = (await post(`${base}/api/embed`, { model: space.model, input: texts })) as { embeddings?: number[][] };
        if (!Array.isArray(j.embeddings)) throw new Error("Ollama 응답에 embeddings 가 없습니다");
        return j.embeddings;
      }
      case "openai":
      case "openai_compatible":
        return pickData(await post(`${base}/embeddings`, { model: space.model, input: texts }, needKey(space.provider === "openai")));
      case "voyage":
        return pickData(await post(`${base}/embeddings`, { model: space.model, input: texts, input_type: kind === "query" ? "query" : "document" }, needKey(true)));
      case "gemini": {
        if (!key) needKey(true);
        const model = space.model.replace(/^models\//, "");
        const j = (await post(
          `${base}/models/${encodeURIComponent(model)}:batchEmbedContents`,
          { requests: texts.map((text) => ({ model: `models/${model}`, content: { parts: [{ text }] }, taskType: kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT" })) },
          { "x-goog-api-key": key! },
        )) as { embeddings?: { values: number[] }[] };
        if (!Array.isArray(j.embeddings)) throw new Error("Gemini 응답에 embeddings 가 없습니다");
        return j.embeddings.map((e) => e.values);
      }
    }
  }

  return {
    async embed(texts, kind) {
      const prefix = kind === "query" ? space.query_prefix : space.passage_prefix;
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        const part = texts.slice(i, i + BATCH).map((t) => `${prefix}${t}`.slice(0, MAX_CHARS));
        const vecs = await batch(part, kind);
        if (vecs.length !== part.length) throw new Error(`${info.label} 응답 벡터 수 ${vecs.length} ≠ 요청 ${part.length}`);
        for (const v of vecs) {
          if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== "number" || !Number.isFinite(x))) throw new Error(`${info.label} 응답 벡터 형식이 올바르지 않습니다`);
          const want = space.dim || out[0]?.length || v.length;
          if (v.length !== want) throw new Error(`${info.label} 응답 벡터 차원 ${v.length} ≠ 공간 차원 ${want} — 모델을 바꿨다면 새 임베딩 공간을 만드세요`);
          out.push(normalize(v));
        }
      }
      return out;
    },
  };
}
