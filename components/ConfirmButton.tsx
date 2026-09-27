"use client";

import type { ReactNode } from "react";

/** 삭제 등 되돌릴 수 없는 폼 제출 전에 확인을 받는다. */
export function ConfirmButton({
  message = "정말 삭제할까요? 되돌릴 수 없습니다.",
  className = "btn-danger btn-sm",
  children,
}: {
  message?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="submit"
      className={className}
      onClick={(e) => {
        if (!confirm(message)) e.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
