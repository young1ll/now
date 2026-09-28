// 스키마 마이그레이션. PRAGMA user_version 으로 적용 여부를 추적한다.
// 규칙: 이미 배포된 항목은 절대 수정하지 말고, 새 항목을 배열 끝에 추가한다.
//
// 금액은 모두 통화의 최소 단위 정수(KRW=원, USD=센트)로 저장한다. lib/money.ts 참고.
// 날짜는 'YYYY-MM-DD', 시각은 ISO 8601 문자열.

export const migrations: string[] = [
  /* 1: 초기 스키마 */ `
  CREATE TABLE businesses (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT '',
    color       TEXT NOT NULL DEFAULT '#6366f1',
    currency    TEXT NOT NULL DEFAULT 'KRW',
    archived    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  -- ── CRM ──────────────────────────────────────────────
  CREATE TABLE clients (
    id          INTEGER PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'company' CHECK (kind IN ('company','person')),
    status      TEXT NOT NULL DEFAULT 'lead'    CHECK (status IN ('lead','active','paused','closed')),
    email       TEXT NOT NULL DEFAULT '',
    phone       TEXT NOT NULL DEFAULT '',
    tags        TEXT NOT NULL DEFAULT '',
    memo        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX clients_business ON clients(business_id, status);

  CREATE TABLE interactions (
    id          INTEGER PRIMARY KEY,
    client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL DEFAULT 'memo' CHECK (kind IN ('call','meeting','email','memo')),
    summary     TEXT NOT NULL,
    occurred_at TEXT NOT NULL
  );
  CREATE INDEX interactions_client ON interactions(client_id, occurred_at);

  -- ── 업무 · 일정 · 마감 ────────────────────────────────
  CREATE TABLE tasks (
    id           INTEGER PRIMARY KEY,
    business_id  INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    client_id    INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    title        TEXT NOT NULL,
    detail       TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','done')),
    priority     INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3),
    due_date     TEXT,
    recurrence   TEXT NOT NULL DEFAULT 'none' CHECK (recurrence IN ('none','weekly','monthly','quarterly','yearly')),
    completed_at TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX tasks_business ON tasks(business_id, status, due_date);

  -- ── 매출 · 청구 · 정산 ────────────────────────────────
  CREATE TABLE invoices (
    id          INTEGER PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    client_id   INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    number      TEXT NOT NULL,
    issue_date  TEXT NOT NULL,
    due_date    TEXT,
    status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','paid','void')),
    currency    TEXT NOT NULL,
    tax_rate    REAL NOT NULL DEFAULT 0,
    memo        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (business_id, number)
  );

  CREATE TABLE invoice_items (
    id          INTEGER PRIMARY KEY,
    invoice_id  INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    quantity    REAL NOT NULL DEFAULT 1,
    unit_price  INTEGER NOT NULL
  );

  CREATE TABLE payments (
    id          INTEGER PRIMARY KEY,
    invoice_id  INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    amount      INTEGER NOT NULL,
    paid_at     TEXT NOT NULL,
    method      TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE expenses (
    id          INTEGER PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    category    TEXT NOT NULL DEFAULT '기타',
    description TEXT NOT NULL,
    amount      INTEGER NOT NULL,
    spent_at    TEXT NOT NULL
  );
  CREATE INDEX expenses_business ON expenses(business_id, spent_at);

  -- ── 지식 · 문서 ──────────────────────────────────────
  CREATE TABLE notes (
    id          INTEGER PRIMARY KEY,
    business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
    client_id   INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    tags        TEXT NOT NULL DEFAULT '',
    pinned      INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE VIRTUAL TABLE notes_fts USING fts5(
    title, body, tags, content='notes', content_rowid='id', tokenize='trigram'
  );
  CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
  END;
  CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
  END;
  CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
    INSERT INTO notes_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
  END;

  -- ── 인프라 연동 · 가시성 ─────────────────────────────
  -- 비밀값은 저장하지 않는다. credential_env 는 환경변수 "이름"만 담는다.
  CREATE TABLE infra_connections (
    id             INTEGER PRIMARY KEY,
    business_id    INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
    provider       TEXT NOT NULL CHECK (provider IN ('aws','gcp','azure','palantir','http','other')),
    name           TEXT NOT NULL,
    account_ref    TEXT NOT NULL DEFAULT '',
    region         TEXT NOT NULL DEFAULT '',
    console_url    TEXT NOT NULL DEFAULT '',
    health_url     TEXT NOT NULL DEFAULT '',
    credential_env TEXT NOT NULL DEFAULT '',
    monthly_budget INTEGER,
    currency       TEXT NOT NULL DEFAULT 'USD',
    memo           TEXT NOT NULL DEFAULT '',
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE infra_checks (
    id            INTEGER PRIMARY KEY,
    connection_id INTEGER NOT NULL REFERENCES infra_connections(id) ON DELETE CASCADE,
    status        TEXT NOT NULL CHECK (status IN ('ok','degraded','down','unknown')),
    latency_ms    INTEGER,
    message       TEXT NOT NULL DEFAULT '',
    checked_at    TEXT NOT NULL
  );
  CREATE INDEX infra_checks_conn ON infra_checks(connection_id, checked_at);

  CREATE TABLE infra_costs (
    id            INTEGER PRIMARY KEY,
    connection_id INTEGER NOT NULL REFERENCES infra_connections(id) ON DELETE CASCADE,
    month         TEXT NOT NULL,
    amount        INTEGER NOT NULL,
    source        TEXT NOT NULL DEFAULT 'manual',
    UNIQUE (connection_id, month)
  );
  `,

  /* 2: AI 운영 계층 — 액션 감사, 에이전트, 설정, IaC 스냅샷. 인프라 가시성(v0.1) 폐지 */ `
  DROP TABLE infra_checks;
  DROP TABLE infra_costs;
  DROP TABLE infra_connections;

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  INSERT INTO settings (key, value) VALUES ('ai_mode', 'guarded');

  -- 외부 AI 에이전트. 토큰은 SHA-256 해시만 저장한다.
  CREATE TABLE agents (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    token_hash   TEXT NOT NULL UNIQUE,
    token_prefix TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked')),
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_seen_at TEXT
  );

  -- 모든 변경은 액션 실행(run)으로 기록된다. 사람·에이전트·시스템 공통.
  CREATE TABLE action_runs (
    id            INTEGER PRIMARY KEY,
    action        TEXT NOT NULL,
    actor_type    TEXT NOT NULL CHECK (actor_type IN ('human','agent','system')),
    actor_id      TEXT NOT NULL,
    actor_name    TEXT NOT NULL,
    risk          TEXT NOT NULL CHECK (risk IN ('low','high')),
    status        TEXT NOT NULL CHECK (status IN ('applied','pending','rejected','failed','denied','cancelled')),
    params        TEXT NOT NULL,
    reason        TEXT NOT NULL DEFAULT '',
    result        TEXT,
    error         TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    decided_at    TEXT,
    decided_by    TEXT,
    decision_note TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX action_runs_status ON action_runs(status, created_at);
  CREATE INDEX action_runs_actor ON action_runs(actor_type, actor_id, created_at);

  CREATE TABLE action_run_refs (
    run_id      INTEGER NOT NULL REFERENCES action_runs(id) ON DELETE CASCADE,
    object_type TEXT NOT NULL,
    object_id   INTEGER NOT NULL,
    PRIMARY KEY (run_id, object_type, object_id)
  );
  CREATE INDEX action_run_refs_object ON action_run_refs(object_type, object_id);

  -- IaC 현행 감사 결과 (npm run iac:audit 이 기록)
  CREATE TABLE infra_snapshots (
    id             INTEGER PRIMARY KEY,
    captured_at    TEXT NOT NULL,
    tool           TEXT NOT NULL,
    status         TEXT NOT NULL CHECK (status IN ('in_sync','drift','error')),
    resource_count INTEGER NOT NULL DEFAULT 0,
    change_count   INTEGER NOT NULL DEFAULT 0,
    resources      TEXT NOT NULL DEFAULT '[]',
    changes        TEXT NOT NULL DEFAULT '[]',
    message        TEXT NOT NULL DEFAULT ''
  );
  `,

  /* 3: 이벤트 · 트리거 · AI 런타임 · 온톨로지 링크 */ `
  -- 이벤트 로그 (outbox). 모든 액션 실행·신호 변화·스케줄이 여기로 들어간다.
  CREATE TABLE events (
    id           INTEGER PRIMARY KEY,
    type         TEXT NOT NULL,
    actor_type   TEXT,
    actor_id     TEXT,
    subject_type TEXT,
    subject_id   INTEGER,
    payload      TEXT NOT NULL DEFAULT '{}',
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX events_type ON events(type, id);

  -- 신호 상태 (raise/resolve 변화 감지용)
  CREATE TABLE signal_state (
    key        TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    severity   TEXT NOT NULL,
    title      TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen  TEXT NOT NULL
  );

  -- AI 실행 프로필: 어떤 공급자·모델로, 어떤 에이전트 신원으로 일하는가
  CREATE TABLE ai_profiles (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL,
    provider      TEXT NOT NULL CHECK (provider IN ('anthropic','openai','gemini','openrouter','ollama','openai_compatible','command')),
    model         TEXT NOT NULL DEFAULT '',
    base_url      TEXT NOT NULL DEFAULT '',
    api_key_env   TEXT NOT NULL DEFAULT '',
    command       TEXT NOT NULL DEFAULT '',
    system_prompt TEXT NOT NULL DEFAULT '',
    max_steps     INTEGER NOT NULL DEFAULT 12,
    agent_id      INTEGER NOT NULL REFERENCES agents(id),
    enabled       INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  -- 트리거: 이벤트(패턴) 또는 스케줄(cron) → 웹훅 또는 AI 실행
  CREATE TABLE triggers (
    id               INTEGER PRIMARY KEY,
    name             TEXT NOT NULL,
    enabled          INTEGER NOT NULL DEFAULT 1,
    kind             TEXT NOT NULL CHECK (kind IN ('event','schedule')),
    event_pattern    TEXT NOT NULL DEFAULT '',
    filter           TEXT NOT NULL DEFAULT '{}',
    schedule         TEXT NOT NULL DEFAULT '',
    target           TEXT NOT NULL CHECK (target IN ('webhook','agent')),
    webhook_url      TEXT NOT NULL DEFAULT '',
    secret_env       TEXT NOT NULL DEFAULT '',
    profile_id       INTEGER REFERENCES ai_profiles(id) ON DELETE SET NULL,
    prompt_template  TEXT NOT NULL DEFAULT '',
    cooldown_sec     INTEGER NOT NULL DEFAULT 0,
    last_fired_at    TEXT,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE trigger_runs (
    id             INTEGER PRIMARY KEY,
    trigger_id     INTEGER NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
    event_id       INTEGER REFERENCES events(id),
    status         TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','skipped')),
    attempts       INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    session_id     INTEGER,
    output         TEXT NOT NULL DEFAULT '',
    error          TEXT,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    started_at     TEXT,
    finished_at    TEXT
  );
  CREATE INDEX trigger_runs_status ON trigger_runs(status, next_attempt_at);

  -- AI 세션 (한 번의 에이전트 실행 기록)
  CREATE TABLE agent_sessions (
    id           INTEGER PRIMARY KEY,
    profile_id   INTEGER NOT NULL REFERENCES ai_profiles(id) ON DELETE CASCADE,
    trigger_run_id INTEGER,
    status       TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
    prompt       TEXT NOT NULL,
    transcript   TEXT NOT NULL DEFAULT '[]',
    final_text   TEXT NOT NULL DEFAULT '',
    steps        INTEGER NOT NULL DEFAULT 0,
    tool_calls   INTEGER NOT NULL DEFAULT 0,
    usage        TEXT NOT NULL DEFAULT '{}',
    error        TEXT,
    started_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    finished_at  TEXT
  );

  -- 단기 에이전트 토큰 (로컬 CLI 에이전트 세션용). 해시만 저장.
  CREATE TABLE agent_session_tokens (
    token_hash TEXT PRIMARY KEY,
    agent_id   INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );

  -- 온톨로지: 사용자 정의 링크 유형과 링크 (1급 관계)
  CREATE TABLE link_types (
    name          TEXT PRIMARY KEY,
    label         TEXT NOT NULL,
    inverse_label TEXT NOT NULL,
    from_type     TEXT NOT NULL,
    to_type       TEXT NOT NULL,
    cardinality   TEXT NOT NULL DEFAULT 'many' CHECK (cardinality IN ('one','many')),
    description   TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE links (
    id         INTEGER PRIMARY KEY,
    link_type  TEXT NOT NULL REFERENCES link_types(name) ON DELETE CASCADE,
    from_type  TEXT NOT NULL,
    from_id    INTEGER NOT NULL,
    to_type    TEXT NOT NULL,
    to_id      INTEGER NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (link_type, from_type, from_id, to_type, to_id)
  );
  CREATE INDEX links_from ON links(from_type, from_id);
  CREATE INDEX links_to ON links(to_type, to_id);

  INSERT INTO link_types (name, label, inverse_label, from_type, to_type, cardinality, description) VALUES
    ('referred_by', '소개자', '소개한 고객', 'client', 'client', 'one', '이 고객을 소개해 준 고객'),
    ('depends_on', '선행 업무', '후행 업무', 'task', 'task', 'many', '이 업무를 시작하려면 먼저 끝나야 하는 업무'),
    ('documents', '문서화 대상', '관련 문서', 'note', 'task', 'many', '이 문서가 절차·결과를 설명하는 업무'),
    ('cites', '근거 문서', '인용됨', 'invoice', 'note', 'many', '청구 근거가 되는 문서(계약·견적)');
  `,
  // 4: 검색 색인 (docs/MEMORY.md M1) — 원본에서 언제든 재생성 가능한 파생 데이터
  `
  -- 검색 단위. 객체 카드(seq 0)와 문서 본문 구획(seq 1..)
  CREATE TABLE chunks (
    id           INTEGER PRIMARY KEY,
    owner_type   TEXT NOT NULL,
    owner_id     INTEGER NOT NULL,
    business_id  INTEGER,
    seq          INTEGER NOT NULL DEFAULT 0,
    head         TEXT NOT NULL DEFAULT '',        -- 제목 줄 (카드 머리 · 문서 제목 경로). 검색 가중치 5배
    text         TEXT NOT NULL,
    tokens       INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    indexed_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (owner_type, owner_id, seq)
  );
  CREATE INDEX chunks_business ON chunks(business_id);
  CREATE INDEX chunks_hash ON chunks(content_hash);

  CREATE VIRTUAL TABLE chunks_fts USING fts5(head, text, content='chunks', content_rowid='id', tokenize='trigram');
  -- 2글자 검색어(고객·계약 …)는 trigram 으로 못 찾는다. 큰 색인에서는 어절 접두 일치(고객* → 고객에게)로 찾는다.
  CREATE VIRTUAL TABLE chunks_words USING fts5(head, text, content='chunks', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
  CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, head, text) VALUES (new.id, new.head, new.text);
    INSERT INTO chunks_words(rowid, head, text) VALUES (new.id, new.head, new.text);
  END;
  CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, head, text) VALUES ('delete', old.id, old.head, old.text);
    INSERT INTO chunks_words(chunks_words, rowid, head, text) VALUES ('delete', old.id, old.head, old.text);
  END;
  CREATE TRIGGER chunks_au AFTER UPDATE OF head, text ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, head, text) VALUES ('delete', old.id, old.head, old.text);
    INSERT INTO chunks_fts(rowid, head, text) VALUES (new.id, new.head, new.text);
    INSERT INTO chunks_words(chunks_words, rowid, head, text) VALUES ('delete', old.id, old.head, old.text);
    INSERT INTO chunks_words(rowid, head, text) VALUES (new.id, new.head, new.text);
  END;
  `,
  // 5: 임베딩 공간 (docs/MEMORY.md M2) — 벡터 자체는 본 DB 밖 파생 파일(now-vec.db)에 둔다
  `
  CREATE TABLE embedding_spaces (
    id             INTEGER PRIMARY KEY,
    name           TEXT NOT NULL,
    provider       TEXT NOT NULL CHECK (provider IN ('ollama','openai','gemini','voyage','openai_compatible')),
    model          TEXT NOT NULL,
    dim            INTEGER NOT NULL DEFAULT 0,          -- 0 = 첫 응답에서 확정
    base_url       TEXT NOT NULL DEFAULT '',
    api_key_env    TEXT NOT NULL DEFAULT '',            -- 환경변수 "이름"만
    query_prefix   TEXT NOT NULL DEFAULT '',            -- e5 계열: "query: "
    passage_prefix TEXT NOT NULL DEFAULT '',            -- e5 계열: "passage: "
    local_only     INTEGER NOT NULL DEFAULT 1,          -- 1 = 본문이 이 기기/사설망을 떠나지 않음
    auto_activate  INTEGER NOT NULL DEFAULT 0,          -- 다 채워지면 자동 활성화 (활성 공간이 없을 때만)
    status         TEXT NOT NULL DEFAULT 'building' CHECK (status IN ('building','active','retired')),
    last_error     TEXT,
    last_error_at  TEXT,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    activated_at   TEXT
  );
  `,
  // 6: 기억 (docs/MEMORY.md M3) — AI·사람이 함께 관리하는 원자적 믿음. 쓰기는 memory.* 액션, 사용 기록만 텔레메트리
  `
  CREATE TABLE memories (
    id               INTEGER PRIMARY KEY,
    business_id      INTEGER REFERENCES businesses(id) ON DELETE CASCADE,   -- NULL = 전역(운영자 개인·공용)
    kind             TEXT NOT NULL CHECK (kind IN ('fact','preference','lesson','procedure_hint','caution')),
    statement        TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','active','verified','disputed','superseded','retired')),
    confidence       REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
    origin           TEXT NOT NULL CHECK (origin IN ('human','agent','consolidation','import')),
    tainted          INTEGER NOT NULL DEFAULT 0,
    pinned           INTEGER NOT NULL DEFAULT 0,
    valid_from       TEXT,
    valid_to         TEXT,
    supersedes_id    INTEGER REFERENCES memories(id) ON DELETE SET NULL,
    superseded_by_id INTEGER REFERENCES memories(id) ON DELETE SET NULL,
    created_by       TEXT NOT NULL,          -- 'human:operator' · 'agent:3' · 'system:system'
    verified_by      TEXT,
    verified_at      TEXT,
    retired_reason   TEXT,
    use_count        INTEGER NOT NULL DEFAULT 0,
    last_used_at     TEXT,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX memories_status ON memories(status, business_id);

  -- 사용 기록 (텔레메트리 — 액션이 아니다: agents.last_seen_at 과 같은 취급)
  CREATE TABLE memory_uses (
    id         INTEGER PRIMARY KEY,
    memory_id  INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    session_id INTEGER,                      -- agent_sessions.id (있으면)
    actor      TEXT NOT NULL,
    how        TEXT NOT NULL CHECK (how IN ('context','cited')),
    used_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX memory_uses_memory ON memory_uses(memory_id, used_at);

  ALTER TABLE agent_sessions ADD COLUMN context_hash TEXT;
  ALTER TABLE agent_sessions ADD COLUMN context_refs TEXT NOT NULL DEFAULT '[]';

  -- 이전 버전의 link_type.define 은 이 네 이름도 받았다. 운영자가 이미 정의해 둔 같은 이름의 유형은
  -- '<이름>_user' 로 옮긴다 (유형 복사 → 링크 이동 → 옛 유형 삭제: links.link_type 외래키에 ON UPDATE 가 없어서).
  INSERT INTO link_types (name, label, inverse_label, from_type, to_type, cardinality, description, created_at)
    SELECT name || '_user', label, inverse_label, from_type, to_type, cardinality, description, created_at FROM link_types
    WHERE name IN ('about','evidenced_by','contradicts','promoted_to');
  UPDATE links SET link_type = link_type || '_user' WHERE link_type IN ('about','evidenced_by','contradicts','promoted_to');
  DELETE FROM link_types WHERE name IN ('about','evidenced_by','contradicts','promoted_to');

  INSERT INTO link_types (name, label, inverse_label, from_type, to_type, cardinality, description) VALUES
    ('about', '대상', '관련 기억', 'memory', '*', 'many', '이 기억이 무엇에 관한 것인가'),
    ('evidenced_by', '근거', '근거로 쓰인 기억', 'memory', '*', 'many', '이 기억을 뒷받침하는 객체'),
    ('contradicts', '충돌', '충돌', 'memory', 'memory', 'many', '서로 모순되는 기억'),
    ('promoted_to', '승격됨', '승격 원본 기억', 'memory', '*', 'one', '이 기억이 구조화되어 옮겨간 객체');
  `,
];
