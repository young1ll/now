# 기억 · 지식 · 검색 설계 (v0.4 방향)

> 상태: **M1 · M2 · M3 구현됨** (§11 · §12 · §13), M4 이후 설계안. 구현하면서 바뀌는 부분은 이 문서를 먼저 고친다.
> 전제: [ONTOLOGY.md](ONTOLOGY.md) 의 의미(semantic) · 행동(kinetic) 계층, [AGENTS.md](AGENTS.md) 의 단일 관문(`executeAction`).

## 0. 한 문장

**AI 의 기억은 온톨로지 안의 객체이고, 쓰기는 액션이며, 벡터는 언제든 버리고 다시 만들 수 있는 캐시다.**

이 한 문장에서 나머지가 다 따라 나온다.

- 기억이 객체이므로 사람이 같은 화면(열 기반 탐색기, 그래프, 승인함)에서 보고 고친다. 별도의 "AI 전용 블랙박스"가 없다.
- 쓰기가 액션이므로 누가 · 무엇을 근거로 · 언제 기억했는지가 감사 로그(`action_runs`)에 남는다. 위험도 · 정책 · AI 모드가 그대로 적용된다.
- 벡터가 캐시이므로 임베딩 모델을 바꾸거나 없어도 시스템이 돌아간다. 원본(source of truth)은 항상 SQLite 의 행이다.

## 1. 개념 정리 — 무엇을 "기억"이라 부르는가

인지과학의 기억 분류를 그대로 가져오되, 이미 있는 자산에 대응시킨다.

| 종류 | 질문 | Now 에서의 실체 | 수명 | 누가 쓰나 |
|---|---|---|---|---|
| **작업 기억** (working) | 지금 이 일에 필요한 것 | 세션의 *컨텍스트 팩* (아래 §5) | 세션 1회 | 런타임이 조립 |
| **일화 기억** (episodic) | 무슨 일이 있었나 | `events` · `action_runs` · `agent_sessions` (이미 있음) + **에피소드 요약** (신규) | 영구 (요약은 재생성 가능) | 시스템 자동 |
| **의미 기억** (semantic) | 무엇이 사실인가 | ① 온톨로지 객체·링크 (구조화된 사실) ② **`memory` 객체** (구조로 못 담는 원자적 믿음) | 유효기간까지 | AI 제안 · 사람 확정 |
| **절차 기억** (procedural) | 어떻게 하나 | **플레이북** 문서 (단계가 액션을 참조) | 버전 관리 | 사람 작성 · AI 개정 제안 |
| **지식** (knowledge) | 세상/문서가 뭐라고 하나 | `notes` → **문서 + 청크** (출처·버전) | 문서 수명 | 누구나 |

핵심 구분 세 가지.

1. **지식 ≠ 기억.** 지식은 "문서가 이렇게 말한다" (출처가 주인), 기억은 "우리는 이렇게 믿고 운영한다" (근거를 인용하는 원자적 주장). 계약서 PDF 는 지식이고, "고객 A 는 매월 5일에 결제한다"는 그 계약서와 입금 기록 3건을 근거로 한 기억이다.
2. **기억 ≠ 온톨로지 사실.** 구조로 담을 수 있으면 구조로 담는다 (`client.payment_day = 5`). `memory` 는 구조가 아직 없는 것 — 선호, 뉘앙스, 교훈, 예외 — 의 착륙장이다. 같은 기억이 반복 사용되면 **승격**을 제안한다 (§3.4).
3. **대화 로그 ≠ 기억.** 세션 기록 원문은 일화의 원료일 뿐, 그대로 벡터화해 다시 주입하지 않는다 (잡음·프롬프트 주입 경로·토큰 낭비). 요약 → 주장 추출 → 검증을 거친 것만 기억이 된다.

## 2. 데이터 모델 (초안 — 실제 마이그레이션 4 는 §11 참고)

모든 테이블은 `lib/db/migrations.ts` 배열 **끝에 추가**한다. 기존 `notes` 는 유지하고 문서 계층이 감싼다.

```sql
-- 의미 기억: 원자적 주장 하나 = 한 행
CREATE TABLE memories (
  id            INTEGER PRIMARY KEY,
  business_id   INTEGER REFERENCES businesses(id),     -- NULL = 전역(운영자 개인)
  kind          TEXT NOT NULL CHECK (kind IN ('fact','preference','lesson','procedure_hint','caution')),
  statement     TEXT NOT NULL,                          -- 한 문장, 자기완결적 ("그 고객" 금지)
  status        TEXT NOT NULL DEFAULT 'proposed'
                CHECK (status IN ('proposed','active','verified','disputed','superseded','retired')),
  confidence    REAL NOT NULL DEFAULT 0.5,              -- 0..1, 작성자 자기평가 → 근거·사용으로 보정
  origin        TEXT NOT NULL CHECK (origin IN ('human','agent','consolidation','import')),
  tainted       INTEGER NOT NULL DEFAULT 0,             -- 외부 비신뢰 입력(메일·웹훅)에서 유래
  pinned        INTEGER NOT NULL DEFAULT 0,             -- 항상 컨텍스트에 포함
  valid_from    TEXT, valid_to TEXT,                    -- 사실의 유효기간 (YYYY-MM-DD)
  supersedes_id INTEGER REFERENCES memories(id),        -- 정정 = 새 행 + 이전 행 superseded
  created_run   INTEGER REFERENCES action_runs(id),     -- 어느 액션이 만들었나 (작성자·시각은 여기서)
  verified_by   TEXT, verified_at TEXT,
  last_used_at  TEXT, use_count INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- 기억의 주어/근거는 기존 1급 링크를 재사용: link_types 에 'about', 'evidenced_by', 'contradicts' 추가
--   memory:12 --about--> client:3
--   memory:12 --evidenced_by--> invoice:41 / note:7 / run:120 / document:9

-- 문서(지식): notes 를 감싸 버전·출처를 붙인다
CREATE TABLE documents (
  id INTEGER PRIMARY KEY, business_id INTEGER REFERENCES businesses(id),
  kind TEXT NOT NULL CHECK (kind IN ('note','playbook','source','episode','brief')),
  title TEXT NOT NULL, note_id INTEGER REFERENCES notes(id),
  source_uri TEXT, source_hash TEXT,                    -- 외부 원본 (URL·파일) 과 내용 해시
  version INTEGER NOT NULL DEFAULT 1, tainted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- 검색 단위. 문서만이 아니라 객체·기억도 청크가 된다 ("무엇이든 찾을 수 있다")
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,
  owner_type TEXT NOT NULL, owner_id INTEGER NOT NULL,  -- document | memory | client | task | …
  business_id INTEGER, seq INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL, tokens INTEGER NOT NULL,
  content_hash TEXT NOT NULL,                           -- sha256(정규화된 text) — 재임베딩 판단 기준
  UNIQUE (owner_type, owner_id, seq)
);
CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='id', tokenize='trigram');

-- 임베딩 공간 = (제공자, 모델, 차원, 양자화). 모델 교체 = 새 공간을 뒤에서 채운 뒤 원자적 전환
CREATE TABLE embedding_spaces (
  id INTEGER PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, dim INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('building','active','retired')),
  local_only INTEGER NOT NULL DEFAULT 1,                -- 외부 API 로 본문을 보내도 되는가
  created_at TEXT NOT NULL
);
CREATE TABLE embed_queue (                              -- outbox 이벤트로 채워지는 작업 큐
  chunk_id INTEGER NOT NULL, space_id INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chunk_id, space_id)
);
```

벡터 자체는 **본 DB 밖**, 파생 전용 파일 `data/now-vec.db` 에 둔다 (`ATTACH`).

- 백업(`VACUUM INTO`)이 벡터로 부풀지 않는다. 벡터는 백업하지 않고 복원 후 재생성한다.
- 손상·모델 교체 시 파일을 지우면 끝. 원본 행과 `content_hash` 로 언제든 재구축.
- `vec0` 가상 테이블: `CREATE VIRTUAL TABLE vec_<space> USING vec0(business_id integer partition key, e bit[D], +f float[D])` — 파티션 키로 사업 단위 스캔을 줄이고, `bit` 로 1차 후보, 보조 컬럼(`+f`)의 float 로 재정렬.

## 3. AI · 사람 공동 관리 — 기억의 생애

### 3.1 상태 기계

```
            memory.propose (agent)                 memory.confirm (human)
  (없음) ─────────────────────────▶ proposed ──────────────────────────────▶ verified
     │                                │  ▲   │                                   │
     │ memory.record (human)          │  │   │ 신뢰 사다리 충족 시 자동             │ memory.correct
     └──────────▶ verified            │  │   ▼                                   ▼
                                      │  │  active ── 충돌 감지 ──▶ disputed   새 행(verified) + 이전 행 superseded
                                      │  └── memory.resolve ◀──────────┘
                                      └── 만료(미사용·미확인 N일) / memory.retire ──▶ retired
```

- **사람이 말한 것은 곧바로 `verified`.** 사람이 콘솔·CLI·채팅에서 "앞으로 이 고객은 세금계산서 월말 일괄 발행"이라고 적으면 `memory.record`.
- **AI 가 추론한 것은 `proposed`.** `tainted` 가 아니고, 해당 에이전트의 신뢰 등급이 충분하고(§6.3), 근거 링크가 2개 이상이면 `active` 로 바로 쓸 수 있다. 그 외에는 승인함의 **기억 검토** 줄에 쌓인다.
- `active` 는 "쓸 수 있지만 사람이 아직 보지 않음". 컨텍스트 팩에서 `verified` 와 구분 표시되어 AI 스스로 무게를 다르게 둔다.
- **정정은 수정이 아니라 대체.** `memory.correct` 는 새 행을 만들고 이전 행을 `superseded` 로 둔다. "AI 가 언제부터 무엇을 믿었나"를 되짚을 수 있어야 why-탐색기가 성립한다.

### 3.2 액션 목록 (전부 `lib/ontology/actions/memory.ts`)

| 액션 | 누가 | 위험도 | 비고 |
|---|---|---|---|
| `memory.propose` | AI | low | 근거 링크 필수. 저장 전 유사 기억 검색 → 중복이면 기존 행 `use_count`·근거만 보강 |
| `memory.record` | 사람 | low · `humanOnly` | 즉시 verified |
| `memory.confirm` / `memory.reject` | 사람 | low · `humanOnly` | 승인함 일괄 처리 지원 |
| `memory.correct` | 사람 · AI | 사람 low / AI **high** | AI 가 verified 기억을 뒤집으려면 승인 필요 |
| `memory.retire` | 사람 · AI | verified 이면 high, 아니면 low | 함수형 위험도 |
| `memory.pin` | 사람 | `humanOnly` | 항상 주입 — 토큰 예산을 쓰므로 사람만 |
| `memory.resolve` | 사람 | `humanOnly` | 충돌 해결: 둘 중 하나 선택 또는 둘 다 정정 |
| `memory.promote` | AI 제안 · 사람 승인 | high | 기억 → 구조화된 속성/규범 (§3.4) |

### 3.3 충돌 · 오염 방지

- **충돌 감지**: `propose`/`record` 시 같은 `about` 대상의 기억 중 벡터 유사도 ≥ 0.85 (또는 FTS 상위) 를 뽑아, 규칙(같은 속성·다른 값) → 필요 시 LLM 판정으로 모순 여부 확인. 모순이면 둘 다 `disputed` + `contradicts` 링크 + 신호 `memory_conflict` (승인함 노출).
- **프롬프트 주입 차단**: 비신뢰 입력(메일 본문, 웹훅 페이로드, 스크랩한 웹페이지)에서 나온 문서·기억은 `tainted=1`. tainted 기억은 사람 확인 없이 `active`/`verified` 가 될 수 없고, 컨텍스트 팩에서는 v0.3 의 `<event-data>` 와 같은 방식으로 **데이터로만 펜스** 친다. 명령형 문장("~하라")은 기억 문장으로 받지 않는다 (propose 검증 단계에서 거부).
- **비밀값**: 청크화 전에 토큰·키 패턴을 가린다 (`nows_`, `now_`, `sk-…`, `AKIA…` 등). 임베딩 제공자로 나가는 텍스트에도 동일.

### 3.4 승격 경로 — 기억이 구조가 되는 순간

`use_count` 가 높고 verified 인 기억 중 "대상·속성·값" 형태로 파싱되는 것을 큐레이터가 주 1회 모아 `memory.promote` 로 제안한다.

- "고객 A 는 매월 5일 결제" → 고객 속성 `payment_day=5` (v0.4 사용자 정의 속성) 또는 다음 단계의 **규범/약속**(commitment: "매월 5일까지 입금")으로.
- 승격되면 기억은 `superseded`, 대체물로 링크된다. 이렇게 **비정형 → 정형**으로 흐르는 파이프가 온톨로지를 사용하면서 자라게 만드는 엔진이다.

## 4. 지식베이스

- `notes` 는 그대로 두고 `documents(kind='note')` 가 감싼다. 새 입력 경로: 파일(텍스트·마크다운·PDF 텍스트), URL 스냅샷, 메일(추후 연동) → `document.ingest` 액션 (외부 fetch 가 없으면 low).
- **플레이북** (`kind='playbook'`): 마크다운 + 단계마다 액션 참조 (`[[action:invoice.issue]]`). AI 가 자율 실행하는 플레이북의 변경은 AI 행동을 바꾸므로 **high** (사람 승인). 실행 결과는 에피소드로 남고 "이 플레이북이 몇 번 성공/실패했나"가 문서 옆에 보인다.
- **에피소드** (`kind='episode'`): 세션 종료·하루 마감 시 워커가 만든 요약. 원문 대신 이것을 청크화한다. 요약에는 사용한 기억 id, 실행한 액션 run id 가 링크로 붙는다.
- **브리프** (`kind='brief'`): 아침 브리핑 같은 AI 산출물. 읽고 버려도 되지만 검색은 된다.

## 5. 검색 — 하이브리드 회상 (`recall`)

하나의 질의로 세 신호를 합친다.

1. **어휘** — `chunks_fts` (trigram, 한국어 부분일치에 이미 강함). 고유명사·번호(사업자번호, 청구서 번호)에 결정적.
2. **의미** — 활성 임베딩 공간에서 KNN. 동의어·다른 표현.
3. **관계** — 1·2 의 상위 결과가 가리키는 객체에서 그래프 1홉 확장 (`neighborhood`, 이미 있음). 질의에 대상(`client:3`)이 주어지면 그 이웃을 먼저.

**융합**: Reciprocal Rank Fusion (k=60) → 가중치 보정.

```
score = RRF(fts, vec, graph)
      × status_weight   (verified 1.0 · active 0.8 · proposed 0.5 · disputed 0.2)
      × recency         (문서: 반감기 180일 · 에피소드: 30일 · 기억: 미적용, valid_to 로 컷)
      × (tainted ? 0.7 : 1)
```

**컨텍스트 팩** — 세션 시작·도구 호출 시 조립되는 작업 기억.

- 순서: `pinned` → 대상 객체의 verified/active 기억 → `recall(task)` 상위 → 관련 플레이북.
- 토큰 예산 기본 2,000 (프로필별 조정). 각 항목에 `[mem:12]` 같은 id 를 달아 주입하고, AI 가 인용한 id 는 `last_used_at`·`use_count` 를 갱신 → 안 쓰이는 기억은 자연 소멸, 자주 쓰이는 기억은 승격 후보.
- 팩은 결정적이다 (같은 상태 → 같은 팩). 세션 기록에 팩 해시를 남겨 why-탐색기에서 "그때 AI 가 본 것"을 재현.

## 6. 에이전트 구조

### 6.1 역할은 적게, 권한은 좁게

| 역할 | 무엇 | 쓰는 액션 | LLM |
|---|---|---|---|
| **운영자** (operator) | 현재의 범용 AI 세션 | 전부 (정책 적용) | O |
| **큐레이터** (curator) | 에피소드 요약 · 기억 추출 · 중복 병합 · 만료 · 승격 제안 | `memory.*`, `document.*` 만 | O (저렴한 모델 가능) |
| **조정자** (reconciler) | 신호·규범 평가 (다음 단계에서 하드코딩 신호를 대체) | 없음 (이벤트만 냄) | X |
| **임베더** | 청크 → 벡터 | 없음 (파생 데이터만) | 임베딩 모델 |

멀티에이전트 대화 구조(에이전트끼리 협상)는 도입하지 않는다. 조정은 **공유 온톨로지 + 이벤트**로 한다 — 에이전트끼리 말하지 않고, 같은 세계를 보고 액션으로 바꾼다. 이것이 사람이 끼어들 수 있는 이유다.

에이전트 정의에 `role`, `allowed_actions` (glob), `business_scope`, `memory_scope` 를 추가한다 (v0.4 로드맵의 "에이전트별 권한 범위"와 같은 작업).

### 6.2 새 MCP 도구 (REST `/api/v1/tools/*` 동일)

| 도구 | 역할 |
|---|---|
| `recall(query, about?, kinds?, k?)` | 하이브리드 검색. 결과마다 출처 ref·상태·점수 구성 |
| `get_context(about? , task?)` | 컨텍스트 팩 그대로 반환 (로컬 CLI 에이전트도 같은 팩을 받는다) |
| `remember(statement, kind, about[], evidence[])` | `memory.propose` 의 얇은 래퍼 |
| `cite(memory_ids[])` | 사용 기록 (팩 밖에서 recall 로 찾은 기억을 썼을 때) |

기존 `search_objects` 는 `recall` 의 어휘 전용 모드로 흡수하되 이름은 호환 유지.

### 6.3 신뢰 사다리와의 연결

`(agent, action)` 별로 최근 N건의 승인/거절/사후 정정 비율을 집계한다. 기억에 대해서는 **"proposed 가 verified 된 비율"**과 **"사람이 정정한 비율"**이 에이전트의 기억 신뢰도다. 임계를 넘으면 해당 에이전트의 `memory.propose` 는 `active` 로 바로 착지한다. 등급은 올라갈 때 사람 승인, 내려갈 때 자동.

## 7. 벡터화 — 성능 설계

### 7.1 실측 (sqlite-vec 0.1.9, 이 개발 컨테이너, 768차원, k=20, 전수 스캔)

| 청크 수 | float32 p50 | int8 p50 | bit p50 (k=200) |
|---|---|---|---|
| 20,000 | 25 ms | 12 ms | 5 ms |
| 100,000 | 127 ms | 53 ms | 27 ms |

1인 사업의 현실적인 규모는 **1만~5만 청크** (문서 수천 개 + 객체 카드 + 기억 + 에피소드). 이 범위에서는 ANN 인덱스(HNSW 등)나 별도 벡터 DB 가 필요 없다. **bit 1차 후보 200 → float 재정렬 20** 이면 5만 청크에서도 p95 < 20ms 를 목표로 잡을 수 있다. 별도 벡터 서버(Qdrant·pgvector·Neo4j vector)는 도입하지 않는다 — 로컬 우선 · 단일 파일 백업 원칙과 충돌하고, 이 규모에서 이득이 없다. 50만 청크를 넘으면 그때 재평가한다.

### 7.2 쓰기 경로 — 요청 경로에서 절대 임베딩하지 않는다

```
액션 실행 ──▶ outbox 이벤트 (이미 있음)
              │
              ▼  워커 tick
         청크화 (동기, 저렴) ──▶ content_hash 비교 ──▶ 바뀐 청크만 embed_queue
                                                          │  배치 64 · 제공자별 동시성 1~2 · 지수 백오프
                                                          ▼
                                               now-vec.db upsert (bit + float)
```

- **해시로 중복 제거**: 같은 텍스트(다른 문서의 같은 문단, 수정 안 된 문단)는 다시 임베딩하지 않는다. 문서 수정 시 바뀐 문단만 재계산.
- **청크화 규칙**
  - 문서: 제목 경로(`# > ##`)를 앞에 붙인 문단 묶음, 목표 350 토큰 · 상한 512 · 겹침 없음 (제목 경로가 문맥 역할).
  - 객체: **객체 카드** 한 장 — 스키마(`PROPERTIES`)로 렌더한 한국어 요약 + 주요 링크 이름. 속성 변경 시 해시가 바뀌면 재생성.
  - 기억: 문장 하나 = 청크 하나.
  - 에피소드: 요약만. 세션 원문은 청크화하지 않는다.
- **질의 임베딩 캐시**: 정규화된 질의 → 벡터 LRU (메모리 1,000개). 에이전트는 비슷한 질의를 반복한다.
- **검색 지연 예산** (로컬 Ollama 기준): 질의 임베딩 20~60ms + FTS 5ms + KNN 10ms + 그래프 확장 5ms ≈ **p95 100ms**. 외부 API 임베딩은 질의 임베딩이 150~400ms 로 지배적 → 캐시가 중요.

### 7.3 임베딩 제공자

`embedding_spaces` 행 하나 = (제공자, 모델, 차원, 주소, 접두사). 제공자는 전부 **HTTP 어댑터**(`lib/knowledge/embed.ts`)다.

| 제공자 | 기본 모델 (예시) | 전송 | 비고 |
|---|---|---|---|
| Ollama (로컬) | `bge-m3` (1024, 다국어·한국어 양호) | 로컬 | **기본값.** `POST /api/embed`. 연결 실패 시 "`ollama pull bge-m3` 후 실행" 안내 |
| OpenAI 호환 | LM Studio · vLLM · llama.cpp · TEI · Infinity 의 아무 모델 | 주소가 localhost·사설망·`.local`·`host.docker.internal` 이면 로컬, 아니면 외부 | `POST {base}/embeddings`, 키는 있으면 |
| OpenAI | `text-embedding-3-small` | 외부 | 키 필수 (`OPENAI_API_KEY`) |
| Gemini | `gemini-embedding-001` | 외부 | `batchEmbedContents`, 키는 `x-goog-api-key` 헤더 (URL 에 넣지 않음), taskType 질의/문서 구분 |
| Voyage | `voyage-3.5` 계열 | 외부 | Anthropic 권장 임베딩 (Anthropic 자체 임베딩 API 는 없음). input_type 질의/문서 구분 |
| 없음 | — | — | **FTS + 그래프만으로 동작** (의미 질의 품질만 떨어짐) |

- **in-process 모델(transformers.js·ONNX)은 넣지 않았다.** 이 개발 환경에서는 Hugging Face 가 막혀 있어 모델을 받아 검증할 수 없고, 검증 못 한 경로를 기본값으로 둘 수 없다. 로컬 실행은 Ollama/OpenAI 호환 서버로 한다 (HTTP 로만).
- e5 계열처럼 질의/문서 접두사가 필요한 모델은 공간의 `query_prefix`·`passage_prefix` 로 (폼 입력은 앞뒤 공백이 잘리므로 콜론으로 끝나면 공백 한 칸을 붙인다).
- 외부 임베딩 = 사업 데이터가 밖으로 나감. `embedding.space_create` · `embedding.activate` 는 공간이 로컬이 아니면(`local_only=0`) **high**, 세 액션 모두 `humanOnly`.
- **모델 교체**: 새 공간 `building` → 워커가 뒤에서 채움 (시스템 화면에 % 표시) → 100% 가 되면 `embedding.activate` 로 전환 (`force` 로 강제 가능) → 이전 공간 `retired` → 시간당 정리(`gcVectors`)에서 knn 테이블 DROP · 벡터 삭제. 교체 중에도 검색은 이전 공간으로 계속된다.

### 7.4 품질 측정

"잘 찾는가"를 감으로 두지 않는다.

- `tests/fixtures/recall.jsonl`: (질의, 기대 ref) 골든셋 — 시드 데이터 기준 30개부터.
- `npm run eval:recall` → recall@5 · MRR · p95 지연을 FTS 단독 / 벡터 단독 / 하이브리드별로 출력. CI 에서는 FTS+그래프 모드(임베딩 없이)만 회귀 검사.
- 시스템 화면에 임베딩 공간 상태(청크 수, 큐 적체, 실패, 마지막 처리 시각)를 IaC 감사처럼 노출.

## 8. 사람 쪽 화면

- **`/memory` — 열 기반**: `검토 대기(proposed · disputed) │ 기억 상세(문장 · 근거 · 사용 이력 · 정정 계보) │ 관련(대상 객체 · 충돌 상대 · 그래프)`. 키보드로 확인/거절/정정 연속 처리 (승인함과 같은 리듬).
- **객체 화면의 "AI 가 아는 것" 패널**: `client:3` 을 열면 그 고객에 대한 기억이 상태별로. 사람이 여기서 바로 고치면 `memory.correct`.
- **검색 `/search` 를 recall 로 교체**: 결과마다 왜 나왔는지(어휘 / 의미 / 관계) 태그.
- **why-탐색기의 첫 버전**: 세션 상세에서 "이 결정에 쓰인 기억·문서" 목록 (팩 해시 + 인용 id 로 재현).

## 9. 구현 순서와 완료 기준

앞서 합의한 로드맵(메타 온톨로지 → 약속·규범·조정 → 근거·커넥터 → 예외 중심 UI·신뢰 사다리 → 도메인 팩)과 충돌하지 않도록, 기억 계층은 **기존 7개 객체 유형 위에서 먼저** 동작하게 만들고 메타 온톨로지가 들어오면 `about` 링크 대상만 넓어지게 한다.

| 단계 | 내용 | 완료 기준 |
|---|---|---|
| **M1 검색 기반** ✅ | `chunks`·`chunks_fts`·`chunks_words`, 객체 카드, 색인 워커, `recall`(FTS+그래프), `/search` 교체, 골든셋·`eval:recall` (`documents` 는 M4 로) | 임베딩 없이 recall@5 기준선 측정, 기존 테스트 전부 통과 — §11 |
| **M2 벡터** ✅ | `embedding_spaces`·`now-vec.db` (`embed_queue` 대신 해시 LEFT JOIN — §12), Ollama/OpenAI 호환/OpenAI/Gemini/Voyage 임베더, bit→float 재정렬, 공간 교체 | 5만 청크 합성 데이터 p95 < 20ms (KNN), 하이브리드 recall@5 > FTS 단독 |
| **M3 기억** ✅ | `memories` · `memory_uses` + 액션 10종 + 링크 유형 4종(`*` 도착), 어휘 중복·숫자 충돌, tainted 상속, 컨텍스트 팩, `/memory` 화면, MCP `remember`·`get_context`·`cite` | AI 가 제안 → 사람 확인 → 다음 세션 팩에 등장하는 E2E, 충돌 신호 E2E — §13 |
| **M4 큐레이터** | 에피소드 요약, 기억 추출·병합·만료, 승격 제안, 플레이북 문서 | 매일 밤 큐레이터 실행 결과가 승인함에 "기억 검토 n건"으로 나타남 |
| **M5 신뢰** | 에이전트 역할·범위, 기억 신뢰도 집계, 자동 착지 | 등급 상승은 사람 승인, 하락은 자동 — 테스트로 고정 |

M1 → M3 까지가 "AI 와 사람이 함께 관리하는 기억/지식"의 최소 완성형이다. M2 는 M1 과 병행 가능하며, 임베딩이 없어도 M3 이 동작하도록 설계한다.

## 10. 하지 않기로 한 것

- **벡터 전용 DB · 외부 메모리 서비스** — 규모 대비 이득 없음, 로컬 우선·단일 파일 원칙 위반.
- **대화 원문 전체 벡터화** — 잡음, 주입 경로, 토큰 낭비. 요약·주장만.
- **AI 가 사람 확인 없이 verified 기억을 바꾸는 것** — 항상 high.
- **기억을 시스템 프롬프트에 무제한 누적** — 팩은 예산·결정성·인용 추적이 있는 것만.
- **Neo4j 를 원본으로** — 계속 분석용 복제본. 벡터도 Neo4j 에 넣지 않는다.

## 11. M1 구현 기록 (v0.4)

### 무엇이 들어갔나

| 위치 | 내용 |
|---|---|
| 마이그레이션 4 | `chunks` (+ `head` 제목 줄) · `chunks_fts` (trigram) · `chunks_words` (unicode61, 어절 접두) — 트리거로 동기화 |
| `lib/knowledge/cards.ts` | 객체 카드 렌더러: 유형별로 "찾을 때 떠올릴 말"만 — 이름·상태·부모 이름(+식별자)·메모·접촉 이력 20건·청구 품목·입금 방법·사용자 정의 링크(양방향). 개수·잔액 같은 자주 바뀌는 파생값은 뺀다. 문서 본문은 제목 경로가 붙은 ~700자 구획 |
| `lib/knowledge/indexer.ts` | `reindexAll`(멱등, 해시가 같으면 쓰지 않음) · `indexPending`(이벤트 커서 → 바뀐 객체 + 외래키 자식 + 삭제된 객체를 식별자로 품은 카드) · 시간당 전체 스윕 · `ensureIndexed`(워커가 꺼져 있어도 요청 시 증분 반영) |
| `lib/knowledge/recall.ts` | 검색어 분석(조사·어미 제거하되 원형도 유지, 질문어 제거, 끝 명사 = 유형 힌트) → 어휘 후보(bm25 상위, 제목 줄 5배) → idf 채점(필드 이름 제외) → 그래프 확장(사용자 링크 1.0 · 외래키 0.6 · 사업 허브 제외) → RRF(k=20) |
| 표면 | `/search` (근거 태그: 참조·내용·관계·주변, 일치 강조, 유형 탭), MCP·REST `recall`, `now recall`, 시스템 화면의 색인 상태, 워커 틱 |
| 평가 | `tests/fixtures/recall.jsonl` 24건 (어휘 14 · 관계 4 · 참조 1 · 의미 5), `npm run eval:recall [--load N] [--verbose]`, 회귀 테스트 |

### 설계에서 바뀐 것

- **`documents` 테이블은 M4 로 미룸.** M1 에서는 `notes` 가 곧 문서다. 외부 원본·에피소드·플레이북이 생길 때 도입한다.
- **2글자 검색어.** trigram 은 2글자(고객·계약·마감)를 못 찾는다. 색인이 5,000 구획 이하면 `LIKE`(어절 중간까지 정확), 그보다 크면 `chunks_words` 어절 접두 검색(`고객*` → 고객에게). 큰 색인에서 "법인카드"의 "카드" 같은 합성어 중간 일치는 잃는다 — M2 벡터가 메운다.
- **필드 이름은 일치가 아니다.** 모든 업무 카드에 "마감:" 이 있으므로 채점 텍스트에서 필드 이름을 뺀다 (후보 검색에는 남는다).
- **관계 신호의 허브 문제.** 사업은 모든 객체와 연결돼 관계 순위 1위를 차지했다 → 확장에서 제외 (사업은 관계가 아니라 범위). 관계로만 들어온 결과는 최대 3개.
- **카드에 부모 식별자.** "고객: 한빛상사 (CLT-0001)" — 부모가 삭제되면 외래키는 이미 NULL 이라 따라갈 수 없으므로, 식별자로 FTS 에서 찾아 다시 렌더한다. 식별자로 찾기도 된다.

### 측정 (이 개발 컨테이너)

| 조건 | R@1 | R@5 | MRR | p50 | p95 |
|---|---|---|---|---|---|
| 예시 데이터 (49 객체 / 57 구획), 어휘만 | 0.75 | 0.96 | 0.84 | 1 ms | 2 ms |
| 〃 하이브리드 | 0.75 | 0.96 | 0.85 | 2 ms | 3 ms |
| + 합성 50,000 구획 (질의와 같은 어휘로 만든 최악 조건), 하이브리드 | 0.67 | 0.88 | 0.76 | 32 ms | 47~57 ms |

- 어휘·관계·참조 질의는 5만 구획 잡음 속에서도 전부 5위 안. 무너지는 것은 **의미 질의**("클라우드 서버 비용" → AWS, "신규 문의 들어온 가게" → 카페 온도): 50k 에서 0.40. 이것이 M2 의 목표치다.
- 첫 구현(검색어별 전체 id 수집 + LIKE 스캔)은 50k 에서 p50 1.4초였다. bm25 상위 후보 + 문서빈도 상한 + 어절 접두 색인으로 40배 줄였다.
- 이 규모의 골든셋에서는 하이브리드와 어휘만의 차이가 작다 — 카드가 이미 링크 상대의 이름을 텍스트로 품기 때문. 관계 신호는 순서를 바로잡는 역할 (예: "누가 카페 온도를 소개했나" 3위 → 2위). 골든셋을 실제 사용 질의로 키우는 것이 다음 과제.

## 12. M2 구현 기록 (v0.4)

### 무엇이 들어갔나

| 위치 | 내용 |
|---|---|
| 마이그레이션 5 | `embedding_spaces` (공급자·모델·차원(0 = 첫 응답에서 확정)·주소·키 환경변수 이름·접두사·`local_only`·`auto_activate`·상태·마지막 오류) |
| `lib/knowledge/vectors.ts` | `now-vec.db` 를 `ATTACH … AS vec` (sqlite-vec 적재 실패 시 이유를 기억하고 강등). `vec.vectors(space_id, content_hash, f)` + 공간별 `vec.knn_<id>` = `vec0(e bit[D])`. `storeVectors`(INSERT OR IGNORE, 멱등) · `knn`(bit 후보 `max(k·20, 200)` → float 내적 재정렬) · `gcVectors` · `spaceCoverage` |
| `lib/knowledge/embed.ts` | 공급자 어댑터 5종 (배치 32 · 문서 60초 / 질의 5초 시간 초과 · L2 정규화 · 차원 검증 · 한국어 오류, 키 값은 오류 문구에서도 지움) · `isLocalUrl` |
| `lib/knowledge/embedder.ts` | `embedPending` — building·active 공간마다 벡터 없는 고유 해시(카드 먼저)를 배치로. 실패 시 `last_error` + 지수 백오프(1분×2ⁿ, 최대 1시간, `settings.embed_backoff:<id>`). `auto_activate` 공간은 다 차면 **시스템 액션**으로 활성화(감사 기록). 질의 임베딩 LRU 500 |
| `lib/knowledge/redact.ts` | 색인 단계 비밀값 가림 (`nows_`/`now_` 토큰 · `sk-…` · `AKIA…` · Bearer · PEM 개인 키 · `password: …` 류). 해시도 가린 텍스트로 |
| `lib/knowledge/recall.ts` | `async`. 모드 `hybrid`(참조 + 어휘 + 의미 + 관계 + 주변) · `lexical` · `vector`(의미만, 평가용). 의미 목록 = 질의 임베딩 1회 → KNN `max(k·4, 40)` → 청크 → 소유자별 최고 점수 → `MIN_SEMANTIC` 미만 제외. 관계 씨앗 = 참조 → 어휘·의미 상위를 번갈아. 결과에 `similarity` · `vector` · `degraded` |
| 액션 | `embedding.space_create` (로컬 low / 외부 high) · `embedding.activate` (로컬 low / 외부 high, `force`) · `embedding.retire` — 전부 `humanOnly` |
| 표면 | `/search` 근거 태그 "의미"(green) + 유사도, 상태줄(공간·차원·%) · 강등 경고. `/system` 임베딩 공간 표(상태 · 로컬/외부 · % · 마지막 오류 · 활성화/폐기) · 벡터 파일 경로·크기 · sqlite-vec 오류. 도구·MCP·REST·CLI 의 `recall` 에 `similarity`·`vector`·`degraded`. 도구 실행이 `async` 로 (`callTool`·`handleMcp`) |
| 워커 | 틱: 색인 → 임베딩(`embed: false` 로 끔). 상주 루프에서는 임베딩을 기다리지 않는다. 시간당 스윕 때 `gcVectors` |
| 평가 | `eval:recall` 이 `lexical · vector · hybrid` 출력, `--embed-url/--embed-model/--embed-provider/--query-prefix/--passage-prefix`, `--vec-bench N --dim D` |

### 설계에서 바뀐 것

- **`embed_queue` 테이블 없음.** 할 일 = "청크에는 있는데 이 공간의 벡터에는 없는 해시" 를 `chunks LEFT JOIN vec.vectors` 로 바로 구한다. 큐를 따로 두면 청크 수정·삭제·공간 추가마다 큐를 맞춰야 하는데, 해시 조인은 그 자체로 멱등이고 벡터 파일을 지워도 저절로 다시 채워진다. 5만 청크가 다 찬 상태에서 틱당 약 17ms (이 컨테이너).
- **`+f float[D]` 보조 컬럼 대신 `vec.vectors.f` BLOB.** vec0 보조 컬럼은 KNN 결과 행에서만 읽혀 재정렬에 쓰기 불편하고, 같은 해시를 여러 청크가 공유하므로 (공간, 해시)당 한 행이 맞다. vec0 의 `business_id partition key` 도 뺐다 — 한 해시가 여러 사업의 청크일 수 있고, 범위 필터는 청크로 되돌릴 때 건다.
- **벡터 파일은 연결마다 ATTACH.** 본 DB 가 `:memory:` 이면 벡터도 메모리 (`NOW_VEC_PATH` 보다 우선 — 테스트·평가가 실제 파일을 건드리지 않게). ATTACH 는 트랜잭션 안에서 못 하므로 `embedding.activate` 는 `noTransaction` 으로 먼저 붙이고 상태 변경만 트랜잭션으로.
- **상주 워커는 임베딩을 기다리지 않는다.** 느린 로컬 모델(CPU Ollama 로 128개에 수 초)이 다음 틱의 스케줄·신호 감지를 붙잡지 않도록 background 틱에서는 띄워 두고(`inflight` 로 겹침 방지) 다음 틱으로 넘어간다. `--once`·테스트는 기다린다.
- **질의 캐시 키** = 공간 id + 생성 시각 + 공급자 + 모델 + 주소 + 질의 접두사 + 정규화된 질의 (id 만으로는 DB 를 새로 만들 때 되풀이된다).
- **비밀값 가림의 할당문**은 값만 가리고 키 이름은 남긴다 (`password: [비밀값 가림]`) — "비밀번호가 적힌 메모" 로는 찾을 수 있게. 키 이름 앞에 경계를 두지 않는다(명세 그대로) — `\b` 를 붙이면 `_` 가 단어 문자라 `DB_PASSWORD=` · `client_secret=` · `GITHUB_TOKEN=` 같은 .env 형태를 놓친다.
- **색인 형식 버전** (`settings.index_format`, 현재 `2` = 비밀값 가림). 저장된 값과 다르면 다음 `indexPending`/`ensureIndexed` 가 주기 스윕을 기다리지 않고 전체 재색인한다. M1 에서 가리지 않고 색인한 청크가 업그레이드 직후 만든 (외부) 공간으로 나가지 않도록 — 워커 틱은 색인이 임베딩보다 먼저다. 가림·카드 규칙을 바꾸면 이 값을 올린다. 방어를 한 겹 더: `embedPending` 도 공급자로 보내기 직전에 `redactSecrets` 를 다시 적용한다 (해시는 청크의 것 — 멱등성 유지).
- **벡터 파일 ↔ 본 DB 묶기** (`vec.spaces(space_id, fingerprint)`). 지문 = 본 DB 공간 행의 생성 시각·공급자·모델·주소·문서 접두사. 붙일 때(attach) 지문이 다르거나 없는 공간의 벡터·knn 테이블을 버리고, 쓸 때 다시 확인한다. 본 DB 만 새로 만들거나 복원해 공간 id(1…)가 되풀이돼도 옛 모델 벡터를 "이미 임베딩됨"으로 보거나 옛 차원 knn 테이블에 막혀 영구 실패하지 않는다. `gcVectors` 도 지문이 다른 공간을 정리한다.
- **요청 경로의 질의 임베딩은 짧게.** 문서 배치는 60초지만 질의는 5초(`QUERY_TIMEOUT_MS`) — 넘으면 어휘 + 관계로 강등. 공급자 장애(연결 실패·시간 초과·5xx·429 — `EmbedError.outage`)로 질의가 실패하면 30초 동안 같은 공간에 다시 묻지 않고(프로세스 안 음성 캐시), 워커가 문서 배치에서 장애를 확인해 백오프 중이면(`settings.embed_outage:<id>`) 아예 묻지 않는다. 입력·인증 오류(4xx)는 장애로 보지 않는다 — 문서 하나가 거부됐다고 의미 검색을 끄지 않게. KNN·청크 조회의 SQLite 오류도 `degraded: "벡터 검색 실패 — …"` 로 강등한다.
- **의미 검색을 건너뛰는 질의는 식별자뿐인 질의(`CLT-0003`)만.** 한 글자(돈·차)나 불용어뿐이라 어휘 검색어가 비어도 임베딩한다. 건너뛸 때도 활성 공간이 있으면 `vector` 에 알린다 (`null` = 활성 공간 없음).
- **가중치** ref 3 · lexical 1 · semantic 1 · about 0.7 · graph 0.5 (명세 그대로). 검증용 WordLlama(256차원)로 semantic 0.5~1.5 를 훑었을 때 골든셋 24건의 차이는 MRR ±0.02 안이었다 — 약한 모델 하나에 맞춰 조정하지 않는다. `MIN_SEMANTIC` 0.25 도 그대로 (WordLlama 는 무관한 쌍도 0.3~0.5 라 이 값이 거의 자르지 않는다 — 모델별 분포 차이. 실제 모델(bge-m3)로 재평가할 것).
- **bit 후보 수.** `knn()` 기본은 명세대로 `max(k·20, 200)` 이지만, recall 은 `max(200, 2×요청 수)` 로 부른다 (요청 수 = `max(k·4, 40)`). vec0 의 top-k 선택 비용이 후보 수에 거의 비례하기 때문이다 — 5만 × 1024차원 bit 에서 후보 10 ≈ 3ms · 200 ≈ 14ms · 400 ≈ 33ms · 800 ≈ 70ms · 1600 ≈ 104ms. 명세식(k=10 → 요청 40 → 후보 800)이면 합성 5만 청크 평가에서 vector p50 75ms, 바꾼 뒤 15ms (품질 동일). vec0 의 k 상한은 4096.
- **범위·유형 필터는 KNN 뒤에.** 후보를 청크로 되돌린 다음 사업 범위·유형·알 수 없는 소유자를 거른다. 그래서 좁은 필터(다른 사업이 대부분인 색인에서 한 사업만, 드문 유형만)에서는 의미 목록이 비거나 짧아질 수 있다 — 어휘·관계 목록은 영향 없음. 규모가 커지면 vec0 partition key(사업)나 필터별 후보 확대를 검토.

### 측정 (이 개발 컨테이너)

```bash
npm run eval:recall                                                                  # 공간 없이 (M1 과 같은 수치여야 한다)
npm run eval:recall -- --embed-url http://127.0.0.1:8088/v1 --embed-model wordllama --verbose   # 검증용 WordLlama 256차원
npm run eval:recall -- --embed-url http://127.0.0.1:11434 --embed-provider ollama --embed-model bge-m3
npm run eval:recall -- --vec-bench 50000 --dim 1024
```

| 조건 | 모드 | R@1 | R@5 | MRR | p50 | p95 |
|---|---|---|---|---|---|---|
| 예시 데이터, 공간 없음 | lexical | 0.75 | 0.96 | 0.84 | 0.9 ms | 1.3 ms |
| 〃 | hybrid | 0.75 | 0.96 | 0.85 | 1.7 ms | 3.5 ms |
| 예시 데이터 + WordLlama 256 | lexical | 0.75 | 0.96 | 0.84 | 1.0 ms | 5.6 ms |
| 〃 | vector | 0.46 | 0.83 | 0.60 | 4.9 ms | 12.2 ms |
| 〃 | hybrid | **0.79** | 0.96 | **0.88** | 4.1 ms | 6.9 ms |
| + 합성 50,000 구획 (WordLlama 로 임베딩 58.8초) | vector | | | | 14.6 ms | |
| 〃 | hybrid | | | | 45.2 ms | 71.7 ms |
| 예시 데이터 + bge-m3 1024 (Ollama) | hybrid | 미측정 — 이 환경에는 Ollama 가 없다 (위 명령으로 측정) | | | | |

| `--vec-bench 50000 --dim 1024` | 후보 | knn p50 | knn p95 | recall@10 |
|---|---|---|---|---|
| 무작위 단위 벡터 (bit 양자화 최악 조건) | 200 (기본) | 16.4 ms | 23.8 ms | 0.37 |
| 〃 | 1000 | 108.1 ms | 143.0 ms | 0.67 |
| 군집 벡터 (중심 200 + 잡음) | 200 (기본) | 16.3 ms | 25.4 ms | 0.99 |
| 〃 | 1000 | 107.9 ms | 143.3 ms | 1.00 |

- **WordLlama 는 검증용이다.** 이 개발 환경의 네트워크 정책이 Hugging Face·Ollama 레지스트리를 막아 실제 임베딩 모델(bge-m3·e5)을 받을 수 없었다. WordLlama(정적 토큰 임베딩, PyPI 휠에 가중치 포함)를 OpenAI 호환 서버로 띄워 공급자 경로 전체를 실제 모델로 돌렸다. 약한 모델에서도 하이브리드가 R@1 +0.04 · MRR +0.04 — 의미 질의 품질의 진짜 수치는 bge-m3 로 다시 재야 한다.
- 실제 문장 임베딩은 군집 구조가 있으므로 bit 1차 후보 200 → float 재정렬이 정확 검색과 거의 같다(0.99). 무작위 벡터(0.37)는 이론적 최악 조건. 50k·1024차원 KNN p95 는 약 24ms 로 목표(20ms)를 조금 넘는다 — vec0 의 bit 스캔 자체 비용(≈14ms)이 대부분.
- 5만 구획 하이브리드 p95 72ms 의 대부분은 어휘 후보 채점과 관계 확장이다 (의미 목록 자체는 15ms).

## 13. M3 구현 기록 (v0.4)

### 무엇이 들어갔나

| 위치 | 내용 |
|---|---|
| 마이그레이션 6 | `memories` (상태 6종 · 종류 5종 · 신뢰도 · 출처 · 오염 · 고정 · 유효기간 · 정정 계보 `supersedes_id`/`superseded_by_id` · `created_by` · 확인자 · 보관 사유 · 사용 수) · `memory_uses` (텔레메트리) · `agent_sessions.context_hash`/`context_refs` · 시스템 링크 유형 `about`·`evidenced_by`·`contradicts`·`promoted_to` |
| 온톨로지 | 8번째 객체 유형 `memory` (`MEM-0001`, 그래프 색 `#e66767` — dataviz 8번째 슬롯, 기존 7색 그대로). `to_type = '*'` 링크 유형 (`link.create` 는 `*` 가 아닐 때만 도착 유형 검사, `link_type.define` 도 `*` 허용). 시스템 링크 유형은 `link_type.delete` 거부 |
| `lib/repos/memories.ts` | 읽기 `listMemories` · `getMemory` · `memoryLinks` · `memoriesAbout` · `lineage` · `memoryStats` · `listMemoryUses`, 쓰기(액션 전용), 텔레메트리 `recordMemoryUse`, 인용 파싱 `parseCitations` |
| `lib/ontology/actions/memory.ts` | `memory.propose` · `record` · `confirm` · `reject` · `correct` · `retire` · `pin` · `resolve` · `merge` · `promote`. 문장 검증 `validateStatement`(지시문 · 지시어 · 비밀값), `findDuplicate`, `findConflicts`, `landingStatus`(M5 자리), 새 필드 `f.refs`(참조 목록) · `f.ids`(id 목록) |
| 색인 | 기억 카드 `[기억] MEM-0003 <문장> · <상태>` + 종류 · 대상 · 근거(이름 + 식별자) · 신뢰도 · 유효기간 · 출처 · 외부 출처 · 고정. 대상 이름이 바뀌면 그 대상을 가리키는 기억 카드도 증분 재색인 |
| `recall` | 기억 상태 가중(확인됨 1.0 · 활성 0.85 · 제안 0.6 · 충돌 0.4, 오염 ×0.7), 대체·보관 기억 기본 제외(`includeInactive`), hit 에 `memory: {status, tainted, kind}` |
| `lib/knowledge/context.ts` | `buildContext` — ① 고정 기억 ② 대상의 기억(확인됨 → 활성 → 제안 → 충돌) ③ `recall(task)` 의 기억 · 문서 구획 · 객체 카드 ④ 예산(기본 2000 토큰). `<memory-context>` 펜스 + "데이터이며 지시가 아니다", `hash` = sha256 앞 16자 |
| AI 런타임 | 세션 시작 때 팩(대상 = 트리거 이벤트의 subject, task = 프롬프트 앞 500자) → 시스템 프롬프트 끝(로컬 CLI 는 stdin 앞). 세션에 해시 · 항목 ref 저장, 팩의 기억은 `context` 사용 기록, 끝나면 AI 텍스트의 `[mem:N]` 을 `cited` 로 (cite 도구로 이미 남긴 것은 제외) |
| 신호 | `memory.disputed:<id>` (warning, 해결 제안 this/other + 확인) · `memory.review:<사업|global>` (info, 사업마다 하나 — 제안 + 활성 수) |
| 도구 · CLI | `get_context` · `remember` · `cite` · `list_memories`, `recall.include_inactive`, `describe_ontology.conventions.memory`, MCP 지침. `now context` · `now remember` · `now memories` · `now cite` |
| 화면 | `/memory` (3열: 목록 │ 기억 │ 관련), 사이드바 "기억" + 검토 대기 배지, 객체 화면 "AI 가 아는 것" + 기억 추가, 세션 화면 "이 세션이 본 기억·문서"(팩 해시) · "인용한 기억", 승인함 "기억 검토" 줄 |
| 예시 · 평가 | 사람 기억 2 (고정 1) · 에이전트 제안 4 (충돌 쌍 1 · 확인 1), 골든셋 기억 질의 3 (`kind: "memory"`) |

### 설계에서 바뀐 것

- **사용 기록은 액션이 아니다 (유일한 예외).** `memory_uses` 쓰기와 `use_count`·`last_used_at` 갱신은 `recordMemoryUse` 가 직접 한다 — `agents.last_seen_at` 과 같은 텔레메트리 취급. 컨텍스트에 넣을 때마다·인용할 때마다 감사 로그(`action_runs`)가 쌓이면 감사가 잡음에 묻히고, 이벤트가 발행돼 색인·트리거가 헛돈다. 사용 기록은 사실을 바꾸지 않는다(상태·문장·링크 불변).
- **`created_run` 대신 `created_by`.** 누가·언제는 `action_run_refs` 로 이미 따라갈 수 있고, 행 안의 `created_by`('agent:3')는 목록·카드에서 조인 없이 출처를 보이기 위해서다.
- **액션 10종.** 설계의 8종 + `memory.merge`(M4 큐레이터용) · `memory.record` 분리. `memory.promote` 는 설계의 "AI 제안 · 사람 승인 · high" 대신 사람 전용 · low — 승격은 이미 구조화된 객체를 사람이 만든 뒤의 표시다.
- **중복은 어휘 규칙만.** 같은 사업 범위 · 살아 있는 상태 · about 이 겹치거나 둘 다 없음 · 정규화 문장(공백·문장부호 제거, 소문자)이 같거나 문자 trigram Jaccard ≥ 0.85 — **그리고 숫자가 같을 때만** (아래 충돌 규칙의 숫자 비교). 긴 문장에서 "10% 할인"과 "15% 할인"은 Jaccard 가 0.85 를 넘기 때문에, 숫자가 다르면 중복이 아니라 충돌 후보로 넘긴다. 의미가 같은 다른 표현은 M4 큐레이터가 벡터로 합친다 (액션은 동기라 임베딩을 부르지 않는다).
- **충돌은 숫자·날짜 규칙.** about 이 겹치는 살아 있는 기억 중 숫자를 `#` 으로 바꾼 뼈대가 같거나 trigram Jaccard ≥ 0.7 이고 숫자가 다른 것. 숫자는 **등장 순서대로** 비교한다 — 명세의 "숫자 집합"을 그대로 쓰면 `2026-01-10` 과 `2026-10-01`, "3일 청구 · 10일 입금"과 "10일 청구 · 3일 입금"이 같은 집합이라 모순을 놓친다. 뼈대가 같으면 자리별로, 뼈대가 다르면(어순이 바뀐 비슷한 문장) 순서 없이 비교한다. 점 날짜(`2026.01.10`)는 대시 날짜와 같은 모양(자리마다 하나)으로 정규화한다. **양쪽 모두 숫자가 있어야** 한다 ("할인 가능" → "10% 할인 가능"은 구체화). 설계의 벡터 유사도 · LLM 판정은 M4. 입력 `contradicts` 로 명시 충돌도 가능.
- **에이전트는 확인된 기억을 충돌로 끌어내리지 못한다.** 명세는 "양쪽 disputed" 지만, 에이전트의 제안이 사람이 확인한 기억을 `disputed` 로 바꾸면 "AI 가 사람 확인 없이 verified 기억을 바꾸는 것"(§10)이 저위험으로 열린다. 그래서 행위자가 에이전트면 verified 기억은 충돌의 어느 쪽이든(상대든, 중복 보강 경로에서 자기 자신이 된 기존 기억이든) 상태를 유지하고, 링크 · `memory.disputed` 이벤트 · 신호는 똑같이 생긴다. 사람끼리·제안끼리의 충돌은 명세대로 양쪽 disputed.
- **"사람이 확인한 기억" = 지금 verified · 확인된 적 있음(`verified_at`) · 고정.** 에이전트의 `memory.correct` · `merge` · `retire` 위험도는 이 셋 중 하나면 high 다. 현재 상태만 보면 (사람끼리 충돌로) disputed 가 된 확인 기억을 에이전트가 저위험으로 대체·보관할 수 있다.
- **`business_id` 의 null 도 "지정 안 함".** 사람 폼의 빈 선택('— 없음 —')은 null 로 들어오므로 null 이면 대상의 사업에서 추론한다 (명세 §4 · 필드 도움말). 대상 없이 기록하거나 대상이 여러 사업이면 전역.
- **오염은 나중에 붙은 근거에도 따라간다.** 중복 보강(입력 `tainted` 또는 오염된 근거)과 `link.create` 의 기억 → 오염 기억 `evidenced_by` 도 기억을 tainted 로 만든다. 이미 사람이 확인한(verified) 기억은 새 근거로 흔들지 않는다 (`memory.merge` 와 같은 규칙).
- **사람의 중복 기록은 충돌 중(disputed) 기억도 확인한다** (명세 "중복이면 기존을 verified 로"). `memory.confirm` 과 같다 — 충돌 링크와 상대 상태는 그대로, 해결은 `memory.resolve`.
- **팩의 데이터는 꺾쇠를 전각(＜ ＞)으로 바꾼다.** 펜스 태그를 지우는 방식은 `</memory-</memory-context>context>` 처럼 중첩하면 지운 자리에서 새 태그가 생긴다. 기억 문장 검증도 `memory-context` 태그를 받지 않는다. 지시어·반말 명령형 검사는 어절 단위다 ('단위의'·'차이분석'·이름으로 끝나는 문장은 통과).
- **마이그레이션 6 은 같은 이름의 사용자 링크 유형을 `<이름>_user` 로 옮긴다.** 이전 버전의 `link_type.define` 이 `about` 같은 이름도 받았기 때문 — 그대로 INSERT 하면 업그레이드가 실패해 앱이 뜨지 않는다.
- **기억 액션은 증분 색인에서 그 기억만 다시 렌더한다.** refs 의 대상은 감사·그래프용이고(대상 카드는 기억 링크를 담지 않는다), 대상의 다른 기억까지 따라가면 기억이 많은 고객에서 호출마다 N개를 다시 그린다. 증분 한도(300)는 딸린 객체까지 넓힌 뒤의 수에 건다.
- **`contradicts` · `promoted_to` 는 `link.create` 로 못 만든다.** 기억 상태와 함께 움직여야 하는 링크라 직접 만들면 상태가 어긋난다. `about` · `evidenced_by` 는 허용.
- **기억 링크는 다른 객체의 카드에 넣지 않는다.** 사용자 정의 링크는 양쪽 카드에 들어가는데(§11), 기억까지 그러면 기억 문장이 대상 카드로 복제되어 보관된 기억도 대상 카드로 검색되고, 기억 상태가 바뀔 때마다 대상 카드를 다시 써야 한다.
- **관계 확장에서 기억 이웃은 약하게 (×0.3, 씨앗당 한 번).** 기억이 생기자 예시 데이터의 "hello@ondo.example" 이 hybrid 1위 → 2위로 밀렸다: 카페 온도 기억이 대상 + 근거 두 링크로 이어져 고객의 실제 관계(소개자)보다 관계 점수가 높아졌기 때문. 기억은 대상에 붙은 주석이지 구조적 관계가 아니다.
- **보관된 기억은 관계 확장의 씨앗도 되지 않는다.** 결과에서만 빼면 보관된 기억의 대상이 "관계"로 끌려 들어온다.
- **빈 팩은 빈 문자열.** 넣을 기억·문서가 없으면 펜스도 없다 — 시스템 프롬프트와 로컬 CLI stdin 이 M2 와 같다. 팩은 유효기간(`valid_from`~`valid_to`)이 오늘을 포함하는 기억만 넣고, 예산을 넘으면 거기서 멈춘다 (뒤의 짧은 항목으로 건너뛰지 않는다 — 순서가 곧 우선순위).
- **`remember` 결과의 `status` 는 실행 상태**(applied · pending · failed · denied — `run_action` 과 같다), 기억의 상태는 `memory_status`. 명세의 "status" 를 기억 상태로 덮어쓰면 에이전트가 승인 대기·실패를 구별하지 못한다.
- **`list_memories` 도구 추가** (`now memories` 용). `search_objects` 는 상태 필터가 없다.
- **기본 신뢰도**: 사람 0.9 · 에이전트 0.5 (입력으로 덮어쓸 수 있다). 중복 보강마다 +0.1 (최대 1).
- **`memory.review` 는 사업마다 + 전역(`business_id` NULL) 하나.** 사업 범위를 고르면 그 사업과 전역 기억만 센다 (전역 기억은 모든 범위에서 보인다).
- **인용 추적.** 런타임 세션 안의 도구 호출은 `ToolCtx.sessionId` 를 받아 `cite`·`get_context` 사용 기록이 세션에 묶인다. MCP·REST 로 들어온 외부 에이전트의 사용 기록은 세션 없이 행위자로만 남는다.

### 측정 (이 개발 컨테이너)

```bash
npm run eval:recall
npm run eval:recall -- --embed-url http://127.0.0.1:8088/v1 --embed-model wordllama --verbose
```

| 조건 | 모드 | R@1 | R@5 | MRR | 종류별 R@5 |
|---|---|---|---|---|---|
| 예시 데이터 (55 객체 / 61 구획), 공간 없음 · 골든셋 27건 | lexical | 0.70 | 0.96 | 0.81 | 어휘 1.00 · 참조 1.00 · 관계 1.00 · 의미 0.80 · 기억 1.00 |
| 〃 | hybrid | 0.70 | 0.96 | 0.81 | 〃 |
| 〃 + WordLlama 256 | vector | 0.48 | 0.81 | 0.60 | 어휘 0.86 · 관계 1.00 · 의미 0.80 · 기억 0.67 |
| 〃 | hybrid | 0.78 | 0.96 | 0.85 | 어휘 1.00 · 참조 1.00 · 관계 1.00 · 의미 0.80 · 기억 1.00 |

- 기존 24건만 보면 hybrid 의 R@1 은 M2 와 같다 (18/24). 순위가 바뀐 것은 의미 질의 "계약 갱신 협상 중인 거래처" 3 → 4위 하나 (새 기억이 같은 말을 품어서). 전체 R@1 이 0.75 → 0.70 인 것은 새 기억 질의 3건 중 2건이 1위가 아니기 때문이다 — "카페 온도 규모 기억"은 **제안 상태 ×0.6** 가중으로 4위(확인되지 않은 기억을 일부러 낮게 둔다), "Acme SSO 요구 기억"은 hybrid 에서 관계 신호를 받은 고객 카드가 1위 · 기억 2위.
- 어휘 모드에서 "SSO 요구하는 고객" 은 확인된 기억(MEM-0003)이 1위, 고객이 2위가 되었다. 기억이 질문의 답 그 자체라 퇴행으로 보지 않는다 (hybrid 에서는 고객 1위).
