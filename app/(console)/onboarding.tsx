import { ActionForm } from "@/components/ActionForm";
import { PageHeader, Panel } from "@/components/ui";
import { db } from "@/lib/db";
import { getAction } from "@/lib/ontology/execute";

export function Onboarding({ sp }: { sp: Record<string, string | string[] | undefined> }) {
  return (
    <>
      <PageHeader icon="ops" eyebrow="초기 설정" title="Now 사업 운영 체제" meta="첫 사업을 등록하면 운영을 시작할 수 있습니다." error={typeof sp.error === "string" ? sp.error : undefined} />
      <div className="max-w-2xl p-5">
        <Panel title="1 · 사업 등록">
          <ActionForm def={getAction("business.create")!} db={db()} scope={null} values={{ currency: "KRW", color: "#2D72D2" }} next="/" />
        </Panel>
        <p className="mt-4 text-[12px] text-fg-3">
          예시 데이터로 둘러보려면 <code className="mono text-fg-2">npm run db:seed</code>. 그다음 <a href="/agents" className="link">에이전트</a>를 연결하세요.
        </p>
      </div>
    </>
  );
}
