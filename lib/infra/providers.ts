import type { Provider } from "@/lib/repos/infra";

type ProviderInfo = {
  label: string;
  /** account_ref 입력란의 의미 */
  accountLabel: string;
  /** 공개 서비스 상태 페이지 */
  statusPage?: string;
  /** 자격증명 환경변수 이름 예시 */
  credentialHint: string;
};

export const PROVIDER_INFO: Record<Provider, ProviderInfo> = {
  aws: {
    label: "AWS",
    accountLabel: "계정 ID",
    statusPage: "https://health.aws.amazon.com/health/status",
    credentialHint: "AWS_PROD_ACCESS_KEY",
  },
  gcp: {
    label: "Google Cloud",
    accountLabel: "프로젝트 ID",
    statusPage: "https://status.cloud.google.com",
    credentialHint: "GCP_MAIN_SA_KEY",
  },
  azure: {
    label: "Azure",
    accountLabel: "구독 ID",
    statusPage: "https://azure.status.microsoft",
    credentialHint: "AZURE_SUB_TOKEN",
  },
  palantir: {
    label: "Palantir Foundry",
    accountLabel: "Foundry 호스트",
    credentialHint: "PALANTIR_FOUNDRY_TOKEN",
  },
  http: {
    label: "HTTP 서비스",
    accountLabel: "서비스 식별자",
    credentialHint: "",
  },
  other: {
    label: "기타",
    accountLabel: "식별자",
    credentialHint: "",
  },
};
