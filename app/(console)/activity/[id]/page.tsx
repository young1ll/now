import Link from "next/link";
import { notFound } from "next/navigation";
import { runActionForm } from "@/app/actions/console";
import { ActionDrawer, actHref } from "@/components/ActionDrawer";
import { Icon } from "@/components/icons";
import { ApprovalCard, actionTitle } from "@/components/runs";
import { Actor, ObjectLink, PageHeader, Panel, PropertyList, RUN_STATUS, Tag, fmtTime } from "@/components/ui";
import { getGrant } from "@/lib/repos/agents";
import { db } from "@/lib/db";
import { runId } from "@/lib/ontology/ids";
import { type SearchParams, idParam, one } from "@/lib/params";
import { getRun, grantIdOf } from "@/lib/repos/runs";

export default async function RunPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const id = idParam((await params).id);
  const run = id ? getRun(db(), id) : undefined;
  if (!run) notFound();
  const sp = await searchParams;
  const st = RUN_STATUS[run.status];
  const path = `/activity/${run.id}`;
  const grantId = grantIdOf(run);
  const grant = grantId ? getGrant(db(), grantId) : undefined;
  const flaggable = run.actor_type === "agent" && run.status === "applied";
  return (
    <>
      <PageHeader
        icon="activity"
        eyebrow={<><span className="mono">{runId(run.id)}</span> · 액션 실행</>}
        title={
          <span className="flex items-center gap-2">
            {actionTitle(run.action)} <Tag tone={st.tone}>{st.label}</Tag>
            {grantId !== null && <Tag tone="ai">자율 권한</Tag>}
            {run.flagged_at && <Tag tone="red">문제 표시</Tag>}
          </span>
        }
        meta={run.result?.summary ?? run.error ?? ""}
        error={one(sp.error)}
        actions={
          <>
            {flaggable && !run.flagged_at && <Link href={actHref(path, "run.flag", { run_id: run.id })} className="btn-danger"><Icon name="warning" size={12} /> 문제 표시</Link>}
            <Link href="/activity" className="btn">활동 로그</Link>
          </>
        }
      />
      {run.flagged_at && (
        <div className="flex flex-wrap items-center gap-2 border-b border-danger/50 bg-danger/10 px-5 py-2 text-[12.5px] text-danger-fg">
          <Icon name="warning" size={12} />
          <span className="flex-1">
            문제 표시 · <span className="mono">{fmtTime(run.flagged_at)}</span> · {run.flagged_by}: {run.flag_note}
            <span className="ml-1 text-fg-3">— 신뢰 지표에 반영되고, 이 액션의 자율 권한은 자동 회수됩니다.</span>
          </span>
          <form action={runActionForm}>
            <input type="hidden" name="__action" value="run.unflag" />
            <input type="hidden" name="run_id" value={run.id} />
            <button className="btn btn-sm">표시 해제</button>
          </form>
        </div>
      )}
      <div className="grid grid-cols-1 gap-px bg-void p-px lg:grid-cols-2">
        <div className="flex flex-col gap-px">
          {run.status === "pending" && <Panel title="결정"><ApprovalCard run={run} /></Panel>}
          <Panel title="실행 정보">
            <PropertyList
              items={[
                { label: "액션", value: run.action, mono: true },
                { label: "행위자", value: <Actor type={run.actor_type} name={run.actor_name} /> },
                { label: "위험도", value: <Tag tone={run.risk === "high" ? "amber" : "green"}>{run.risk === "high" ? "고위험" : "저위험"}</Tag> },
                { label: "요청 시각", value: fmtTime(run.created_at), mono: true },
                { label: "근거", value: run.reason || "—" },
                { label: "결정자", value: run.decided_by ?? "—" },
                { label: "결정 시각", value: fmtTime(run.decided_at), mono: true },
                { label: "결정 메모", value: run.decision_note || "—" },
                ...(grant
                  ? [{ label: "자율 권한", value: <span className="text-ai-fg"><span className="mono">#{grant.id}</span> <span className="mono">{grant.action}</span> · 부여 {grant.granted_by} · <span className="mono">~{grant.expires_at.slice(0, 10)}</span>{grant.revoked_at ? ` · 회수됨 (${grant.revoked_reason ?? ""})` : ""}</span> }]
                  : []),
                { label: "오류", value: run.error ? <span className="text-danger-fg">{run.error}</span> : "—" },
              ]}
            />
          </Panel>
          <Panel title="관련 객체" count={run.refs.length}>
            {run.refs.length === 0 ? <p className="text-fg-3">없음 (삭제된 객체는 결과 데이터에 남습니다)</p> : (
              <div className="flex flex-col gap-1">{run.refs.map((r) => <ObjectLink key={`${r.type}${r.id}`} type={r.type} id={r.id} />)}</div>
            )}
          </Panel>
        </div>
        <div className="flex flex-col gap-px">
          <Panel title="입력 파라미터">
            <pre className="mono overflow-x-auto bg-inset p-3 text-[12px] leading-relaxed text-fg-2">{JSON.stringify(run.params, null, 2)}</pre>
          </Panel>
          <Panel title="결과">
            <pre className="mono overflow-x-auto bg-inset p-3 text-[12px] leading-relaxed text-fg-2">{JSON.stringify(run.result, null, 2) ?? "null"}</pre>
          </Panel>
        </div>
      </div>
      <ActionDrawer sp={sp} path={path} scope={null} next={path} />
    </>
  );
}
