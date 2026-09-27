export default function NotFound() {
  return (
    <div className="py-20 text-center">
      <h1 className="text-lg font-semibold">찾을 수 없습니다</h1>
      <p className="muted mt-2 text-sm">삭제되었거나 존재하지 않는 항목입니다.</p>
      <a href="/" className="link mt-4 inline-block text-sm">대시보드로</a>
    </div>
  );
}
