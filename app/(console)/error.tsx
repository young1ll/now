"use client";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="m-5 border border-danger bg-danger/10 p-5">
      <div className="label-caps text-danger-fg">오류</div>
      <p className="mt-2 text-[13px]">{error.message || "알 수 없는 오류"}</p>
      {error.digest && <p className="mono mt-1 text-fg-4">digest {error.digest}</p>}
      <button className="btn mt-4" onClick={reset}>다시 시도</button>
    </div>
  );
}
