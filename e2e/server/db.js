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
      connector_id   TEXT NOT NULL,
      grant_json     TEXT NOT NULL,
      access_mode    TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'active',
      consumed       INTEGER NOT NULL DEFAULT 0,
      issued_at      TEXT NOT NULL,
      expires_at     TEXT
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

  // Version counter for change tracking
  await db.query(sql`
    CREATE TABLE IF NOT EXISTS version_counter (
      connector_id  TEXT NOT NULL,
      stream        TEXT NOT NULL,
      max_version   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(connector_id, stream)
    )
  `);

  return db;
}

export { sql };
