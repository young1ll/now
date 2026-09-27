# 온톨로지

## 지금 구조는 "진정한 온톨로지" 인가?

v0.2 까지는 **타입이 있는 객체 계층**이었다 — 객체 유형이 코드에 고정되고, 관계는 외래키에 숨어 있었다.
v0.3 에서 다음을 갖추면서 온톨로지의 핵심 요건을 채웠다.

| 요건 | 구현 |
|---|---|
| 스키마가 데이터다 | `lib/ontology/schema.ts` (객체 유형·속성 타입) + `link_types` 테이블. 에이전트는 `describe_ontology` 로 읽는다 |
| 관계가 1급 시민이다 | 외래키 관계(intrinsic) · 감사 파생 관계(derived: 에이전트가 변경한 객체) · 사용자 정의 링크(custom, `links` 테이블)를 **하나의 그래프**로 다룬다 |
| 관계 유형을 늘릴 수 있다 | `link_type.define` 액션 (에이전트는 승인 필요) — 방향 · 역방향 라벨 · 다중성(one/many) |
| 그래프 질의 | 이웃 탐색(BFS, 1~4단계) · 최단 경로 · 범위 전체 그래프 — 콘솔 `/graph`, 도구 `traverse` · `find_path` |
| 행동이 온톨로지에 묶인다 | 액션은 객체 유형·대상에 바인딩되고, 객체 상태에 따라 가능한 액션만 노출 (`actionsFor`) |
| 변경 이력이 그래프에 남는다 | 모든 액션 실행이 객체 참조(`action_run_refs`)와 이벤트로 기록 → "누가 무엇을 바꿨나" 가 관계로 보인다 |

아직 없는 것 (로드맵): 사용자 정의 **객체 유형**(현재는 7종 고정), 사용자 정의 속성, 파생 속성 함수(예: 고객 LTV), 링크 속성.

## 왜 Neo4j 를 기록 원본으로 쓰지 않았나

- 1인 로컬 운영: JVM 서버 하나를 더 띄우고 백업·업그레이드·드리프트를 관리하는 비용이 크다.
- 감사·승인의 단일 관문(트랜잭션 + 감사 기록)을 두 저장소에 걸치면 원자성이 깨진다.
- 규모: 수천~수만 객체의 이웃·경로 질의는 SQLite + 인덱스로 충분히 빠르다.

대신 **Neo4j 를 분석용 복제본**으로 붙였다.

```bash
NEO4J_URL=http://127.0.0.1:7474 NEO4J_USER=neo4j NEO4J_PASSWORD=… npm run graph:neo4j
npm run graph:neo4j -- --cypher data/graph.cypher   # 파일로만 내보내기
```

- 노드: `:NowObject:<Client|Task|Invoice|…>` {key, type, id, display_id, title, status, business_id}
- 관계: 링크 유형 → 관계 유형 (`task.client` → `:CLIENT`, `referred_by` → `:REFERRED_BY`, `agent.touched` → `:TOUCHED`)
- 전체 교체 방식이라 여러 번 실행해도 결과가 같다 (Neo4j 5 에서 검증).

```cypher
// 고객별 업무 수
MATCH (c:Client)<-[:CLIENT]-(t:Task) RETURN c.title, count(t) ORDER BY count(t) DESC
// 에이전트가 가장 많이 만진 객체 유형
MATCH (a:Agent)-[:TOUCHED]->(o) RETURN a.title, labels(o)[1], count(*) ORDER BY count(*) DESC
// 소개 네트워크
MATCH p=(:Client)-[:REFERRED_BY*1..3]->(:Client) RETURN p
```

쓰기는 항상 액션을 통해 SQLite 로 — Neo4j 에서 직접 바꾼 내용은 다음 동기화에 덮어써진다.

## 기본 링크 유형

| 이름 | 방향 | 출처 |
|---|---|---|
| client.business · task.business · invoice.business · expense.business · note.business | → business | 외래키 |
| task.client · invoice.client · note.client | → client | 외래키 |
| agent.touched | agent → * | 감사 파생 |
| referred_by | client → client (하나) | 사용자 정의 |
| depends_on | task → task | 사용자 정의 |
| documents | note → task | 사용자 정의 |
| cites | invoice → note | 사용자 정의 |
