/**
 * PDPP Personal Server — Database layer (`better-sqlite3`).
 *
 * The reference implementation talks to SQLite synchronously. Callers do:
 *
 *     const db = getDb();
 *     const row = db.prepare('SELECT ... WHERE id = ?').get(id);
 *     const list = db.prepare('SELECT ... WHERE stream = ?').all(stream);
 *     db.prepare('INSERT ...').run(...);
 *     const tx = db.transaction(fn);
 *
 * `db.prepare(text)` is transparently cached: calling it with the same SQL
 * text returns the same `Statement` instance. `better-sqlite3`'s docs
 * explicitly recommend preparing statements once and reusing them; caching
 * inside `prepare()` gives every call site that property without forcing
 * call sites to hoist statements to module scope.
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

let db;

export function getDb() {
  return db;
}

/**
 * Close the module-scoped database, if any. `initDb()` calls this before
 * opening a new one so tests that stop and restart the server on the same
 * dbPath release file locks cleanly.
 */
export function closeDb() {
  if (db) {
    try { db.close(); } catch { /* best-effort */ }
    db = null;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS connectors (
  connector_id TEXT PRIMARY KEY,
  manifest     TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

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
);

CREATE TABLE IF NOT EXISTS tokens (
  token_id      TEXT PRIMARY KEY,
  grant_id      TEXT,
  subject_id    TEXT NOT NULL,
  client_id     TEXT,
  token_kind    TEXT NOT NULL,
  expires_at    TEXT,
  revoked       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

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
);

CREATE INDEX IF NOT EXISTS idx_pending_consents_status_expires
  ON pending_consents(status, expires_at);

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
);

CREATE INDEX IF NOT EXISTS idx_owner_device_auth_status_expires
  ON owner_device_auth(status, expires_at);

CREATE TABLE IF NOT EXISTS connector_schedules (
  connector_id      TEXT PRIMARY KEY,
  interval_seconds  INTEGER NOT NULL,
  jitter_seconds    INTEGER NOT NULL DEFAULT 0,
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS controller_active_runs (
  connector_id  TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL UNIQUE,
  trace_id      TEXT NOT NULL,
  scenario_id   TEXT NOT NULL,
  started_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_controller_active_runs_run_id
  ON controller_active_runs(run_id);

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id                  TEXT PRIMARY KEY,
  registration_mode          TEXT NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  client_secret              TEXT,
  metadata_json              TEXT NOT NULL,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_clients_registration_mode
  ON oauth_clients(registration_mode, created_at);

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
);

CREATE INDEX IF NOT EXISTS idx_records_lookup
  ON records(connector_id, stream, record_key);

CREATE INDEX IF NOT EXISTS idx_records_version
  ON records(connector_id, stream, version);

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
);

CREATE INDEX IF NOT EXISTS idx_record_changes_record
  ON record_changes(connector_id, stream, record_key, version);

CREATE TABLE IF NOT EXISTS blobs (
  blob_id       TEXT PRIMARY KEY,
  connector_id  TEXT NOT NULL,
  stream        TEXT NOT NULL,
  record_key    TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  data          BLOB
);

CREATE TABLE IF NOT EXISTS blob_bindings (
  blob_id       TEXT NOT NULL,
  connector_id  TEXT NOT NULL,
  stream        TEXT NOT NULL,
  record_key    TEXT NOT NULL,
  PRIMARY KEY(blob_id, connector_id, stream, record_key),
  FOREIGN KEY(blob_id) REFERENCES blobs(blob_id)
);

CREATE INDEX IF NOT EXISTS idx_blob_bindings_record
  ON blob_bindings(connector_id, stream, record_key);

CREATE TABLE IF NOT EXISTS connector_state (
  connector_id  TEXT NOT NULL,
  stream        TEXT NOT NULL,
  state_json    TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(connector_id, stream)
);

CREATE TABLE IF NOT EXISTS grant_connector_state (
  grant_id      TEXT NOT NULL,
  connector_id  TEXT NOT NULL,
  stream        TEXT NOT NULL,
  state_json    TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(grant_id, connector_id, stream)
);

CREATE TABLE IF NOT EXISTS version_counter (
  connector_id  TEXT NOT NULL,
  stream        TEXT NOT NULL,
  max_version   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(connector_id, stream)
);

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
);

CREATE INDEX IF NOT EXISTS idx_spine_events_trace
  ON spine_events(trace_id, occurred_at, recorded_at);

CREATE INDEX IF NOT EXISTS idx_spine_events_grant
  ON spine_events(grant_id, occurred_at, recorded_at);

CREATE INDEX IF NOT EXISTS idx_spine_events_run
  ON spine_events(run_id, occurred_at, recorded_at);

-- Lexical retrieval extension — SQLite FTS5 backing for GET /v1/search.
-- One row per (connector_id, stream, record_key, field) where \`field\` is
-- declared in the stream's manifest under query.search.lexical_fields.
-- Maintenance is JS-side at the record write/update/delete call sites
-- (see search.js); the manifest decides what's indexable, which triggers
-- can't see. The non-content columns are UNINDEXED to keep the FTS index
-- small and the full-text matching focused on \`text\`.
-- Spec: openspec/changes/add-lexical-retrieval-extension/specs/lexical-retrieval/spec.md
CREATE VIRTUAL TABLE IF NOT EXISTS lexical_search_index USING fts5(
  connector_id UNINDEXED,
  stream       UNINDEXED,
  record_key   UNINDEXED,
  field        UNINDEXED,
  text,
  tokenize = 'unicode61'
);

-- Snapshots for opaque-cursor pagination on /v1/search. A snapshot freezes
-- a query's full ranked result list at first-page time so cursoring is
-- stable within a session. Snapshots have a TTL; expired snapshots make
-- the cursor return \`invalid_cursor\`, which the spec already permits.
CREATE TABLE IF NOT EXISTS lexical_search_snapshots (
  snapshot_id   TEXT PRIMARY KEY,
  query         TEXT NOT NULL,
  plan_hash     TEXT NOT NULL,
  results_json  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-(connector, stream) fingerprint of the last-rebuilt declared
-- lexical_fields set. Used by the backfill drift detector in search.js
-- to force a rebuild when the manifest changes the field set, even when
-- the field count stays the same (e.g. ['title'] -> ['selftext']). The
-- row-count heuristic alone cannot detect that case because stale rows
-- satisfy the count band.
CREATE TABLE IF NOT EXISTS lexical_search_meta (
  connector_id        TEXT NOT NULL,
  stream              TEXT NOT NULL,
  fields_fingerprint  TEXT NOT NULL,
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(connector_id, stream)
);

-- Semantic retrieval experimental extension — drift tracking.
-- Per-(connector, stream) fingerprint of the last-rebuilt declared
-- semantic_fields set AND the backend identity (model_id + dimensions +
-- distance_metric) at index time. The backfill drift detector in
-- search-semantic.js compares these against the live backend on startup and
-- on every connector register/update; any disagreement flips
-- capabilities.semantic_retrieval.index_state to "stale" until a rebuild
-- restores coverage.
-- Spec: openspec/changes/add-semantic-retrieval-experimental-extension/specs/semantic-retrieval/spec.md
CREATE TABLE IF NOT EXISTS semantic_search_meta (
  connector_id        TEXT NOT NULL,
  stream              TEXT NOT NULL,
  fields_fingerprint  TEXT NOT NULL,
  model_id            TEXT NOT NULL,
  dimensions          INTEGER NOT NULL,
  distance_metric     TEXT NOT NULL,
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(connector_id, stream)
);

-- Persistent in-progress semantic backfill identity. This lets an
-- interrupted rebuild resume already-written record-field vectors when the
-- active field fingerprint and backend storage identity still match.
CREATE TABLE IF NOT EXISTS semantic_search_backfill_progress (
  connector_id        TEXT NOT NULL,
  stream              TEXT NOT NULL,
  fields_fingerprint  TEXT NOT NULL,
  model_id            TEXT NOT NULL,
  dimensions          INTEGER NOT NULL,
  distance_metric     TEXT NOT NULL,
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(connector_id, stream)
);

-- Maps logical semantic-index identity (connector_id, scope_key, record_key)
-- to the vec0 rowid (sqlite-vec path only). vec0 requires an integer rowid
-- and does not support composite text PKs; this sidecar lets us upsert by
-- logical identity. Unused on the BLOB-flat fallback.
-- scope_key encodes (stream, field) as JSON.stringify([stream, field]);
-- see search-semantic.js for the helper.
CREATE TABLE IF NOT EXISTS semantic_search_rowid (
  connector_id  TEXT NOT NULL,
  scope_key     TEXT NOT NULL,
  record_key    TEXT NOT NULL,
  rowid         INTEGER NOT NULL,
  PRIMARY KEY(connector_id, scope_key, record_key)
);

-- BLOB-flat fallback table (used only when sqlite-vec cannot be loaded).
-- Stores embeddings as Float32Array byte BLOBs; distance is computed in JS
-- after the plan-scoped SELECT narrows to the authorized (connector_id,
-- scope_key) tuples. Same grant-safety invariants as the sqlite-vec path:
-- no unauthorized row is ever read, because the caller constructs the
-- WHERE clause from a grant-gated plan.
CREATE TABLE IF NOT EXISTS semantic_search_blob (
  connector_id  TEXT NOT NULL,
  scope_key     TEXT NOT NULL,
  record_key    TEXT NOT NULL,
  embedding     BLOB NOT NULL,
  PRIMARY KEY(connector_id, scope_key, record_key)
);
CREATE INDEX IF NOT EXISTS idx_semantic_search_blob_plan
  ON semantic_search_blob(connector_id, scope_key);

-- Opaque-cursor snapshots for /v1/search/semantic, parallel to
-- lexical_search_snapshots. One row per active paged search session.
-- Stale cursors (plan change, model change, rebuild) are detected in
-- search-semantic.js and return invalid_cursor; the row may persist
-- until TTL eviction.
CREATE TABLE IF NOT EXISTS semantic_search_snapshots (
  snapshot_id   TEXT PRIMARY KEY,
  query         TEXT NOT NULL,
  plan_hash     TEXT NOT NULL,
  results_json  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

/**
 * Wrap a `better-sqlite3` Database so `db.prepare(text)` returns a cached
 * Statement keyed on the SQL text. Other methods (exec, pragma, transaction,
 * close, inTransaction, etc.) pass through to the underlying instance.
 *
 * We install this via a Proxy so callers keep using the standard Database
 * API — no new methods to learn.
 */
function withCachedPrepare(raw) {
  const cache = new Map();
  return new Proxy(raw, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (text) => {
          let stmt = cache.get(text);
          if (!stmt) {
            stmt = target.prepare(text);
            cache.set(text, stmt);
          }
          return stmt;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Try to load the `sqlite-vec` extension into `raw`. Returns:
 *   - 'sqlite-vec' if the extension loaded and vec_version() responds
 *   - 'blob-flat'  if loading failed for any reason (platform binary
 *                  missing, locked-down environment, etc.)
 *
 * The returned kind is stamped onto the wrapped db as `db.vectorIndexKind`
 * so `search-semantic.js` can select the matching `VectorIndex` backend
 * without re-probing. Both backends are persistent and expose the same
 * interface; the sqlite-vec path is strongly preferred (native SIMD,
 * in-index scope_key filtering), and the blob-flat fallback exists so
 * the reference still ships the extension on environments where the
 * sqlite-vec binary can't load.
 *
 * Spec: openspec/changes/implement-semantic-retrieval-experimental-extension/
 *       specs/reference-implementation-architecture/spec.md
 *       ("The reference's default semantic index SHALL persist across
 *        process restarts")
 */
function loadVectorExtension(raw) {
  try {
    sqliteVec.load(raw);
    // Confirm the extension is actually usable — load() can succeed but
    // vec_version() can still fail if the binary mismatches. Fail-closed:
    // any error here degrades to blob-flat rather than advertising
    // sqlite-vec and then crashing on first MATCH.
    raw.prepare('SELECT vec_version() AS v').get();
    return 'sqlite-vec';
  } catch {
    return 'blob-flat';
  }
}

export function initDb(path = ':memory:') {
  closeDb();
  const raw = new Database(path);

  // Performance PRAGMAs — see openspec/changes/add-polyfill-connector-system/
  // design-notes/sqlite-performance-recommendations.md for rationale. WAL is
  // invalid on in-memory DBs.
  if (path !== ':memory:') {
    raw.pragma('journal_mode = WAL');
    raw.pragma('synchronous = NORMAL');
    raw.pragma('temp_store = MEMORY');
    raw.pragma('mmap_size = 268435456');
    raw.pragma('cache_size = -65536');
  }

  const vectorIndexKind = loadVectorExtension(raw);

  raw.exec(SCHEMA);
  db = withCachedPrepare(raw);
  // Stamp the chosen vector-index backend onto the wrapped db so
  // search-semantic.js can select without re-probing. The Proxy's
  // get-handler falls through to Reflect for non-`prepare` properties,
  // so direct property reads like `db.vectorIndexKind` work.
  Object.defineProperty(raw, 'vectorIndexKind', {
    value: vectorIndexKind,
    writable: false,
    enumerable: true,
    configurable: false,
  });
  return db;
}
