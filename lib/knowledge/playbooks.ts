// 플레이북 — 절차 기억 (docs/MEMORY.md §1, §4). kind 'playbook' 문서이고, 본문의 [[action:<이름>]] 이 액션 참조다.
import { getAction } from "@/lib/ontology/execute";

export const ACTION_REF = /\[\[action:([^\]\s]+)\]\]/g;

/** 본문의 액션 참조 (등장 순서, 중복 제거). known = 액션 카탈로그에 있는 이름 */
export function playbookActions(body: string): { name: string; known: boolean }[] {
  const out = new Map<string, boolean>();
  for (const m of body.matchAll(ACTION_REF)) if (!out.has(m[1])) out.set(m[1], !!getAction(m[1]));
  return [...out].map(([name, known]) => ({ name, known }));
}
