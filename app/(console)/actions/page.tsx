import { PageHeader, Panel, Tag } from "@/components/ui";
import { db } from "@/lib/db";
import { jsonSchemaOf } from "@/lib/ontology/action";
import { ACTION_LIST } from "@/lib/ontology/actions";
import { AI_MODE_LABEL } from "@/lib/ontology/actions/system";
import { OBJECTS } from "@/lib/ontology/objects";
import { getAiMode } from "@/lib/repos/settings";

export const metadata = { title: "액션 카탈로그" };

export default function ActionsPage() {
  const mode = getAiMode(db());
  const groups = Object.entries(Object.groupBy(ACTION_LIST, (a) => a.objectType));
  const outcome = (risk: string, human: boolean) => {
    if (human) return <Tag tone="blue">사람 전용</Tag>;
    if (mode === "frozen") return <Tag tone="red">차단</Tag>;
    if (mode === "supervised") return <Tag tone="amber">승인</Tag>;
    if (mode === "autonomous") return <Tag tone="green">즉시</Tag>;
    return risk === "high" ? <Tag tone="amber">승인</Tag> : risk === "low" ? <Tag tone="green">즉시</Tag> : <Tag tone="slate">상태에 따라</Tag>;
  };
  return (
    <>
      <PageHeader icon="action" eyebrow="자동화 · 거버넌스" title="액션 카탈로그" meta={`사람과 AI 가 데이터를 바꿀 수 있는 유일한 경로 · ${ACTION_LIST.length}개 · 현재 모드: ${AI_MODE_LABEL[mode]}`} />
      <div className="flex flex-col gap-px bg-void p-px">
        {groups.map(([type, list]) => (
          <Panel key={type} title={type === "system" ? "시스템" : OBJECTS[type as keyof typeof OBJECTS].label} count={list!.length} flush>
            <table className="grid-table">
              <thead><tr><th className="w-[170px]">이름</th><th className="w-[140px]">제목</th><th>설명</th><th className="w-[80px]">위험도</th><th className="w-[100px]">AI 실행 시</th><th>파라미터</th></tr></thead>
              <tbody>
                {list!.map((a) => {
                  const risk = typeof a.risk === "function" ? "dynamic" : a.risk;
                  const schema = jsonSchemaOf(a) as { properties: Record<string, unknown>; required?: string[] };
                  return (
                    <tr key={a.name}>
                      <td className="mono text-primary-fg">{a.name}</td>
                      <td>{a.title}</td>
                      <td className="text-fg-2">{a.description}</td>
                      <td><Tag tone={risk === "high" ? "amber" : risk === "low" ? "green" : "slate"}>{risk === "high" ? "고위험" : risk === "low" ? "저위험" : "변동"}</Tag></td>
                      <td>{outcome(risk, !!a.humanOnly)}</td>
                      <td className="mono text-[11px] text-fg-3">
                        {Object.keys(schema.properties).map((k) => (
                          <span key={k} className={`mr-2 whitespace-nowrap ${schema.required?.includes(k) ? "text-fg" : ""}`}>{k}{schema.required?.includes(k) ? "*" : ""}</span>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>
        ))}
      </div>
    </>
  );
}
