import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// 콘솔에는 로그인이 없다 → 로컬 호스트 이름으로 온 요청만 받는다 (DNS 리바인딩 차단).
// 다른 이름으로 접속해야 하면 NOW_ALLOWED_HOSTS=host1,host2 로 추가한다.
const ALLOWED = new Set(["localhost", "127.0.0.1", "[::1]", ...(process.env.NOW_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean)]);

export function proxy(req: NextRequest) {
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "").toLowerCase();
  if (!ALLOWED.has(host)) return new NextResponse("Host not allowed", { status: 421 });
  return NextResponse.next();
}

export const config = { matcher: "/((?!_next/static|_next/image|icon.svg).*)" };
