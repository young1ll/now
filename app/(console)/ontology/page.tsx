import Link from "next/link";
import { ActionDrawer, actHref } from "@/components/ActionDrawer";
import { Icon } from "@/components/icons";
import { Callout, OBJECT_ICON, PageHeader, Panel, Tag } from "@/components/ui";
import { TYPE_COLOR } from "@/lib/ontology/palette";
import { currentScope } from "@/lib/context";
import { db } from "@/lib/db";
import { OBJECTS } from "@/lib/ontology/objects";
import { PROPERTIES, allLinkTypes } from "@/lib/ontology/schema";
import { OBJECT_TYPES } from "@/lib/ontology/types";
import { type SearchParams, one } from "@/lib/params";

export const metadata = { title: "온톨로지 스키마" };

const SOURCE = {
  intrinsic: { label: "구조 (외래키)", tone: "slate" as const },
  derived: { label: "파생 (감사)", tone: "ai" as const },
  custom: { label: "사용자 정의", tone: "blue" as const },
};

export default async function OntologyPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const scope = await currentScope();
  const links = allLinkTypes(db());
  const counts = new Map(
    (db().prepare("SELECT link_type, COUNT(*) AS n FROM links GROUP BY 1").all() as { link_type: string; n: number }[]).map((r) => [r.link_type, r.n]),
  );
  const objCount = (t: string) => (db().prepare(`SELECT COUNT(*) AS n FROM ${{ business: "businesses", client: "clients", task: "tasks", invoice: "invoices", expense: "expenses", note: "notes", agent: "agents", memory: "memories" }[t]}`).get() as { n: number }).n;

  return (
    <>
      <PageHeader
        icon="schema"
        eyebrow="온톨로지"
        title="스키마"
        meta="객체 유형 · 속성 · 링크 유형 · 액션. 에이전트는 describe_ontology 로 같은 정의를 읽는다."
        error={one(sp.error)}
        actions={
          <>
            <Link href="/graph" className="btn"><Icon name="graph" size={12} /> 그래프</Link>
            <Link href={actHref("/ontology", "link_type.define")} className="btn-primary"><Icon name="plus" size={12} /> 링크 유형 정의</Link>
          </>
        }
      />
      <div className="grid gap-px bg-void p-px xl:grid-cols-12">
        <div className="xl:col-span-7">
          <Panel title="객체 유형" count={OBJECT_TYPES.length} flush className="h-full">
            <table className="grid-table">
              <thead><tr><th>유형</th><th className="text-right">객체</th><th>속성</th><th>액션</th></tr></thead>
              <tbody>
                {OBJECT_TYPES.map((t) => (
                  <tr key={t}>
                    <td className="whitespace-nowrap">
                      <Link href={`/o/${t}`} className="flex items-center gap-2 hover:underline">
                        <span className="size-2.5" style={{ background: TYPE_COLOR[t] }} />
                        <Icon name={OBJECT_ICON[t]} size={12} className="text-fg-3" />
                        {OBJECTS[t].label} <span className="mono text-[11px] text-fg-4">{t}</span>
                      </Link>
                    </td>
                    <td className="num">{objCount(t)}</td>
                    <td className="text-[11.5px]">
                      {PROPERTIES[t].map((p) => (
                        <span key={p.key} className="mr-2 inline-block whitespace-nowrap" title={p.description}>
                          <span className="mono text-fg-2">{p.key}</span><span className="text-fg-4">:{p.type}</span>
                        </span>
                      ))}
                    </td>
                    <td className="mono text-[11px] text-fg-3">{OBJECTS[t].actions.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>
        <div className="flex flex-col gap-px xl:col-span-5">
          <Panel title="링크 유형" count={links.length} flush>
            <table className="grid-table">
              <thead><tr><th>이름</th><th>방향</th><th>출처</th><th className="text-right">링크</th></tr></thead>
              <tbody>
                {links.map((l) => (
                  <tr key={l.name}>
                    <td>
                      <div className="mono text-primary-fg">{l.name}</div>
                      <div className="text-[11.5px] text-fg-3">{l.label} ↔ {l.inverseLabel}{l.cardinality === "one" ? " · 하나" : ""}</div>
                    </td>
                    <td className="mono text-[11px] whitespace-nowrap text-fg-2">{l.fromType} → {l.toType}</td>
                    <td><Tag tone={SOURCE[l.source].tone}>{SOURCE[l.source].label}</Tag></td>
                    <td className="num">{l.source === "custom" ? (counts.get(l.name) ?? 0) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
          <Panel title="설계">
            <div className="space-y-2">
              <Callout tone="blue" title="기록 원본은 SQLite, 그래프는 질의 계층">
                객체와 외래키 관계는 기존 테이블에, 사용자 정의 관계는 <code className="mono">links</code> 에 저장되고, 이 화면·그래프·에이전트 도구(traverse, find_path)가 하나의 그래프로 읽습니다.
              </Callout>
              <Callout tone="ai" title="Neo4j 는 분석용 복제본">
                <code className="mono">npm run graph:neo4j</code> 로 전체 그래프를 Neo4j 에 동기화하면 Cypher 로 자유롭게 질의할 수 있습니다. 쓰기는 항상 액션을 통해 SQLite 로.
              </Callout>
            </div>
          </Panel>
        </div>
      </div>
      <ActionDrawer sp={sp} path="/ontology" scope={scope} next="/ontology" />
    </>
  );
}
