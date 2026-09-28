import { runActionForm } from "@/app/actions/console";
import { AutoRefresh } from "@/components/client";
import { Icon } from "@/components/icons";
import { Callout, Empty, Metric, PageHeader, Panel, PropertyList, Tag, fmtTime, timeAgo } from "@/components/ui";
import { db } from "@/lib/db";
import { indexStats } from "@/lib/knowledge/indexer";
import { latestSnapshot, listSnapshots } from "@/lib/repos/snapshots";
import { runtimeInfo } from "@/lib/system";

export const metadata = { title: "시스템 · 인프라" };

const SNAP = { in_sync: { label: "일치", tone: "green" as const }, drift: { label: "드리프트", tone: "red" as const }, error: { label: "오류", tone: "amber" as const } };
const ACTION_TONE: Record<string, "green" | "amber" | "red" | "blue"> = { create: "green", update: "amber", delete: "red" };

const kb = (n: number) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`);
const dur = (s: number) => (s < 3600 ? `${Math.floor(s / 60)}분` : s < 86400 ? `${Math.floor(s / 3600)}시간 ${Math.floor((s % 3600) / 60)}분` : `${Math.floor(s / 86400)}일 ${Math.floor((s % 86400) / 3600)}시간`);

export default function SystemPage() {
  const rt = runtimeInfo(db());
  const snap = latestSnapshot(db());
  const history = listSnapshots(db(), 20);
  const lastBackup = rt.backups[0];
  const idx = indexStats(db());

  return (
    <>
      <AutoRefresh seconds={30} />
      <PageHeader icon="system" eyebrow="자동화 · 거버넌스" title="시스템 · 인프라" meta="런타임 상태와 IaC(OpenTofu) 현행 감사. 인프라는 코드(infra/)로만 바꾸고, 여기서는 실제 상태가 코드와 같은지 감시합니다." live />
      <div className="grid grid-cols-2 border-b border-line bg-panel sm:grid-cols-3 xl:grid-cols-6">
        <Metric label="앱" value={`v${rt.version}`} sub={`node ${rt.node}`} />
        <Metric label="가동 시간" value={dur(rt.uptimeSec)} sub={`PID ${rt.pid} · ${rt.memoryMb} MB`} />
        <Metric label="DB 스키마" value={`${rt.db.schema}/${rt.db.schemaLatest}`} sub={rt.db.integrity ? "무결성 정상" : "무결성 오류"} tone={rt.db.integrity && rt.db.schema === rt.db.schemaLatest ? "success" : "danger"} />
        <Metric label="DB 크기" value={kb(rt.db.bytes)} sub={`WAL ${kb(rt.db.walBytes)}`} />
        <Metric label="마지막 백업" value={lastBackup ? timeAgo(lastBackup.at) : "없음"} sub={`${rt.backups.length}개 보관`} tone={lastBackup ? undefined : "warning"} />
        <Metric label="IaC 상태" value={snap ? SNAP[snap.status].label : "미감사"} sub={snap ? timeAgo(snap.captured_at) : "npm run iac:audit"} tone={!snap ? "warning" : snap.status === "in_sync" ? "success" : "danger"} />
      </div>

      <div className="grid gap-px bg-void p-px xl:grid-cols-12">
        <div className="flex flex-col gap-px xl:col-span-8">
          <Panel
            title="IaC 현행 감사 — 관리 리소스"
            count={snap?.resource_count ?? 0}
            action={snap && <span className="mono text-[11px] text-fg-3">{snap.tool} · {fmtTime(snap.captured_at)}</span>}
            flush
          >
            {!snap ? (
              <div className="p-3">
                <Callout tone="amber" title="아직 감사 기록이 없습니다">
                  <code className="mono">cd infra && tofu init && tofu apply</code> 로 배포한 뒤 <code className="mono">npm run iac:audit</code> 를 실행하세요 (cron 으로 주기 실행 권장).
                </Callout>
              </div>
            ) : (
              <>
                {snap.message && (
                  <div className={`border-b px-3 py-2 text-[12.5px] ${snap.status === "in_sync" ? "border-line text-fg-2" : "border-danger/50 bg-danger/10 text-danger-fg"}`}>{snap.message}</div>
                )}
                {snap.resources.length === 0 ? <Empty icon="system">state 에 리소스가 없습니다.</Empty> : (
                  <table className="grid-table">
                    <thead><tr><th>주소</th><th>유형</th><th>핵심 속성</th></tr></thead>
                    <tbody>
                      {snap.resources.map((r) => (
                        <tr key={r.address}>
                          <td className="mono text-primary-fg">{r.address}</td>
                          <td className="mono text-fg-3">{r.type}</td>
                          <td className="text-[11.5px]">
                            {Object.entries(r.attributes).slice(0, 8).map(([k, v]) => (
                              <span key={k} className="mr-3 inline-block"><span className="text-fg-4">{k}=</span><span className="mono text-fg-2">{v}</span></span>
                            ))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            )}
          </Panel>
          {snap && snap.changes.length > 0 && (
            <Panel title="드리프트 — 코드와 다른 리소스" count={snap.changes.length} flush>
              <table className="grid-table">
                <thead><tr><th>주소</th><th>유형</th><th>plan 이 제안하는 조치</th></tr></thead>
                <tbody>
                  {snap.changes.map((c) => (
                    <tr key={c.address}>
                      <td className="mono">{c.address}</td>
                      <td className="mono text-fg-3">{c.type}</td>
                      <td className="flex gap-1">{c.actions.map((a) => <Tag key={a} tone={ACTION_TONE[a] ?? "slate"}>{a}</Tag>)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          )}
          <Panel title="감사 이력" count={history.length} flush>
            {history.length === 0 ? <Empty icon="system">기록 없음</Empty> : (
              <table className="grid-table">
                <thead><tr><th>시각</th><th>도구</th><th>결과</th><th className="text-right">리소스</th><th className="text-right">변경</th><th>메시지</th></tr></thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id}>
                      <td className="mono">{fmtTime(h.captured_at)}</td>
                      <td className="mono text-fg-3">{h.tool}</td>
                      <td><Tag tone={SNAP[h.status].tone}>{SNAP[h.status].label}</Tag></td>
                      <td className="num">{h.resource_count}</td>
                      <td className="num">{h.change_count}</td>
                      <td className="max-w-[260px] truncate text-fg-3">{h.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>
        <div className="flex flex-col gap-px xl:col-span-4">
          <Panel title="데이터베이스">
            <PropertyList
              items={[
                { label: "경로", value: rt.db.path, mono: true },
                ...Object.entries(rt.db.counts).map(([k, v]) => ({ label: k, value: String(v), mono: true })),
              ]}
            />
          </Panel>
          <Panel title="검색 색인" action={<a href="/search" className="btn-minimal btn-sm">검색</a>}>
            <PropertyList
              items={[
                { label: "객체 · 구획", value: `${idx.owners} · ${idx.chunks}`, mono: true },
                { label: "토큰 (추정)", value: idx.tokens.toLocaleString(), mono: true },
                { label: "반영 대기 이벤트", value: String(idx.lag), mono: true },
                { label: "전체 스윕", value: idx.sweptAt ? timeAgo(idx.sweptAt) : "아직 없음" },
                { label: "벡터 (의미 검색)", value: "없음 — 어휘 + 관계 (M2 예정)" },
              ]}
            />
          </Panel>
          <Panel
            title="백업"
            count={rt.backups.length}
            flush
            action={
              <form action={runActionForm}>
                <input type="hidden" name="__action" value="system.backup" />
                <button className="btn btn-sm"><Icon name="bolt" size={10} /> 지금 백업</button>
              </form>
            }
          >
            {rt.backups.length === 0 ? <div className="p-3"><Callout tone="amber">백업이 없습니다. <code className="mono">npm run db:backup</code></Callout></div> : (
              <table className="grid-table">
                <tbody>
                  {rt.backups.slice(0, 10).map((b) => (
                    <tr key={b.file}><td className="mono">{b.file}</td><td className="num">{kb(b.bytes)}</td><td className="mono text-right text-fg-3">{timeAgo(b.at)}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
          <Panel title="운영 명령">
            <pre className="mono overflow-x-auto bg-inset p-2 text-[11.5px] leading-relaxed text-fg-2">{`npm run iac:build        # 이미지 빌드
cd infra && tofu apply    # 배포/변경 (코드로만)
npm run iac:audit         # 현행 감사 → 이 화면
npm run db:backup         # 온라인 백업 (= 지금 백업)
npm run eval:recall       # 검색 품질·지연 측정
curl localhost:3000/api/health`}</pre>
          </Panel>
        </div>
      </div>
    </>
  );
}
