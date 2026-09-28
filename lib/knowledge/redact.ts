// 비밀값 가림 — 색인 단계에서 청크 텍스트에 적용한다. 그러면 FTS 에도, 임베딩 공급자(외부일 수 있음)에도
// 원문 비밀이 가지 않는다 (docs/MEMORY.md §3.3). 해시도 가린 텍스트로 계산하므로 비밀만 바뀐 수정은 재임베딩하지 않는다.

export const REDACTED = "[비밀값 가림]";

const PATTERNS: RegExp[] = [
  // PEM 개인 키 (여러 줄)
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // Now 에이전트·세션 토큰
  /\bnows?_[A-Za-z0-9_-]{8,}/g,
  // OpenAI·Anthropic 계열 키 (sk-…, sk-ant-…)
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  // AWS 접근 키 id
  /\bAKIA[0-9A-Z]{16}\b/g,
  // HTTP Authorization 헤더 값
  /\bBearer\s+[A-Za-z0-9._-]{16,}/g,
];

/**
 * "password: hunter22" → "password: [비밀값 가림]" — 키 이름은 남겨 "비밀번호가 적힌 메모"로는 찾을 수 있게 한다.
 * 앞 경계를 두지 않는다 (명세 §5 그대로): `_` 는 JS 의 단어 문자라 \b 를 붙이면 .env 형태(DB_PASSWORD=…,
 * GITHUB_TOKEN=…, client_secret=…, OPENAI_API_KEY=…)를 놓친다. 비밀값은 덜 가리는 쪽이 더 나쁘다 —
 * mysecret=… 같은 붙은 이름도 가린다. 접두어(DB_, client_ 등)는 일치 밖이라 키 이름과 함께 그대로 남는다.
 */
const ASSIGNMENT = /(api[_-]?key|secret|password|token)(\s*[:=]\s*)(?!\[비밀값)\S{6,}/gi;

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, REDACTED);
  return out.replace(ASSIGNMENT, (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`);
}
