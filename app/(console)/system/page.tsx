import Link from "next/link";
import { runActionForm } from "@/app/actions/console";
import { ActionDrawer, actHref } from "@/components/ActionDrawer";
import { AutoRefresh } from "@/components/client";
import { Icon } from "@/components/icons";
import { Callout, Empty, Metric, PageHeader, Panel, PropertyList, Tag, fmtTime, timeAgo } from "@/components/ui";
import { currentScope } from "@/lib/context";
import { db } from "@/lib/db";
import { EMBED_PROVIDER_INFO } from "@/lib/knowledge/embed";
import { backoffUntil } from "@/lib/knowledge/embedder";
import { indexStats } from "@/lib/knowledge/indexer";
import { spaceCoverage, vectorStoreInfo } from "@/lib/knowledge/vectors";
import { type SearchParams, one } from "@/lib/params";
import { type SpaceStatus, listSpaces } from "@/lib/repos/embeddings";
import { latestSnapshot, listSnapshots } from "@/lib/repos/snapshots";
import { runtimeInfo } from "@/lib/system";

export const metadata = { title: "시스템 · 인프라" };

const SNAP = { in_sync: { label: "일치", tone: "green" as const }, drift: { label: "드리프트", tone: "red" as const }, error: { label: "오류", tone: "amber" as const } };
const ACTION_TONE: Record<string, "green" | "amber" | "red" | "blue"> = { create: "green", update: "amber", delete: "red" };

const SPACE_STATUS: Record<SpaceStatus, { label: string; tone: "green" | "blue" | "zinc" }> = {
  active: { label: "활성", tone: "green" },
  building: { label: "채우는 중", tone: "blue" },
  retired: { label: "폐기", tone: "zinc" },
};

const kb = (n: number) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`);
const dur = (s: number) => (s < 3600 ? `${Math.floor(s / 60)}분` : s < 86400 ? `${Math.floor(s / 3600)}시간 ${Math.floor((s % 3600) / 60)}분` : `${Math.floor(s / 86400)}일 ${Math.floor((s % 86400) / 3600)}시간`);

export default async function SystemPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const scope = await currentScope();
  const rt = runtimeInfo(db());
  const snap = latestSnapshot(db());
  const history = listSnapshots(db(), 20);
  const lastBackup = rt.backups[0];
  const idx = indexStats(db());
  const vec = vectorStoreInfo(db());
  const spaces = listSpaces(db()).map((s) => ({ ...s, cov: spaceCoverage(db(), s.id), backoff: backoffUntil(db(), s.id) }));
  const active = spaces.find((s) => s.status === "active");

  return (
    <>
      <AutoRefresh seconds={30} />
      <PageHeader icon="system" eyebrow="자동화 · 거버넌스" title="시스템 · 인프라" meta="런타임 상태와 IaC(OpenTofu) 현행 감사. 인프라는 코드(infra/)로만 바꾸고, 여기서는 실제 상태가 코드와 같은지 감시합니다." error={one(sp.error)} live />
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
          <Panel
            title="검색 색인 — 임베딩 공간 (의미 검색)"
            count={spaces.length}
            flush
            action={
              <Link href={actHref("/system", "embedding.space_create", {}, { provider: "ollama", model: "bge-m3", auto_activate: true })} className="btn btn-sm">
                <Icon name="plus" size={10} /> 임베딩 공간 추가
              </Link>
            }
          >
            <div className="border-b border-line px-3 py-2 text-[12px] text-fg-3">
              {!vec.enabled ? (
                <>벡터 기능이 꺼져 있습니다 (<code className="mono">NOW_VECTORS=off</code>) — 검색은 어휘 + 관계로 동작합니다.</>
              ) : active ? (
                <>
                  의미 검색: <span className="mono text-fg-2">{active.model}</span> · <span className="mono">{active.dim}</span>차원 · 임베딩 <span className="mono">{active.cov.pct}%</span>
                  {active.local_only ? " · 로컬" : " · 외부 공급자 (검색 질의·본문이 외부로 전송)"}
                </>
              ) : (
                <>활성 임베딩 공간이 없습니다 — 검색은 어휘 + 관계로 동작합니다. 공간을 추가하면 워커가 뒤에서 채우고, 다 차면 활성화할 수 있습니다.</>
              )}
            </div>
            {vec.enabled && !vec.attached && (
              <div className="border-b border-line p-3">
                <Callout tone="red" title="벡터 저장소를 열 수 없습니다">
                  {vec.error ?? "알 수 없는 오류"} — 이 플랫폼에서 sqlite-vec 가 동작하지 않으면 <code className="mono">NOW_VECTORS=off</code> 로 끄세요.
                </Callout>
              </div>
            )}
            {spaces.length === 0 ? (
              <Empty icon="search">
                임베딩 공간이 없습니다. 로컬 Ollama(<code className="mono">ollama pull bge-m3</code>)가 기본 — 본문이 이 기기를 떠나지 않습니다.
              </Empty>
            ) : (
              <table className="grid-table">
                <thead>
                  <tr>
                    <th>이름</th>
                    <th className="max-md:hidden">공급자 · 모델</th>
                    <th className="text-right max-md:hidden">차원</th>
                    <th>상태</th>
                    <th className="max-md:hidden">전송</th>
                    <th className="text-right max-md:hidden">임베딩</th>
                    <th className="max-md:hidden">마지막 오류</th>
                    <th className="w-[1%]" />
                  </tr>
                </thead>
                <tbody>
                  {spaces.map((s) => (
                    <tr key={s.id}>
                      <td>
                        {s.name}
                        {s.auto_activate && s.status === "building" ? <span className="ml-1.5 text-[11px] text-fg-4">자동 활성화</span> : null}
                        {/* 좁은 화면: 숨긴 열의 요약 */}
                        <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-fg-3 md:hidden">
                          <span className="mono break-all text-fg-2">{s.model}</span>
                          {s.local_only ? <Tag tone="none">로컬</Tag> : <Tag tone="amber">외부</Tag>}
                          {s.status !== "retired" && <span className="mono">{s.cov.pct}%</span>}
                        </div>
                        {s.last_error && <div className="mt-0.5 line-clamp-2 break-all text-[11px] text-danger-fg md:hidden">{s.last_error}</div>}
                      </td>
                      <td className="text-fg-3 max-md:hidden">
                        {EMBED_PROVIDER_INFO[s.provider].label} · <span className="mono text-fg-2">{s.model}</span>
                        {s.base_url && <div className="mono break-all text-[11px] text-fg-4">{s.base_url}</div>}
                      </td>
                      <td className="num max-md:hidden">{s.dim || "—"}</td>
                      <td><Tag tone={SPACE_STATUS[s.status].tone}>{SPACE_STATUS[s.status].label}</Tag></td>
                      <td className="max-md:hidden">{s.local_only ? <Tag tone="none">로컬</Tag> : <Tag tone="amber">외부</Tag>}</td>
                      <td className="num max-md:hidden" title={`${s.cov.embedded} / ${s.cov.total} 고유 청크`}>{s.status === "retired" ? "—" : `${s.cov.pct}%`}</td>
                      <td className="max-w-[280px] text-[11.5px] max-md:hidden">
                        {s.last_error ? (
                          <>
                            <div className="text-danger-fg">{s.last_error}</div>
                            <div className="text-fg-4">
                              {timeAgo(s.last_error_at)}
                              {s.backoff && new Date(s.backoff).getTime() > Date.now() ? ` · 재시도 ${fmtTime(s.backoff)}` : ""}
                            </div>
                          </>
                        ) : (
                          <span className="text-fg-4">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap">
                        <div className="flex gap-1">
                          {s.status === "building" && s.dim > 0 && (
                            <form action={runActionForm}>
                              <input type="hidden" name="__action" value="embedding.activate" />
                              <input type="hidden" name="id" value={s.id} />
                              {s.cov.pct < 100 && (
                                <>
                                  <input type="hidden" name="__bool_force" value="1" />
                                  <input type="hidden" name="force" value="on" />
                                </>
                              )}
                              <button className="btn btn-sm" title={s.cov.pct < 100 ? `아직 ${s.cov.pct}% — 덜 찬 상태로 강제 전환` : "검색에 이 공간을 사용"}>
                                {s.cov.pct < 100 ? "강제 활성화" : "활성화"}
                              </button>
                            </form>
                          )}
                          {s.status !== "retired" && (
                            <form action={runActionForm}>
                              <input type="hidden" name="__action" value="embedding.retire" />
                              <input type="hidden" name="id" value={s.id} />
                              <button className="btn-minimal btn-sm">폐기</button>
                            </form>
                          )}
                        </div>
                      </td>
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
                { label: "의미 검색", value: active ? `${active.model} · ${active.cov.pct}%` : vec.enabled ? "없음 — 어휘 + 관계" : "꺼짐 (NOW_VECTORS=off)" },
                { label: "벡터 파일", value: vec.path, mono: true },
                { label: "벡터 크기", value: vec.attached ? kb(vec.bytes) : (vec.error ?? "열리지 않음"), mono: vec.attached },
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
npm run eval:recall       # 검색 품질·지연 측정 (--embed-url · --vec-bench)
curl localhost:3000/api/health`}</pre>
          </Panel>
        </div>
      </div>
      <ActionDrawer sp={sp} path="/system" scope={scope} next="/system" />
    </>
  );
}
