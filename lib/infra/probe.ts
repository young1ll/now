import type { CheckStatus, Connection } from "@/lib/repos/infra";

export type ProbeResult = { status: CheckStatus; latency_ms: number | null; message: string };

type Env = Record<string, string | undefined>;

/**
 * 연결 하나의 상태를 점검한다.
 *
 * 현재 판단 근거는 두 가지뿐이다 (추측하지 않는다):
 *  1. health_url 응답 — 2xx/3xx: ok, 4xx: degraded, 5xx·네트워크 오류·타임아웃: down
 *  2. credential_env 로 지정한 환경변수 존재 여부 — 없으면 ok 를 degraded 로 낮춘다
 * 둘 다 없으면 unknown.
 *
 * 공급자 API(비용·리소스 조회)를 직접 호출하는 어댑터는 docs/ROADMAP.md 참고.
 */
export async function probe(
  conn: Pick<Connection, "health_url" | "credential_env">,
  { env = process.env as Env, fetchImpl = fetch, timeoutMs = 8000 }: {
    env?: Env;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<ProbeResult> {
  const credName = conn.credential_env.trim();
  const credMissing = credName !== "" && !env[credName];
  const notes: string[] = [];
  if (credName) notes.push(credMissing ? `자격증명 ${credName} 미설정` : `자격증명 ${credName} 확인`);

  if (!conn.health_url.trim()) {
    notes.unshift("헬스 URL 미설정");
    return { status: credMissing ? "degraded" : "unknown", latency_ms: null, message: notes.join(" · ") };
  }

  const started = performance.now();
  let status: CheckStatus;
  let latency: number | null = null;
  try {
    const res = await fetchImpl(conn.health_url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    latency = Math.round(performance.now() - started);
    status = res.status < 400 ? "ok" : res.status < 500 ? "degraded" : "down";
    notes.unshift(`HTTP ${res.status}`);
  } catch (e) {
    status = "down";
    const err = e as Error;
    notes.unshift(err.name === "TimeoutError" ? `응답 없음 (${timeoutMs / 1000}초 초과)` : `연결 실패: ${err.message}`);
  }

  if (status === "ok" && credMissing) status = "degraded";
  return { status, latency_ms: latency, message: notes.join(" · ") };
}
