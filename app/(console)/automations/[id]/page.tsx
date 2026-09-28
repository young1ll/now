import Link from "next/link";
import { notFound } from "next/navigation";
import { runActionForm } from "@/app/actions/console";
import { ActionDrawer } from "@/components/ActionDrawer";
import { ActionForm } from "@/components/ActionForm";
import { TriggerRunTable } from "@/components/automation";
import { AutoRefresh } from "@/components/client";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Icon } from "@/components/icons";
import { Empty, PageHeader, Panel, PropertyList, Tag, fmtTime } from "@/components/ui";
import { currentScope } from "@/lib/context";
import { db } from "@/lib/db";
import { getAction } from "@/lib/ontology/execute";
import { type SearchParams, idParam, one } from "@/lib/params";
import { getProfile } from "@/lib/repos/ai";
import { getTrigger, listTriggerRuns } from "@/lib/repos/triggers";

export default async function TriggerPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const id = idParam((await params).id);
  const t = id ? getTrigger(db(), id) : undefined;
  if (!t) notFound();
  const sp = await searchParams;
  const scope = await currentScope();
  const runs = listTriggerRuns(db(), { triggerId: t.id, limit: 50 });
  const profile = t.profile_id ? getProfile(db(), t.profile_id) : undefined;
  const path = `/automations/${t.id}`;
  return (
    <>
      <AutoRefresh seconds={10} />
      <PageHeader
        icon="trigger"
        eyebrow={<Link href="/automations" className="hover:text-fg">트리거</Link>}
        title={<span className="flex items-center gap-2">{t.name} {t.enabled ? <Tag tone="green">켜짐</Tag> : <Tag tone="zinc">꺼짐</Tag>}</span>}
        meta={t.kind === "event" ? `이벤트 ${t.event_pattern}` : `스케줄 ${t.schedule}`}
        error={one(sp.error)}
        actions={
          <>
            <form action={runActionForm}>
              <input type="hidden" name="__action" value="trigger.fire" />
              <input type="hidden" name="id" value={t.id} />
              <button className="btn"><Icon name="play" size={10} /> 지금 실행</button>
            </form>
            <form action={runActionForm}>
              <input type="hidden" name="__action" value="trigger.update" />
              <input type="hidden" name="id" value={t.id} />
              <input type="hidden" name="__bool_enabled" value="1" />
              {!t.enabled && <input type="hidden" name="enabled" value="on" />}
              <button className="btn">{t.enabled ? <><Icon name="pause" size={10} /> 끄기</> : <><Icon name="play" size={10} /> 켜기</>}</button>
            </form>
            <form action={runActionForm}>
              <input type="hidden" name="__action" value="trigger.delete" />
              <input type="hidden" name="id" value={t.id} />
              <input type="hidden" name="__next" value="/automations" />
              <ConfirmButton message="트리거와 실행 기록을 삭제할까요?">삭제</ConfirmButton>
            </form>
          </>
        }
      />
      <div className="grid grid-cols-1 gap-px bg-void p-px xl:grid-cols-12">
        <div className="flex flex-col gap-px xl:col-span-7">
          <Panel title="실행 기록" count={runs.length} flush>
            {runs.length === 0 ? <Empty icon="event">아직 실행되지 않았습니다.</Empty> : <TriggerRunTable runs={runs} showTrigger={false} />}
          </Panel>
        </div>
        <div className="flex flex-col gap-px xl:col-span-5">
          <Panel title="설정">
            <PropertyList
              items={[
                { label: "유형", value: t.kind === "event" ? "이벤트" : "스케줄" },
                { label: t.kind === "event" ? "패턴" : "cron", value: t.kind === "event" ? t.event_pattern : t.schedule, mono: true },
                { label: "필터", value: t.filter, mono: true },
                { label: "대상", value: t.target === "agent" ? `AI · ${profile?.name ?? "(없음)"}` : t.webhook_url },
                ...(t.target === "webhook" ? [{ label: "서명", value: t.secret_env || "없음", mono: true }] : []),
                { label: "쿨다운", value: `${t.cooldown_sec}초` },
                { label: "마지막 발화", value: fmtTime(t.last_fired_at), mono: true },
              ]}
            />
            {t.target === "agent" && (
              <>
                <div className="label-caps mt-3 mb-1">프롬프트 템플릿</div>
                <pre className="mono max-h-48 overflow-auto bg-inset p-2 text-[11.5px] whitespace-pre-wrap text-fg-2">{t.prompt_template || "(기본 지시문)"}</pre>
              </>
            )}
          </Panel>
          <Panel title="수정">
            <ActionForm def={getAction("trigger.update")!} db={db()} scope={scope} values={{ ...t, enabled: !!t.enabled }} locked={["id"]} next={path} />
          </Panel>
        </div>
      </div>
      <ActionDrawer sp={sp} path={path} scope={scope} />
    </>
  );
}
