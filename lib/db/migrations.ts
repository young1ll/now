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
];
