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
import { createHash } from 'node:crypto';
import * as sqliteVec from 'sqlite-vec';

const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 30_000;
const LEGACY_SYNC_STATE_OWNER_SUBJECT_ID = 'owner_local';

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

CREATE TABLE IF NOT EXISTS connector_instances (
  connector_instance_id TEXT PRIMARY KEY,
  owner_subject_id      TEXT NOT NULL,
  connector_id          TEXT NOT NULL,
  display_name          TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked')),
  source_kind           TEXT NOT NULL CHECK (source_kind IN ('account', 'local_device', 'manual', 'legacy')),
  source_binding_key    TEXT NOT NULL,
  source_binding_json   TEXT NOT NULL DEFAULT '{}',
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  revoked_at            TEXT,
  UNIQUE(owner_subject_id, connector_id, source_kind, source_binding_key),
  FOREIGN KEY(connector_id) REFERENCES connectors(connector_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_connector_instances_owner_connector_status
  ON connector_instances(owner_subject_id, connector_id, status);

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

CREATE TABLE IF NOT EXISTS web_push_subscriptions (
  id                  TEXT PRIMARY KEY,
  owner_subject_id    TEXT NOT NULL,
  endpoint            TEXT NOT NULL UNIQUE,
  p256dh              TEXT NOT NULL,
  auth                TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  revoked_at          TEXT,
  last_success_at     TEXT,
  last_failure_at     TEXT,
  last_failure_reason TEXT,
  last_used_at        TEXT,
  user_agent          TEXT,
  platform            TEXT,
  device_label        TEXT
);

CREATE INDEX IF NOT EXISTS idx_web_push_subscriptions_owner_active
  ON web_push_subscriptions(owner_subject_id, revoked_at, updated_at);

CREATE TABLE IF NOT EXISTS device_exporters (
  device_id                  TEXT PRIMARY KEY,
  owner_subject_id           TEXT NOT NULL,
  display_name               TEXT NOT NULL,
  status                     TEXT NOT NULL DEFAULT 'active',
  agent_version              TEXT,
  collector_protocol_version TEXT,
  last_heartbeat_at          TEXT,
  last_error_json            TEXT,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  revoked_at                 TEXT
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
  connector_instance_id TEXT,
  local_binding_id    TEXT NOT NULL,
  display_name        TEXT,
  status              TEXT NOT NULL DEFAULT 'active',
  last_error_json     TEXT,
  -- Heartbeat evidence persisted from device collector reports. Used by
  -- the connection-health outbox axis so the operator console can see
  -- whether a source instance is idle, actively draining, or stalled
  -- without reading device-local SQLite. Bounded values; no secrets.
  last_heartbeat_at      TEXT,
  last_heartbeat_status  TEXT,
  records_pending        INTEGER,
  outbox_diagnostics_json TEXT,
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

CREATE TABLE IF NOT EXISTS source_webhook_events (
  source_id    TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  body_hash    TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  PRIMARY KEY(source_id, event_id)
);

CREATE TABLE IF NOT EXISTS connector_schedules (
  connector_instance_id TEXT PRIMARY KEY,
  connector_id      TEXT NOT NULL,
  interval_seconds  INTEGER NOT NULL,
  jitter_seconds    INTEGER NOT NULL DEFAULT 0,
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS controller_active_runs (
  connector_instance_id TEXT PRIMARY KEY,
  connector_id  TEXT NOT NULL,
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
  surface_subject_id TEXT,
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
  surface_subject_id TEXT,
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
  connector_instance_id      TEXT NOT NULL,
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
  connector_instance_id TEXT PRIMARY KEY,
  connector_id       TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  id                    TEXT PRIMARY KEY,
  device_code           TEXT NOT NULL UNIQUE,
  code                  TEXT UNIQUE,
  client_id             TEXT NOT NULL,
  redirect_uri          TEXT NOT NULL,
  state                 TEXT,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending',
  grant_id              TEXT,
  token_id              TEXT,
  created_at            TEXT NOT NULL,
  expires_at            TEXT NOT NULL,
  issued_at             TEXT,
  consumed_at           TEXT
);

CREATE INDEX IF NOT EXISTS idx_oauth_authorization_codes_code
  ON oauth_authorization_codes(code);
CREATE INDEX IF NOT EXISTS idx_oauth_authorization_codes_client_status
  ON oauth_authorization_codes(client_id, status, expires_at);

CREATE TABLE IF NOT EXISTS records (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  connector_id  TEXT NOT NULL,
  connector_instance_id TEXT NOT NULL,
  stream        TEXT NOT NULL,
  record_key    TEXT NOT NULL,
  record_json   TEXT NOT NULL,
  emitted_at    TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  deleted       INTEGER NOT NULL DEFAULT 0,
  deleted_at    TEXT,
  UNIQUE(connector_instance_id, stream, record_key)
);

CREATE INDEX IF NOT EXISTS idx_records_lookup
  ON records(connector_id, stream, record_key);

CREATE INDEX IF NOT EXISTS idx_records_version
  ON records(connector_id, stream, version);

CREATE TABLE IF NOT EXISTS record_changes (
  connector_id  TEXT NOT NULL,
  connector_instance_id TEXT NOT NULL,
  stream        TEXT NOT NULL,
  record_key    TEXT NOT NULL,
  version       INTEGER NOT NULL,
  record_json   TEXT,
  emitted_at    TEXT NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0,
  deleted_at    TEXT,
  PRIMARY KEY(connector_instance_id, stream, version)
);

CREATE INDEX IF NOT EXISTS idx_record_changes_record
  ON record_changes(connector_id, stream, record_key, version);

CREATE TABLE IF NOT EXISTS blobs (
  blob_id       TEXT PRIMARY KEY,
  connector_id  TEXT NOT NULL,
  connector_instance_id TEXT NOT NULL,
  stream        TEXT NOT NULL,
  record_key    TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  data          BLOB
);

CREATE TABLE IF NOT EXISTS dataset_summary_projection (
  projection_key TEXT PRIMARY KEY,
  summary_json   TEXT NOT NULL,
  metadata_json  TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  -- Monotonic generation counter used to fence concurrent rebuild/reconcile
  -- writers against live record/blob delta writers. Every projection write
  -- bumps the generation. A rebuild captures the post-rebuilding-mark
  -- generation and only commits its final summary when the captured value
  -- still matches; otherwise it leaves the projection stale rather than
  -- silently overwriting a concurrent delta.
  generation     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS dataset_summary_stream_projection (
  connector_id              TEXT NOT NULL,
  stream                    TEXT NOT NULL,
  record_count              INTEGER NOT NULL DEFAULT 0,
  record_json_bytes         INTEGER NOT NULL DEFAULT 0,
  earliest_ingested_at      TEXT,
  latest_ingested_at        TEXT,
  earliest_record_time      TEXT,
  latest_record_time        TEXT,
  consent_time_field        TEXT,
  dirty_record_time_bounds  INTEGER NOT NULL DEFAULT 0,
  computed_at               TEXT,
  PRIMARY KEY(connector_id, stream)
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
  connector_instance_id TEXT NOT NULL,
  stream        TEXT NOT NULL,
  record_key    TEXT NOT NULL,
  json_path     TEXT NOT NULL DEFAULT '@record',
  PRIMARY KEY(blob_id, connector_instance_id, stream, record_key, json_path),
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
  connector_instance_id TEXT NOT NULL,
  stream        TEXT NOT NULL,
  state_json    TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(connector_instance_id, stream)
);

CREATE TABLE IF NOT EXISTS grant_connector_state (
  grant_id      TEXT NOT NULL,
  connector_id  TEXT NOT NULL,
  connector_instance_id TEXT NOT NULL,
  stream        TEXT NOT NULL,
  state_json    TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(grant_id, connector_instance_id, stream)
);

CREATE TABLE IF NOT EXISTS connector_detail_gaps (
  gap_id              TEXT PRIMARY KEY,
  connector_id        TEXT NOT NULL,
  connector_instance_id TEXT NOT NULL,
  grant_id            TEXT,
  source_json         TEXT NOT NULL,
  stream              TEXT NOT NULL,
  parent_stream       TEXT,
  record_key          TEXT,
  detail_locator_json TEXT,
  list_cursor_json    TEXT,
  scope_json          TEXT,
  reason              TEXT,
  status              TEXT NOT NULL DEFAULT 'pending',
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  last_attempt_at     TEXT,
  next_attempt_after  TEXT,
  last_error_json     TEXT,
  discovered_run_id   TEXT,
  last_run_id         TEXT,
  recovered_run_id    TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (status IN ('pending', 'in_progress', 'recovered', 'terminal'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_connector_detail_gaps_identity
  ON connector_detail_gaps(connector_id, ifnull(grant_id, ''), stream, ifnull(parent_stream, ''), ifnull(record_key, ''), ifnull(detail_locator_json, ''));

CREATE INDEX IF NOT EXISTS idx_connector_detail_gaps_pending
  ON connector_detail_gaps(connector_id, grant_id, status, stream, next_attempt_after);

CREATE TABLE IF NOT EXISTS version_counter (
  connector_id  TEXT NOT NULL,
  connector_instance_id TEXT NOT NULL,
  stream        TEXT NOT NULL,
  max_version   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(connector_instance_id, stream)
);

-- Durable structured attention records for the reference operator console.
-- Scoped per (connector_id, connector_instance_id) so the connector summary
-- and detail projections only see attention belonging to the connection
-- they are rendering. record_json carries the full AttentionRecord shape
-- as serialized by the runtime; the projection only needs a small subset
-- (lifecycle, axes, reason_code, action_target, etc.) plus the secret-safe
-- redaction the runtime applies at construction time.
CREATE TABLE IF NOT EXISTS connector_attention_records (
  attention_id          TEXT PRIMARY KEY,
  dedupe_key            TEXT NOT NULL,
  connector_id          TEXT NOT NULL,
  connector_instance_id TEXT NOT NULL,
  connection_id         TEXT NOT NULL,
  run_id                TEXT,
  reason_code           TEXT NOT NULL,
  lifecycle             TEXT NOT NULL,
  sensitivity           TEXT NOT NULL,
  expires_at            TEXT,
  record_json           TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  CHECK (lifecycle IN ('open', 'acknowledged', 'in_progress', 'resolved', 'expired', 'cancelled', 'superseded')),
  CHECK (sensitivity IN ('none', 'non_secret', 'secret'))
);

CREATE INDEX IF NOT EXISTS idx_connector_attention_open
  ON connector_attention_records(connector_id, connector_instance_id, lifecycle, updated_at);

CREATE INDEX IF NOT EXISTS idx_connector_attention_dedupe
  ON connector_attention_records(connector_id, connector_instance_id, dedupe_key, lifecycle);

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
-- One row per (connector_instance_id, stream, record_key, field) where \`field\` is
-- declared in the stream's manifest under query.search.lexical_fields.
-- Maintenance is JS-side at the record write/update/delete call sites
-- (see search.js); the manifest decides what's indexable, which triggers
-- can't see. The non-content columns are UNINDEXED to keep the FTS index
-- small and the full-text matching focused on \`text\`.
-- Spec: openspec/changes/add-lexical-retrieval-extension/specs/lexical-retrieval/spec.md
CREATE VIRTUAL TABLE IF NOT EXISTS lexical_search_index USING fts5(
  connector_id UNINDEXED,
  connector_instance_id UNINDEXED,
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

-- Per-(connector instance, stream) fingerprint of the last-rebuilt declared
-- lexical_fields set. Used by the backfill drift detector in search.js
-- to force a rebuild when the manifest changes the field set, even when
-- the field count stays the same (e.g. ['title'] -> ['selftext']). The
-- row-count heuristic alone cannot detect that case because stale rows
-- satisfy the count band.
CREATE TABLE IF NOT EXISTS lexical_search_meta (
  connector_id        TEXT NOT NULL,
  connector_instance_id TEXT NOT NULL,
  stream              TEXT NOT NULL,
  fields_fingerprint  TEXT NOT NULL,
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(connector_instance_id, stream)
);

-- Semantic retrieval experimental extension — drift tracking.
-- Per-(connector instance, stream) fingerprint of the last-rebuilt declared
-- semantic_fields set AND the backend identity (model_id + dimensions +
-- distance_metric) at index time. The backfill drift detector in
-- search-semantic.js compares these against the live backend on startup and
-- on every connector register/update; any disagreement flips
-- capabilities.semantic_retrieval.index_state to "stale" until a rebuild
-- restores coverage.
-- Spec: openspec/changes/add-semantic-retrieval-experimental-extension/specs/semantic-retrieval/spec.md
CREATE TABLE IF NOT EXISTS semantic_search_meta (
  connector_instance_id TEXT NOT NULL,
  connector_id        TEXT NOT NULL,
  stream              TEXT NOT NULL,
  fields_fingerprint  TEXT NOT NULL,
  model_id            TEXT NOT NULL,
  dimensions          INTEGER NOT NULL,
  distance_metric     TEXT NOT NULL,
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(connector_instance_id, stream)
);

-- Persistent in-progress semantic backfill identity. This lets an
-- interrupted rebuild resume already-written record-field vectors when the
-- active field fingerprint and backend storage identity still match.
CREATE TABLE IF NOT EXISTS semantic_search_backfill_progress (
  connector_instance_id TEXT NOT NULL,
  connector_id        TEXT NOT NULL,
  stream              TEXT NOT NULL,
  fields_fingerprint  TEXT NOT NULL,
  model_id            TEXT NOT NULL,
  dimensions          INTEGER NOT NULL,
  distance_metric     TEXT NOT NULL,
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(connector_instance_id, stream)
);

-- Maps logical semantic-index identity (connector_instance_id, scope_key, record_key)
-- to the vec0 rowid (sqlite-vec path only). vec0 requires an integer rowid
-- and does not support composite text PKs; this sidecar lets us upsert by
-- logical identity. Unused on the BLOB-flat fallback.
-- scope_key encodes (stream, field) as JSON.stringify([stream, field]);
-- see search-semantic.js for the helper.
CREATE TABLE IF NOT EXISTS semantic_search_rowid (
  connector_instance_id TEXT NOT NULL,
  connector_id  TEXT NOT NULL,
  scope_key     TEXT NOT NULL,
  record_key    TEXT NOT NULL,
  rowid         INTEGER NOT NULL,
  PRIMARY KEY(connector_instance_id, scope_key, record_key)
);

-- BLOB-flat fallback table (used only when sqlite-vec cannot be loaded).
-- Stores embeddings as Float32Array byte BLOBs; distance is computed in JS
-- after the plan-scoped SELECT narrows to the authorized (connector_id,
-- scope_key) tuples. Same grant-safety invariants as the sqlite-vec path:
-- no unauthorized row is ever read, because the caller constructs the
-- WHERE clause from a grant-gated plan.
CREATE TABLE IF NOT EXISTS semantic_search_blob (
  connector_instance_id TEXT NOT NULL,
  connector_id  TEXT NOT NULL,
  scope_key     TEXT NOT NULL,
  record_key    TEXT NOT NULL,
  embedding     BLOB NOT NULL,
  PRIMARY KEY(connector_instance_id, scope_key, record_key)
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

-- Retained-size read model (reference-only, owner-facing).
-- See openspec/changes/add-retained-size-read-model/ for the spec delta.
--
-- Three projection tables for three finite grains: global, connection,
-- stream. The global row carries owner-facing metadata about projection
-- freshness; connection and stream rows are bounded by the connector
-- instance/manifest, never by JSON path. All byte measures are logical
-- (UTF-8 record JSON, retained record_changes JSON, retained blob bytes).
-- Physical storage metrics are deliberately out of scope.
CREATE TABLE IF NOT EXISTS retained_size_global (
  projection_key                TEXT PRIMARY KEY,
  current_record_json_bytes     INTEGER NOT NULL DEFAULT 0,
  record_history_json_bytes     INTEGER NOT NULL DEFAULT 0,
  blob_bytes                    INTEGER NOT NULL DEFAULT 0,
  record_count                  INTEGER NOT NULL DEFAULT 0,
  record_history_count          INTEGER NOT NULL DEFAULT 0,
  blob_count                    INTEGER NOT NULL DEFAULT 0,
  -- 1 means a write happened that the projection could not safely
  -- incrementally apply (e.g. a bulk delete). Hot reads must surface this
  -- as 'stale' rather than presenting the row as fresh truth.
  dirty                         INTEGER NOT NULL DEFAULT 1,
  computed_at                   TEXT,
  -- JSON metadata: { state, stale_since, rebuild_status, last_error }.
  -- Same shape as dataset_summary_projection.metadata_json so the
  -- existing dashboard surface stays consistent.
  metadata_json                 TEXT
);

CREATE TABLE IF NOT EXISTS retained_size_connection (
  connector_instance_id         TEXT NOT NULL,
  connector_id                  TEXT NOT NULL,
  current_record_json_bytes     INTEGER NOT NULL DEFAULT 0,
  record_history_json_bytes     INTEGER NOT NULL DEFAULT 0,
  blob_bytes                    INTEGER NOT NULL DEFAULT 0,
  record_count                  INTEGER NOT NULL DEFAULT 0,
  record_history_count          INTEGER NOT NULL DEFAULT 0,
  blob_count                    INTEGER NOT NULL DEFAULT 0,
  dirty                         INTEGER NOT NULL DEFAULT 1,
  computed_at                   TEXT,
  PRIMARY KEY(connector_instance_id)
);
CREATE INDEX IF NOT EXISTS idx_retained_size_connection_connector
  ON retained_size_connection(connector_id);

CREATE TABLE IF NOT EXISTS retained_size_stream (
  connector_instance_id         TEXT NOT NULL,
  connector_id                  TEXT NOT NULL,
  stream                        TEXT NOT NULL,
  current_record_json_bytes     INTEGER NOT NULL DEFAULT 0,
  record_history_json_bytes     INTEGER NOT NULL DEFAULT 0,
  blob_bytes                    INTEGER NOT NULL DEFAULT 0,
  record_count                  INTEGER NOT NULL DEFAULT 0,
  record_history_count          INTEGER NOT NULL DEFAULT 0,
  blob_count                    INTEGER NOT NULL DEFAULT 0,
  dirty                         INTEGER NOT NULL DEFAULT 1,
  computed_at                   TEXT,
  PRIMARY KEY(connector_instance_id, stream)
);

CREATE TABLE IF NOT EXISTS retained_size_record_family (
  connector_instance_id         TEXT NOT NULL,
  connector_id                  TEXT NOT NULL,
  stream                        TEXT NOT NULL,
  record_family                 TEXT NOT NULL,
  current_record_json_bytes     INTEGER NOT NULL DEFAULT 0,
  record_history_json_bytes     INTEGER NOT NULL DEFAULT 0,
  blob_bytes                    INTEGER NOT NULL DEFAULT 0,
  record_count                  INTEGER NOT NULL DEFAULT 0,
  record_history_count          INTEGER NOT NULL DEFAULT 0,
  blob_count                    INTEGER NOT NULL DEFAULT 0,
  dirty                         INTEGER NOT NULL DEFAULT 1,
  computed_at                   TEXT,
  PRIMARY KEY(connector_instance_id, stream, record_family)
);

CREATE TABLE IF NOT EXISTS retained_size_top_rows (
  scope                         TEXT NOT NULL,
  measure                       TEXT NOT NULL,
  rank                          INTEGER NOT NULL,
  grain_key                     TEXT NOT NULL,
  connector_instance_id         TEXT,
  connector_id                  TEXT,
  stream                        TEXT,
  record_key                    TEXT,
  blob_id                       TEXT,
  current_record_json_bytes     INTEGER NOT NULL DEFAULT 0,
  record_history_json_bytes     INTEGER NOT NULL DEFAULT 0,
  blob_bytes                    INTEGER NOT NULL DEFAULT 0,
  total_retained_bytes          INTEGER NOT NULL DEFAULT 0,
  record_count                  INTEGER NOT NULL DEFAULT 0,
  record_history_count          INTEGER NOT NULL DEFAULT 0,
  blob_count                    INTEGER NOT NULL DEFAULT 0,
  dirty                         INTEGER NOT NULL DEFAULT 1,
  computed_at                   TEXT,
  metadata_json                 TEXT,
  PRIMARY KEY(scope, measure, rank)
);
CREATE INDEX IF NOT EXISTS idx_retained_size_top_rows_lookup
  ON retained_size_top_rows(scope, measure, total_retained_bytes DESC, rank ASC);
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

function ensureBrowserSurfaceLeaseIndexes(raw) {
  raw.exec(`
DROP INDEX IF EXISTS idx_browser_surface_leases_one_pending_connector_profile;

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
`);
}

function migrateBrowserSurfaceLeaseEnumChecks(raw) {
  const row = raw.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'browser_surface_leases'"
  ).get();
  const createSql = typeof row?.sql === 'string' ? row.sql : '';
  if (createSql.includes("'starting_surface'") && createSql.includes("'surface_start_failed'")) {
    return;
  }

  addColumnIfMissing(raw, 'browser_surface_leases', 'surface_subject_id', 'TEXT');

  raw.exec(`
DROP TABLE IF EXISTS browser_surface_leases_new;

CREATE TABLE browser_surface_leases_new (
  lease_id        TEXT PRIMARY KEY,
  surface_id      TEXT,
  connector_id    TEXT NOT NULL,
  profile_key     TEXT NOT NULL,
  surface_subject_id TEXT,
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

INSERT INTO browser_surface_leases_new(
  lease_id,
  surface_id,
  connector_id,
  profile_key,
  surface_subject_id,
  account_key,
  run_id,
  status,
  priority_class,
  requested_at,
  leased_at,
  released_at,
  expires_at,
  fencing_token,
  wait_reason
)
SELECT
  lease_id,
  surface_id,
  connector_id,
  profile_key,
  NULL AS surface_subject_id,
  account_key,
  run_id,
  status,
  priority_class,
  requested_at,
  leased_at,
  released_at,
  expires_at,
  fencing_token,
  wait_reason
FROM browser_surface_leases;

DROP TABLE browser_surface_leases;
ALTER TABLE browser_surface_leases_new RENAME TO browser_surface_leases;
`);
  ensureBrowserSurfaceLeaseIndexes(raw);
}

function tableColumns(raw, table) {
  return raw.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function hasTableColumn(raw, table, column) {
  return tableColumns(raw, table).includes(column);
}

function stableJson(value) {
  if (value == null) return '{}';
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashKey(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sourceBindingKey(sourceBinding) {
  return hashKey(stableJson(sourceBinding ?? {}));
}

function connectorInstanceId(ownerSubjectId, connectorId, sourceKind, bindingKey) {
  return `cin_${hashKey(`${ownerSubjectId}\n${connectorId}\n${sourceKind}\n${bindingKey}`).slice(0, 24)}`;
}

function localDeviceConnectorId(connectorId) {
  return `local-device:${encodeURIComponent(connectorId)}`;
}

function legacyLocalDeviceConnectorId(connectorId, sourceInstanceId) {
  return `${localDeviceConnectorId(connectorId)}:${encodeURIComponent(sourceInstanceId)}`;
}

function makeLegacyConnectorInstanceId(ownerSubjectId, connectorId) {
  const hash = createHash('sha256').update(`${ownerSubjectId}\n${connectorId}`).digest('hex');
  return `cin_legacy_${hash.slice(0, 24)}`;
}

function legacySyncStateConnectorInstanceId(raw, connectorId) {
  const rows = raw.prepare(
    `SELECT connector_instance_id
       FROM connector_instances
      WHERE connector_id = ?
      ORDER BY connector_instance_id`
  ).all(connectorId);
  if (rows.length === 1) {
    return rows[0].connector_instance_id;
  }
  return makeLegacyConnectorInstanceId(LEGACY_SYNC_STATE_OWNER_SUBJECT_ID, connectorId);
}

function migrateConnectorSyncStateInstanceColumns(raw, opts = {}) {
  const ownerHasInstanceColumn = hasTableColumn(raw, 'connector_state', 'connector_instance_id');
  const grantHasInstanceColumn = hasTableColumn(raw, 'grant_connector_state', 'connector_instance_id');
  if (ownerHasInstanceColumn && grantHasInstanceColumn) {
    return { rebuilt: false, backfilledRows: 0 };
  }

  const migration = raw.transaction(() => {
    const ownerRows = raw.prepare(
      `SELECT connector_id,
              ${ownerHasInstanceColumn ? 'connector_instance_id,' : ''}
              stream,
              state_json,
              updated_at
         FROM connector_state
        ORDER BY connector_id, stream`
    ).all();
    const grantRows = raw.prepare(
      `SELECT grant_id,
              connector_id,
              ${grantHasInstanceColumn ? 'connector_instance_id,' : ''}
              stream,
              state_json,
              updated_at
         FROM grant_connector_state
        ORDER BY grant_id, connector_id, stream`
    ).all();
    const byConnector = new Map();
    const resolveInstanceId = (row) => {
      if (typeof row.connector_instance_id === 'string' && row.connector_instance_id.trim()) {
        return row.connector_instance_id.trim();
      }
      const connectorId = row.connector_id;
      if (!byConnector.has(connectorId)) {
        byConnector.set(connectorId, legacySyncStateConnectorInstanceId(raw, connectorId));
      }
      return byConnector.get(connectorId);
    };

    raw.exec(`
      DROP TABLE connector_state;
      CREATE TABLE connector_state (
        connector_id  TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        stream        TEXT NOT NULL,
        state_json    TEXT NOT NULL,
        updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(connector_instance_id, stream)
      );

      DROP TABLE grant_connector_state;
      CREATE TABLE grant_connector_state (
        grant_id      TEXT NOT NULL,
        connector_id  TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        stream        TEXT NOT NULL,
        state_json    TEXT NOT NULL,
        updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(grant_id, connector_instance_id, stream)
      );
    `);

    const insertOwner = raw.prepare(
      `INSERT INTO connector_state(connector_id, connector_instance_id, stream, state_json, updated_at)
       VALUES(?, ?, ?, ?, ?)`
    );
    const insertGrant = raw.prepare(
      `INSERT INTO grant_connector_state(grant_id, connector_id, connector_instance_id, stream, state_json, updated_at)
       VALUES(?, ?, ?, ?, ?, ?)`
    );
    for (const row of ownerRows) {
      insertOwner.run(row.connector_id, resolveInstanceId(row), row.stream, row.state_json, row.updated_at);
    }
    for (const row of grantRows) {
      insertGrant.run(
        row.grant_id,
        row.connector_id,
        resolveInstanceId(row),
        row.stream,
        row.state_json,
        row.updated_at
      );
    }

    return {
      rebuilt: true,
      backfilledRows: (ownerHasInstanceColumn ? 0 : ownerRows.length) + (grantHasInstanceColumn ? 0 : grantRows.length),
    };
  });

  const result = migration();
  if (typeof opts.onSchemaMigration === 'function') {
    opts.onSchemaMigration({ name: 'connector_sync_state_instance_columns', ...result });
  }
  return result;
}

function updateConnectorIdForInstance(raw, table, oldConnectorId, newConnectorId, connectorInstanceId) {
  if (!hasTableColumn(raw, table, 'connector_id') || !hasTableColumn(raw, table, 'connector_instance_id')) {
    return 0;
  }
  return raw.prepare(
    `UPDATE ${table}
        SET connector_id = ?
      WHERE connector_id = ?
        AND connector_instance_id = ?`
  ).run(newConnectorId, oldConnectorId, connectorInstanceId).changes;
}

function migrateLocalDeviceConnectorInstances(raw, opts = {}) {
  if (
    !hasTableColumn(raw, 'device_source_instances', 'connector_instance_id')
    || !hasTableColumn(raw, 'connector_instances', 'source_binding_key')
    || !hasTableColumn(raw, 'connector_instances', 'source_binding_json')
  ) {
    return { rebuilt: false, backfilledRows: 0 };
  }

  const rows = raw.prepare(
    `SELECT dsi.source_instance_id,
            dsi.device_id,
            dsi.connector_id,
            dsi.connector_instance_id,
            dsi.local_binding_id,
            dsi.display_name,
            dsi.status,
            dsi.created_at,
            dsi.updated_at,
            dsi.revoked_at,
            de.owner_subject_id
       FROM device_source_instances dsi
       JOIN device_exporters de ON de.device_id = dsi.device_id
      WHERE dsi.connector_id IS NOT NULL
        AND trim(dsi.connector_id) <> ''
        AND dsi.source_instance_id IS NOT NULL
        AND trim(dsi.source_instance_id) <> ''
      ORDER BY dsi.device_id, dsi.source_instance_id`
  ).all();
  if (rows.length === 0) {
    return { rebuilt: false, backfilledRows: 0 };
  }

  const tables = [
    'connector_state',
    'grant_connector_state',
    'records',
    'record_changes',
    'version_counter',
    'blobs',
    'blob_bindings',
    'lexical_search_index',
    'lexical_search_meta',
    'semantic_search_rowid',
    'semantic_search_blob',
    'semantic_search_meta',
    'semantic_search_backfill_progress',
    'connector_detail_gaps',
    'connector_schedules',
    'controller_active_runs',
    'scheduler_run_history',
    'scheduler_last_run_times',
  ];

  const migration = raw.transaction(() => {
    const legacyInstanceRows = raw.prepare(
      `SELECT connector_instance_id
         FROM (
           SELECT connector_instance_id FROM connector_state WHERE connector_id = ?
           UNION
           SELECT connector_instance_id FROM grant_connector_state WHERE connector_id = ?
           UNION
           SELECT connector_instance_id FROM records WHERE connector_id = ?
           UNION
           SELECT connector_instance_id FROM record_changes WHERE connector_id = ?
           UNION
           SELECT connector_instance_id FROM version_counter WHERE connector_id = ?
           UNION
           SELECT connector_instance_id FROM blobs WHERE connector_id = ?
           UNION
           SELECT connector_instance_id FROM blob_bindings WHERE connector_id = ?
           UNION
           SELECT connector_instance_id FROM lexical_search_index WHERE connector_id = ?
           UNION
           SELECT connector_instance_id FROM lexical_search_meta WHERE connector_id = ?
           UNION
           SELECT connector_instance_id FROM semantic_search_rowid WHERE connector_id = ?
           UNION
           SELECT connector_instance_id FROM semantic_search_blob WHERE connector_id = ?
           UNION
           SELECT connector_instance_id FROM semantic_search_meta WHERE connector_id = ?
           UNION
           SELECT connector_instance_id FROM semantic_search_backfill_progress WHERE connector_id = ?
         )
        WHERE connector_instance_id IS NOT NULL
          AND trim(connector_instance_id) <> ''
        ORDER BY connector_instance_id`
    );
    const upsertConnector = raw.prepare(
      `INSERT INTO connectors(connector_id, manifest, created_at)
       VALUES(?, ?, ?)
       ON CONFLICT(connector_id) DO NOTHING`
    );
    const getExistingInstanceByBinding = raw.prepare(
      `SELECT connector_instance_id
         FROM connector_instances
        WHERE owner_subject_id = ?
          AND connector_id = ?
          AND source_kind = 'local_device'
          AND source_binding_key = ?
        LIMIT 1`
    );
    const upsertInstance = raw.prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       )
       VALUES(?, ?, ?, ?, ?, 'local_device', ?, ?, ?, ?, ?)
       ON CONFLICT(connector_instance_id) DO UPDATE SET
         owner_subject_id = excluded.owner_subject_id,
         connector_id = excluded.connector_id,
         display_name = excluded.display_name,
         status = excluded.status,
         source_kind = excluded.source_kind,
         source_binding_key = excluded.source_binding_key,
         source_binding_json = excluded.source_binding_json,
         updated_at = excluded.updated_at,
         revoked_at = excluded.revoked_at`
    );
    const updateSourceInstance = raw.prepare(
      `UPDATE device_source_instances
          SET connector_instance_id = ?,
              updated_at = ?
        WHERE device_id = ?
          AND source_instance_id = ?`
    );

    let backfilledRows = 0;
    const now = new Date().toISOString();
    for (const row of rows) {
      const sourceBinding = {
        kind: 'local_device',
        device_id: row.device_id,
        local_binding_name: row.local_binding_id,
        source_instance_id: row.source_instance_id,
      };
      const bindingKey = sourceBindingKey(sourceBinding);
      const newConnectorId = localDeviceConnectorId(row.connector_id);
      const oldConnectorId = legacyLocalDeviceConnectorId(row.connector_id, row.source_instance_id);
      const legacyRows = legacyInstanceRows.all(
        oldConnectorId,
        oldConnectorId,
        oldConnectorId,
        oldConnectorId,
        oldConnectorId,
        oldConnectorId,
        oldConnectorId,
        oldConnectorId,
        oldConnectorId,
        oldConnectorId,
        oldConnectorId,
        oldConnectorId,
        oldConnectorId,
      );
      const legacyInstanceIds = [...new Set(legacyRows.map((r) => r.connector_instance_id.trim()).filter(Boolean))];
      if (!row.connector_instance_id && legacyInstanceIds.length > 1) {
        throw new Error(
          `Cannot migrate local-device source_instance_id '${row.source_instance_id}': legacy rows under '${oldConnectorId}' have multiple connector_instance_ids (${legacyInstanceIds.join(', ')}) and device_source_instances.connector_instance_id is empty.`
        );
      }
      const currentInstanceId = typeof row.connector_instance_id === 'string' && row.connector_instance_id.trim()
        ? row.connector_instance_id.trim()
        : null;
      const legacyInstanceId = legacyInstanceIds[0] || null;
      const existingBinding = getExistingInstanceByBinding.get(row.owner_subject_id, row.connector_id, bindingKey);
      const existingBindingInstanceId = existingBinding?.connector_instance_id || null;
      if (currentInstanceId && existingBindingInstanceId && existingBindingInstanceId !== currentInstanceId) {
        throw new Error(
          `Cannot migrate local-device source_instance_id '${row.source_instance_id}': existing binding uses connector_instance_id '${existingBindingInstanceId}' but source row uses '${currentInstanceId}'.`
        );
      }
      if (legacyInstanceId && existingBindingInstanceId && existingBindingInstanceId !== legacyInstanceId) {
        throw new Error(
          `Cannot migrate local-device source_instance_id '${row.source_instance_id}': existing binding uses connector_instance_id '${existingBindingInstanceId}' but legacy rows use '${legacyInstanceId}'.`
        );
      }
      const resolvedInstanceId = currentInstanceId
        || existingBindingInstanceId
        || legacyInstanceId
        || connectorInstanceId(row.owner_subject_id, row.connector_id, 'local_device', bindingKey);
      const createdAt = row.created_at || now;
      const updatedAt = row.updated_at || now;
      const displayName = row.display_name || row.local_binding_id || row.connector_id;
      const status = row.status === 'revoked' ? 'revoked' : 'active';
      const manifest = stableJson({
        connector_id: row.connector_id,
        display_name: displayName,
        streams: [],
      });

      upsertConnector.run(row.connector_id, manifest, createdAt);
      upsertInstance.run(
        resolvedInstanceId,
        row.owner_subject_id,
        row.connector_id,
        displayName,
        status,
        bindingKey,
        stableJson(sourceBinding),
        createdAt,
        updatedAt,
        status === 'revoked' ? (row.revoked_at ?? updatedAt) : null,
      );
      if (currentInstanceId !== resolvedInstanceId) {
        updateSourceInstance.run(resolvedInstanceId, updatedAt, row.device_id, row.source_instance_id);
        backfilledRows += 1;
      }

      for (const table of tables) {
        backfilledRows += updateConnectorIdForInstance(raw, table, oldConnectorId, newConnectorId, resolvedInstanceId);
      }
    }
    return { rebuilt: false, backfilledRows };
  });

  const result = migration();
  if (result.backfilledRows > 0 && typeof opts.onSchemaMigration === 'function') {
    opts.onSchemaMigration({ name: 'local_device_connector_instances', ...result });
  }
  return result;
}

function migrateRecordStorageInstanceColumns(raw, opts = {}) {
  const recordsHaveInstance = hasTableColumn(raw, 'records', 'connector_instance_id');
  const changesHaveInstance = hasTableColumn(raw, 'record_changes', 'connector_instance_id');
  const countersHaveInstance = hasTableColumn(raw, 'version_counter', 'connector_instance_id');
  const bindingsHaveInstance = hasTableColumn(raw, 'blob_bindings', 'connector_instance_id');
  if (recordsHaveInstance && changesHaveInstance && countersHaveInstance && bindingsHaveInstance) {
    return { rebuilt: false, backfilledRows: 0 };
  }

  const migration = raw.transaction(() => {
    const records = raw.prepare(
      `SELECT id, connector_id, ${recordsHaveInstance ? 'connector_instance_id,' : ''} stream, record_key, record_json, emitted_at, version, deleted, deleted_at
         FROM records
        ORDER BY id`
    ).all();
    const changes = raw.prepare(
      `SELECT connector_id, ${changesHaveInstance ? 'connector_instance_id,' : ''} stream, record_key, version, record_json, emitted_at, deleted, deleted_at
         FROM record_changes
        ORDER BY connector_id, stream, version`
    ).all();
    const counters = raw.prepare(
      `SELECT connector_id, ${countersHaveInstance ? 'connector_instance_id,' : ''} stream, max_version
         FROM version_counter
        ORDER BY connector_id, stream`
    ).all();
    const bindings = raw.prepare(
      `SELECT blob_id, connector_id, ${bindingsHaveInstance ? 'connector_instance_id,' : ''} stream, record_key, json_path
         FROM blob_bindings
        ORDER BY blob_id, connector_id, stream, record_key, json_path`
    ).all();
    const instanceIds = new Map();
    const resolveInstanceId = (row) => {
      if (typeof row.connector_instance_id === 'string' && row.connector_instance_id.trim()) return row.connector_instance_id.trim();
      if (!instanceIds.has(row.connector_id)) instanceIds.set(row.connector_id, legacySyncStateConnectorInstanceId(raw, row.connector_id));
      return instanceIds.get(row.connector_id);
    };

    raw.exec(`
      DROP TABLE records;
      CREATE TABLE records (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        connector_id  TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        stream        TEXT NOT NULL,
        record_key    TEXT NOT NULL,
        record_json   TEXT NOT NULL,
        emitted_at    TEXT NOT NULL,
        version       INTEGER NOT NULL DEFAULT 1,
        deleted       INTEGER NOT NULL DEFAULT 0,
        deleted_at    TEXT,
        UNIQUE(connector_instance_id, stream, record_key)
      );

      DROP TABLE record_changes;
      CREATE TABLE record_changes (
        connector_id  TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        stream        TEXT NOT NULL,
        record_key    TEXT NOT NULL,
        version       INTEGER NOT NULL,
        record_json   TEXT,
        emitted_at    TEXT NOT NULL,
        deleted       INTEGER NOT NULL DEFAULT 0,
        deleted_at    TEXT,
        PRIMARY KEY(connector_instance_id, stream, version)
      );

      DROP TABLE version_counter;
      CREATE TABLE version_counter (
        connector_id  TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        stream        TEXT NOT NULL,
        max_version   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(connector_instance_id, stream)
      );

      DROP TABLE blob_bindings;
      CREATE TABLE blob_bindings (
        blob_id       TEXT NOT NULL,
        connector_id  TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        stream        TEXT NOT NULL,
        record_key    TEXT NOT NULL,
        json_path     TEXT NOT NULL DEFAULT '@record',
        PRIMARY KEY(blob_id, connector_instance_id, stream, record_key, json_path),
        FOREIGN KEY(blob_id) REFERENCES blobs(blob_id),
        CHECK (json_path = '@record' OR substr(json_path, 1, 1) = '/')
      );
    `);

    const insertRecord = raw.prepare(
      `INSERT INTO records(id, connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, deleted_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of records) {
      insertRecord.run(row.id, row.connector_id, resolveInstanceId(row), row.stream, row.record_key, row.record_json, row.emitted_at, row.version, row.deleted, row.deleted_at);
    }

    const insertChange = raw.prepare(
      `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted, deleted_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of changes) {
      insertChange.run(row.connector_id, resolveInstanceId(row), row.stream, row.record_key, row.version, row.record_json, row.emitted_at, row.deleted, row.deleted_at);
    }

    const insertCounter = raw.prepare(
      `INSERT INTO version_counter(connector_id, connector_instance_id, stream, max_version)
       VALUES(?, ?, ?, ?)`
    );
    for (const row of counters) {
      insertCounter.run(row.connector_id, resolveInstanceId(row), row.stream, row.max_version);
    }

    const insertBinding = raw.prepare(
      `INSERT INTO blob_bindings(blob_id, connector_id, connector_instance_id, stream, record_key, json_path)
       VALUES(?, ?, ?, ?, ?, ?)`
    );
    for (const row of bindings) {
      insertBinding.run(row.blob_id, row.connector_id, resolveInstanceId(row), row.stream, row.record_key, row.json_path);
    }

    raw.exec(`
      CREATE INDEX IF NOT EXISTS idx_records_lookup ON records(connector_instance_id, stream, record_key);
      CREATE INDEX IF NOT EXISTS idx_records_version ON records(connector_instance_id, stream, version);
      CREATE INDEX IF NOT EXISTS idx_record_changes_record ON record_changes(connector_instance_id, stream, record_key, version);
      CREATE INDEX IF NOT EXISTS idx_blob_bindings_record ON blob_bindings(connector_instance_id, stream, record_key);
    `);

    return {
      rebuilt: true,
      backfilledRows:
        (recordsHaveInstance ? 0 : records.length)
        + (changesHaveInstance ? 0 : changes.length)
        + (countersHaveInstance ? 0 : counters.length)
        + (bindingsHaveInstance ? 0 : bindings.length),
    };
  });

  const result = migration();
  if (typeof opts.onSchemaMigration === 'function') {
    opts.onSchemaMigration({ name: 'record_storage_instance_columns', ...result });
  }
  return result;
}

function migrateBlobOriginInstanceColumn(raw, opts = {}) {
  addColumnIfMissing(raw, 'blobs', 'connector_instance_id', 'TEXT');
  const rows = raw.prepare(
    `SELECT blob_id, connector_id, connector_instance_id
       FROM blobs
      WHERE connector_instance_id IS NULL OR trim(connector_instance_id) = ''
      ORDER BY connector_id, blob_id`
  ).all();
  if (rows.length === 0) {
    return { rebuilt: false, backfilledRows: 0 };
  }

  const bindingInstance = raw.prepare(
    `SELECT connector_instance_id
       FROM blob_bindings
      WHERE blob_id = ? AND connector_id = ?
        AND connector_instance_id IS NOT NULL
        AND trim(connector_instance_id) <> ''
      ORDER BY connector_instance_id
      LIMIT 1`
  );
  const update = raw.prepare(
    `UPDATE blobs SET connector_instance_id = ? WHERE blob_id = ?`
  );
  const legacyInstanceIds = new Map();
  const migration = raw.transaction(() => {
    let backfilledRows = 0;
    for (const row of rows) {
      const binding = bindingInstance.get(row.blob_id, row.connector_id);
      let connectorInstanceId = typeof binding?.connector_instance_id === 'string'
        ? binding.connector_instance_id.trim()
        : '';
      if (!connectorInstanceId) {
        if (!legacyInstanceIds.has(row.connector_id)) {
          legacyInstanceIds.set(row.connector_id, legacySyncStateConnectorInstanceId(raw, row.connector_id));
        }
        connectorInstanceId = legacyInstanceIds.get(row.connector_id);
      }
      update.run(connectorInstanceId, row.blob_id);
      backfilledRows += 1;
    }
    return { rebuilt: false, backfilledRows };
  });

  const result = migration();
  if (typeof opts.onSchemaMigration === 'function') {
    opts.onSchemaMigration({ name: 'blob_origin_instance_column', ...result });
  }
  return result;
}

function migrateLexicalSearchInstanceColumns(raw, opts = {}) {
  const indexHasInstance = hasTableColumn(raw, 'lexical_search_index', 'connector_instance_id');
  const metaHasInstance = hasTableColumn(raw, 'lexical_search_meta', 'connector_instance_id');
  if (indexHasInstance && metaHasInstance) {
    return { rebuilt: false, backfilledRows: 0 };
  }

  const migration = raw.transaction(() => {
    const indexRows = raw.prepare(
      `SELECT connector_id, ${indexHasInstance ? 'connector_instance_id,' : ''} stream, record_key, field, text
         FROM lexical_search_index
        ORDER BY connector_id, stream, record_key, field`
    ).all();
    const metaRows = raw.prepare(
      `SELECT connector_id, ${metaHasInstance ? 'connector_instance_id,' : ''} stream, fields_fingerprint, updated_at
         FROM lexical_search_meta
        ORDER BY connector_id, stream`
    ).all();
    const instanceIds = new Map();
    const resolveInstanceId = (row) => {
      if (typeof row.connector_instance_id === 'string' && row.connector_instance_id.trim()) return row.connector_instance_id.trim();
      if (!instanceIds.has(row.connector_id)) instanceIds.set(row.connector_id, legacySyncStateConnectorInstanceId(raw, row.connector_id));
      return instanceIds.get(row.connector_id);
    };

    raw.exec(`
      DROP TABLE lexical_search_index;
      CREATE VIRTUAL TABLE lexical_search_index USING fts5(
        connector_id UNINDEXED,
        connector_instance_id UNINDEXED,
        stream       UNINDEXED,
        record_key   UNINDEXED,
        field        UNINDEXED,
        text,
        tokenize = 'unicode61'
      );

      DROP TABLE lexical_search_meta;
      CREATE TABLE lexical_search_meta (
        connector_id        TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        stream              TEXT NOT NULL,
        fields_fingerprint  TEXT NOT NULL,
        updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(connector_instance_id, stream)
      );
    `);

    const insertIndex = raw.prepare(
      `INSERT INTO lexical_search_index(connector_id, connector_instance_id, stream, record_key, field, text)
       VALUES(?, ?, ?, ?, ?, ?)`
    );
    for (const row of indexRows) {
      insertIndex.run(row.connector_id, resolveInstanceId(row), row.stream, row.record_key, row.field, row.text);
    }

    const insertMeta = raw.prepare(
      `INSERT INTO lexical_search_meta(connector_id, connector_instance_id, stream, fields_fingerprint, updated_at)
       VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(connector_instance_id, stream) DO UPDATE SET
         connector_id = excluded.connector_id,
         fields_fingerprint = excluded.fields_fingerprint,
         updated_at = excluded.updated_at`
    );
    for (const row of metaRows) {
      insertMeta.run(row.connector_id, resolveInstanceId(row), row.stream, row.fields_fingerprint, row.updated_at);
    }

    return {
      rebuilt: true,
      backfilledRows: (indexHasInstance ? 0 : indexRows.length) + (metaHasInstance ? 0 : metaRows.length),
    };
  });

  const result = migration();
  if (typeof opts.onSchemaMigration === 'function') {
    opts.onSchemaMigration({ name: 'lexical_search_instance_columns', ...result });
  }
  return result;
}

function migrateConnectorDetailGapInstanceColumns(raw, opts = {}) {
  const hasInstance = hasTableColumn(raw, 'connector_detail_gaps', 'connector_instance_id');
  if (!hasInstance) {
    addColumnIfMissing(raw, 'connector_detail_gaps', 'connector_instance_id', 'TEXT');
    const rows = raw.prepare('SELECT gap_id, connector_id FROM connector_detail_gaps ORDER BY gap_id').all();
    const instanceIds = new Map();
    const resolveInstanceId = (connectorId) => {
      if (!instanceIds.has(connectorId)) instanceIds.set(connectorId, legacySyncStateConnectorInstanceId(raw, connectorId));
      return instanceIds.get(connectorId);
    };
    const update = raw.prepare('UPDATE connector_detail_gaps SET connector_instance_id = ? WHERE gap_id = ?');
    for (const row of rows) {
      update.run(resolveInstanceId(row.connector_id), row.gap_id);
    }
    if (typeof opts.onSchemaMigration === 'function') {
      opts.onSchemaMigration({ name: 'connector_detail_gap_instance_columns', rebuilt: false, backfilledRows: rows.length });
    }
  }

  raw.exec(`
DROP INDEX IF EXISTS uniq_connector_detail_gaps_identity;
DROP INDEX IF EXISTS idx_connector_detail_gaps_pending;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_connector_detail_gaps_identity
  ON connector_detail_gaps(connector_instance_id, ifnull(grant_id, ''), stream, ifnull(parent_stream, ''), ifnull(record_key, ''), ifnull(detail_locator_json, ''));
CREATE INDEX IF NOT EXISTS idx_connector_detail_gaps_pending
  ON connector_detail_gaps(connector_instance_id, grant_id, status, stream, next_attempt_after);
`);
}

function migrateSchedulerInstanceColumns(raw) {
  const schedulesHaveInstance = hasTableColumn(raw, 'connector_schedules', 'connector_instance_id');
  const activeRunsHaveInstance = hasTableColumn(raw, 'controller_active_runs', 'connector_instance_id');
  const historyHaveInstance = hasTableColumn(raw, 'scheduler_run_history', 'connector_instance_id');
  const lastRunHaveInstance = hasTableColumn(raw, 'scheduler_last_run_times', 'connector_instance_id');
  if (schedulesHaveInstance && activeRunsHaveInstance && historyHaveInstance && lastRunHaveInstance) return;

  raw.transaction(() => {
    const schedules = raw.prepare(`SELECT ${schedulesHaveInstance ? 'connector_instance_id,' : ''} connector_id, interval_seconds, jitter_seconds, enabled, created_at, updated_at FROM connector_schedules ORDER BY connector_id`).all();
    const activeRuns = raw.prepare(`SELECT ${activeRunsHaveInstance ? 'connector_instance_id,' : ''} connector_id, run_id, trace_id, scenario_id, started_at FROM controller_active_runs ORDER BY connector_id`).all();
    const history = raw.prepare(`SELECT id, ${historyHaveInstance ? 'connector_instance_id,' : ''} connector_id, source_json, status, records_emitted, reported_records_emitted, checkpoint_summary_json, known_gaps_json, connector_error_json, run_id, trace_id, failure_reason, terminal_reason, started_at, completed_at, error, attempt FROM scheduler_run_history ORDER BY id`).all();
    const lastRuns = raw.prepare(`SELECT ${lastRunHaveInstance ? 'connector_instance_id,' : ''} connector_id, last_run_time_ms, updated_at FROM scheduler_last_run_times ORDER BY connector_id`).all();
    const instanceIds = new Map();
    const resolveInstanceId = (row) => {
      if (typeof row.connector_instance_id === 'string' && row.connector_instance_id.trim()) return row.connector_instance_id.trim();
      if (!instanceIds.has(row.connector_id)) instanceIds.set(row.connector_id, legacySyncStateConnectorInstanceId(raw, row.connector_id));
      return instanceIds.get(row.connector_id);
    };

    raw.exec(`
DROP TABLE connector_schedules;
CREATE TABLE connector_schedules (
  connector_instance_id TEXT PRIMARY KEY,
  connector_id      TEXT NOT NULL,
  interval_seconds  INTEGER NOT NULL,
  jitter_seconds    INTEGER NOT NULL DEFAULT 0,
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

DROP TABLE controller_active_runs;
CREATE TABLE controller_active_runs (
  connector_instance_id TEXT PRIMARY KEY,
  connector_id  TEXT NOT NULL,
  run_id        TEXT NOT NULL UNIQUE,
  trace_id      TEXT NOT NULL,
  scenario_id   TEXT NOT NULL,
  started_at    TEXT NOT NULL
);

DROP TABLE scheduler_run_history;
CREATE TABLE scheduler_run_history (
  id                         INTEGER PRIMARY KEY AUTOINCREMENT,
  connector_instance_id      TEXT NOT NULL,
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

DROP TABLE scheduler_last_run_times;
CREATE TABLE scheduler_last_run_times (
  connector_instance_id TEXT PRIMARY KEY,
  connector_id       TEXT NOT NULL,
  last_run_time_ms   INTEGER NOT NULL,
  updated_at         TEXT NOT NULL
);
`);

    const insertSchedule = raw.prepare(`INSERT INTO connector_schedules(connector_instance_id, connector_id, interval_seconds, jitter_seconds, enabled, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)`);
    for (const row of schedules) insertSchedule.run(resolveInstanceId(row), row.connector_id, row.interval_seconds, row.jitter_seconds, row.enabled, row.created_at, row.updated_at);
    const insertActiveRun = raw.prepare(`INSERT INTO controller_active_runs(connector_instance_id, connector_id, run_id, trace_id, scenario_id, started_at) VALUES(?, ?, ?, ?, ?, ?)`);
    for (const row of activeRuns) insertActiveRun.run(resolveInstanceId(row), row.connector_id, row.run_id, row.trace_id, row.scenario_id, row.started_at);
    const insertHistory = raw.prepare(`INSERT INTO scheduler_run_history(id, connector_instance_id, connector_id, source_json, status, records_emitted, reported_records_emitted, checkpoint_summary_json, known_gaps_json, connector_error_json, run_id, trace_id, failure_reason, terminal_reason, started_at, completed_at, error, attempt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of history) insertHistory.run(row.id, resolveInstanceId(row), row.connector_id, row.source_json, row.status, row.records_emitted, row.reported_records_emitted, row.checkpoint_summary_json, row.known_gaps_json, row.connector_error_json, row.run_id, row.trace_id, row.failure_reason, row.terminal_reason, row.started_at, row.completed_at, row.error, row.attempt);
    const insertLastRun = raw.prepare(`INSERT INTO scheduler_last_run_times(connector_instance_id, connector_id, last_run_time_ms, updated_at) VALUES(?, ?, ?, ?)`);
    for (const row of lastRuns) insertLastRun.run(resolveInstanceId(row), row.connector_id, row.last_run_time_ms, row.updated_at);
  })();

  raw.exec(`
DROP INDEX IF EXISTS idx_scheduler_run_history_connector_completed;
CREATE INDEX IF NOT EXISTS idx_controller_active_runs_run_id ON controller_active_runs(run_id);
CREATE INDEX IF NOT EXISTS idx_scheduler_run_history_connector_completed ON scheduler_run_history(connector_instance_id, completed_at, id);
`);
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

function migrateSemanticSearchInstanceColumns(raw, opts = {}) {
  const rowidHasInstance = hasTableColumn(raw, 'semantic_search_rowid', 'connector_instance_id');
  const blobHasInstance = hasTableColumn(raw, 'semantic_search_blob', 'connector_instance_id');
  const metaHasInstance = hasTableColumn(raw, 'semantic_search_meta', 'connector_instance_id');
  const progressHasInstance = hasTableColumn(raw, 'semantic_search_backfill_progress', 'connector_instance_id');
  if (rowidHasInstance && blobHasInstance && metaHasInstance && progressHasInstance) {
    return { rebuilt: false, backfilledRows: 0 };
  }

  const migration = raw.transaction(() => {
    const rowids = raw.prepare(
      `SELECT ${rowidHasInstance ? 'connector_instance_id,' : ''} connector_id, scope_key, record_key, rowid
        FROM semantic_search_rowid`
    ).all();
    const blobs = raw.prepare(
      `SELECT ${blobHasInstance ? 'connector_instance_id,' : ''} connector_id, scope_key, record_key, embedding
        FROM semantic_search_blob`
    ).all();
    const metas = raw.prepare(
      `SELECT ${metaHasInstance ? 'connector_instance_id,' : ''} connector_id, stream, fields_fingerprint, model_id, dimensions, distance_metric, updated_at
        FROM semantic_search_meta`
    ).all();
    const progressRows = raw.prepare(
      `SELECT ${progressHasInstance ? 'connector_instance_id,' : ''} connector_id, stream, fields_fingerprint, model_id, dimensions, distance_metric, updated_at
        FROM semantic_search_backfill_progress`
    ).all();

    const instanceIds = new Map();
    const resolveInstanceId = (row) => {
      if (typeof row.connector_instance_id === 'string' && row.connector_instance_id.trim()) return row.connector_instance_id.trim();
      if (!instanceIds.has(row.connector_id)) instanceIds.set(row.connector_id, legacySyncStateConnectorInstanceId(raw, row.connector_id));
      return instanceIds.get(row.connector_id);
    };

    raw.exec(`
      DROP TABLE IF EXISTS semantic_search_rowid;
      DROP TABLE IF EXISTS semantic_search_blob;
      DROP TABLE IF EXISTS semantic_search_meta;
      DROP TABLE IF EXISTS semantic_search_backfill_progress;

      CREATE TABLE semantic_search_meta (
        connector_instance_id TEXT NOT NULL,
        connector_id        TEXT NOT NULL,
        stream              TEXT NOT NULL,
        fields_fingerprint  TEXT NOT NULL,
        model_id            TEXT NOT NULL,
        dimensions          INTEGER NOT NULL,
        distance_metric     TEXT NOT NULL,
        updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(connector_instance_id, stream)
      );

      CREATE TABLE semantic_search_backfill_progress (
        connector_instance_id TEXT NOT NULL,
        connector_id        TEXT NOT NULL,
        stream              TEXT NOT NULL,
        fields_fingerprint  TEXT NOT NULL,
        model_id            TEXT NOT NULL,
        dimensions          INTEGER NOT NULL,
        distance_metric     TEXT NOT NULL,
        updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(connector_instance_id, stream)
      );

      CREATE TABLE semantic_search_rowid (
        connector_instance_id TEXT NOT NULL,
        connector_id  TEXT NOT NULL,
        scope_key     TEXT NOT NULL,
        record_key    TEXT NOT NULL,
        rowid         INTEGER NOT NULL,
        PRIMARY KEY(connector_instance_id, scope_key, record_key)
      );

      CREATE TABLE semantic_search_blob (
        connector_instance_id TEXT NOT NULL,
        connector_id  TEXT NOT NULL,
        scope_key     TEXT NOT NULL,
        record_key    TEXT NOT NULL,
        embedding     BLOB NOT NULL,
        PRIMARY KEY(connector_instance_id, scope_key, record_key)
      );
      CREATE INDEX IF NOT EXISTS idx_semantic_search_blob_plan
        ON semantic_search_blob(connector_id, scope_key);
    `);

    const insertRowid = raw.prepare(
      `INSERT INTO semantic_search_rowid(connector_instance_id, connector_id, scope_key, record_key, rowid)
        VALUES(?, ?, ?, ?, ?)`
    );
    for (const row of rowids) insertRowid.run(resolveInstanceId(row), row.connector_id, row.scope_key, row.record_key, row.rowid);

    const insertBlob = raw.prepare(
      `INSERT INTO semantic_search_blob(connector_instance_id, connector_id, scope_key, record_key, embedding)
        VALUES(?, ?, ?, ?, ?)`
    );
    for (const row of blobs) insertBlob.run(resolveInstanceId(row), row.connector_id, row.scope_key, row.record_key, row.embedding);

    const insertMeta = raw.prepare(
      `INSERT INTO semantic_search_meta(connector_instance_id, connector_id, stream, fields_fingerprint, model_id, dimensions, distance_metric, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of metas) insertMeta.run(resolveInstanceId(row), row.connector_id, row.stream, row.fields_fingerprint, row.model_id, row.dimensions, row.distance_metric, row.updated_at);

    const insertProgress = raw.prepare(
      `INSERT INTO semantic_search_backfill_progress(connector_instance_id, connector_id, stream, fields_fingerprint, model_id, dimensions, distance_metric, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of progressRows) insertProgress.run(resolveInstanceId(row), row.connector_id, row.stream, row.fields_fingerprint, row.model_id, row.dimensions, row.distance_metric, row.updated_at);

    return { rebuilt: true, backfilledRows: rowids.length + blobs.length + metas.length + progressRows.length };
  });

  const result = migration();
  if (typeof opts.onSchemaMigration === 'function') {
    opts.onSchemaMigration({ name: 'semantic_search_instance_columns', ...result });
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
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'device_exporters', 'collector_protocol_version', 'TEXT'));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'device_exporters', 'last_heartbeat_at', 'TEXT'));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'device_exporters', 'last_error_json', 'TEXT'));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'device_enrollment_codes', 'connector_id', "TEXT NOT NULL DEFAULT 'unknown'"));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'device_enrollment_codes', 'local_binding_id', "TEXT NOT NULL DEFAULT 'default'"));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'device_enrollment_codes', 'display_name', 'TEXT'));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'device_source_instances', 'connector_instance_id', 'TEXT'));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'device_source_instances', 'last_error_json', 'TEXT'));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'device_source_instances', 'last_heartbeat_at', 'TEXT'));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'device_source_instances', 'last_heartbeat_status', 'TEXT'));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'device_source_instances', 'records_pending', 'INTEGER'));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'device_source_instances', 'outbox_diagnostics_json', 'TEXT'));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'browser_surfaces', 'surface_mode', 'TEXT'));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'browser_surfaces', 'surface_subject_id', 'TEXT'));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'browser_surfaces', 'surface_source', 'TEXT'));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'browser_surfaces', 'stream_origin', 'TEXT'));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'browser_surfaces', 'container_name', 'TEXT'));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'browser_surfaces', 'profile_dir', 'TEXT'));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'browser_surfaces', 'profile_volume', 'TEXT'));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, 'browser_surface_leases', 'surface_subject_id', 'TEXT'));
  // Dataset summary projection fencing: a `generation` column lets rebuild
  // and reconcile writers guard their final summary write against
  // concurrent record/blob delta writers. Pre-existing rows seed with 0;
  // any subsequent write bumps the counter so old captures cannot win.
  runWithSqliteBusyRetrySync(() =>
    addColumnIfMissing(raw, 'dataset_summary_projection', 'generation', 'INTEGER NOT NULL DEFAULT 0'),
  );
  runWithSqliteBusyRetrySync(() => migrateBrowserSurfaceLeaseEnumChecks(raw));
  runWithSqliteBusyRetrySync(() => ensureBrowserSurfaceLeaseIndexes(raw));
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
  runWithSqliteBusyRetrySync(() => migrateConnectorSyncStateInstanceColumns(raw, opts));
  runWithSqliteBusyRetrySync(() => migrateConnectorDetailGapInstanceColumns(raw, opts));
  runWithSqliteBusyRetrySync(() => migrateRecordStorageInstanceColumns(raw, opts));
  runWithSqliteBusyRetrySync(() => migrateBlobOriginInstanceColumn(raw, opts));
  runWithSqliteBusyRetrySync(() => migrateSemanticSearchInstanceColumns(raw, opts));
  runWithSqliteBusyRetrySync(() => migrateLexicalSearchInstanceColumns(raw, opts));
  runWithSqliteBusyRetrySync(() => migrateLocalDeviceConnectorInstances(raw, opts));
  raw.exec(`
DROP INDEX IF EXISTS idx_records_lookup;
DROP INDEX IF EXISTS idx_records_version;
DROP INDEX IF EXISTS idx_record_changes_record;
DROP INDEX IF EXISTS idx_blob_bindings_record;
CREATE INDEX IF NOT EXISTS idx_records_lookup ON records(connector_instance_id, stream, record_key);
CREATE INDEX IF NOT EXISTS idx_records_version ON records(connector_instance_id, stream, version);
CREATE INDEX IF NOT EXISTS idx_record_changes_record ON record_changes(connector_instance_id, stream, record_key, version);
CREATE INDEX IF NOT EXISTS idx_blob_bindings_record ON blob_bindings(connector_instance_id, stream, record_key);
`);
  runWithSqliteBusyRetrySync(() => migrateSchedulerInstanceColumns(raw));
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
