// 온톨로지 그래프를 Neo4j 로 내보낸다 (읽기 전용 분석 복제본 — 기록 원본은 SQLite).
//   NEO4J_URL=http://127.0.0.1:7474 NEO4J_USER=neo4j NEO4J_PASSWORD=… npm run graph:neo4j
//   npm run graph:neo4j -- --cypher data/graph.cypher     (파일로만 내보내기)
// 동기화는 전체 교체: :NowObject 노드를 지우고 다시 만든다.
import fs from "node:fs";
import { db } from "@/lib/db";
import { type Graph, overview } from "@/lib/ontology/graph";
import { OBJECT_TYPES } from "@/lib/ontology/types";

const LABEL: Record<string, string> = { business: "Business", client: "Client", task: "Task", invoice: "Invoice", expense: "Expense", note: "Note", agent: "Agent" };
const relType = (linkType: string) => linkType.replace(/^[a-z]+\./, "").replace(/[^a-zA-Z0-9]/g, "_").toUpperCase() || "LINK";

export function toStatements(g: Graph): { statement: string; parameters: Record<string, unknown> }[] {
  const out: { statement: string; parameters: Record<string, unknown> }[] = [{ statement: "MATCH (n:NowObject) DETACH DELETE n", parameters: {} }];
  for (const type of Object.keys(LABEL)) {
    const nodes = g.nodes.filter((n) => n.type === type).map((n) => ({ key: n.key, type: n.type, id: n.id, display_id: n.displayId, title: n.title, status: n.status?.label ?? null, business_id: n.businessId }));
    if (nodes.length) out.push({ statement: `UNWIND $nodes AS n CREATE (x:NowObject:${LABEL[type]}) SET x = n`, parameters: { nodes } });
  }
  const byRel = new Map<string, Graph["edges"]>();
  for (const e of g.edges) byRel.set(relType(e.linkType), [...(byRel.get(relType(e.linkType)) ?? []), e]);
  for (const [rel, edges] of byRel) {
    out.push({
      statement: `UNWIND $edges AS e MATCH (a:NowObject {key: e.from}), (b:NowObject {key: e.to}) CREATE (a)-[r:${rel}]->(b) SET r.link_type = e.link_type, r.label = e.label, r.source = e.source`,
      parameters: { edges: edges.map((e) => ({ from: e.from, to: e.to, link_type: e.linkType, label: e.label, source: e.source })) },
    });
  }
  return out;
}

function cypherLiteral(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map(cypherLiteral).join(", ")}]`;
  if (typeof v === "object") return `{${Object.entries(v).map(([k, x]) => `${k}: ${cypherLiteral(x)}`).join(", ")}}`;
  return `'${String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

async function main() {
  const g = overview(db(), null, { types: [...OBJECT_TYPES], limit: 100_000 });
  const stmts = toStatements(g);
  const out = process.argv.indexOf("--cypher");
  if (out >= 0) {
    const file = process.argv[out + 1] ?? "data/graph.cypher";
    const text = stmts.map((s) => `${Object.entries(s.parameters).map(([k, v]) => `:param ${k} => ${cypherLiteral(v)};`).join("\n")}\n${s.statement};`).join("\n\n");
    fs.writeFileSync(file, text);
    console.log(`Cypher → ${file} (노드 ${g.nodes.length} · 관계 ${g.edges.length})`);
    return;
  }
  const url = process.env.NEO4J_URL;
  if (!url) throw new Error("NEO4J_URL 이 필요합니다 (또는 --cypher <파일>)");
  const auth = Buffer.from(`${process.env.NEO4J_USER ?? "neo4j"}:${process.env.NEO4J_PASSWORD ?? ""}`).toString("base64");
  const commit = async (statements: typeof stmts) => {
    const res = await fetch(`${url.replace(/\/$/, "")}/db/${process.env.NEO4J_DATABASE ?? "neo4j"}/tx/commit`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Basic ${auth}` },
      body: JSON.stringify({ statements }),
    });
    const body = (await res.json()) as { errors?: { code: string; message: string }[] };
    if (!res.ok || body.errors?.length) throw new Error(body.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${res.status}`);
  };
  // 스키마 변경은 쓰기와 다른 트랜잭션이어야 한다
  await commit([{ statement: "CREATE CONSTRAINT now_key IF NOT EXISTS FOR (n:NowObject) REQUIRE n.key IS UNIQUE", parameters: {} }]);
  await commit(stmts);
  console.log(`Neo4j 동기화 완료 → ${url} (노드 ${g.nodes.length} · 관계 ${g.edges.length})`);
}

if (process.argv[1]?.endsWith("neo4j-sync.ts")) {
  main().catch((e) => {
    console.error(`[graph:neo4j] ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
