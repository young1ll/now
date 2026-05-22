import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TaxBrief — 세무 상담 보고서",
  description: "국가법령정보센터 기반 세무 상담 보고서 생성기",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
