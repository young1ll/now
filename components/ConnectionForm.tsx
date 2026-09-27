import { BusinessSelect, EnumSelect } from "@/components/selects";
import { Field } from "@/components/ui";
import { CURRENCIES } from "@/lib/labels";
import { toMajor } from "@/lib/money";
import { PROVIDER_INFO } from "@/lib/infra/providers";
import type { Business } from "@/lib/repos/businesses";
import type { Connection } from "@/lib/repos/infra";

const PROVIDER_OPTIONS = Object.fromEntries(Object.entries(PROVIDER_INFO).map(([k, v]) => [k, v.label])) as Record<string, string>;

export function ConnectionForm({
  action,
  businesses,
  conn,
  defaultBusinessId,
}: {
  action: (fd: FormData) => Promise<void>;
  businesses: Business[];
  conn?: Connection;
  defaultBusinessId?: number | null;
}) {
  return (
    <form action={action} className="grid gap-3">
      {conn && <input type="hidden" name="id" value={conn.id} />}
      <div className="grid grid-cols-2 gap-3">
        <Field label="공급자"><EnumSelect name="provider" options={PROVIDER_OPTIONS} defaultValue={conn?.provider ?? "aws"} /></Field>
        <Field label="이름"><input name="name" defaultValue={conn?.name} className="input" required placeholder="prod, data-lake…" /></Field>
      </div>
      <Field label="사업"><BusinessSelect businesses={businesses} allowShared defaultValue={conn ? conn.business_id : defaultBusinessId} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="계정·프로젝트·구독 ID / 호스트"><input name="account_ref" defaultValue={conn?.account_ref} className="input" /></Field>
        <Field label="리전"><input name="region" defaultValue={conn?.region} className="input" placeholder="ap-northeast-2" /></Field>
      </div>
      <Field label="콘솔 URL"><input name="console_url" type="url" defaultValue={conn?.console_url} className="input" placeholder="https://" /></Field>
      <Field label="헬스체크 URL (GET 2xx·3xx = 정상)"><input name="health_url" type="url" defaultValue={conn?.health_url} className="input" placeholder="https://api.example.com/health" /></Field>
      <Field label="자격증명 환경변수 이름 (값은 .env.local 에만)">
        <input name="credential_env" defaultValue={conn?.credential_env} className="input font-mono" placeholder="AWS_PROD_ACCESS_KEY" pattern="[A-Z_][A-Z0-9_]*" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="월 예산">
          <input name="monthly_budget" inputMode="decimal" defaultValue={conn?.monthly_budget != null ? toMajor(conn.monthly_budget, conn.currency) : ""} className="input text-right" />
        </Field>
        <Field label="통화">
          <select name="currency" defaultValue={conn?.currency ?? "USD"} className="input">{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select>
        </Field>
      </div>
      <Field label="메모"><textarea name="memo" rows={2} defaultValue={conn?.memo} className="input" /></Field>
      <button className="btn-primary">{conn ? "저장" : "추가하고 점검"}</button>
    </form>
  );
}
