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

const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 30_000;

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

function resolveSqliteBusyTimeoutMs(value = process.env.PDPP_SQLITE_BUSY_TIMEOUT_MS) {
  if (value == null || value === '') return DEFAULT_SQLITE_BUSY_TIMEOUT_MS;
  const timeout = Number(value);
  if (!Number.isFinite(timeout) || timeout < 0) {
    throw new Error(`PDPP_SQLITE_BUSY_TIMEOUT_MS must be a non-negative number, got ${value}`);
  }
  return Math.floor(timeout);
}

/**
 * Best-effort retry wrapper for SQLite writes that race against a
 * still-shutting-down sibling process. The canonical case: `node --watch`
 * (and Docker dev compose, which runs `node --watch`) restarts the server
 * after an edit. SQLite's per-process `busy_timeout` retries are usually
 * enough, but on slow hosts and bind-mounted volumes the new process can
 * occasionally observe a `SQLITE_BUSY` from the old process's WAL writer
 * faster than the busy-timeout window covers (e.g., the old process held
 * a mid-startup write transaction that `db.close()` rolled back, but the
 * `-shm`/`-wal` lock wasn't visible-as-released yet to the new opener).
 *
 * Use this only for startup writes that:
 *   - are bounded and idempotent (seeds, reconciles), and
 *   - we'd rather retry than fail-the-process on transient contention.
 *
 * Persistent locks still surface — once the retry budget is exhausted we
 * rethrow with the original error so operators see a real diagnostic.
 *
 * Spec note: the `PDPP_SQLITE_BUSY_TIMEOUT_MS` ceiling already bounds
 * SQLite's own retry loop. This helper layers a small bounded application
 * retry on top so we don't re-enter SQLite immediately after a busy
 * failure — backoff gives the sibling process time to finish closing.
 */
const TRANSIENT_LOCK_CODES = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_BUSY_SNAPSHOT']);

export function isTransientSqliteLockError(err) {
  if (!err) return false;
  if (err.code && TRANSIENT_LOCK_CODES.has(err.code)) return true;
  const message = typeof err.message === 'string' ? err.message : '';
  return message.includes('database is locked') || message.includes('database table is locked');
}

/**
 * Synchronous sibling of `runWithSqliteBusyRetry` for the boot path.
 *
 * `initDb` runs synchronously (better-sqlite3 is sync; the surrounding
 * `await initDb(...)` call site only awaits the Promise wrapper) and the
 * very first write after opening the DB is `raw.exec(SCHEMA)`. On Docker
 * dev restart (`node --watch` or `docker compose restart reference`),
 * the new process can race the old process's still-closing WAL writer.
 * `seedPreRegisteredClients` is already wrapped in the async retry
 * helper, but the SCHEMA exec runs BEFORE that — so a transient lock
 * surfaces as `SQLITE_BUSY` from the boot itself. This helper applies
 * the same bounded retry policy without going async.
 *
 * Uses a busy-wait spin to back off because we are intentionally on the
 * synchronous path; the retry budget is small (5 attempts capped at
 * 1.5s each) and only fires on a transient lock, so the worst case is
 * ~5s of boot delay before we surface the original error.
 */
export function runWithSqliteBusyRetrySync(fn, opts = {}) {
  const maxAttempts = Number.isFinite(opts.maxAttempts) ? Math.max(1, opts.maxAttempts) : 5;
  const initialDelayMs = Number.isFinite(opts.initialDelayMs) ? Math.max(0, opts.initialDelayMs) : 100;
  const maxDelayMs = Number.isFinite(opts.maxDelayMs) ? Math.max(initialDelayMs, opts.maxDelayMs) : 1500;
  const onRetry = typeof opts.onRetry === 'function' ? opts.onRetry : null;

  const sleepSync = typeof opts.sleepSync === 'function'
    ? opts.sleepSync
    : (ms) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) { /* busy-wait */ }
      };

  let attempt = 0;
  let lastErr;
  while (attempt < maxAttempts) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientSqliteLockError(err)) throw err;
      attempt += 1;
      if (attempt >= maxAttempts) break;
      const delay = Math.min(maxDelayMs, initialDelayMs * 2 ** (attempt - 1));
      if (onRetry) onRetry({ err, attempt, delay });
      sleepSync(delay);
    }
  }
  throw lastErr;
}

export async function runWithSqliteBusyRetry(fn, opts = {}) {
  const maxAttempts = Number.isFinite(opts.maxAttempts) ? Math.max(1, opts.maxAttempts) : 5;
  const initialDelayMs = Number.isFinite(opts.initialDelayMs) ? Math.max(0, opts.initialDelayMs) : 100;
  const maxDelayMs = Number.isFinite(opts.maxDelayMs) ? Math.max(initialDelayMs, opts.maxDelayMs) : 1500;
  const onRetry = typeof opts.onRetry === 'function' ? opts.onRetry : null;
  const sleep = typeof opts.sleep === 'function'
    ? opts.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let attempt = 0;
  let lastErr;
  while (attempt < maxAttempts) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientSqliteLockError(err)) throw err;
      attempt += 1;
      if (attempt >= maxAttempts) break;
      const delay = Math.min(maxDelayMs, initialDelayMs * 2 ** (attempt - 1));
      if (onRetry) onRetry({ err, attempt, delay });
      await sleep(delay);
    }
  }
  throw lastErr;
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
  denied_at                TEXT,
  -- approval_id is a non-redeemable opaque public id projected to operator
  -- read surfaces (/_ref/approvals) so callers cannot lift the live
  -- device_code (which is bearer-equivalent in the consent flow when
  -- combined with /consent/approve) from a public projection. The
  -- internal device_code remains the authoritative join key for the form
  -- approve/deny POSTs and the request_uri.
  approval_id              TEXT UNIQUE
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
  scenario_id        TEXT,
  -- approval_id mirrors the column on pending_consents — see comment there.
  -- The owner-device flow's device_code is the literal bearer for
  -- POST /oauth/token; projecting it to operator surfaces is a
  -- direct credential leak.
  approval_id        TEXT UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_owner_device_auth_status_expires
  ON owner_device_auth(status, expires_at);

CREATE TABLE IF NOT EXISTS device_exporters (
  device_id         TEXT PRIMARY KEY,
  owner_subject_id  TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active',
  agent_version     TEXT,
  last_heartbeat_at TEXT,
  last_error_json   TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  revoked_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_device_exporters_owner_status
  ON device_exporters(owner_subject_id, status, created_at);

CREATE TABLE IF NOT EXISTS device_ingest_credentials (
  credential_id     TEXT PRIMARY KEY,
  device_id         TEXT NOT NULL,
  token_hash        TEXT NOT NULL UNIQUE,
  status            TEXT NOT NULL DEFAULT 'active',
  created_at        TEXT NOT NULL,
  last_used_at      TEXT,
  revoked_at        TEXT,
  FOREIGN KEY(device_id) REFERENCES device_exporters(device_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_device_ingest_credentials_device_status
  ON device_ingest_credentials(device_id, status);

CREATE TABLE IF NOT EXISTS device_enrollment_codes (
  enrollment_code_id  TEXT PRIMARY KEY,
  code_hash           TEXT NOT NULL UNIQUE,
  owner_subject_id    TEXT NOT NULL,
  connector_id        TEXT NOT NULL,
  local_binding_id    TEXT NOT NULL,
  display_name        TEXT,
  device_id           TEXT,
  status              TEXT NOT NULL DEFAULT 'pending',
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  consumed_at         TEXT,
  revoked_at          TEXT,
  FOREIGN KEY(device_id) REFERENCES device_exporters(device_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_device_enrollment_codes_owner_status
  ON device_enrollment_codes(owner_subject_id, status, expires_at);

CREATE TABLE IF NOT EXISTS device_source_instances (
  source_instance_id  TEXT PRIMARY KEY,
  device_id           TEXT NOT NULL,
  connector_id        TEXT NOT NULL,
  local_binding_id    TEXT NOT NULL,
  display_name        TEXT,
  status              TEXT NOT NULL DEFAULT 'active',
  last_error_json     TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  revoked_at          TEXT,
  UNIQUE(device_id, connector_id, local_binding_id),
  UNIQUE(device_id, source_instance_id),
  FOREIGN KEY(device_id) REFERENCES device_exporters(device_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_device_source_instances_device_status
  ON device_source_instances(device_id, status);

CREATE TABLE IF NOT EXISTS device_ingest_batch_outcomes (
  device_id       TEXT NOT NULL,
  batch_id        TEXT NOT NULL,
  body_hash       TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  status          TEXT NOT NULL,
  http_status     INTEGER NOT NULL,
  response_json   TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY(device_id, batch_id, body_hash),
  UNIQUE(device_id, batch_id),
  FOREIGN KEY(device_id) REFERENCES device_exporters(device_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_device_ingest_batch_outcomes_source
  ON device_ingest_batch_outcomes(device_id, source_instance_id, created_at);

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

CREATE TABLE IF NOT EXISTS browser_surfaces (
  surface_id       TEXT PRIMARY KEY,
  backend          TEXT NOT NULL,
  profile_key      TEXT NOT NULL,
  connector_id     TEXT NOT NULL,
  account_key      TEXT,
  surface_mode     TEXT,
  surface_source   TEXT,
  cdp_url          TEXT NOT NULL,
  stream_base_url  TEXT NOT NULL,
  stream_origin    TEXT,
  health           TEXT NOT NULL,
  container_id     TEXT,
  container_name   TEXT,
  profile_dir      TEXT,
  profile_volume   TEXT,
  active_lease_id  TEXT,
  created_at       TEXT NOT NULL,
  last_used_at     TEXT NOT NULL,
  CHECK (backend IN ('neko')),
  CHECK (surface_mode IS NULL OR surface_mode IN ('static', 'dynamic')),
  CHECK (health IN ('starting', 'ready', 'unhealthy', 'stopping'))
);

CREATE INDEX IF NOT EXISTS idx_browser_surfaces_profile_health
  ON browser_surfaces(backend, profile_key, health, last_used_at);

CREATE INDEX IF NOT EXISTS idx_browser_surfaces_active_lease
  ON browser_surfaces(active_lease_id)
  WHERE active_lease_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS browser_surface_leases (
  lease_id        TEXT PRIMARY KEY,
  surface_id      TEXT,
  connector_id    TEXT NOT NULL,
  profile_key     TEXT NOT NULL,
  account_key     TEXT,
  run_id          TEXT NOT NULL,
  status          TEXT NOT NULL,
  priority_class  TEXT NOT NULL,
  requested_at    TEXT NOT NULL,
  leased_at       TEXT,
  released_at     TEXT,
  expires_at      TEXT NOT NULL,
  fencing_token   INTEGER NOT NULL,
  wait_reason     TEXT,
  CHECK (status IN (
    'waiting_for_browser_surface',
    'starting_surface',
    'leased',
    'released',
    'expired',
    'deferred',
    'cancelled',
    'surface_failed'
  )),
  CHECK (priority_class IN ('owner_interactive', 'scheduled_refresh')),
  CHECK (wait_reason IS NULL OR wait_reason IN (
    'capacity_full',
    'surface_starting',
    'surface_unhealthy',
    'surface_start_failed',
    'surface_readiness_timeout',
    'incompatible_static_profile',
    'launch_precondition_failed',
    'lease_wait_timeout'
  )),
  FOREIGN KEY (surface_id) REFERENCES browser_surfaces(surface_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_surface_leases_one_non_terminal_run
  ON browser_surface_leases(run_id)
  WHERE status NOT IN ('released', 'expired', 'deferred', 'cancelled', 'surface_failed');

CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_surface_leases_one_active_surface
  ON browser_surface_leases(surface_id)
  WHERE surface_id IS NOT NULL AND status = 'leased';

CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_surface_leases_one_pending_connector_profile
  ON browser_surface_leases(connector_id, profile_key, COALESCE(account_key, ''))
  WHERE status IN ('waiting_for_browser_surface', 'starting_surface');

CREATE INDEX IF NOT EXISTS idx_browser_surface_leases_non_terminal
  ON browser_surface_leases(status, priority_class, requested_at);

CREATE TABLE IF NOT EXISTS scheduler_run_history (
  id                         INTEGER PRIMARY KEY AUTOINCREMENT,
  connector_id               TEXT NOT NULL,
  source_json                TEXT NOT NULL,
  status                     TEXT NOT NULL,
  records_emitted            INTEGER NOT NULL DEFAULT 0,
  reported_records_emitted   INTEGER,
  checkpoint_summary_json    TEXT,
  known_gaps_json            TEXT NOT NULL DEFAULT '[]',
  connector_error_json       TEXT,
  run_id                     TEXT,
  trace_id                   TEXT,
  failure_reason             TEXT,
  terminal_reason            TEXT,
  started_at                 TEXT NOT NULL,
  completed_at               TEXT NOT NULL,
  error                      TEXT,
  attempt                    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduler_run_history_connector_completed
  ON scheduler_run_history(connector_id, completed_at, id);

CREATE TABLE IF NOT EXISTS scheduler_last_run_times (
  connector_id       TEXT PRIMARY KEY,
  last_run_time_ms   INTEGER NOT NULL,
  updated_at         TEXT NOT NULL
);

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

-- blob_bindings.json_path: either an RFC 6901 JSON Pointer naming the
-- record_json leaf the blob replaces (e.g. '/output_preview',
-- '/messages/0/content') or the reserved pseudo-path '@record' for
-- record-level bindings that aren't tied to a specific field
-- (current attachment-style writers). The CHECK constraint enforces
-- the shape — every json_path is either '@record' or starts with '/'.
-- See docs/binary-content-invariant-design-brief.md §4.6.
CREATE TABLE IF NOT EXISTS blob_bindings (
  blob_id       TEXT NOT NULL,
  connector_id  TEXT NOT NULL,
  stream        TEXT NOT NULL,
  record_key    TEXT NOT NULL,
  json_path     TEXT NOT NULL DEFAULT '@record',
  PRIMARY KEY(blob_id, connector_id, stream, record_key, json_path),
  FOREIGN KEY(blob_id) REFERENCES blobs(blob_id),
  CHECK (json_path = '@record' OR substr(json_path, 1, 1) = '/')
);

CREATE INDEX IF NOT EXISTS idx_blob_bindings_record
  ON blob_bindings(connector_id, stream, record_key);

-- sha256 uniqueness is *implied* by the blob_id = 'blob_sha256_<hex>'
-- naming convention plus the PRIMARY KEY on blob_id. Making the
-- invariant explicit at the schema layer protects against future drift
-- where a code path might generate a non-derived blob_id.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_blobs_sha256
  ON blobs(sha256);

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

-- spine_events.event_seq: stable monotonic logical sequence assigned at
-- append time. Disclosure-spine timeline pagination orders by event_seq
-- so the cursor contract no longer leaks SQLite rowid. The column is
-- additive; existing rows are backfilled in initDb post-schema. New
-- inserts compute event_seq via a (SELECT MAX(event_seq) + 1 FROM ...)
-- subquery inside the INSERT, which is safe under SQLite's single-writer
-- lock model.
-- Spec: openspec/changes/replace-spine-rowid-cursor-with-event-seq/specs/
--       reference-implementation-architecture/spec.md
CREATE TABLE IF NOT EXISTS spine_events (
  event_id         TEXT PRIMARY KEY,
  event_seq        INTEGER,
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
  source_kind      TEXT,
  source_id        TEXT,
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
function addColumnIfMissing(raw, table, column, type) {
  const cols = raw.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return;
  raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

function tableColumns(raw, table) {
  return raw.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function hasTableColumn(raw, table, column) {
  return tableColumns(raw, table).includes(column);
}

function isSourceKind(value) {
  return value === 'connector' || value === 'provider_native';
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseSpineSourceShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const source = value;
  const canonicalKind = nonEmptyString(source.kind);
  const canonicalId = nonEmptyString(source.id);
  if (isSourceKind(canonicalKind) && canonicalId) {
    return { kind: canonicalKind, id: canonicalId };
  }

  const legacyKind = nonEmptyString(source.binding_kind);
  if (legacyKind === 'connector') {
    const id = nonEmptyString(source.connector_id);
    if (id) return { kind: 'connector', id };
  }
  if (legacyKind === 'provider_native') {
    const id = nonEmptyString(source.provider_id);
    if (id) return { kind: 'provider_native', id };
  }

  const connectorId = nonEmptyString(source.connector_id);
  const providerId = nonEmptyString(source.provider_id);
  if (connectorId && !providerId) return { kind: 'connector', id: connectorId };
  if (providerId && !connectorId) return { kind: 'provider_native', id: providerId };

  return null;
}

function parseSpineEventData(rawJson, eventId) {
  try {
    return rawJson ? JSON.parse(rawJson) : {};
  } catch (err) {
    throw new Error(`Cannot migrate spine_events row ${eventId}: data_json is not valid JSON`);
  }
}

function deriveSpineSource(payload, row) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (Object.prototype.hasOwnProperty.call(payload, 'source')) {
      const source = parseSpineSourceShape(payload.source);
      if (source) return source;
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'source_binding')) {
      const source = parseSpineSourceShape(payload.source_binding);
      if (source) return source;
    }
    const connectorId = nonEmptyString(payload.connector_id);
    const providerId = nonEmptyString(payload.provider_id);
    if (connectorId && !providerId) return { kind: 'connector', id: connectorId };
    if (providerId && !connectorId) return { kind: 'provider_native', id: providerId };
  }

  const sourceKind = nonEmptyString(row.source_kind);
  const sourceId = nonEmptyString(row.source_id);
  if (isSourceKind(sourceKind) && sourceId) {
    return { kind: sourceKind, id: sourceId };
  }

  const providerId = nonEmptyString(row.provider_id);
  if (providerId) {
    return { kind: 'provider_native', id: providerId };
  }

  const actorId = nonEmptyString(row.actor_id);
  if (row.actor_type === 'runtime' && actorId) {
    return { kind: 'connector', id: actorId };
  }

  return null;
}

function migrateSpineSourceColumns(raw, opts = {}) {
  if (!tableColumns(raw, 'spine_events').length) {
    return { backfilledRows: 0, rowCount: 0, droppedProviderId: false };
  }

  const hadProviderId = hasTableColumn(raw, 'spine_events', 'provider_id');
  const migration = raw.transaction(() => {
    const beforeCount = raw.prepare('SELECT COUNT(*) AS count FROM spine_events').get().count;
    addColumnIfMissing(raw, 'spine_events', 'source_kind', 'TEXT');
    addColumnIfMissing(raw, 'spine_events', 'source_id', 'TEXT');

    const providerProjection = hadProviderId ? ', provider_id' : '';
    const rows = raw.prepare(
      `SELECT event_id, actor_type, actor_id, data_json, source_kind, source_id${providerProjection} FROM spine_events`
    ).all();
    const update = raw.prepare(
      'UPDATE spine_events SET source_kind = @source_kind, source_id = @source_id, data_json = @data_json WHERE event_id = @event_id'
    );
    let backfilledRows = 0;

    for (const row of rows) {
      const payload = parseSpineEventData(row.data_json, row.event_id);
      const source = deriveSpineSource(payload, row);
      if (!source) {
        continue;
      }
      const nextPayload = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? { ...payload, source }
        : { source };
      const nextDataJson = JSON.stringify(nextPayload);
      if (row.source_kind !== source.kind || row.source_id !== source.id || row.data_json !== nextDataJson) {
        update.run({
          event_id: row.event_id,
          source_kind: source.kind,
          source_id: source.id,
          data_json: nextDataJson,
        });
        backfilledRows += 1;
      }
    }

    if (hadProviderId) {
      raw.exec('ALTER TABLE spine_events DROP COLUMN provider_id');
    }
    raw.exec(
      `CREATE INDEX IF NOT EXISTS idx_spine_events_source
        ON spine_events(source_kind, source_id, occurred_at, recorded_at)`
    );

    const afterCount = raw.prepare('SELECT COUNT(*) AS count FROM spine_events').get().count;
    if (beforeCount !== afterCount) {
      throw new Error(`spine_events source migration row-count mismatch: before=${beforeCount} after=${afterCount}`);
    }
    raw.pragma('user_version = 1');
    return { backfilledRows, rowCount: afterCount, droppedProviderId: hadProviderId };
  });

  const result = migration();
  if (typeof opts.onSchemaMigration === 'function') {
    opts.onSchemaMigration({ name: 'spine_events_source_columns', ...result });
  }
  return result;
}

/**
 * Migrate `blob_bindings` to include `json_path` in the primary key.
 *
 * Pre-migration shape: PRIMARY KEY (blob_id, connector_id, stream, record_key).
 * Post-migration shape: PRIMARY KEY (blob_id, connector_id, stream, record_key, json_path)
 * with json_path TEXT NOT NULL and CHECK (json_path = '@record' OR substr(json_path, 1, 1) = '/').
 *
 * SQLite has no `ALTER TABLE ... ADD COLUMN ... PRIMARY KEY`, so the
 * migration is a full table rebuild: create blob_bindings_new with the
 * new shape, copy rows backfilling json_path = '@record' (the
 * pre-existing semantics — every legacy binding was a record-level
 * attachment-style binding), DROP the old table, and rename.
 *
 * Idempotent: detects the new shape via PRAGMA table_info and skips when
 * the column is already present.
 *
 * See docs/binary-content-invariant-design-brief.md §4.6.
 */
function migrateBlobBindingsJsonPath(raw, opts = {}) {
  if (hasTableColumn(raw, 'blob_bindings', 'json_path')) {
    return { rebuilt: false, backfilledRows: 0 };
  }

  const migration = raw.transaction(() => {
    const before = raw.prepare('SELECT COUNT(*) AS count FROM blob_bindings').get().count;

    raw.exec(`
      CREATE TABLE blob_bindings_new (
        blob_id       TEXT NOT NULL,
        connector_id  TEXT NOT NULL,
        stream        TEXT NOT NULL,
        record_key    TEXT NOT NULL,
        json_path     TEXT NOT NULL DEFAULT '@record',
        PRIMARY KEY(blob_id, connector_id, stream, record_key, json_path),
        FOREIGN KEY(blob_id) REFERENCES blobs(blob_id),
        CHECK (json_path = '@record' OR substr(json_path, 1, 1) = '/')
      );

      INSERT INTO blob_bindings_new (blob_id, connector_id, stream, record_key, json_path)
      SELECT blob_id, connector_id, stream, record_key, '@record'
      FROM blob_bindings;

      DROP TABLE blob_bindings;

      ALTER TABLE blob_bindings_new RENAME TO blob_bindings;

      CREATE INDEX IF NOT EXISTS idx_blob_bindings_record
        ON blob_bindings(connector_id, stream, record_key);
    `);

    const after = raw.prepare('SELECT COUNT(*) AS count FROM blob_bindings').get().count;
    if (before !== after) {
      throw new Error(
        `blob_bindings json_path migration row-count mismatch: before=${before} after=${after}`
      );
    }
    return { rebuilt: true, backfilledRows: after };
  });

  const result = migration();
  if (typeof opts.onSchemaMigration === 'function') {
    opts.onSchemaMigration({ name: 'blob_bindings_json_path', ...result });
  }
  return result;
}

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

export function initDb(path = ':memory:', opts = {}) {
  closeDb();
  const busyTimeoutMs = resolveSqliteBusyTimeoutMs(opts.busyTimeoutMs);
  const raw = new Database(path, { timeout: busyTimeoutMs });
  raw.pragma(`busy_timeout = ${busyTimeoutMs}`);

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

  // The first non-trivial write on the freshly opened DB. On Docker dev
  // restart the previous process may still be closing its WAL writer;
  // wrap with the same bounded retry policy used by
  // `seedPreRegisteredClients` so a single SQLITE_BUSY at boot doesn't
  // crash the new process. Sync because better-sqlite3 / initDb are sync.
  runWithSqliteBusyRetrySync(() => raw.exec(SCHEMA), {
    onRetry: opts.onSchemaRetry,
  });
  // Idempotent column additions for tables that pre-existed before the
  // column was introduced. SQLite has no `ADD COLUMN IF NOT EXISTS`, so
  // we probe pragma table_info and only ALTER when the column is missing.
  // Adds the non-redeemable `approval_id` column on the consent + device
  // auth tables; see SCHEMA comment for rationale.
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'pending_consents', 'approval_id', 'TEXT'));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'owner_device_auth', 'approval_id', 'TEXT'));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'device_exporters', 'agent_version', 'TEXT'));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'device_exporters', 'last_heartbeat_at', 'TEXT'));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'device_exporters', 'last_error_json', 'TEXT'));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'device_enrollment_codes', 'connector_id', "TEXT NOT NULL DEFAULT 'unknown'"));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'device_enrollment_codes', 'local_binding_id', "TEXT NOT NULL DEFAULT 'default'"));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'device_enrollment_codes', 'display_name', 'TEXT'));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'device_source_instances', 'last_error_json', 'TEXT'));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'browser_surfaces', 'surface_mode', 'TEXT'));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'browser_surfaces', 'surface_source', 'TEXT'));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'browser_surfaces', 'stream_origin', 'TEXT'));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'browser_surfaces', 'container_name', 'TEXT'));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'browser_surfaces', 'profile_dir', 'TEXT'));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'browser_surfaces', 'profile_volume', 'TEXT'));
  // Disclosure-spine `event_seq` migration. Pre-existing reference DBs were
  // created before `event_seq` existed; add the column non-destructively and
  // seed it for any rows that lack a value. The seed orders by `rowid` —
  // SQLite's physical row identity at the moment of backfill — purely as a
  // one-shot reconstruction of historical append order. After backfill,
  // `event_seq` is the only ordering surface readers and cursors consult;
  // the cursor contract no longer reads `rowid`.
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'spine_events', 'event_seq', 'INTEGER'));
  runWithSqliteBusyRetrySync(() => {
    raw.exec(
      `UPDATE spine_events SET event_seq = rowid WHERE event_seq IS NULL`
    );
  });
  runWithSqliteBusyRetrySync(() => migrateSpineSourceColumns(raw, opts));
  // blob_bindings gains a json_path column (RFC 6901 JSON Pointer or
  // '@record' pseudo-path). Required for lossless binary extraction
  // during sqlite→postgres migration; see
  // docs/binary-content-invariant-design-brief.md §4.6. Legacy rows
  // backfill with '@record' (their existing record-level semantics).
  runWithSqliteBusyRetrySync(() => migrateBlobBindingsJsonPath(raw, opts));
  raw.exec(
    `CREATE INDEX IF NOT EXISTS idx_spine_events_run_terminal
      ON spine_events(run_id, event_type, event_seq DESC)
      WHERE run_id IS NOT NULL
        AND event_type IN ('run.completed', 'run.failed', 'run.cancelled', 'run.abandoned')`
  );
  // Boot-epoch reconciliation idempotency: at most one run.abandoned per
  // orphaned run.started.event_id. A retry of the boot reconciler hits
  // the unique-violation, which the runtime catches by constraint name
  // (sqlite_constraint_unique with INDEX spine_run_abandoned_cause_unique)
  // and treats as no-op. See docs/run-reconciliation-design-brief.md section 3.5.
  raw.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS spine_run_abandoned_cause_unique
      ON spine_events(json_extract(data_json, '$.caused_by_event_id'))
      WHERE event_type = 'run.abandoned'`
  );
  raw.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_spine_events_seq ON spine_events(event_seq) WHERE event_seq IS NOT NULL`
  );
  // Index gives us a fast lookup-by-approval-id and approximates the
  // UNIQUE constraint on the column (the inline CREATE TABLE form
  // declares it UNIQUE; SQLite's ALTER TABLE ADD COLUMN does not
  // accept UNIQUE inline, so a partial unique index is the equivalent
  // for pre-existing DBs).
  raw.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_consents_approval_id ON pending_consents(approval_id) WHERE approval_id IS NOT NULL`);
  raw.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_owner_device_auth_approval_id ON owner_device_auth(approval_id) WHERE approval_id IS NOT NULL`);
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
