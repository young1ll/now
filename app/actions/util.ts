import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { FormError } from "@/lib/form";

/**
 * 서버 액션 래퍼. 입력 오류(FormError)는 요청을 보낸 페이지로 ?error= 를 붙여 되돌린다.
 * 그 외 오류는 그대로 던져 error.tsx 가 처리한다.
 */
export function formAction(fn: (fd: FormData) => Promise<void> | void) {
  return async (fd: FormData) => {
    try {
      await fn(fd);
    } catch (e) {
      if (!(e instanceof FormError)) throw e;
      const ref = (await headers()).get("referer");
      const url = new URL(ref ?? "/", "http://local");
      url.searchParams.set("error", e.message);
      redirect(`${url.pathname}?${url.searchParams}`);
    }
  };
}
