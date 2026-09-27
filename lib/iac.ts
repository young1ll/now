// OpenTofu/Terraform JSON 출력 → 감사용 스냅샷. 비밀값은 걸러낸다.
import type { IacChange, IacResource } from "@/lib/repos/snapshots";

type StateResource = {
  address: string;
  mode: string;
  type: string;
  name: string;
  provider_name?: string;
  values?: Record<string, unknown>;
};
type StateModule = { resources?: StateResource[]; child_modules?: StateModule[] };

const SECRET = /(env|secret|password|passwd|token|key|auth|credential|cert)/i;

function flatten(m: StateModule | undefined): StateResource[] {
  if (!m) return [];
  return [...(m.resources ?? []), ...(m.child_modules ?? []).flatMap(flatten)];
}

function scalar(v: unknown): string | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  if (typeof v === "string") return v.length > 120 ? `${v.slice(0, 117)}…` : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

/** 유형별로 감사에 의미 있는 속성. 목록에 없는 유형은 비밀이 아닌 스칼라 전부. */
const KEEP: Record<string, string[]> = {
  docker_container: ["name", "image", "restart", "must_run", "memory", "memory_swap", "user", "init", "read_only"],
  docker_network: ["name", "driver", "internal"],
  docker_volume: ["name", "driver", "mountpoint"],
  docker_image: ["name", "image_id"],
};

/** 리소스 유형별로 감사에 의미 있는 속성만 추린다. 비밀로 보이는 키는 항상 제외. */
export function auditAttributes(type: string, values: Record<string, unknown> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  const keep = KEEP[type];
  for (const [k, v] of Object.entries(values)) {
    if (SECRET.test(k) || (keep && !keep.includes(k))) continue;
    const s = scalar(v);
    if (s !== undefined) out[k] = s;
  }
  if (type === "docker_container") {
    const ports = (values.ports as { internal?: number; external?: number; ip?: string }[] | undefined) ?? [];
    if (ports.length) out.ports = ports.map((p) => `${p.ip ?? "0.0.0.0"}:${p.external ?? "?"}→${p.internal}`).join(", ");
    const vols = (values.volumes as { volume_name?: string; host_path?: string; container_path?: string }[] | undefined) ?? [];
    if (vols.length) out.volumes = vols.map((v) => `${v.volume_name || v.host_path}:${v.container_path}`).join(", ");
    const env = (values.env as string[] | undefined) ?? [];
    if (env.length) out.env_keys = env.map((e) => e.split("=")[0]).sort().join(", "); // 값은 절대 기록하지 않음
    if (typeof out.image === "string") out.image = out.image.replace(/^sha256:/, "").slice(0, 12);
  }
  // 잡음이 많은 키 제거
  for (const k of ["id", "attach", "logs", "rm", "tty", "stdin_open", "privileged", "publish_all_ports"]) delete out[k];
  return out;
}

export function parseState(showJson: unknown): IacResource[] {
  const root = (showJson as { values?: { root_module?: StateModule } })?.values?.root_module;
  return flatten(root)
    .filter((r) => r.mode === "managed")
    .map((r) => ({
      address: r.address,
      type: r.type,
      name: r.name,
      provider: (r.provider_name ?? "").split("/").slice(-1)[0] ?? "",
      attributes: auditAttributes(r.type, r.values),
    }));
}

/** plan JSON (tofu show -json <planfile>) 의 실제 변경만. */
export function parseChanges(planJson: unknown): IacChange[] {
  const rc = (planJson as { resource_changes?: { address: string; type: string; mode?: string; change: { actions: string[] } }[] })?.resource_changes ?? [];
  return rc
    .filter((c) => c.mode !== "data" && !(c.change.actions.length === 1 && ["no-op", "read"].includes(c.change.actions[0])))
    .map((c) => ({ address: c.address, type: c.type, actions: c.change.actions }));
}
