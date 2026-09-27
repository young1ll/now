import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Now · Business OS", template: "%s · Now" },
  description: "AI 가 운영하고 사람이 관망·개입하는 1인 사업 운영 체제",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
