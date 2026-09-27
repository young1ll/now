"use client";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-6 dark:border-red-900 dark:bg-red-950">
      <h1 className="font-semibold text-red-700 dark:text-red-300">문제가 발생했습니다</h1>
      <p className="mt-2 text-sm text-red-700 dark:text-red-300">{error.message || "알 수 없는 오류"}</p>
      {error.digest && <p className="muted mt-1 text-xs">digest: {error.digest}</p>}
      <button className="btn mt-4" onClick={reset}>다시 시도</button>
    </div>
  );
}
