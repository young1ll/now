import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3", "sqlite-vec"],
  // sqlite-vec 는 플랫폼별 패키지(sqlite-vec-linux-x64 …)의 .so 를 실행 시점에 require.resolve 한다 — 추적기가 못 따라가므로 명시
  outputFileTracingIncludes: { "/**/*": ["./node_modules/sqlite-vec-*/**/*"] },
  // 외부 자료 가져오기(document.import)는 본문 20만 자까지 받는다 — 한글 UTF-8 로 ~600KB (기본 한도 1MB 에 여유를 둔다)
  experimental: { serverActions: { bodySizeLimit: "2mb" } },
};

export default nextConfig;
