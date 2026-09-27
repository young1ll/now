"use client";

import type { ReactNode } from "react";

/** 되돌릴 수 없는 제출 전에 확인을 받는다. */
export function ConfirmButton({
  message = "정말 실행할까요? 되돌릴 수 없습니다.",
  className = "btn-danger",
  children,
  name,
  value,
}: {
  message?: string;
  className?: string;
  children: ReactNode;
  name?: string;
  value?: string;
}) {
  return (
    <button
      type="submit"
      name={name}
      value={value}
      className={className}
      onClick={(e) => {
        if (!confirm(message)) e.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
