# 기억 · 지식 · 검색 설계 (v0.4 방향)

> 상태: **설계 확정안 / 미구현**. 구현하면서 바뀌는 부분은 이 문서를 먼저 고친다.
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

## 2. 데이터 모델 (마이그레이션 4 초안)

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

기존 `ai_profiles` 와 같은 방식으로 `embedding_spaces` 가 제공자를 참조한다.

| 제공자 | 기본 모델 (예시) | 비고 |
|---|---|---|
| Ollama (로컬) | `bge-m3` (1024, 다국어·한국어 양호) | **기본값.** 본문이 기기를 떠나지 않음 |
| OpenAI | `text-embedding-3-small` (차원 축소 512 가능) | 외부 전송 → `local_only=0` 명시 필요 |
| Gemini | `gemini-embedding` 계열 | 〃 |
| Voyage | `voyage-3` 계열 | Anthropic 권장 임베딩 (Anthropic 자체 임베딩 API 는 없음) |
| 없음 | — | **FTS + 그래프만으로 동작** (성능 저하, 기능 유지) |

- 외부 임베딩 = 사업 데이터가 밖으로 나감. 공간 생성/전환 액션(`embedding.space_create`, `embedding.activate`)은 `local_only=0` 이면 **high · humanOnly**.
- **모델 교체**: 새 공간 `building` → 큐가 뒤에서 채움 (진행률 표시) → 100% 가 되면 `embedding.activate` 로 원자적 전환 → 이전 공간 `retired` 후 파일에서 삭제. 교체 중에도 검색은 이전 공간으로 계속된다.

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
| **M1 검색 기반** | `documents`·`chunks`·`chunks_fts`, 객체 카드, 청크화 워커, `recall`(FTS+그래프), `/search` 교체, 골든셋·`eval:recall` | 임베딩 없이 recall@5 기준선 측정, 기존 테스트 전부 통과 |
| **M2 벡터** | `embedding_spaces`·`embed_queue`·`now-vec.db`, Ollama/OpenAI/Gemini 임베더, bit→float 재정렬, 공간 교체 | 5만 청크 합성 데이터 p95 < 20ms (KNN), 하이브리드 recall@5 > FTS 단독 |
| **M3 기억** | `memories` + 액션 8종 + 링크 유형 3종, 충돌 감지, tainted 처리, `/memory` 화면, MCP `remember`·`get_context`·`cite` | AI 가 제안 → 사람 확인 → 다음 세션 팩에 등장하는 E2E, 충돌 신호 E2E |
| **M4 큐레이터** | 에피소드 요약, 기억 추출·병합·만료, 승격 제안, 플레이북 문서 | 매일 밤 큐레이터 실행 결과가 승인함에 "기억 검토 n건"으로 나타남 |
| **M5 신뢰** | 에이전트 역할·범위, 기억 신뢰도 집계, 자동 착지 | 등급 상승은 사람 승인, 하락은 자동 — 테스트로 고정 |

M1 → M3 까지가 "AI 와 사람이 함께 관리하는 기억/지식"의 최소 완성형이다. M2 는 M1 과 병행 가능하며, 임베딩이 없어도 M3 이 동작하도록 설계한다.

## 10. 하지 않기로 한 것

- **벡터 전용 DB · 외부 메모리 서비스** — 규모 대비 이득 없음, 로컬 우선·단일 파일 원칙 위반.
- **대화 원문 전체 벡터화** — 잡음, 주입 경로, 토큰 낭비. 요약·주장만.
- **AI 가 사람 확인 없이 verified 기억을 바꾸는 것** — 항상 high.
- **기억을 시스템 프롬프트에 무제한 누적** — 팩은 예산·결정성·인용 추적이 있는 것만.
- **Neo4j 를 원본으로** — 계속 분석용 복제본. 벡터도 Neo4j 에 넣지 않는다.
