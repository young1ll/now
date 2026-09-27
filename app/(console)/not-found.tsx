import Link from "next/link";

export default function NotFound() {
  return (
    <div className="p-10 text-center">
      <div className="label-caps">404</div>
      <p className="mt-2">객체를 찾을 수 없습니다 — 삭제되었거나 존재하지 않습니다.</p>
      <Link href="/" className="link mt-3 inline-block">오퍼레이션으로</Link>
    </div>
  );
}
