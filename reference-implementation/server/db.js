/**
 * PDPP Personal Server — Database layer (SQLite via @databases/sqlite)
 */
import createDatabase, { sql } from '@databases/sqlite';

let db;

export function getDb() {
  return db;
}

export async function initDb(path = ':memory:') {
  db = createDatabase(path);

  // Performance pragmas — see openspec/changes/add-polyfill-connector-system/
  // design-notes/sqlite-performance-recommendations.md for rationale.
  // In-memory DBs reject WAL, so only apply to file-backed ones.
  if (path !== ':memory:') {
    await db.query(sql`PRAGMA journal_mode = WAL`);
    await db.query(sql`PRAGMA synchronous = NORMAL`);
    await db.query(sql`PRAGMA temp_store = MEMORY`);
    await db.query(sql`PRAGMA mmap_size = 268435456`);
    await db.query(sql`PRAGMA cache_size = -65536`);
  }

  await db.query(sql`
    CREATE TABLE IF NOT EXISTS connectors (
      connector_id TEXT PRIMARY KEY,
      manifest     TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  await db.query(sql`
    CREATE TABLE IF NOT EXISTS grants (
      grant_id       TEXT PRIMARY KEY,
      subject_id     TEXT NOT NULL,
      client_id      TEXT NOT NULL,
      storage_binding_json TEXT,
      grant_json     TEXT NOT NULL,
      access_mode    TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'active',
      consumed       INTEGER NOT NULL DEFAULT 0,
      issued_at      TEXT NOT NULL,
      expires_at     TEXT,
      trace_id       TEXT,
      scenario_id    TEXT
    )
  `);

  await db.query(sql`
    CREATE TABLE IF NOT EXISTS tokens (
      token_id      TEXT PRIMARY KEY,
      grant_id      TEXT,
      subject_id    TEXT NOT NULL,
      client_id     TEXT,
      token_kind    TEXT NOT NULL,
      expires_at    TEXT,
      revoked       INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  await db.query(sql`
    CREATE TABLE IF NOT EXISTS pending_consents (
      device_code              TEXT PRIMARY KEY,
      user_code                TEXT NOT NULL UNIQUE,
      params_json              TEXT NOT NULL,
      status                   TEXT NOT NULL DEFAULT 'pending',
      subject_id               TEXT,
      grant_id                 TEXT,
      token_id                 TEXT,
      ai_training_consented    INTEGER,
      request_id               TEXT,
      trace_id                 TEXT,
      scenario_id              TEXT,
      created_at               TEXT NOT NULL,
      expires_at               TEXT NOT NULL,
      approved_at              TEXT,
      denied_at                TEXT
    )
  `);

  await db.query(sql`
    CREATE INDEX IF NOT EXISTS idx_pending_consents_status_expires
    ON pending_consents(status, expires_at)
  `);

  await db.query(sql`
    CREATE TABLE IF NOT EXISTS owner_device_auth (
      device_code        TEXT PRIMARY KEY,
      user_code          TEXT NOT NULL UNIQUE,
      client_id          TEXT NOT NULL,
      status             TEXT NOT NULL DEFAULT 'pending',
      subject_id         TEXT,
      token_id           TEXT,
      interval_seconds   INTEGER NOT NULL DEFAULT 5,
      last_polled_at     TEXT,
      created_at         TEXT NOT NULL,
      expires_at         TEXT NOT NULL,
      approved_at        TEXT,
      denied_at          TEXT,
      request_id         TEXT,
      trace_id           TEXT,
      scenario_id        TEXT
    )
  `);

  await db.query(sql`
    CREATE INDEX IF NOT EXISTS idx_owner_device_auth_status_expires
    ON owner_device_auth(status, expires_at)
  `);

  await db.query(sql`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id                  TEXT PRIMARY KEY,
      registration_mode          TEXT NOT NULL,
      token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
      client_secret              TEXT,
      metadata_json              TEXT NOT NULL,
      created_at                 TEXT NOT NULL,
      updated_at                 TEXT NOT NULL
    )
  `);

  await db.query(sql`
    CREATE INDEX IF NOT EXISTS idx_oauth_clients_registration_mode
    ON oauth_clients(registration_mode, created_at)
  `);

  // Records table: stream + connector_id scoped storage
  await db.query(sql`
    CREATE TABLE IF NOT EXISTS records (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      connector_id  TEXT NOT NULL,
      stream        TEXT NOT NULL,
      record_key    TEXT NOT NULL,
      record_json   TEXT NOT NULL,
      emitted_at    TEXT NOT NULL,
      version       INTEGER NOT NULL DEFAULT 1,
      deleted       INTEGER NOT NULL DEFAULT 0,
      deleted_at    TEXT,
      UNIQUE(connector_id, stream, record_key)
    )
  `);

  await db.query(sql`
    CREATE INDEX IF NOT EXISTS idx_records_lookup
    ON records(connector_id, stream, record_key)
  `);

  await db.query(sql`
    CREATE INDEX IF NOT EXISTS idx_records_version
    ON records(connector_id, stream, version)
  `);

  await db.query(sql`
    CREATE TABLE IF NOT EXISTS record_changes (
      connector_id  TEXT NOT NULL,
      stream        TEXT NOT NULL,
      record_key    TEXT NOT NULL,
      version       INTEGER NOT NULL,
      record_json   TEXT,
      emitted_at    TEXT NOT NULL,
      deleted       INTEGER NOT NULL DEFAULT 0,
      deleted_at    TEXT,
      PRIMARY KEY(connector_id, stream, version)
    )
  `);

  await db.query(sql`
    CREATE INDEX IF NOT EXISTS idx_record_changes_record
    ON record_changes(connector_id, stream, record_key, version)
  `);

  // Blobs table
  await db.query(sql`
    CREATE TABLE IF NOT EXISTS blobs (
      blob_id       TEXT PRIMARY KEY,
      connector_id  TEXT NOT NULL,
      stream        TEXT NOT NULL,
      record_key    TEXT NOT NULL,
      mime_type     TEXT NOT NULL,
      size_bytes    INTEGER NOT NULL,
      sha256        TEXT NOT NULL,
      data          BLOB
    )
  `);

  // Connector sync state
  await db.query(sql`
    CREATE TABLE IF NOT EXISTS connector_state (
      connector_id  TEXT NOT NULL,
      stream        TEXT NOT NULL,
      state_json    TEXT NOT NULL,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(connector_id, stream)
    )
  `);

  await db.query(sql`
    CREATE TABLE IF NOT EXISTS grant_connector_state (
      grant_id      TEXT NOT NULL,
      connector_id  TEXT NOT NULL,
      stream        TEXT NOT NULL,
      state_json    TEXT NOT NULL,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(grant_id, connector_id, stream)
    )
  `);

  // Version counter for change tracking
  await db.query(sql`
    CREATE TABLE IF NOT EXISTS version_counter (
      connector_id  TEXT NOT NULL,
      stream        TEXT NOT NULL,
      max_version   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(connector_id, stream)
    )
  `);

  await db.query(sql`
    CREATE TABLE IF NOT EXISTS spine_events (
      event_id         TEXT PRIMARY KEY,
      event_type       TEXT NOT NULL,
      occurred_at      TEXT NOT NULL,
      recorded_at      TEXT NOT NULL,
      scenario_id      TEXT NOT NULL,
      trace_id         TEXT NOT NULL,
      actor_type       TEXT NOT NULL,
      actor_id         TEXT NOT NULL,
      subject_type     TEXT,
      subject_id       TEXT,
      object_type      TEXT NOT NULL,
      object_id        TEXT NOT NULL,
      status           TEXT NOT NULL,
      request_id       TEXT,
      grant_id         TEXT,
      run_id           TEXT,
      provider_id      TEXT,
      client_id        TEXT,
      stream_id        TEXT,
      token_id         TEXT,
      interaction_id   TEXT,
      data_json        TEXT NOT NULL,
      version          TEXT NOT NULL
    )
  `);

  await db.query(sql`
    CREATE INDEX IF NOT EXISTS idx_spine_events_trace
    ON spine_events(trace_id, occurred_at, recorded_at)
  `);

  await db.query(sql`
    CREATE INDEX IF NOT EXISTS idx_spine_events_grant
    ON spine_events(grant_id, occurred_at, recorded_at)
  `);

  await db.query(sql`
    CREATE INDEX IF NOT EXISTS idx_spine_events_run
    ON spine_events(run_id, occurred_at, recorded_at)
  `);

  return db;
}

export { sql };
