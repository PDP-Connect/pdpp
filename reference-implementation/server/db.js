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
    CREATE TABLE IF NOT EXISTS connector_schedules (
      connector_id      TEXT PRIMARY KEY,
      interval_seconds  INTEGER NOT NULL,
      jitter_seconds    INTEGER NOT NULL DEFAULT 0,
      enabled           INTEGER NOT NULL DEFAULT 1,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    )
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

  // Lexical retrieval extension — SQLite FTS5 backing for GET /v1/search.
  // One row per (connector_id, stream, record_key, field) where `field` is
  // declared in the stream's manifest under query.search.lexical_fields.
  // Maintenance is JS-side at the record write/update/delete call sites
  // (see search.js); the manifest decides what's indexable, which triggers
  // can't see. The non-content columns are UNINDEXED to keep the FTS index
  // small and the full-text matching focused on `text`.
  // Spec: openspec/changes/add-lexical-retrieval-extension/specs/lexical-retrieval/spec.md
  await db.query(sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS lexical_search_index USING fts5(
      connector_id UNINDEXED,
      stream       UNINDEXED,
      record_key   UNINDEXED,
      field        UNINDEXED,
      text,
      tokenize = 'unicode61'
    )
  `);

  // Snapshots for opaque-cursor pagination on /v1/search. A snapshot freezes
  // a query's full ranked result list at first-page time so cursoring is
  // stable within a session. Snapshots have a TTL; expired snapshots make
  // the cursor return `invalid_cursor`, which the spec already permits.
  await db.query(sql`
    CREATE TABLE IF NOT EXISTS lexical_search_snapshots (
      snapshot_id   TEXT PRIMARY KEY,
      query         TEXT NOT NULL,
      plan_hash     TEXT NOT NULL,
      results_json  TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Per-(connector, stream) fingerprint of the last-rebuilt declared
  // lexical_fields set. Used by the backfill drift detector in search.js
  // to force a rebuild when the manifest changes the field set, even when
  // the field count stays the same (e.g. ['title'] -> ['selftext']). The
  // row-count heuristic alone cannot detect that case because stale rows
  // satisfy the count band.
  await db.query(sql`
    CREATE TABLE IF NOT EXISTS lexical_search_meta (
      connector_id        TEXT NOT NULL,
      stream              TEXT NOT NULL,
      fields_fingerprint  TEXT NOT NULL,
      updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(connector_id, stream)
    )
  `);

  return db;
}

export { sql };
