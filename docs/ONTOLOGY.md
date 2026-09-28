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

아직 없는 것 (로드맵): 사용자 정의 **객체 유형**(현재는 8종 고정 — v0.4 M3 에서 `memory` 추가), 사용자 정의 속성, 파생 속성 함수(예: 고객 LTV), 링크 속성.

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
| about | memory → * | 시스템 (기억) |
| evidenced_by | memory → * | 시스템 (기억) |
| contradicts | memory → memory | 시스템 (기억) — `memory.*` 액션만 |
| promoted_to | memory → * (하나) | 시스템 (기억) — `memory.promote` 만 |

## 기억(memory) — 8번째 객체 유형 (v0.4 M3)

구조로 담기 어려운 사실·선호·교훈·절차 힌트·주의를 **한 문장**으로 적은 객체다. 식별자 `MEM-0001`, 참조 `memory:1`, 그래프 색 `#e66767` (dataviz 팔레트 8번째 슬롯).
설계와 생애는 [MEMORY.md](MEMORY.md) §3 · §13.

- **상태**: `proposed`(에이전트 제안, 미확인) · `active`(쓸 수 있지만 미확인 — M5 자동 착지용) · `verified`(사람 확인) · `disputed`(충돌) · `superseded`(정정·합치기·승격으로 대체) · `retired`(보관)
- **속성**: statement · kind(fact/preference/lesson/procedure_hint/caution) · status · confidence · origin(human/agent/…) · tainted(외부 비신뢰 출처) · pinned · valid_from/valid_to · use_count · last_used_at
- **관계**는 1급 링크를 재사용한다: `about`(무엇에 관한가) · `evidenced_by`(근거) · `contradicts`(충돌 상대) · `promoted_to`(구조화된 대체물).
- **도착 유형 `*`**: 링크 유형의 `to_type` 이 `*` 이면 아무 객체나 도착점이 된다. `link.create` 는 `to_type !== "*"` 일 때만 도착 유형을 검사한다. `link_type.define` 도 `*` 를 받는다.
- **시스템 링크 유형** 4종은 `link_type.delete` 로 지울 수 없다. `contradicts` · `promoted_to` 는 기억 상태와 함께 움직이므로 `link.create` 로 직접 만들 수 없다 (`about` · `evidenced_by` 는 가능 — 오염된 기억을 `evidenced_by` 로 붙이면 출발 기억도 tainted). 업그레이드 전에 같은 이름의 사용자 유형이 있었으면 마이그레이션 6 이 `<이름>_user` 로 옮긴다.
- 객체를 지우면 삭제 액션의 `deleteLinksFor` 가 about·근거 링크를 정리한다. 기억 자체는 남는다 (화면에 "대상 없음").
- 기억과의 링크는 다른 객체의 **검색 카드에 넣지 않는다** (기억 문장이 대상 카드로 복제되면 보관된 기억도 대상 카드로 검색된다). 대신 대상의 이름이 바뀌면 그 대상을 가리키는 기억 카드가 증분 색인에서 다시 만들어진다.
- 객체 화면(`/o/<type>/<id>`)의 **"AI 가 아는 것"** 패널이 그 객체에 관한 기억을 상태와 함께 보여 준다. 기억 자체의 화면은 `/memory` (열 기반) — `/o/memory/<id>` 는 그리로 보낸다.
