// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { load as loadSqliteVec } from "sqlite-vec";
import {
  makeConnectorInstanceId as canonicalConnectorInstanceId,
  makeConnectorInstanceSourceBindingKey as canonicalSourceBindingKey,
} from "./connector-instance-utils.ts";
import { canonicalConnectorKey } from "./connector-key.ts";

const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 30_000;
const LEGACY_SYNC_STATE_OWNER_SUBJECT_ID = "owner_local";
const Database = createRequire(import.meta.url)("better-sqlite3") as new (
  filename: string,
  options: { timeout: number }
) => SqliteDatabase;

type SqliteRow = Record<string, unknown>;
interface SqliteRunResult {
  changes: number;
  lastInsertRowid: bigint | number;
}

interface SqliteStatement {
  all: <T = SqliteRow>(...params: unknown[]) => T[];
  get: <T = SqliteRow>(...params: unknown[]) => T | undefined;
  run: (...params: unknown[]) => SqliteRunResult;
}

interface SqliteDatabase {
  close: () => SqliteDatabase;
  exec: (source: string) => SqliteDatabase;
  loadExtension: (file: string, entrypoint?: string) => void;
  pragma: (source: string, options?: { simple?: boolean }) => unknown;
  prepare: (sql: string) => SqliteStatement;
  transaction: <T>(fn: () => T) => () => T;
}
type VectorIndexKind = "sqlite-vec" | "blob-flat";
type DatabaseHandle = SqliteDatabase & { vectorIndexKind: VectorIndexKind };

interface SqliteErrorLike {
  code?: string;
  message?: string;
}

interface BusyRetryEvent {
  attempt: number;
  delay: number;
  err: unknown;
}

interface BusyRetryOptions {
  initialDelayMs?: number;
  maxAttempts?: number;
  maxDelayMs?: number;
  onRetry?: ((event: BusyRetryEvent) => void) | undefined;
  sleep?: (milliseconds: number) => Promise<void>;
  sleepSync?: (milliseconds: number) => void;
}

interface NormalizedBusyRetryOptions {
  initialDelayMs: number;
  maxAttempts: number;
  maxDelayMs: number;
  onRetry: ((event: BusyRetryEvent) => void) | null;
}

interface BusyRetryState {
  attempt: number;
}

interface SchemaMigrationEvent {
  backfilledRows?: number;
  changes?: number;
  droppedProviderId?: boolean;
  name: string;
  rebuilt?: boolean;
  [key: string]: unknown;
}

interface SqliteMasterRow {
  sql: string | null;
}

interface SqliteCountRow {
  count: number;
}

interface ConnectorStateRow {
  connector_id: string;
  connector_instance_id?: string | null;
  state_json: string;
  stream: string;
  updated_at: string;
}

interface ConnectorScopedRow {
  connector_id: string;
  connector_instance_id?: string | null;
}

interface GrantConnectorStateRow extends ConnectorStateRow {
  grant_id: string;
}

interface LocalDeviceSourceRow {
  connector_id: string;
  connector_instance_id: string | null;
  created_at: string | null;
  device_id: string;
  display_name: string | null;
  local_binding_id: string;
  owner_subject_id: string;
  revoked_at: string | null;
  source_instance_id: string;
  status: string;
  updated_at: string | null;
}

interface ConnectorInstanceIdRow {
  connector_instance_id: string;
}

interface ConnectorIdRow {
  connector_id: string;
  gap_id?: number;
}

interface BlobRow {
  blob_id: string;
  connector_id: string;
}

interface LexicalIndexRow extends ConnectorScopedRow {
  field: string;
  record_key: string;
  stream: string;
  text: string;
}

interface LexicalMetaRow extends ConnectorScopedRow {
  fields_fingerprint: string;
  stream: string;
  updated_at: string;
}

interface RecordStorageRow extends ConnectorScopedRow {
  deleted: number;
  deleted_at: string | null;
  emitted_at: string;
  id?: number;
  record_json: string | null;
  record_key: string;
  stream: string;
  version: number;
}

interface VersionCounterRow extends ConnectorScopedRow {
  max_version: number;
  stream: string;
}

interface BlobBindingRow extends ConnectorScopedRow {
  blob_id: string;
  json_path: string;
  record_key: string;
  stream: string;
}

interface ScheduleRow extends ConnectorScopedRow {
  created_at: string;
  enabled: number;
  interval_seconds: number;
  jitter_seconds: number;
  updated_at: string;
}

interface ActiveRunRow extends ConnectorScopedRow {
  run_id: string;
  scenario_id: string;
  started_at: string;
  trace_id: string;
}

interface SchedulerHistoryRow extends ConnectorScopedRow {
  attempt: number;
  checkpoint_summary_json: string | null;
  completed_at: string;
  connector_error_json: string | null;
  error: string | null;
  failure_reason: string | null;
  id?: number;
  known_gaps_json: string;
  records_emitted: number;
  reported_records_emitted: number | null;
  run_id: string | null;
  source_json: string;
  started_at: string;
  status: string;
  terminal_reason: string | null;
  trace_id: string | null;
}

interface LastRunRow extends ConnectorScopedRow {
  last_run_time_ms: number;
  updated_at: string;
}

interface SemanticIndexRow extends ConnectorScopedRow {
  embedding?: Uint8Array;
  record_key: string;
  rowid?: number;
  scope_key: string;
}

interface SemanticMetaRow extends ConnectorScopedRow {
  dimensions: number;
  distance_metric: string;
  fields_fingerprint: string;
  model_id: string;
  stream: string;
  updated_at: string;
}

interface LegacyInstanceRow {
  connector_id: string;
  connector_instance_id: string;
  created_at: string;
  display_name: string;
  owner_subject_id: string;
  revoked_at: string | null;
  status: string;
  updated_at: string;
}

interface AccountDestinationRow {
  connector_instance_id: string;
  source_binding_key: string;
  source_kind: string;
  status: string;
}

interface InitDbOptions extends BusyRetryOptions {
  busyTimeoutMs?: number;
  onSchemaMigration?: (event: SchemaMigrationEvent) => void;
  onSchemaRetry?: (event: BusyRetryEvent) => void;
}

type MigrationOptions = Pick<InitDbOptions, "onSchemaMigration">;

const BROWSER_SURFACE_LEASE_CREATE_TABLE_NAME_PATTERN =
  /^(CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)(?:"browser_surface_leases"|browser_surface_leases)/i;

let db: DatabaseHandle | null = null;
let sqliteStoreCacheGeneration = 0;
let sqliteStoreCacheIdentity = "sqlite:closed:0";

export function getDb(): DatabaseHandle {
  return db as DatabaseHandle;
}

export function getSqliteStoreCacheIdentity(): string {
  return sqliteStoreCacheIdentity;
}

/**
 * Close the module-scoped database, if any. `initDb()` calls this before
 * opening a new one so tests that stop and restart the server on the same
 * dbPath release file locks cleanly.
 */
export function closeDb(): void {
  if (db) {
    try {
      db.close();
    } catch {
      /* best-effort */
    }
    db = null;
  }
  sqliteStoreCacheGeneration += 1;
  sqliteStoreCacheIdentity = `sqlite:closed:${sqliteStoreCacheGeneration}`;
}

function resolveSqliteBusyTimeoutMs(
  value: string | number | undefined = process.env.PDPP_SQLITE_BUSY_TIMEOUT_MS
): number {
  if (value === undefined || value === "") {
    return DEFAULT_SQLITE_BUSY_TIMEOUT_MS;
  }
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
const TRANSIENT_LOCK_CODES = new Set(["SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_BUSY_SNAPSHOT"]);

export function isTransientSqliteLockError(err: unknown): boolean {
  if (!err) {
    return false;
  }
  const sqliteError = typeof err === "object" ? (err as SqliteErrorLike) : null;
  if (sqliteError?.code && TRANSIENT_LOCK_CODES.has(sqliteError.code)) {
    return true;
  }
  const message = typeof sqliteError?.message === "string" ? sqliteError.message : "";
  return message.includes("database is locked") || message.includes("database table is locked");
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
// Normalize the shared retry knobs for the busy-retry helpers. Defaults: 5
// attempts, 100ms initial backoff doubling to a 1.5s ceiling. Clamps keep the
// invariants the loop relies on (attempts >= 1, delays non-negative, ceiling
// never below the floor).
function normalizeBusyRetryOptions(opts: BusyRetryOptions): NormalizedBusyRetryOptions {
  const maxAttempts =
    typeof opts.maxAttempts === "number" && Number.isFinite(opts.maxAttempts) ? Math.max(1, opts.maxAttempts) : 5;
  const initialDelayMs =
    typeof opts.initialDelayMs === "number" && Number.isFinite(opts.initialDelayMs)
      ? Math.max(0, opts.initialDelayMs)
      : 100;
  const maxDelayMs =
    typeof opts.maxDelayMs === "number" && Number.isFinite(opts.maxDelayMs)
      ? Math.max(initialDelayMs, opts.maxDelayMs)
      : 1500;
  const onRetry = typeof opts.onRetry === "function" ? opts.onRetry : null;
  return { initialDelayMs, maxAttempts, maxDelayMs, onRetry };
}

// Exponential backoff for retry `attempt` (1-based), capped at `maxDelayMs`.
function computeBusyRetryDelay(attempt: number, initialDelayMs: number, maxDelayMs: number): number {
  return Math.min(maxDelayMs, initialDelayMs * 2 ** (attempt - 1));
}

function getMappedValue<T>(values: ReadonlyMap<string, T>, key: string): T {
  const value = values.get(key);
  if (value === undefined) {
    throw new Error(`Missing mapped value for ${key}`);
  }
  return value;
}

// Decide the next step after a caught error in a busy-retry loop. Rethrows a
// non-transient error or the current transient error when the retry budget is
// exhausted; otherwise returns the backoff delay to wait before the next
// attempt (after advancing `state.attempt` and firing `onRetry`). Shared by
// the sync and async runners — only their wait mechanism differs.
function nextBusyRetryDelay(err: unknown, state: BusyRetryState, cfg: NormalizedBusyRetryOptions): number {
  if (!isTransientSqliteLockError(err)) {
    throw err;
  }
  state.attempt += 1;
  if (state.attempt >= cfg.maxAttempts) {
    throw err;
  }
  const delay = computeBusyRetryDelay(state.attempt, cfg.initialDelayMs, cfg.maxDelayMs);
  if (cfg.onRetry) {
    cfg.onRetry({ attempt: state.attempt, delay, err });
  }
  return delay;
}

// Select the injected or default wait strategy independently of retry execution.
function selectBusyRetryWait(opts: BusyRetryOptions, sync: true): (milliseconds: number) => void;
function selectBusyRetryWait(opts: BusyRetryOptions, sync: false): (milliseconds: number) => Promise<void>;
function selectBusyRetryWait(
  opts: BusyRetryOptions,
  sync: boolean
): ((milliseconds: number) => void) | ((milliseconds: number) => Promise<void>) {
  const sleep = sync ? opts.sleepSync : opts.sleep;
  if (typeof sleep === "function") {
    return sleep;
  }
  return sync
    ? (ms) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          /* busy-wait */
        }
      }
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
}

export function runWithSqliteBusyRetrySync<T>(fn: () => T, opts: BusyRetryOptions = {}): T {
  const cfg = normalizeBusyRetryOptions(opts);
  const sleepSync = selectBusyRetryWait(opts, true);

  const state = { attempt: 0 };
  for (;;) {
    try {
      return fn();
    } catch (err: unknown) {
      const delay = nextBusyRetryDelay(err, state, cfg);
      sleepSync(delay);
    }
  }
}

export function runWithSqliteBusyRetry<T>(fn: () => T | Promise<T>, opts: BusyRetryOptions = {}): Promise<T> {
  const cfg = normalizeBusyRetryOptions(opts);
  const sleep = selectBusyRetryWait(opts, false);

  const state = { attempt: 0 };
  const attempt = async (): Promise<T> => {
    try {
      return await fn();
    } catch (err: unknown) {
      const delay = nextBusyRetryDelay(err, state, cfg);
      await sleep(delay);
      return attempt();
    }
  };
  return attempt();
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
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked', 'draft')),
  source_kind           TEXT NOT NULL CHECK (source_kind IN ('account', 'local_device', 'browser_collector', 'manual')),
  source_binding_key    TEXT NOT NULL,
  source_binding_json   TEXT NOT NULL DEFAULT '{}',
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  revoked_at            TEXT,
  -- Monotonic per-connection identity of the registered manifest content.
  -- This is intentionally an event counter, not a wall-clock value: a
  -- remove/re-add ABA advances twice even when no reader observes the middle.
  manifest_generation   INTEGER NOT NULL DEFAULT 0,
  UNIQUE(owner_subject_id, connector_id, source_kind, source_binding_key),
  FOREIGN KEY(connector_id) REFERENCES connectors(connector_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_connector_instances_owner_connector_status
  ON connector_instances(owner_subject_id, connector_id, status);
CREATE INDEX IF NOT EXISTS idx_connector_instances_owner_identity_page
  ON connector_instances(owner_subject_id, connector_id, created_at, connector_instance_id);

-- Durable record that a connector-instance IDENTITY was owner-deleted.
-- connector_instance_id is deterministic (hash of owner + connector +
-- source_kind + source_binding_key), so once deleteConnection removes the
-- connector_instances row, that same id/binding key is free to be reused by
-- a later upsert (e.g. a device-exporter re-enrollment under the same
-- local_binding_name). This table is the durable fact that blocks that
-- reuse: upsert's no-existing-row path checks it and fails closed with
-- connection_tombstoned instead of silently resurrecting the identity.
-- Identity + timestamp only -- no configuration, secrets, or record data.
-- See openspec/changes/fix-owner-delete-resurrection.
CREATE TABLE IF NOT EXISTS connector_instance_tombstones (
  connector_instance_id TEXT PRIMARY KEY,
  owner_subject_id      TEXT NOT NULL,
  connector_id          TEXT NOT NULL,
  source_kind           TEXT NOT NULL,
  source_binding_key    TEXT NOT NULL,
  deleted_at            TEXT NOT NULL,
  UNIQUE(owner_subject_id, connector_id, source_kind, source_binding_key)
);

-- Per-connection encrypted static-secret credential store. A peer of the
-- instance-scoped storage / schedule state: a single connector-declared static
-- provider secret sealed at rest under the owner/operator key and keyed to
-- exactly one connector instance. The plaintext is NEVER
-- stored; sealed_secret is the AES-256-GCM token from credential-encryption.js
-- and is never returned by any read surface. See
-- add-static-secret-owner-connect-primitive design Decisions 1 & 7.
CREATE TABLE IF NOT EXISTS connector_instance_credentials (
  connector_instance_id TEXT PRIMARY KEY,
  owner_subject_id      TEXT NOT NULL,
  credential_kind       TEXT NOT NULL CHECK (credential_kind IN ('app_password', 'personal_access_token', 'secret_bundle', 'username_password')),
  sealed_secret         TEXT NOT NULL,
  fingerprint           TEXT,
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'rejected')),
  captured_at           TEXT NOT NULL,
  rotated_at            TEXT,
  revoked_at            TEXT,
  rejected_at           TEXT,
  rejection_reason      TEXT,
  FOREIGN KEY(connector_instance_id) REFERENCES connector_instances(connector_instance_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_connector_instance_credentials_owner_status
  ON connector_instance_credentials(owner_subject_id, status);

CREATE TABLE IF NOT EXISTS acquisition_batches (
  batch_id              TEXT PRIMARY KEY,
  owner_subject_id      TEXT NOT NULL,
  connector_id          TEXT NOT NULL,
  connector_instance_id TEXT NOT NULL,
  acquisition_method    TEXT NOT NULL CHECK (acquisition_method IN ('provider_api', 'owner_artifact', 'device_sync', 'device_backup', 'browser_polyfill')),
  source_format         TEXT,
  parser_version        TEXT,
  artifact_sha256       TEXT,
  uploaded_file_name    TEXT,
  status                TEXT NOT NULL CHECK (status IN ('validated', 'committed', 'duplicate', 'failed')),
  event_time_start      TEXT,
  event_time_end        TEXT,
  parsed_count          INTEGER,
  accepted_count        INTEGER NOT NULL DEFAULT 0,
  duplicate_count       INTEGER NOT NULL DEFAULT 0,
  skipped_count         INTEGER NOT NULL DEFAULT 0,
  failed_count          INTEGER NOT NULL DEFAULT 0,
  media_coverage_json   TEXT,
  warnings_json         TEXT NOT NULL DEFAULT '[]',
  receipt_json          TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  FOREIGN KEY(connector_id) REFERENCES connectors(connector_id) ON DELETE RESTRICT,
  FOREIGN KEY(connector_instance_id) REFERENCES connector_instances(connector_instance_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_acquisition_batches_connection_created
  ON acquisition_batches(connector_instance_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_acquisition_batches_owner_connector_artifact
  ON acquisition_batches(owner_subject_id, connector_id, artifact_sha256)
  WHERE artifact_sha256 IS NOT NULL;

CREATE TABLE IF NOT EXISTS manual_upload_artifacts (
  artifact_id           TEXT PRIMARY KEY,
  owner_subject_id      TEXT NOT NULL,
  connector_id          TEXT NOT NULL,
  connector_instance_id TEXT,
  file_name             TEXT NOT NULL,
  staging_path          TEXT NOT NULL,
  final_path            TEXT,
  file_size_bytes       INTEGER NOT NULL DEFAULT 0,
  artifact_sha256       TEXT,
  status                TEXT NOT NULL CHECK (status IN ('uploaded', 'validating', 'staged', 'duplicate', 'failed')),
  acquisition_batch_id  TEXT,
  validation_json       TEXT,
  error_json            TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  FOREIGN KEY(connector_id) REFERENCES connectors(connector_id) ON DELETE RESTRICT,
  FOREIGN KEY(connector_instance_id) REFERENCES connector_instances(connector_instance_id) ON DELETE SET NULL,
  FOREIGN KEY(acquisition_batch_id) REFERENCES acquisition_batches(batch_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_manual_upload_artifacts_connection_created
  ON manual_upload_artifacts(connector_instance_id, created_at DESC);

CREATE TABLE IF NOT EXISTS record_acquisition_provenance (
  connector_instance_id TEXT NOT NULL,
  stream                TEXT NOT NULL,
  record_key            TEXT NOT NULL,
  batch_id              TEXT NOT NULL,
  acquisition_method    TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  PRIMARY KEY(connector_instance_id, stream, record_key, batch_id),
  FOREIGN KEY(batch_id) REFERENCES acquisition_batches(batch_id) ON DELETE CASCADE,
  FOREIGN KEY(connector_instance_id) REFERENCES connector_instances(connector_instance_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_record_acquisition_provenance_record
  ON record_acquisition_provenance(connector_instance_id, stream, record_key);

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
  package_id    TEXT,
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
  interval_seconds         INTEGER NOT NULL DEFAULT 2,
  last_polled_at           TEXT,
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
  -- Peer axis to connector_instances.source_kind ('local_device' |
  -- 'browser_collector' for enrollment-derived rows). Part of the stable
  -- enrollment binding-identity key alongside (device_id owner, connector_id,
  -- local_binding_id) so distinct connector-instance kinds sharing an owner,
  -- connector, and binding name can never adopt or collide with each other's
  -- orphaned identity. Nullable for legacy rows written before this column
  -- existed; those never participate in orphan adoption (see
  -- find-orphaned-device-for-binding.sql).
  source_kind         TEXT,
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
  manifest_generation    INTEGER,
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
  connector_instance_id TEXT NOT NULL DEFAULT '',
  connector_id    TEXT NOT NULL DEFAULT '',
  batch_seq       INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL,
  http_status     INTEGER,
  response_json   TEXT,
  record_count    INTEGER NOT NULL DEFAULT 0,
  durable_prefix_count INTEGER NOT NULL DEFAULT 0,
  manifest_fingerprint TEXT NOT NULL DEFAULT '',
  semantic_capability_identity TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  accepted_at     TEXT,
  CHECK (status IN ('processing', 'accepted')),
  CHECK (durable_prefix_count >= 0 AND durable_prefix_count <= record_count),
  CHECK (status <> 'accepted' OR durable_prefix_count = record_count),
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

-- Outbound event subscriptions (reference-only). Each subscription is bound
-- either to a single client + grant or to a trusted owner-agent client +
-- owner subject. The persisted scope_json is an authority snapshot so
-- derivation can refuse events outside the original disclosure authority.
-- secret_hash stores a one-way digest of the per-subscription HMAC secret;
-- the raw secret is returned exactly once at create time.
CREATE TABLE IF NOT EXISTS client_event_subscriptions (
  subscription_id        TEXT PRIMARY KEY,
  authority_kind         TEXT NOT NULL DEFAULT 'client_grant',
  grant_id               TEXT,
  client_id              TEXT NOT NULL,
  subject_id             TEXT NOT NULL,
  callback_url           TEXT NOT NULL,
  secret_hash            TEXT NOT NULL,
  secret_text            TEXT NOT NULL,
  scope_json             TEXT NOT NULL,
  status                 TEXT NOT NULL,
  verification_challenge TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  disabled_at            TEXT,
  disabled_reason        TEXT,
  CHECK (status IN (
    'pending_verification',
    'active',
    'disabled',
    'disabled_failure',
    'disabled_revoked',
    'deleted'
  )),
  CHECK (authority_kind IN ('client_grant', 'trusted_owner_agent')),
  CHECK (
    (authority_kind = 'client_grant' AND grant_id IS NOT NULL)
    OR (authority_kind = 'trusted_owner_agent' AND grant_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_client_event_subscriptions_client
  ON client_event_subscriptions(client_id, status);
CREATE INDEX IF NOT EXISTS idx_client_event_subscriptions_grant
  ON client_event_subscriptions(grant_id);

CREATE TABLE IF NOT EXISTS client_event_queue (
  queue_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id TEXT NOT NULL,
  event_id        TEXT NOT NULL UNIQUE,
  event_type      TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  enqueued_at     TEXT NOT NULL,
  next_attempt_at TEXT NOT NULL,
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL,
  last_error      TEXT,
  CHECK (status IN ('pending', 'delivered', 'final_failure', 'dropped'))
);

CREATE INDEX IF NOT EXISTS idx_client_event_queue_due
  ON client_event_queue(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_client_event_queue_subscription
  ON client_event_queue(subscription_id, status);

CREATE TABLE IF NOT EXISTS client_event_attempts (
  attempt_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_id         INTEGER NOT NULL,
  attempted_at     TEXT NOT NULL,
  status_code      INTEGER,
  ok               INTEGER NOT NULL DEFAULT 0,
  latency_ms       INTEGER,
  error            TEXT,
  response_snippet TEXT
);

CREATE INDEX IF NOT EXISTS idx_client_event_attempts_queue
  ON client_event_attempts(queue_id, attempt_id);

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
  started_at    TEXT NOT NULL,
  run_generation INTEGER NOT NULL DEFAULT 1
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
  window_settle_endpoint TEXT,
  health           TEXT NOT NULL,
  container_id     TEXT,
  container_name   TEXT,
  profile_dir      TEXT,
  profile_volume   TEXT,
  browser_generation_hash TEXT,
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

CREATE TABLE IF NOT EXISTS presentation_screen_states (
  browser_session_id TEXT PRIMARY KEY,
  surface_id         TEXT NOT NULL,
  lease_id           TEXT,
  baseline_json      TEXT NOT NULL,
  captured_at        TEXT NOT NULL,
  resolved_at        TEXT,
  resolution         TEXT CHECK (resolution IS NULL OR resolution IN ('restored', 'recycled'))
);

CREATE INDEX IF NOT EXISTS idx_presentation_screen_states_unrestored
  ON presentation_screen_states(captured_at)
  WHERE resolution IS NULL;

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
  CHECK (priority_class IN ('interactive', 'background')),
  CHECK (wait_reason IS NULL OR wait_reason IN (
    'capacity_full',
    'surface_starting',
    'surface_unhealthy',
    'surface_start_failed',
    'surface_readiness_timeout',
    'incompatible_static_profile',
    'launch_precondition_failed',
    'lease_wait_timeout',
    'retained_capacity_reserved'
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

CREATE TABLE IF NOT EXISTS browser_surface_replacement_receipts (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  replacement_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  scope TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  connector_id TEXT,
  profile_key TEXT NOT NULL,
  surface_subject_id TEXT,
  run_id TEXT,
  lease_id TEXT,
  surface_id TEXT,
  previous_generation_hash TEXT,
  next_generation_hash TEXT,
  cause TEXT NOT NULL CHECK (cause IN (
    'capacity_pressure',
    'idle_ttl',
    'operator_requested',
    'restart_reconcile',
    'readiness_invalidated',
    'allocator_internal_ensure_surface',
    'same_container_browser_generation_change',
    'external_or_host_loss'
  )),
  phase TEXT NOT NULL CHECK (phase IN ('started', 'completed', 'terminal')),
  terminal_outcome TEXT CHECK (terminal_outcome IS NULL OR terminal_outcome IN ('failed', 'abandoned')),
  observed_at TEXT NOT NULL,
  UNIQUE (idempotency_key, phase),
  UNIQUE (replacement_id, phase),
  CHECK ((phase = 'terminal') = (terminal_outcome IS NOT NULL)),
  CHECK (phase != 'completed' OR next_generation_hash IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_browser_surface_replacement_scope_order
  ON browser_surface_replacement_receipts(connection_id, surface_subject_id, event_seq, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_browser_surface_replacement_surface_order
  ON browser_surface_replacement_receipts(surface_id, event_seq, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_surface_replacement_one_resolution
  ON browser_surface_replacement_receipts(replacement_id)
  WHERE phase IN ('completed', 'terminal');

CREATE TABLE IF NOT EXISTS browser_surface_replacement_selection_overrides (
  replacement_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  connector_id TEXT,
  profile_key TEXT NOT NULL,
  surface_subject_id TEXT,
  surface_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  prior_failed_replacement_id TEXT NOT NULL,
  replacement_batch_id TEXT,
  applied_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_browser_surface_replacement_selection_override_batch
  ON browser_surface_replacement_selection_overrides(replacement_batch_id);
CREATE TABLE IF NOT EXISTS browser_surface_replacement_selection_override_batches (
  replacement_batch_id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  connector_id TEXT,
  profile_key TEXT NOT NULL,
  surface_subject_id TEXT,
  prior_failed_replacement_id TEXT NOT NULL,
  reviewed_artifact_sha256 TEXT NOT NULL,
  first_event_seq INTEGER NOT NULL,
  last_event_seq INTEGER NOT NULL,
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS browser_surface_replacement_selection_override_audit_outbox (
  audit_outbox_id TEXT PRIMARY KEY,
  replacement_batch_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('apply', 'revoke')),
  reviewed_artifact_sha256 TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  UNIQUE(replacement_batch_id, operation)
);

-- Kind-neutral, run-grain durable projection. Historically scheduler-only
-- (scheduler_run_history); generalized so the general run executor writes
-- one row per run (scheduled/manual/browser/cancelled) -- see
-- openspec/changes/generalize-run-history-write-authority. completed_at
-- is nullable to hold the row created at run.started (status 'running')
-- before the terminal write finalizes it; existing scheduler-era readers
-- filter status <> 'running' so their visible output is unchanged.
CREATE TABLE IF NOT EXISTS run_history (
  id                         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                     TEXT,
  connector_instance_id      TEXT NOT NULL,
  connector_id               TEXT NOT NULL,
  trigger_kind               TEXT,
  source_json                TEXT NOT NULL,
  status                     TEXT NOT NULL,
  records_emitted            INTEGER NOT NULL DEFAULT 0,
  reported_records_emitted   INTEGER,
  checkpoint_summary_json    TEXT,
  known_gaps_json            TEXT NOT NULL DEFAULT '[]',
  connector_error_json       TEXT,
  trace_id                   TEXT,
  failure_reason             TEXT,
  terminal_reason            TEXT,
  started_at                 TEXT NOT NULL,
  completed_at               TEXT,
  error                      TEXT,
  attempt                    INTEGER NOT NULL DEFAULT 1,
  facts_json                 TEXT,
  -- Provenance flag: true only for rows the SCHEDULER's own write path
  -- (server/stores/scheduler-store.ts appendRunHistory, called from
  -- runtime/scheduler/run-executor.ts) has touched. The run.started/
  -- terminal spine-event hook (server/stores/run-history-writer.ts) sets
  -- this false — it fires for every run kind, including ones that never
  -- pass through the scheduler (e.g. runtime/controller.ts runNow calling
  -- runConnector directly). Scheduler cadence/backoff readers
  -- (runtime/scheduler.ts hydratePersistence, dispatch-governor.ts
  -- evaluateBackoffDispatch) filter on this column so a run newly visible
  -- in run_history via the generalized writer does not silently start
  -- influencing scheduler backoff math — see terminal-read-architecture-
  -- fable-0730.md R7.5 and openspec/changes/
  -- generalize-run-history-write-authority.
  scheduler_managed          INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_run_history_connector_completed
  ON run_history(connector_id, completed_at, id);

-- run_id alone is NOT globally unique: two different connections can
-- independently mint the same run_id (Date.now()-based generators with no
-- connection-scoped entropy — confirmed live). (run_id,
-- connector_instance_id) is the real identity. See
-- openspec/changes/run-history-backfill-list-cutover.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_run_history_run_id_instance
  ON run_history(run_id, connector_instance_id) WHERE run_id IS NOT NULL;

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

-- Operator-managed CIMD documents. Each row is a stable
-- /oauth/client-metadata/:id document that local MCP clients (Claude Code,
-- Codex) use as their client_id. Public-client only; no secrets stored here.
CREATE TABLE IF NOT EXISTS cimd_client_documents (
  document_id    TEXT PRIMARY KEY,
  client_name    TEXT,
  redirect_uris  TEXT NOT NULL DEFAULT '[]',
  logo_uri       TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

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
  package_id            TEXT,
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

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  refresh_token_hash   TEXT PRIMARY KEY,
  client_id            TEXT NOT NULL,
  grant_id             TEXT,
  package_id           TEXT,
  subject_id           TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'active',
  created_at           TEXT NOT NULL,
  expires_at           TEXT,
  last_used_at         TEXT,
  revoked_at           TEXT
);

CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_grant
  ON oauth_refresh_tokens(grant_id, status);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_client_status
  ON oauth_refresh_tokens(client_id, status, expires_at);

CREATE TABLE IF NOT EXISTS grant_packages (
  package_id        TEXT PRIMARY KEY,
  subject_id        TEXT NOT NULL,
  client_id         TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active',
  package_json      TEXT NOT NULL,
  parent_package_id TEXT,
  trace_id          TEXT,
  scenario_id       TEXT,
  created_at        TEXT NOT NULL,
  approved_at       TEXT NOT NULL,
  revoked_at        TEXT,
  FOREIGN KEY(parent_package_id) REFERENCES grant_packages(package_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_grant_packages_client_status
  ON grant_packages(client_id, status, created_at);

CREATE TABLE IF NOT EXISTS grant_package_members (
  package_id    TEXT NOT NULL,
  grant_id      TEXT NOT NULL,
  token_id      TEXT NOT NULL,
  source_json   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  added_at      TEXT NOT NULL,
  revoked_at    TEXT,
  PRIMARY KEY(package_id, grant_id),
  FOREIGN KEY(package_id) REFERENCES grant_packages(package_id) ON DELETE CASCADE,
  FOREIGN KEY(grant_id) REFERENCES grants(grant_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_grant_package_members_grant
  ON grant_package_members(grant_id, status);

CREATE TABLE IF NOT EXISTS records (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  connector_id  TEXT NOT NULL,
  connector_instance_id TEXT NOT NULL,
  stream        TEXT NOT NULL,
  record_key    TEXT NOT NULL,
  record_json   TEXT NOT NULL,
  emitted_at    TEXT NOT NULL,
  -- The record's SEMANTIC time (when the thing happened): the manifest
  -- consent_time_field / cursor_field value from record_json, coerced to ISO
  -- (epoch-aware), falling back to emitted_at when no semantic field is declared
  -- or the value is missing/unparseable. Drives the Explore merged-timeline SORT
  -- (ORDER BY semantic_time DESC); pagination/membership stays anchored on the
  -- monotonic id. Never null.
  semantic_time TEXT NOT NULL DEFAULT '',
  version       INTEGER NOT NULL DEFAULT 1,
  deleted       INTEGER NOT NULL DEFAULT 0,
  deleted_at    TEXT,
  UNIQUE(connector_instance_id, stream, record_key)
);

CREATE INDEX IF NOT EXISTS idx_records_lookup
  ON records(connector_id, stream, record_key);

CREATE INDEX IF NOT EXISTS idx_records_version
  ON records(connector_id, stream, version);

-- NOTE: the keyset index for the Explore merged-timeline
-- (idx_records_semantic_time, an EXPRESSION index on
-- COALESCE(NULLIF(semantic_time,''), emitted_at) DESC, record_key DESC matching
-- the read ORDER BY so it stays index-backed before the Step-B backfill) is
-- NOT created here. The inline SCHEMA runs on a pre-existing records table whose
-- CREATE TABLE IF NOT EXISTS is a no-op, so the semantic_time column may not
-- exist yet (it is added by migrateRecordSemanticTimeColumn). Creating the index
-- here would fail with no-such-column: semantic_time. It is created in the
-- post-migration index block below, after the column is guaranteed present.

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
-- See docs/reference/binary-content-invariant-design-brief.md §4.6.
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
  manifest_generation INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(connector_instance_id, stream)
);

CREATE TABLE IF NOT EXISTS grant_connector_state (
  grant_id      TEXT NOT NULL,
  connector_id  TEXT NOT NULL,
  connector_instance_id TEXT NOT NULL,
  stream        TEXT NOT NULL,
  state_json    TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  manifest_generation INTEGER NOT NULL DEFAULT 0,
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
  lease_run_id        TEXT,
  lease_id            TEXT,
  lease_attempted     INTEGER NOT NULL DEFAULT 0,
  lease_expires_at    TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (status IN ('pending', 'in_progress', 'recovered', 'terminal'))
);

-- NOTE: the UNIQUE identity index for connector_detail_gaps is created by
-- migrateConnectorDetailGapInstanceColumns (which always runs on init), NOT
-- here. That migration first reconciles any pre-existing locator-drift
-- duplicate rows, then builds the index — so it can never fail a UNIQUE
-- constraint over legacy duplicates. Creating the unique index in this
-- bootstrap DDL would run BEFORE that dedupe and break on such rows.
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

-- Connector-summary evidence read model (reference-only, owner-facing).
-- See openspec/changes/maintain-connector-summary-read-model/ for the spec
-- delta. One maintained row per connection carrying DURABLE evidence only:
-- identity + lifecycle (connector_id, display_name, status, source_kind,
-- revoked_at) and durable counts/freshness evidence (total_records,
-- stream_count, last_record_updated_at). Time-relative
-- and runtime-relative synthesis (freshness, connection_health,
-- collection_report, rendered_verdict, next_action) is NEVER persisted here;
-- it is computed on read so a cached verdict can never go dishonest.
CREATE TABLE IF NOT EXISTS connector_summary_evidence (
  connector_instance_id         TEXT PRIMARY KEY,
  connector_id                  TEXT NOT NULL,
  display_name                  TEXT NOT NULL DEFAULT '',
  status                        TEXT,
  source_kind                   TEXT,
  revoked_at                    TEXT,
  total_records                 INTEGER NOT NULL DEFAULT 0,
  stream_count                  INTEGER NOT NULL DEFAULT 0,
  last_record_updated_at        TEXT,
  stream_records_json           TEXT NOT NULL DEFAULT '[]',
  retained_bytes_json           TEXT NOT NULL DEFAULT '{"record_json_bytes":0,"record_changes_json_bytes":0,"blob_bytes":0,"total_bytes":0}',
  total_retained_bytes          INTEGER NOT NULL DEFAULT 0,
  -- 1 means a mutation/ingest/run-lifecycle change happened that the
  -- maintained evidence has not yet absorbed. Reads must surface this as
  -- 'stale' rather than presenting the row as fresh truth.
  dirty                         INTEGER NOT NULL DEFAULT 1,
  computed_at                   TEXT,
  -- Advisory monotonic seq of the event that last dirtied this row. Never
  -- load-bearing for correctness; aids reconcile freshness diagnostics.
  source_event_seq              INTEGER,
  -- Honesty envelope: 'fresh' | 'stale' | 'rebuilding' | 'failed' | 'unknown'.
  state                         TEXT NOT NULL DEFAULT 'rebuilding',
  -- Sanitized last error (credentials redacted, bounded length).
  last_error                    TEXT,
  -- Opaque compare-and-set revision for publishers of the terminal owner
  -- LIST projection. Every canonical rebuild/reconcile or dirty transition
  -- advances it, so a payload derived from an older bounded read cannot
  -- publish after the row has moved on.
  canonical_evidence_revision   INTEGER NOT NULL DEFAULT 0,
  -- Durable connection-scoped declaration identity. This is the only
  -- eligibility boundary for terminal, coverage, and heartbeat proof.
  manifest_generation INTEGER NOT NULL DEFAULT 0,
  -- Terminal-gate revision (2026-07-29): the last-observed
  -- connector_schedules.updated_at this row's schedule-derived evidence
  -- was computed against -- 'absent' (a sentinel, not NULL, so "no schedule
  -- row" is distinguishable from "never observed") when no schedule exists.
  -- Compared against the live value on every discovery pass (maintenance
  -- sweep only, never on read) so a schedule pause/resume/delete/upsert
  -- whose best-effort dirty marker was lost is still caught and repaired --
  -- connector_schedules.updated_at is written atomically with every
  -- schedule mutation on both backends, making it a durable repair receipt
  -- with no new outbox table required. See classifyCandidate's
  -- schedule_mismatch reason in connector-summary-evidence-engine.ts.
  schedule_checkpoint TEXT NOT NULL DEFAULT 'unobserved',
  -- Terminal-gate revision (2026-07-29): the last-observed
  -- MAX(spine_events.event_seq) (unfiltered by event_type, unlike the
  -- existing stream_facts_event_seq/terminal-only checkpoint above) for
  -- this connection -- catches a run-lifecycle event (e.g. run.started)
  -- whose best-effort dirty marker was lost, using the spine's own
  -- already-durable, atomically-assigned sequence as the repair receipt.
  run_lifecycle_event_seq INTEGER,
  -- Complete owner LIST-item projection, published only by bounded
  -- maintenance after all durable axes have converged. This is deliberately
  -- one named projection payload, not a generic cache: its state is coupled
  -- to this row's canonical evidence envelope and is invalidated with it.
  list_summary_projection_json TEXT,
  list_summary_projection_state TEXT NOT NULL DEFAULT 'unobserved',
  list_summary_projection_reason_code TEXT,
  list_summary_projection_computed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_connector_summary_evidence_connector
  ON connector_summary_evidence(connector_id);

-- Durable scheduling cursors for bounded, periodic maintenance sweeps
-- (name-keyed, one row per stage). Not evidence, not owner-visible data.
CREATE TABLE IF NOT EXISTS connector_maintenance_cursor (
  name                         TEXT PRIMARY KEY CHECK(name IN ('connector_summary_evidence', 'run_history_backfill')),
  resume_after_id              TEXT,
  updated_at                   TEXT NOT NULL,
  generation                   INTEGER NOT NULL DEFAULT 0,
  lease_token                  TEXT,
  lease_expires_at             TEXT
);

-- Explicit provenance for a rejected write against this exact manifest
-- generation. Retained rows never imply this state by themselves.
CREATE TABLE IF NOT EXISTS manifest_write_violations (
  connector_instance_id TEXT NOT NULL,
  stream                TEXT NOT NULL,
  manifest_generation   INTEGER NOT NULL,
  provenance            TEXT NOT NULL,
  observed_at           TEXT NOT NULL,
  PRIMARY KEY(connector_instance_id, stream, manifest_generation)
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
function withCachedPrepare(raw: SqliteDatabase): DatabaseHandle {
  const cache = new Map<string, SqliteStatement>();
  return new Proxy(raw, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (text: string): SqliteStatement => {
          let stmt = cache.get(text);
          if (!stmt) {
            stmt = target.prepare(text) as unknown as SqliteStatement;
            cache.set(text, stmt);
          }
          return stmt;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as DatabaseHandle;
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
function addColumnIfMissing(raw: SqliteDatabase, table: string, column: string, type: string): void {
  const cols = raw.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) {
    return;
  }
  raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

function migrateDeviceIngestBatchOutcomes(raw: SqliteDatabase): void {
  const columns = raw.prepare("PRAGMA table_info(device_ingest_batch_outcomes)").all();
  const needsRebuild = !columns.some((column) => column.name === "accepted_at");
  if (!needsRebuild) {
    addColumnIfMissing(raw, "device_ingest_batch_outcomes", "manifest_fingerprint", "TEXT NOT NULL DEFAULT ''");
    addColumnIfMissing(raw, "device_ingest_batch_outcomes", "semantic_capability_identity", "TEXT NOT NULL DEFAULT ''");
    return;
  }
  raw.exec(`
    ALTER TABLE device_ingest_batch_outcomes RENAME TO device_ingest_batch_outcomes_legacy;
    CREATE TABLE device_ingest_batch_outcomes (
      device_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      body_hash TEXT NOT NULL,
      source_instance_id TEXT NOT NULL,
      connector_instance_id TEXT NOT NULL DEFAULT '',
      connector_id TEXT NOT NULL DEFAULT '',
      batch_seq INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK (status IN ('processing', 'accepted')),
      http_status INTEGER,
      response_json TEXT,
      record_count INTEGER NOT NULL DEFAULT 0,
      durable_prefix_count INTEGER NOT NULL DEFAULT 0,
      manifest_fingerprint TEXT NOT NULL DEFAULT '',
      semantic_capability_identity TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      accepted_at TEXT,
      CHECK (durable_prefix_count >= 0 AND durable_prefix_count <= record_count),
      CHECK (status <> 'accepted' OR durable_prefix_count = record_count),
      PRIMARY KEY(device_id, batch_id, body_hash),
      UNIQUE(device_id, batch_id),
      FOREIGN KEY(device_id) REFERENCES device_exporters(device_id) ON DELETE CASCADE
    );
    INSERT INTO device_ingest_batch_outcomes(
      device_id, batch_id, body_hash, source_instance_id, status, http_status,
      response_json, record_count, durable_prefix_count, created_at, accepted_at
    )
    SELECT device_id, batch_id, body_hash, source_instance_id, 'accepted',
           http_status, response_json,
           MAX(0, COALESCE(json_extract(response_json, '$.accepted_record_count'), 0)),
           MAX(0, COALESCE(json_extract(response_json, '$.accepted_record_count'), 0)),
           created_at, created_at
      FROM device_ingest_batch_outcomes_legacy;
    DROP TABLE device_ingest_batch_outcomes_legacy;
    CREATE INDEX IF NOT EXISTS idx_device_ingest_batch_outcomes_source
      ON device_ingest_batch_outcomes(device_id, source_instance_id, created_at);
  `);
}

// Reset-safe record-source checkpoint: a non-null counter on
// connector_instances, initialized to zero, that a supported stream or
// connector-wide reset increments by the number of distinct stream
// namespaces whose pre-reset state held a version_counter row or a live
// canonical record. Combined with the per-stream version_counter vector it
// makes the composite checkpoint immune to the ABA collision a bare version
// vector has (reset deletes version_counter; reinsertion can recreate the
// same vector around different canonical records).
// Spec: openspec/changes/reconcile-active-summary-evidence/design.md
function ensureRecordResetGenerationColumn(raw: SqliteDatabase): void {
  addColumnIfMissing(raw, "connector_instances", "record_reset_generation", "INTEGER NOT NULL DEFAULT 0");
}

function ensureConnectorSummaryEvidenceColumns(raw: SqliteDatabase): void {
  addColumnIfMissing(raw, "connector_summary_evidence", "last_record_updated_at", "TEXT");
  addColumnIfMissing(raw, "connector_summary_evidence", "stream_records_json", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(
    raw,
    "connector_summary_evidence",
    "retained_bytes_json",
    'TEXT NOT NULL DEFAULT \'{"record_json_bytes":0,"record_changes_json_bytes":0,"blob_bytes":0,"total_bytes":0}\''
  );
  addColumnIfMissing(raw, "connector_summary_evidence", "total_retained_bytes", "INTEGER NOT NULL DEFAULT 0");
  // Durable per-stream latest-attempt evidence: raw runtime facts from the
  // newest terminal run that attempted each stream, plus the highest terminal
  // spine event_seq folded into the map. NULL seq = never folded (pre-change
  // row); the reconcile pass backfills it from terminal events. Raw facts
  // only — coverage is derived on read.
  addColumnIfMissing(raw, "connector_summary_evidence", "stream_latest_facts_json", "TEXT");
  addColumnIfMissing(raw, "connector_summary_evidence", "stream_facts_event_seq", "INTEGER");
  // Fold-logic version this row's stream_latest_facts_json/stream_facts_event_seq
  // were computed under. NULL/behind-current means the row's fold checkpoint is
  // not trustworthy under the CURRENT fold semantics even though it is a real
  // event_seq — the fold treats it exactly like a NULL checkpoint (re-derive
  // from full history) so a fold-logic fix (e.g. the monotonic-coverage guard)
  // self-heals every existing row on its next reconcile pass, not merely future
  // terminal events. See STREAM_FACTS_FOLD_LOGIC_VERSION in
  // connector-summary-read-model.ts.
  addColumnIfMissing(raw, "connector_summary_evidence", "stream_facts_fold_version", "INTEGER");
  // Orthogonal typed evidence components (reconcile-active-summary-evidence):
  // the exact normalized reset-safe checkpoint this row's record_snapshot
  // was last computed against (for record_checkpoint_mismatch detection),
  // the manifest declaration fingerprint this row's stream declarations
  // were last computed against, and each component's independent
  // current/unobserved/stale/failed state + sanitized reason code. Spec:
  // openspec/changes/reconcile-active-summary-evidence/design.md
  addColumnIfMissing(raw, "connector_summary_evidence", "record_checkpoint_json", "TEXT");
  addColumnIfMissing(raw, "connector_summary_evidence", "manifest_fingerprint", "TEXT");
  addColumnIfMissing(raw, "connector_summary_evidence", "record_snapshot_state", "TEXT NOT NULL DEFAULT 'unobserved'");
  addColumnIfMissing(raw, "connector_summary_evidence", "record_snapshot_reason_code", "TEXT");
  addColumnIfMissing(raw, "connector_summary_evidence", "terminal_facts_state", "TEXT NOT NULL DEFAULT 'unobserved'");
  addColumnIfMissing(raw, "connector_summary_evidence", "terminal_facts_reason_code", "TEXT");
  addColumnIfMissing(
    raw,
    "connector_summary_evidence",
    "manifest_declaration_state",
    "TEXT NOT NULL DEFAULT 'unavailable'"
  );
  addColumnIfMissing(raw, "connector_summary_evidence", "manifest_declaration_reason_code", "TEXT");
  addColumnIfMissing(raw, "connector_summary_evidence", "retained_bytes_state", "TEXT NOT NULL DEFAULT 'unobserved'");
  addColumnIfMissing(raw, "connector_summary_evidence", "retained_bytes_reason_code", "TEXT");
  addColumnIfMissing(raw, "connector_summary_evidence", "manifest_generation", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(raw, "connector_summary_evidence", "canonical_evidence_revision", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(raw, "connector_summary_evidence", "schedule_checkpoint", "TEXT NOT NULL DEFAULT 'unobserved'");
  addColumnIfMissing(raw, "connector_summary_evidence", "run_lifecycle_event_seq", "INTEGER");
  addColumnIfMissing(raw, "connector_summary_evidence", "list_summary_projection_json", "TEXT");
  addColumnIfMissing(
    raw,
    "connector_summary_evidence",
    "list_summary_projection_state",
    "TEXT NOT NULL DEFAULT 'unobserved'"
  );
  addColumnIfMissing(raw, "connector_summary_evidence", "list_summary_projection_reason_code", "TEXT");
  addColumnIfMissing(raw, "connector_summary_evidence", "list_summary_projection_computed_at", "TEXT");
}

function ensureConnectorMaintenanceCursorColumns(raw: SqliteDatabase): void {
  addColumnIfMissing(raw, "connector_maintenance_cursor", "generation", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(raw, "connector_maintenance_cursor", "lease_token", "TEXT");
  addColumnIfMissing(raw, "connector_maintenance_cursor", "lease_expires_at", "TEXT");
}

function migrateManifestWriteViolations(raw: SqliteDatabase): void {
  if (!hasTableColumn(raw, "manifest_write_violations", "manifest_fingerprint")) {
    return;
  }
  raw.transaction(() => {
    raw.exec("ALTER TABLE manifest_write_violations RENAME TO manifest_write_violations_legacy_generation");
    raw.exec(`CREATE TABLE manifest_write_violations (
      connector_instance_id TEXT NOT NULL,
      stream TEXT NOT NULL,
      manifest_generation INTEGER NOT NULL,
      provenance TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      PRIMARY KEY(connector_instance_id, stream, manifest_generation)
    )`);
    // Legacy fingerprint-only rows have no durable event identity. Preserve
    // them as explicitly historical so they can never accuse generation 0.
    raw.exec(`INSERT INTO manifest_write_violations(connector_instance_id, stream, manifest_generation, provenance, observed_at)
      SELECT connector_instance_id, stream,
             -ROW_NUMBER() OVER (PARTITION BY connector_instance_id, stream ORDER BY observed_at, manifest_fingerprint),
             provenance, observed_at
      FROM manifest_write_violations_legacy_generation`);
    raw.exec("DROP TABLE manifest_write_violations_legacy_generation");
  })();
}

function ensureBrowserSurfaceLeaseIndexes(raw: SqliteDatabase): void {
  raw.exec(`
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

const BROWSER_SURFACE_LEASE_GENERATED_OBJECTS = new Set([
  "idx_browser_surface_leases_one_non_terminal_run",
  "idx_browser_surface_leases_one_active_surface",
  "idx_browser_surface_leases_one_pending_connector_profile",
  "idx_browser_surface_leases_non_terminal",
]);

const BROWSER_SURFACE_LEASE_ENUMS = {
  priority_class: {
    current: ["interactive", "background"],
    legacy: ["owner_interactive", "scheduled_refresh"],
    mixed: ["owner_interactive", "scheduled_refresh", "interactive", "background"],
  },
  status: {
    current: [
      "waiting_for_browser_surface",
      "starting_surface",
      "leased",
      "released",
      "expired",
      "deferred",
      "cancelled",
      "surface_failed",
    ],
    legacy: ["waiting_for_browser_surface", "leased", "released", "expired", "deferred", "cancelled", "surface_failed"],
  },
  wait_reason: {
    current: [
      "capacity_full",
      "surface_starting",
      "surface_unhealthy",
      "surface_start_failed",
      "surface_readiness_timeout",
      "incompatible_static_profile",
      "launch_precondition_failed",
      "lease_wait_timeout",
      "retained_capacity_reserved",
    ],
    intermediate: [
      "capacity_full",
      "surface_starting",
      "surface_unhealthy",
      "surface_start_failed",
      "surface_readiness_timeout",
      "incompatible_static_profile",
      "launch_precondition_failed",
      "lease_wait_timeout",
    ],
    legacy: [
      "capacity_full",
      "surface_starting",
      "surface_unhealthy",
      "incompatible_static_profile",
      "launch_precondition_failed",
      "lease_wait_timeout",
    ],
  },
};

function sameEnumMembers(actual: string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value) => expected.includes(value));
}

function enumLiterals(sql: string): string[] {
  return [...sql.matchAll(/'((?:''|[^'])*)'/g)].map((match) => match[1]?.replaceAll("''", "'") ?? "");
}

function sqliteLeaseCheckPattern(column: string): RegExp {
  const quotedColumn = `(?:${column}|"${column}")`;
  if (column === "wait_reason") {
    return new RegExp(
      `((?:CONSTRAINT\\s+(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\\s+)?)CHECK\\s*\\(\\s*${quotedColumn}\\s+IS\\s+NULL\\s+OR\\s+${quotedColumn}\\s+IN\\s*\\([^)]*\\)\\s*\\)`,
      "gi"
    );
  }
  return new RegExp(
    `((?:CONSTRAINT\\s+(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\\s+)?)CHECK\\s*\\(\\s*${quotedColumn}\\s+IN\\s*\\([^)]*\\)\\s*\\)`,
    "gi"
  );
}

function sqliteLeaseCheckSql(column: string, values: readonly string[]): string {
  const allowed = values.map((value) => `'${value}'`).join(", ");
  return column === "wait_reason"
    ? `CHECK (${column} IS NULL OR ${column} IN (${allowed}))`
    : `CHECK (${column} IN (${allowed}))`;
}

function transformSupportedLeaseChecks(createSql: string): { changed: boolean; createSql: string } {
  let changed = false;
  let transformed = createSql;
  for (const [column, shapes] of Object.entries(BROWSER_SURFACE_LEASE_ENUMS)) {
    let found = 0;
    transformed = transformed.replace(sqliteLeaseCheckPattern(column), (whole: string, prefix: string) => {
      found += 1;
      const values = enumLiterals(whole);
      const knownShape = Object.values(shapes).find((shape) => sameEnumMembers(values, shape));
      if (!knownShape) {
        throw new Error(`Unsupported browser_surface_leases ${column} CHECK shape; refusing a lossy migration.`);
      }
      if (!sameEnumMembers(values, shapes.current)) {
        changed = true;
      }
      return `${prefix}${sqliteLeaseCheckSql(column, shapes.current)}`;
    });
    if (found !== 1) {
      throw new Error(
        `Expected exactly one direct browser_surface_leases ${column} CHECK; refusing a lossy migration.`
      );
    }
  }
  return { changed, createSql: transformed };
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function sqliteLeaseDependentObjects(raw: SqliteDatabase): Array<{ name: string; sql: string }> {
  interface DependentObject {
    name: string;
    sql: string;
  }
  const objects = raw
    .prepare(`
    SELECT type, name, sql
    FROM sqlite_master
    WHERE tbl_name = 'browser_surface_leases'
      AND type IN ('index', 'trigger')
      AND sql IS NOT NULL
    ORDER BY type, name
  `)
    .all() as DependentObject[];
  return objects.filter((object) => !BROWSER_SURFACE_LEASE_GENERATED_OBJECTS.has(object.name));
}

function migrateBrowserSurfaceLeaseEnumChecks(raw: SqliteDatabase): void {
  // SQLite cannot rebuild a referenced table while foreign-key enforcement is
  // enabled: dropping the old table invalidates inbound references before the
  // replacement takes its name. Disable enforcement only around this single
  // connection's transaction, then run foreign_key_check before committing.
  const foreignKeysEnabled = raw.pragma("foreign_keys", { simple: true }) === 1;
  if (foreignKeysEnabled) {
    raw.pragma("foreign_keys = OFF");
  }
  try {
    raw.transaction(() => {
      if (
        raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'browser_surface_leases_new'").get()
      ) {
        throw new Error("Found unfinished browser_surface_leases_new migration table; refusing to overwrite it.");
      }
      if (!hasTableColumn(raw, "browser_surface_leases", "surface_subject_id")) {
        raw.exec("ALTER TABLE browser_surface_leases ADD COLUMN surface_subject_id TEXT");
      }
      const row = raw
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'browser_surface_leases'")
        .get();
      const originalSql = typeof row?.sql === "string" ? row.sql : "";
      const { createSql, changed } = transformSupportedLeaseChecks(originalSql);
      const oldRows = raw
        .prepare(
          "SELECT 1 FROM browser_surface_leases WHERE priority_class IN ('owner_interactive', 'scheduled_refresh') LIMIT 1"
        )
        .get();
      if (!(changed || oldRows)) {
        return;
      }
      const newTableSql = createSql.replace(
        BROWSER_SURFACE_LEASE_CREATE_TABLE_NAME_PATTERN,
        "$1browser_surface_leases_new"
      );
      if (newTableSql === createSql) {
        throw new Error("Unsupported browser_surface_leases CREATE TABLE shape; refusing a lossy migration.");
      }
      const dependentObjects = sqliteLeaseDependentObjects(raw);
      const columns = tableColumns(raw, "browser_surface_leases");
      if (!columns.includes("priority_class")) {
        throw new Error("browser_surface_leases has no priority_class column.");
      }
      const quotedColumns = columns.map(quoteSqliteIdentifier).join(", ");
      const projection = columns
        .map((column) =>
          column === "priority_class"
            ? "CASE priority_class WHEN 'owner_interactive' THEN 'interactive' WHEN 'scheduled_refresh' THEN 'background' ELSE priority_class END"
            : quoteSqliteIdentifier(column)
        )
        .join(", ");
      raw.exec("PRAGMA defer_foreign_keys = ON");
      raw.exec(newTableSql);
      raw.exec(
        `INSERT INTO browser_surface_leases_new (${quotedColumns}) SELECT ${projection} FROM browser_surface_leases`
      );
      raw.exec("DROP TABLE browser_surface_leases");
      raw.exec("ALTER TABLE browser_surface_leases_new RENAME TO browser_surface_leases");
      ensureBrowserSurfaceLeaseIndexes(raw);
      for (const object of dependentObjects) {
        raw.exec(object.sql);
      }
      const foreignKeyViolations = raw.prepare("PRAGMA foreign_key_check").all();
      if (foreignKeyViolations.length > 0) {
        throw new Error(
          `browser_surface_leases migration failed foreign_key_check: ${JSON.stringify(foreignKeyViolations)}`
        );
      }
    })();
  } finally {
    if (foreignKeysEnabled) {
      raw.pragma("foreign_keys = ON");
    }
  }
}

function tableColumns(raw: SqliteDatabase, table: string): string[] {
  return raw
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name as string);
}

function hasTableColumn(raw: SqliteDatabase, table: string, column: string): boolean {
  return tableColumns(raw, table).includes(column);
}

function migrateClientEventSubscriptionAuthority(raw: SqliteDatabase): void {
  const cols = raw.prepare("PRAGMA table_info(client_event_subscriptions)").all();
  const grantCol = cols.find((c) => c.name === "grant_id");
  const hasAuthorityKind = cols.some((c) => c.name === "authority_kind");
  if (hasAuthorityKind && grantCol && Number(grantCol.notnull) === 0) {
    return;
  }

  const authorityExpr = hasAuthorityKind ? "authority_kind" : "'client_grant'";
  raw.transaction(() => {
    raw.exec(`
DROP INDEX IF EXISTS idx_client_event_subscriptions_client;
DROP INDEX IF EXISTS idx_client_event_subscriptions_grant;
DROP INDEX IF EXISTS idx_client_event_subscriptions_authority;

ALTER TABLE client_event_subscriptions RENAME TO client_event_subscriptions_old_authority;

CREATE TABLE client_event_subscriptions (
  subscription_id        TEXT PRIMARY KEY,
  authority_kind         TEXT NOT NULL DEFAULT 'client_grant',
  grant_id               TEXT,
  client_id              TEXT NOT NULL,
  subject_id             TEXT NOT NULL,
  callback_url           TEXT NOT NULL,
  secret_hash            TEXT NOT NULL,
  secret_text            TEXT NOT NULL,
  scope_json             TEXT NOT NULL,
  status                 TEXT NOT NULL,
  verification_challenge TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  disabled_at            TEXT,
  disabled_reason        TEXT,
  CHECK (status IN (
    'pending_verification',
    'active',
    'disabled',
    'disabled_failure',
    'disabled_revoked',
    'deleted'
  )),
  CHECK (authority_kind IN ('client_grant', 'trusted_owner_agent')),
  CHECK (
    (authority_kind = 'client_grant' AND grant_id IS NOT NULL)
    OR (authority_kind = 'trusted_owner_agent' AND grant_id IS NULL)
  )
);

INSERT INTO client_event_subscriptions(
  subscription_id, authority_kind, grant_id, client_id, subject_id,
  callback_url, secret_hash, secret_text, scope_json, status,
  verification_challenge, created_at, updated_at, disabled_at, disabled_reason
)
SELECT
  subscription_id,
  ${authorityExpr},
  grant_id,
  client_id,
  subject_id,
  callback_url,
  secret_hash,
  secret_text,
  scope_json,
  status,
  verification_challenge,
  created_at,
  updated_at,
  disabled_at,
  disabled_reason
FROM client_event_subscriptions_old_authority;

DROP TABLE client_event_subscriptions_old_authority;

CREATE INDEX IF NOT EXISTS idx_client_event_subscriptions_client
  ON client_event_subscriptions(client_id, status);
CREATE INDEX IF NOT EXISTS idx_client_event_subscriptions_grant
  ON client_event_subscriptions(grant_id);
CREATE INDEX IF NOT EXISTS idx_client_event_subscriptions_authority
  ON client_event_subscriptions(authority_kind, subject_id, client_id, status);
`);
  })();
}

function ensureClientEventSubscriptionAuthorityIndex(raw: SqliteDatabase): void {
  raw.exec(`
CREATE INDEX IF NOT EXISTS idx_client_event_subscriptions_authority
  ON client_event_subscriptions(authority_kind, subject_id, client_id, status);
`);
}

function stableJson(value: unknown): string {
  if (value === null) {
    return "{}";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function localDeviceConnectorId(connectorId: string): string {
  return `local-device:${encodeURIComponent(connectorId)}`;
}

function legacyLocalDeviceConnectorId(connectorId: string, sourceInstanceId: string): string {
  return `${localDeviceConnectorId(connectorId)}:${encodeURIComponent(sourceInstanceId)}`;
}

function makeDefaultAccountConnectorInstanceId(ownerSubjectId: string, connectorId: string): string {
  const hash = createHash("sha256").update(`${ownerSubjectId}\n${connectorId}\naccount\ndefault`).digest("hex");
  return `cin_${hash.slice(0, 24)}`;
}

function defaultConnectorInstanceIdForBackfill(raw: SqliteDatabase, connectorId: string): string {
  const rows = raw
    .prepare(
      `SELECT connector_instance_id
       FROM connector_instances
      WHERE connector_id = ?
      ORDER BY connector_instance_id`
    )
    .all<ConnectorInstanceIdRow>(connectorId);
  if (rows.length === 1) {
    return rows[0]?.connector_instance_id as string;
  }
  return makeDefaultAccountConnectorInstanceId(LEGACY_SYNC_STATE_OWNER_SUBJECT_ID, connectorId);
}

function migrateConnectorSyncStateInstanceColumns(raw: SqliteDatabase, opts: MigrationOptions = {}) {
  const ownerHasInstanceColumn = hasTableColumn(raw, "connector_state", "connector_instance_id");
  const grantHasInstanceColumn = hasTableColumn(raw, "grant_connector_state", "connector_instance_id");
  if (ownerHasInstanceColumn && grantHasInstanceColumn) {
    return { backfilledRows: 0, rebuilt: false };
  }

  const migration = raw.transaction(() => {
    const ownerRows = raw
      .prepare(
        `SELECT connector_id,
              ${ownerHasInstanceColumn ? "connector_instance_id," : ""}
              stream,
              state_json,
              updated_at
         FROM connector_state
        ORDER BY connector_id, stream`
      )
      .all<ConnectorStateRow>();
    const grantRows = raw
      .prepare(
        `SELECT grant_id,
              connector_id,
              ${grantHasInstanceColumn ? "connector_instance_id," : ""}
              stream,
              state_json,
              updated_at
         FROM grant_connector_state
        ORDER BY grant_id, connector_id, stream`
      )
      .all<GrantConnectorStateRow>();
    const byConnector = new Map<string, string>();
    const resolveInstanceId = (row: ConnectorStateRow | GrantConnectorStateRow): string => {
      if (typeof row.connector_instance_id === "string" && row.connector_instance_id.trim()) {
        return row.connector_instance_id.trim();
      }
      const connectorId = row.connector_id;
      if (!byConnector.has(connectorId)) {
        byConnector.set(connectorId, defaultConnectorInstanceIdForBackfill(raw, connectorId));
      }
      return getMappedValue(byConnector, connectorId);
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
      backfilledRows: (ownerHasInstanceColumn ? 0 : ownerRows.length) + (grantHasInstanceColumn ? 0 : grantRows.length),
      rebuilt: true,
    };
  });

  const result = migration();
  if (typeof opts.onSchemaMigration === "function") {
    opts.onSchemaMigration({ name: "connector_sync_state_instance_columns", ...result });
  }
  return result;
}

function updateConnectorIdForInstance(
  raw: SqliteDatabase,
  table: string,
  oldConnectorId: string,
  newConnectorId: string,
  connectorInstanceId: string
): number {
  if (!(hasTableColumn(raw, table, "connector_id") && hasTableColumn(raw, table, "connector_instance_id"))) {
    return 0;
  }
  return raw
    .prepare(
      `UPDATE ${table}
        SET connector_id = ?
      WHERE connector_id = ?
        AND connector_instance_id = ?`
    )
    .run(newConnectorId, oldConnectorId, connectorInstanceId).changes;
}

interface LocalDeviceMigrationContext {
  getExistingInstanceByBinding: SqliteStatement;
  getTombstoneByBinding: SqliteStatement;
  legacyInstanceRows: SqliteStatement;
  now: string;
  opts: MigrationOptions;
  raw: SqliteDatabase;
  tables: readonly string[];
  updateSourceInstance: SqliteStatement;
  upsertConnector: SqliteStatement;
  upsertInstance: SqliteStatement;
}

interface LocalDeviceMigrationIdentity {
  bindingKey: string;
  connectorKey: string;
  currentInstanceId: string | null;
  existingBindingInstanceId: string | null;
  legacyInstanceId: string | null;
  oldConnectorId: string;
}

function resolveLocalDeviceMigrationIdentity(
  context: LocalDeviceMigrationContext,
  row: LocalDeviceSourceRow
): LocalDeviceMigrationIdentity | null {
  const bindingKey = canonicalSourceBindingKey({ kind: "local_device", local_binding_name: row.local_binding_id });
  const connectorKey: string = canonicalConnectorKey(row.connector_id) ?? row.connector_id;
  const oldConnectorId = legacyLocalDeviceConnectorId(row.connector_id, row.source_instance_id);
  const legacyRows = context.legacyInstanceRows.all<ConnectorInstanceIdRow>(
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
    oldConnectorId
  );
  const legacyInstanceIds = [
    ...new Set(legacyRows.map((legacyRow) => legacyRow.connector_instance_id.trim()).filter(Boolean)),
  ];
  if (!row.connector_instance_id && legacyInstanceIds.length > 1) {
    throw new Error(
      `Cannot migrate local-device source_instance_id '${row.source_instance_id}': legacy rows under '${oldConnectorId}' have multiple connector_instance_ids (${legacyInstanceIds.join(", ")}) and device_source_instances.connector_instance_id is empty.`
    );
  }

  const currentInstanceId = row.connector_instance_id?.trim() || null;
  const legacyInstanceId: string | null = legacyInstanceIds[0] ?? null;
  const existingBinding = context.getExistingInstanceByBinding.get<ConnectorInstanceIdRow>(
    row.owner_subject_id,
    connectorKey,
    bindingKey
  );
  const existingBindingInstanceId: string | null = existingBinding?.connector_instance_id ?? null;
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

  if (!(currentInstanceId || existingBindingInstanceId || legacyInstanceId)) {
    const tombstone = context.getTombstoneByBinding.get(row.owner_subject_id, connectorKey, bindingKey);
    if (tombstone) {
      if (typeof context.opts.onSchemaMigration === "function") {
        context.opts.onSchemaMigration({
          name: "local_device_connector_instances",
          skippedTombstonedRow: {
            connectorId: connectorKey,
            deviceId: row.device_id,
            sourceInstanceId: row.source_instance_id,
          },
        });
      }
      return null;
    }
  }

  return { bindingKey, connectorKey, currentInstanceId, existingBindingInstanceId, legacyInstanceId, oldConnectorId };
}

function migrateLocalDeviceConnectorRow(context: LocalDeviceMigrationContext, row: LocalDeviceSourceRow): number {
  const sourceBinding = {
    device_id: row.device_id,
    kind: "local_device",
    local_binding_name: row.local_binding_id,
    source_instance_id: row.source_instance_id,
  };
  const identity = resolveLocalDeviceMigrationIdentity(context, row);
  if (!identity) {
    return 0;
  }

  const resolvedInstanceId: string =
    identity.currentInstanceId ||
    identity.existingBindingInstanceId ||
    identity.legacyInstanceId ||
    canonicalConnectorInstanceId(row.owner_subject_id, identity.connectorKey, "local_device", identity.bindingKey);
  const createdAt = row.created_at || context.now;
  const updatedAt = row.updated_at || context.now;
  const displayName = row.display_name || row.local_binding_id || row.connector_id;
  const status = row.status === "revoked" ? "revoked" : "active";
  const manifest = stableJson({
    connector_id: identity.connectorKey,
    display_name: displayName,
    streams: [],
  });

  context.upsertConnector.run(identity.connectorKey, manifest, createdAt);
  context.upsertInstance.run(
    resolvedInstanceId,
    row.owner_subject_id,
    identity.connectorKey,
    displayName,
    status,
    identity.bindingKey,
    stableJson(sourceBinding),
    createdAt,
    updatedAt,
    status === "revoked" ? (row.revoked_at ?? updatedAt) : null
  );
  let backfilledRows = 0;
  if (identity.currentInstanceId !== resolvedInstanceId || row.connector_id !== identity.connectorKey) {
    context.updateSourceInstance.run(
      resolvedInstanceId,
      identity.connectorKey,
      updatedAt,
      row.device_id,
      row.source_instance_id
    );
    backfilledRows += 1;
  }
  for (const table of context.tables) {
    backfilledRows += updateConnectorIdForInstance(
      context.raw,
      table,
      identity.oldConnectorId,
      identity.connectorKey,
      resolvedInstanceId
    );
  }
  return backfilledRows;
}

function migrateLocalDeviceConnectorInstances(raw: SqliteDatabase, opts: MigrationOptions = {}) {
  if (
    !(
      hasTableColumn(raw, "device_source_instances", "connector_instance_id") &&
      hasTableColumn(raw, "connector_instances", "source_binding_key") &&
      hasTableColumn(raw, "connector_instances", "source_binding_json")
    )
  ) {
    return { backfilledRows: 0, rebuilt: false };
  }

  const rows = raw
    .prepare(
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
    )
    .all<LocalDeviceSourceRow>();
  if (rows.length === 0) {
    return { backfilledRows: 0, rebuilt: false };
  }

  const tables: string[] = [
    "connector_state",
    "grant_connector_state",
    "records",
    "record_changes",
    "version_counter",
    "blobs",
    "blob_bindings",
    "lexical_search_index",
    "lexical_search_meta",
    "semantic_search_rowid",
    "semantic_search_blob",
    "semantic_search_meta",
    "semantic_search_backfill_progress",
    "connector_detail_gaps",
    "connector_schedules",
    "controller_active_runs",
    "scheduler_run_history",
    "scheduler_last_run_times",
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
    // Durability guard: this sweep runs on EVERY boot (not a one-time
    // upgrade — the top-of-function gate only checks that today's columns
    // exist), re-upserting a connector_instances row for every
    // device_source_instances row it finds. Owner delete clears
    // device_source_instances.connector_instance_id but leaves connector_id/
    // local_binding_id populated, so without this check a plain process
    // restart alone -- no re-enrollment, no HTTP call -- would silently
    // resurrect a deleted connection the next time this sweep runs. See
    // openspec/changes/fix-owner-delete-resurrection.
    const getTombstoneByBinding = raw.prepare(
      `SELECT connector_instance_id
         FROM connector_instance_tombstones
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
              connector_id = ?,
              updated_at = ?
        WHERE device_id = ?
          AND source_instance_id = ?`
    );

    const context: LocalDeviceMigrationContext = {
      getExistingInstanceByBinding,
      getTombstoneByBinding,
      legacyInstanceRows,
      now: new Date().toISOString(),
      opts,
      raw,
      tables,
      updateSourceInstance,
      upsertConnector,
      upsertInstance,
    };
    let backfilledRows = 0;
    for (const row of rows) {
      backfilledRows += migrateLocalDeviceConnectorRow(context, row);
    }
    return { backfilledRows, rebuilt: false };
  });

  const result = migration();
  if (result.backfilledRows > 0 && typeof opts.onSchemaMigration === "function") {
    opts.onSchemaMigration({ name: "local_device_connector_instances", ...result });
  }
  return result;
}

// Add the `records.semantic_time` column on an EXISTING db (CREATE TABLE IF NOT
// EXISTS does not alter an existing table). DEFAULT '' makes this O(1) — no mass
// UPDATE on a large records table at boot. Existing rows keep ''; the substrate
// read COALESCEs '' -> emitted_at, so the merged-timeline sort is no worse than
// the prior emitted_at order until the chunked per-record semantic backfill
// (Step B) populates the real values. New writes set semantic_time at ingest.
function migrateRecordSemanticTimeColumn(raw: SqliteDatabase): { added: boolean } {
  if (hasTableColumn(raw, "records", "semantic_time")) {
    return { added: false };
  }
  raw.exec(`ALTER TABLE records ADD COLUMN semantic_time TEXT NOT NULL DEFAULT ''`);
  return { added: true };
}

function copyRecordStorageRows(
  raw: SqliteDatabase,
  records: RecordStorageRow[],
  changes: RecordStorageRow[],
  counters: VersionCounterRow[],
  bindings: BlobBindingRow[]
): void {
  const instanceIds = new Map<string, string>();
  const resolveInstanceId = (row: ConnectorScopedRow): string => {
    if (typeof row.connector_instance_id === "string" && row.connector_instance_id.trim()) {
      return row.connector_instance_id.trim();
    }
    if (!instanceIds.has(row.connector_id)) {
      instanceIds.set(row.connector_id, defaultConnectorInstanceIdForBackfill(raw, row.connector_id));
    }
    return getMappedValue(instanceIds, row.connector_id);
  };

  const insertRecord = raw.prepare(
    `INSERT INTO records(id, connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, deleted_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const row of records) {
    insertRecord.run(
      row.id,
      row.connector_id,
      resolveInstanceId(row),
      row.stream,
      row.record_key,
      row.record_json,
      row.emitted_at,
      row.version,
      row.deleted,
      row.deleted_at
    );
  }

  const insertChange = raw.prepare(
    `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted, deleted_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const row of changes) {
    insertChange.run(
      row.connector_id,
      resolveInstanceId(row),
      row.stream,
      row.record_key,
      row.version,
      row.record_json,
      row.emitted_at,
      row.deleted,
      row.deleted_at
    );
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
}

function migrateRecordStorageInstanceColumns(raw: SqliteDatabase, opts: MigrationOptions = {}) {
  const recordsHaveInstance = hasTableColumn(raw, "records", "connector_instance_id");
  const changesHaveInstance = hasTableColumn(raw, "record_changes", "connector_instance_id");
  const countersHaveInstance = hasTableColumn(raw, "version_counter", "connector_instance_id");
  const bindingsHaveInstance = hasTableColumn(raw, "blob_bindings", "connector_instance_id");
  if (recordsHaveInstance && changesHaveInstance && countersHaveInstance && bindingsHaveInstance) {
    return { backfilledRows: 0, rebuilt: false };
  }

  const migration = raw.transaction(() => {
    const records = raw
      .prepare(
        `SELECT id, connector_id, ${recordsHaveInstance ? "connector_instance_id," : ""} stream, record_key, record_json, emitted_at, version, deleted, deleted_at
         FROM records
        ORDER BY id`
      )
      .all<RecordStorageRow>();
    const changes = raw
      .prepare(
        `SELECT connector_id, ${changesHaveInstance ? "connector_instance_id," : ""} stream, record_key, version, record_json, emitted_at, deleted, deleted_at
         FROM record_changes
        ORDER BY connector_id, stream, version`
      )
      .all<RecordStorageRow>();
    const counters = raw
      .prepare(
        `SELECT connector_id, ${countersHaveInstance ? "connector_instance_id," : ""} stream, max_version
         FROM version_counter
        ORDER BY connector_id, stream`
      )
      .all<VersionCounterRow>();
    const bindings = raw
      .prepare(
        `SELECT blob_id, connector_id, ${bindingsHaveInstance ? "connector_instance_id," : ""} stream, record_key, json_path
         FROM blob_bindings
        ORDER BY blob_id, connector_id, stream, record_key, json_path`
      )
      .all<BlobBindingRow>();
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

    copyRecordStorageRows(raw, records, changes, counters, bindings);

    raw.exec(`
      CREATE INDEX IF NOT EXISTS idx_records_lookup ON records(connector_instance_id, stream, record_key);
      CREATE INDEX IF NOT EXISTS idx_records_version ON records(connector_instance_id, stream, version);
      CREATE INDEX IF NOT EXISTS idx_record_changes_record ON record_changes(connector_instance_id, stream, record_key, version);
      CREATE INDEX IF NOT EXISTS idx_blob_bindings_record ON blob_bindings(connector_instance_id, stream, record_key);
    `);

    return {
      backfilledRows:
        (recordsHaveInstance ? 0 : records.length) +
        (changesHaveInstance ? 0 : changes.length) +
        (countersHaveInstance ? 0 : counters.length) +
        (bindingsHaveInstance ? 0 : bindings.length),
      rebuilt: true,
    };
  });

  const result = migration();
  if (typeof opts.onSchemaMigration === "function") {
    opts.onSchemaMigration({ name: "record_storage_instance_columns", ...result });
  }
  return result;
}

function migrateBlobOriginInstanceColumn(raw: SqliteDatabase, opts: MigrationOptions = {}) {
  addColumnIfMissing(raw, "blobs", "connector_instance_id", "TEXT");
  const rows = raw
    .prepare(
      `SELECT blob_id, connector_id, connector_instance_id
       FROM blobs
      WHERE connector_instance_id IS NULL OR trim(connector_instance_id) = ''
      ORDER BY connector_id, blob_id`
    )
    .all<BlobRow>();
  if (rows.length === 0) {
    return { backfilledRows: 0, rebuilt: false };
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
  const update = raw.prepare("UPDATE blobs SET connector_instance_id = ? WHERE blob_id = ?");
  const legacyInstanceIds = new Map<string, string>();
  const migration = raw.transaction(() => {
    let backfilledRows = 0;
    for (const row of rows) {
      const binding = bindingInstance.get<ConnectorInstanceIdRow>(row.blob_id, row.connector_id);
      let connectorInstanceId =
        typeof binding?.connector_instance_id === "string" ? binding.connector_instance_id.trim() : "";
      if (!connectorInstanceId) {
        if (!legacyInstanceIds.has(row.connector_id)) {
          legacyInstanceIds.set(row.connector_id, defaultConnectorInstanceIdForBackfill(raw, row.connector_id));
        }
        connectorInstanceId = getMappedValue(legacyInstanceIds, row.connector_id);
      }
      update.run(connectorInstanceId, row.blob_id);
      backfilledRows += 1;
    }
    return { backfilledRows, rebuilt: false };
  });

  const result = migration();
  if (typeof opts.onSchemaMigration === "function") {
    opts.onSchemaMigration({ name: "blob_origin_instance_column", ...result });
  }
  return result;
}

function migrateLexicalSearchInstanceColumns(raw: SqliteDatabase, opts: MigrationOptions = {}) {
  const indexHasInstance = hasTableColumn(raw, "lexical_search_index", "connector_instance_id");
  const metaHasInstance = hasTableColumn(raw, "lexical_search_meta", "connector_instance_id");
  if (indexHasInstance && metaHasInstance) {
    return { backfilledRows: 0, rebuilt: false };
  }

  const migration = raw.transaction(() => {
    const indexRows = raw
      .prepare(
        `SELECT connector_id, ${indexHasInstance ? "connector_instance_id," : ""} stream, record_key, field, text
         FROM lexical_search_index
        ORDER BY connector_id, stream, record_key, field`
      )
      .all<LexicalIndexRow>();
    const metaRows = raw
      .prepare(
        `SELECT connector_id, ${metaHasInstance ? "connector_instance_id," : ""} stream, fields_fingerprint, updated_at
         FROM lexical_search_meta
        ORDER BY connector_id, stream`
      )
      .all<LexicalMetaRow>();
    const instanceIds = new Map<string, string>();
    const resolveInstanceId = (row: ConnectorScopedRow): string => {
      if (typeof row.connector_instance_id === "string" && row.connector_instance_id.trim()) {
        return row.connector_instance_id.trim();
      }
      if (!instanceIds.has(row.connector_id)) {
        instanceIds.set(row.connector_id, defaultConnectorInstanceIdForBackfill(raw, row.connector_id));
      }
      return getMappedValue(instanceIds, row.connector_id);
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
      backfilledRows: (indexHasInstance ? 0 : indexRows.length) + (metaHasInstance ? 0 : metaRows.length),
      rebuilt: true,
    };
  });

  const result = migration();
  if (typeof opts.onSchemaMigration === "function") {
    opts.onSchemaMigration({ name: "lexical_search_instance_columns", ...result });
  }
  return result;
}

function migrateConnectorDetailGapInstanceColumns(raw: SqliteDatabase, opts: MigrationOptions = {}) {
  // A recovery lease is distinct from a recovery attempt. A pre-lease schema
  // can contain interrupted work with no owner tuple; schema bootstrap is the
  // one bounded point that converts that legacy state back to retryable work.
  // Deployment requires zero active runs and a single-version restart, so this
  // is not a mixed-version compatibility protocol.
  const needsLeaseMigration = ["lease_run_id", "lease_id", "lease_attempted", "lease_expires_at"].some(
    (column) => !hasTableColumn(raw, "connector_detail_gaps", column)
  );
  if (needsLeaseMigration) {
    const activeRuns = raw.prepare("SELECT COUNT(*) AS count FROM controller_active_runs").get<SqliteCountRow>();
    if (Number(activeRuns?.count ?? 0) > 0) {
      throw new Error(
        "detail-gap lease migration requires zero active connector runs; drain runs and perform a single-version restart"
      );
    }
  }
  addColumnIfMissing(raw, "connector_detail_gaps", "lease_run_id", "TEXT");
  addColumnIfMissing(raw, "connector_detail_gaps", "lease_id", "TEXT");
  addColumnIfMissing(raw, "connector_detail_gaps", "lease_attempted", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(raw, "connector_detail_gaps", "lease_expires_at", "TEXT");
  const legacyLeaseLess = raw
    .prepare(`
    UPDATE connector_detail_gaps
    SET status = 'pending', lease_attempted = 0
    WHERE status = 'in_progress'
      AND lease_run_id IS NULL AND lease_id IS NULL AND lease_expires_at IS NULL
  `)
    .run();
  if (legacyLeaseLess.changes > 0 && typeof opts.onSchemaMigration === "function") {
    opts.onSchemaMigration({
      backfilledRows: legacyLeaseLess.changes,
      name: "connector_detail_gap_legacy_lease_reclaim",
      rebuilt: false,
    });
  }
  const hasInstance = hasTableColumn(raw, "connector_detail_gaps", "connector_instance_id");
  if (!hasInstance) {
    addColumnIfMissing(raw, "connector_detail_gaps", "connector_instance_id", "TEXT");
    const rows = raw
      .prepare("SELECT gap_id, connector_id FROM connector_detail_gaps ORDER BY gap_id")
      .all<ConnectorIdRow>();
    const instanceIds = new Map<string, string>();
    const resolveInstanceId = (connectorId: string): string => {
      if (!instanceIds.has(connectorId)) {
        instanceIds.set(connectorId, defaultConnectorInstanceIdForBackfill(raw, connectorId));
      }
      return getMappedValue(instanceIds, connectorId);
    };
    const update = raw.prepare("UPDATE connector_detail_gaps SET connector_instance_id = ? WHERE gap_id = ?");
    for (const row of rows) {
      update.run(resolveInstanceId(row.connector_id), row.gap_id);
    }
    if (typeof opts.onSchemaMigration === "function") {
      opts.onSchemaMigration({
        backfilledRows: rows.length,
        name: "connector_detail_gap_instance_columns",
        rebuilt: false,
      });
    }
  }

  // Drop the identity index BEFORE reconciling duplicates so the DELETE below
  // can collapse rows that would violate the new (locator-free) identity, then
  // recreate it. The new identity excludes the volatile locator when a
  // record_key is present, so pre-existing rows that differ ONLY in
  // detail_locator_json (the locator-schema-drift orphan class) now collide.
  raw.exec("DROP INDEX IF EXISTS uniq_connector_detail_gaps_identity");

  // Reconcile pre-existing duplicate rows under the NEW identity. Keep the most
  // resolved sibling per identity group (terminal > recovered > in_progress >
  // pending, then newest updated_at, then gap_id for determinism) and delete the
  // rest. This closes the immortal orphan pending rows: when the same record was
  // recovered/terminalized under a new-shape locator, the stale old-shape pending
  // row is provably redundant and removed. NULL grant_id / parent_stream /
  // record_key are ifnull-normalized so NULLs are not a uniqueness loophole.
  const reconciled = raw
    .prepare(`
    DELETE FROM connector_detail_gaps
    WHERE gap_id IN (
      SELECT gap_id FROM (
        SELECT gap_id,
          ROW_NUMBER() OVER (
            PARTITION BY connector_instance_id, ifnull(grant_id, ''), stream, ifnull(parent_stream, ''),
              CASE WHEN nullif(record_key, '') IS NOT NULL THEN 'key:' || record_key ELSE 'loc:' || ifnull(detail_locator_json, '') END
            ORDER BY
              CASE status
                WHEN 'terminal' THEN 0
                WHEN 'recovered' THEN 1
                WHEN 'in_progress' THEN 2
                ELSE 3
              END,
              updated_at DESC,
              gap_id
          ) AS rank
        FROM connector_detail_gaps
      )
      WHERE rank > 1
    )
  `)
    .run();
  if (reconciled.changes > 0 && typeof opts.onSchemaMigration === "function") {
    opts.onSchemaMigration({
      backfilledRows: reconciled.changes,
      name: "connector_detail_gap_locator_identity_reconcile",
      rebuilt: false,
    });
  }

  raw.exec(`
DROP INDEX IF EXISTS idx_connector_detail_gaps_pending;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_connector_detail_gaps_identity
  ON connector_detail_gaps(connector_instance_id, ifnull(grant_id, ''), stream, ifnull(parent_stream, ''), CASE WHEN nullif(record_key, '') IS NOT NULL THEN 'key:' || record_key ELSE 'loc:' || ifnull(detail_locator_json, '') END);
CREATE INDEX IF NOT EXISTS idx_connector_detail_gaps_pending
  ON connector_detail_gaps(connector_instance_id, grant_id, status, stream, next_attempt_after);
`);
}

function migrateSchedulerInstanceColumns(raw: SqliteDatabase) {
  // This entire migration operates on the legacy scheduler_run_history
  // table name (drop/recreate by that name, below) and predates the
  // run_history generalization. A DB that never had scheduler_run_history
  // at all — every fresh install, since SCHEMA now creates run_history
  // directly — has nothing for this function to do; run_history's own
  // connector_instance_id/schedule/active-run instance columns are already
  // correct in that case (SCHEMA declares them NOT NULL from the start).
  const legacyHistoryTableExists = raw
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scheduler_run_history'")
    .get();
  if (!legacyHistoryTableExists) {
    return;
  }

  const schedulesHaveInstance = hasTableColumn(raw, "connector_schedules", "connector_instance_id");
  const activeRunsHaveInstance = hasTableColumn(raw, "controller_active_runs", "connector_instance_id");
  const historyHaveInstance = hasTableColumn(raw, "scheduler_run_history", "connector_instance_id");
  const lastRunHaveInstance = hasTableColumn(raw, "scheduler_last_run_times", "connector_instance_id");
  if (schedulesHaveInstance && activeRunsHaveInstance && historyHaveInstance && lastRunHaveInstance) {
    return;
  }

  raw.transaction(() => {
    const schedules = raw
      .prepare(
        `SELECT ${schedulesHaveInstance ? "connector_instance_id," : ""} connector_id, interval_seconds, jitter_seconds, enabled, created_at, updated_at FROM connector_schedules ORDER BY connector_id`
      )
      .all<ScheduleRow>();
    const activeRuns = raw
      .prepare(
        `SELECT ${activeRunsHaveInstance ? "connector_instance_id," : ""} connector_id, run_id, trace_id, scenario_id, started_at FROM controller_active_runs ORDER BY connector_id`
      )
      .all<ActiveRunRow>();
    const history = raw
      .prepare(
        `SELECT id, ${historyHaveInstance ? "connector_instance_id," : ""} connector_id, source_json, status, records_emitted, reported_records_emitted, checkpoint_summary_json, known_gaps_json, connector_error_json, run_id, trace_id, failure_reason, terminal_reason, started_at, completed_at, error, attempt FROM scheduler_run_history ORDER BY id`
      )
      .all<SchedulerHistoryRow>();
    const lastRuns = raw
      .prepare(
        `SELECT ${lastRunHaveInstance ? "connector_instance_id," : ""} connector_id, last_run_time_ms, updated_at FROM scheduler_last_run_times ORDER BY connector_id`
      )
      .all<LastRunRow>();
    const instanceIds = new Map<string, string>();
    const resolveInstanceId = (row: ConnectorScopedRow): string => {
      if (typeof row.connector_instance_id === "string" && row.connector_instance_id.trim()) {
        return row.connector_instance_id.trim();
      }
      if (!instanceIds.has(row.connector_id)) {
        instanceIds.set(row.connector_id, defaultConnectorInstanceIdForBackfill(raw, row.connector_id));
      }
      return getMappedValue(instanceIds, row.connector_id);
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

    const insertSchedule = raw.prepare(
      "INSERT INTO connector_schedules(connector_instance_id, connector_id, interval_seconds, jitter_seconds, enabled, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)"
    );
    for (const row of schedules) {
      insertSchedule.run(
        resolveInstanceId(row),
        row.connector_id,
        row.interval_seconds,
        row.jitter_seconds,
        row.enabled,
        row.created_at,
        row.updated_at
      );
    }
    const insertActiveRun = raw.prepare(
      "INSERT INTO controller_active_runs(connector_instance_id, connector_id, run_id, trace_id, scenario_id, started_at) VALUES(?, ?, ?, ?, ?, ?)"
    );
    for (const row of activeRuns) {
      insertActiveRun.run(
        resolveInstanceId(row),
        row.connector_id,
        row.run_id,
        row.trace_id,
        row.scenario_id,
        row.started_at
      );
    }
    const insertHistory = raw.prepare(
      "INSERT INTO scheduler_run_history(id, connector_instance_id, connector_id, source_json, status, records_emitted, reported_records_emitted, checkpoint_summary_json, known_gaps_json, connector_error_json, run_id, trace_id, failure_reason, terminal_reason, started_at, completed_at, error, attempt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const row of history) {
      insertHistory.run(
        row.id,
        resolveInstanceId(row),
        row.connector_id,
        row.source_json,
        row.status,
        row.records_emitted,
        row.reported_records_emitted,
        row.checkpoint_summary_json,
        row.known_gaps_json,
        row.connector_error_json,
        row.run_id,
        row.trace_id,
        row.failure_reason,
        row.terminal_reason,
        row.started_at,
        row.completed_at,
        row.error,
        row.attempt
      );
    }
    const insertLastRun = raw.prepare(
      "INSERT INTO scheduler_last_run_times(connector_instance_id, connector_id, last_run_time_ms, updated_at) VALUES(?, ?, ?, ?)"
    );
    for (const row of lastRuns) {
      insertLastRun.run(resolveInstanceId(row), row.connector_id, row.last_run_time_ms, row.updated_at);
    }
  })();

  raw.exec(`
DROP INDEX IF EXISTS idx_scheduler_run_history_connector_completed;
CREATE INDEX IF NOT EXISTS idx_controller_active_runs_run_id ON controller_active_runs(run_id);
CREATE INDEX IF NOT EXISTS idx_scheduler_run_history_connector_completed ON scheduler_run_history(connector_instance_id, completed_at, id);
`);
}

// Widen `connector_maintenance_cursor.name`'s CHECK to admit the
// `run_history_backfill` cursor row alongside the existing
// `connector_summary_evidence` one. SQLite has no ALTER-CHECK; rebuild the
// table (it holds at most one scheduling row per stage, never owner data)
// and copy through unchanged. No-op once the CHECK already admits both
// names.
function migrateConnectorMaintenanceCursorNameCheck(raw: SqliteDatabase): void {
  const table = raw
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'connector_maintenance_cursor'`)
    .get<SqliteMasterRow>();
  if (!table?.sql || table.sql.includes("run_history_backfill")) {
    return;
  }

  raw.transaction(() => {
    raw.exec(`
      ALTER TABLE connector_maintenance_cursor RENAME TO connector_maintenance_cursor_old_name_check;

      CREATE TABLE connector_maintenance_cursor (
        name                         TEXT PRIMARY KEY CHECK(name IN ('connector_summary_evidence', 'run_history_backfill')),
        resume_after_id              TEXT,
        updated_at                   TEXT NOT NULL,
        generation                   INTEGER NOT NULL DEFAULT 0,
        lease_token                  TEXT,
        lease_expires_at             TEXT
      );

      INSERT INTO connector_maintenance_cursor(
        name, resume_after_id, updated_at, generation, lease_token, lease_expires_at
      )
      SELECT name, resume_after_id, updated_at, generation, lease_token, lease_expires_at
      FROM connector_maintenance_cursor_old_name_check;

      DROP TABLE connector_maintenance_cursor_old_name_check;
    `);
  })();
}

// Rename `scheduler_run_history` -> `run_history` and add the columns the
// generalized run-grain writer needs (`trigger_kind`, `facts_json`,
// nullable `completed_at`/`run_id`/`attempt` default). A pure rename plus
// `ADD COLUMN` is safe and lossless — no row data changes shape. Guarded
// so it is a no-op once the legacy table no longer exists (fresh installs
// get `run_history` directly from SCHEMA; a DB already migrated has
// nothing left under the old name).
//
// The legacy-table check MUST come first, ahead of any `run_history`
// existence check: SCHEMA's own `CREATE TABLE IF NOT EXISTS run_history`
// always runs earlier in `initDb` (it is one monolithic exec'd string),
// so on a DB that still has `scheduler_run_history`, SCHEMA will have
// already created a second, EMPTY `run_history` table by the time this
// function runs. If this function bailed out on `run_history` existing,
// the real data would be stranded under the old name forever. Instead,
// drop that empty placeholder (verified empty first — see below) and
// proceed with the rename.
// SECOND LIVE CANARY REVISE (2026-07-30): an interrupted migration attempt
// can leave a database with BOTH scheduler_run_history (still receiving
// live scheduler writes from a rolled-back-to older revision that has no
// idea run_history/the rename ever existed) AND a non-empty run_history
// (frozen at whatever the interrupted candidate's brief live window
// produced). Genuine, provable, lossless-mergeable state, not an anomaly
// to refuse — see the Postgres twin
// (reconcilePostgresLegacySchedulerRunHistory, server/postgres-storage.ts)
// for the full incident/design rationale; this is its SQLite mirror.
// scheduler_run_history's own numeric `id` values are NEVER reused (they
// collide with run_history's own id sequence on a real interrupted
// migration — confirmed live).
//
// Crash/idempotency: raw.transaction() wraps the caller's entire
// migrateRunHistoryRename body (this function included) — SQLite commits
// or rolls back the whole thing atomically, so table existence itself is
// the only idempotency marker needed, exactly as on Postgres.
function reconcileLegacySchedulerRunHistory(raw: SqliteDatabase): void {
  const rhNullCountBefore = (
    raw.prepare("SELECT COUNT(*) AS n FROM run_history WHERE run_id IS NULL").get() as { n: number }
  ).n;

  // Composite-identity rows (run_id IS NOT NULL): reuse the exact upsert
  // contract insert-run-history.sql already defines for this conflict
  // shape. FOURTH-PASS GATE FIX (2026-07-30): pre-deduplicate the source
  // by (run_id, connector_instance_id), keeping only the highest `id`
  // (the latest write) per pair — the same "scheduler's newer write wins"
  // semantics this merge already establishes for the cross-table overlap
  // case, extended to a duplicate composite key WITHIN scheduler_run_history
  // itself (structurally reachable: the pre-generalization scheduler
  // writer does a plain INSERT with no ON CONFLICT clause at all, so a
  // retried/duplicate scheduled-run completion can produce this shape).
  // SQLite's own INSERT ... SELECT ... ON CONFLICT DO UPDATE does not
  // throw on duplicate source rows the way Postgres does (verified: it
  // applies them in source order, last one wins) — this dedup is added
  // here anyway for defense-in-depth and cross-backend consistency,
  // rather than relying on that undocumented, backend-specific tolerance.
  raw.exec(`
INSERT INTO run_history(
  connector_instance_id, connector_id, source_json, status, records_emitted,
  reported_records_emitted, checkpoint_summary_json, known_gaps_json,
  connector_error_json, run_id, trace_id, failure_reason, terminal_reason,
  started_at, completed_at, error, attempt, scheduler_managed
)
SELECT
  connector_instance_id, connector_id, source_json, status, records_emitted,
  reported_records_emitted, checkpoint_summary_json, known_gaps_json,
  connector_error_json, run_id, trace_id, failure_reason, terminal_reason,
  started_at, completed_at, error, attempt, 1
FROM (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY run_id, connector_instance_id ORDER BY id DESC
  ) AS rn
  FROM scheduler_run_history
  WHERE run_id IS NOT NULL
) deduped
WHERE rn = 1
ORDER BY id ASC
ON CONFLICT(run_id, connector_instance_id) WHERE run_id IS NOT NULL DO UPDATE SET
  source_json = excluded.source_json,
  status = excluded.status,
  records_emitted = excluded.records_emitted,
  reported_records_emitted = excluded.reported_records_emitted,
  checkpoint_summary_json = excluded.checkpoint_summary_json,
  known_gaps_json = excluded.known_gaps_json,
  connector_error_json = excluded.connector_error_json,
  trace_id = excluded.trace_id,
  failure_reason = excluded.failure_reason,
  terminal_reason = excluded.terminal_reason,
  completed_at = excluded.completed_at,
  error = excluded.error,
  attempt = excluded.attempt,
  scheduler_managed = 1;
`);

  // run_id IS NULL rows always insert as new rows (never conflict under a
  // WHERE run_id IS NOT NULL partial unique index) — exactly once, since
  // this whole function only ever runs inside the caller's single
  // all-or-nothing transaction.
  raw.exec(`
INSERT INTO run_history(
  connector_instance_id, connector_id, source_json, status, records_emitted,
  reported_records_emitted, checkpoint_summary_json, known_gaps_json,
  connector_error_json, run_id, trace_id, failure_reason, terminal_reason,
  started_at, completed_at, error, attempt, scheduler_managed
)
SELECT
  connector_instance_id, connector_id, source_json, status, records_emitted,
  reported_records_emitted, checkpoint_summary_json, known_gaps_json,
  connector_error_json, run_id, trace_id, failure_reason, terminal_reason,
  started_at, completed_at, error, attempt, 1
FROM scheduler_run_history
WHERE run_id IS NULL
ORDER BY id ASC;
`);

  // Verify the invariant before the caller is permitted to drop
  // scheduler_run_history — see the Postgres twin's identical comment for
  // the full reasoning (composite-identity existence check for run_id IS
  // NOT NULL rows; before/after NULL-count delta for run_id IS NULL rows).
  const unreconciledNamed = raw
    .prepare(
      `SELECT COUNT(*) AS n
       FROM scheduler_run_history srh
       WHERE srh.run_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM run_history rh
           WHERE rh.run_id = srh.run_id AND rh.connector_instance_id = srh.connector_instance_id
         )`
    )
    .get() as { n: number };
  if (unreconciledNamed.n > 0) {
    throw new Error(
      `reconcileLegacySchedulerRunHistory: ${unreconciledNamed.n} scheduler_run_history row(s) with a run_id could not be verified present in run_history after the merge — refusing to drop scheduler_run_history with unreconciled data. This should never happen (the merge INSERT above covers every run_id IS NOT NULL row); investigate before retrying.`
    );
  }

  const rhNullCountAfter = (
    raw.prepare("SELECT COUNT(*) AS n FROM run_history WHERE run_id IS NULL").get() as { n: number }
  ).n;
  const srhNullCount = (
    raw.prepare("SELECT COUNT(*) AS n FROM scheduler_run_history WHERE run_id IS NULL").get() as { n: number }
  ).n;
  const nullRowsAddedByThisMerge = rhNullCountAfter - rhNullCountBefore;
  if (nullRowsAddedByThisMerge !== srhNullCount) {
    throw new Error(
      `reconcileLegacySchedulerRunHistory: this merge added ${nullRowsAddedByThisMerge} run_id-IS-NULL row(s) to run_history but scheduler_run_history has ${srhNullCount} — refusing to drop scheduler_run_history with unreconciled data. This should never happen (the merge INSERT above is unconditional and unfiltered); investigate before retrying.`
    );
  }
}

function migrateRunHistoryRename(raw: SqliteDatabase): void {
  const legacyExists = raw
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scheduler_run_history'")
    .get();
  if (!legacyExists) {
    return;
  }

  raw.transaction(() => {
    const staleEmptyRunHistory = raw
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'run_history'")
      .get();
    if (staleEmptyRunHistory) {
      const rowCount = raw.prepare("SELECT COUNT(*) AS n FROM run_history").get() as { n: number };
      if (rowCount.n > 0) {
        // Interrupted-migration state: both tables carry real data.
        // Reconcile losslessly rather than refuse — see
        // reconcileLegacySchedulerRunHistory's own header. run_history
        // already carries the full current column set (it exists and is
        // non-empty, so its own CREATE TABLE IF NOT EXISTS or an earlier
        // completed rename already established it) — only the merge and
        // the legacy DROP are needed here.
        reconcileLegacySchedulerRunHistory(raw);
        raw.exec("DROP TABLE scheduler_run_history;");
        return;
      }
      raw.exec("DROP TABLE run_history;");
    }
    raw.exec("ALTER TABLE scheduler_run_history RENAME TO run_history;");
    addColumnIfMissing(raw, "run_history", "trigger_kind", "TEXT");
    addColumnIfMissing(raw, "run_history", "facts_json", "TEXT");
    // Every pre-existing row was written exclusively by the scheduler's own
    // appendRunHistory (the generalized writer did not exist yet) — mark
    // them scheduler_managed=1 so cadence/backoff readers keep seeing
    // exactly the rows they saw before this migration.
    addColumnIfMissing(raw, "run_history", "scheduler_managed", "INTEGER NOT NULL DEFAULT 1");

    // completed_at nullability is repaired separately by
    // migrateRunHistoryCompletedAtNullable, called unconditionally (not
    // gated on legacyExists) right after this function — see that
    // function's own header for why the repair cannot live inside this
    // legacy-table-gated branch.
    raw.exec(`
DROP INDEX IF EXISTS idx_scheduler_run_history_connector_completed;
CREATE INDEX IF NOT EXISTS idx_run_history_connector_completed
  ON run_history(connector_id, completed_at, id);
`);
  })();

  // Separate, non-transactional step, mirroring the original migration's
  // shape. run_id alone is NOT globally unique — two different
  // connections can legitimately share a run_id (confirmed live; see
  // openspec/changes/run-history-backfill-list-cutover) — so the real
  // identity, and the only key this index can be built on without
  // colliding on legitimate historical data, is (run_id,
  // connector_instance_id). Unlike the bare-run_id index this replaces,
  // this one is NOT wrapped in a swallow-and-log try/catch: a duplicate
  // (run_id, connector_instance_id) pair would mean a genuine data
  // anomaly (the same connection's same run recorded twice under
  // different rows), which must fail the migration loudly rather than
  // leave the writer's ON CONFLICT target unindexed and silently
  // degraded.
  raw.exec(`
DROP INDEX IF EXISTS uniq_run_history_run_id;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_run_history_run_id_instance
  ON run_history(run_id, connector_instance_id) WHERE run_id IS NOT NULL;
`);
}

// REVISE fix (fleet-migration gap, 2026-07-30 second gate pass): the
// completed_at nullable repair e44bf3391 added lived INSIDE
// migrateRunHistoryRename's `legacyExists`-gated branch, which returns
// immediately once `scheduler_run_history` no longer exists. A database
// whose scheduler_run_history -> run_history rename already executed
// under an EARLIER deployment of this migration (i.e. before e44bf3391
// shipped the completed_at fix) is permanently stuck on the legacy NOT
// NULL constraint: the repair's own guard (`legacyExists`) is false by
// the time that fix ships, so the repair never reaches it, and every
// run.started write throws forever on that database. This is a distinct,
// unconditional repair: it runs whenever `run_history` exists and its
// completed_at column is still NOT NULL, independent of whether
// scheduler_run_history exists. SQLite has no ALTER COLUMN; rebuild the
// table with the fresh-install (nullable-completed_at) column defs, copy
// every row by explicit column list (preserving `id` exactly — callers
// order by it as a tie-breaker), drop the old table, rename the rebuild
// into place. Idempotent (a second run finds completed_at already
// nullable and no-ops); a no-op on fresh installs (run_history is
// created nullable from the start).
function migrateRunHistoryCompletedAtNullable(raw: SqliteDatabase): void {
  const runHistoryExists = raw
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'run_history'")
    .get();
  if (!runHistoryExists) {
    return;
  }
  const completedAtColumn = raw
    .prepare("SELECT \"notnull\" FROM pragma_table_info('run_history') WHERE name = 'completed_at'")
    .get() as { notnull: number } | undefined;
  if (!completedAtColumn?.notnull) {
    return;
  }
  raw.transaction(() => {
    raw.exec(`
CREATE TABLE run_history_new (
  id                         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                     TEXT,
  connector_instance_id      TEXT NOT NULL,
  connector_id               TEXT NOT NULL,
  trigger_kind               TEXT,
  source_json                TEXT NOT NULL,
  status                     TEXT NOT NULL,
  records_emitted            INTEGER NOT NULL DEFAULT 0,
  reported_records_emitted   INTEGER,
  checkpoint_summary_json    TEXT,
  known_gaps_json            TEXT NOT NULL DEFAULT '[]',
  connector_error_json       TEXT,
  trace_id                   TEXT,
  failure_reason             TEXT,
  terminal_reason            TEXT,
  started_at                 TEXT NOT NULL,
  completed_at               TEXT,
  error                      TEXT,
  attempt                    INTEGER NOT NULL DEFAULT 1,
  facts_json                 TEXT,
  scheduler_managed          INTEGER NOT NULL DEFAULT 0
);
INSERT INTO run_history_new (
  id, run_id, connector_instance_id, connector_id, trigger_kind, source_json, status,
  records_emitted, reported_records_emitted, checkpoint_summary_json, known_gaps_json,
  connector_error_json, trace_id, failure_reason, terminal_reason, started_at,
  completed_at, error, attempt, facts_json, scheduler_managed
)
SELECT
  id, run_id, connector_instance_id, connector_id, trigger_kind, source_json, status,
  records_emitted, reported_records_emitted, checkpoint_summary_json, known_gaps_json,
  connector_error_json, trace_id, failure_reason, terminal_reason, started_at,
  completed_at, error, attempt, facts_json, scheduler_managed
FROM run_history;
DROP TABLE run_history;
ALTER TABLE run_history_new RENAME TO run_history;
`);
    // The rebuild drops every index the source table carried (SQLite does
    // not preserve indexes across a table rename-in-place substitution
    // here since run_history_new never had them) — recreate both indexes
    // this table is known to carry so a repair on an already-migrated
    // database does not silently lose them. The unique index is
    // (run_id, connector_instance_id), not run_id alone — run_id is NOT
    // globally unique (see migrateRunHistoryRename above and
    // openspec/changes/run-history-backfill-list-cutover) — and, unlike
    // the bare-run_id index this replaces, is NOT wrapped in a
    // swallow-and-log try/catch: a duplicate (run_id,
    // connector_instance_id) pair is a genuine data anomaly that must
    // fail this migration loudly.
    raw.exec(`
CREATE INDEX IF NOT EXISTS idx_run_history_connector_completed
  ON run_history(connector_id, completed_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_run_history_run_id_instance
  ON run_history(run_id, connector_instance_id) WHERE run_id IS NOT NULL;
`);
  })();
}

// Reference tables that hold a direct `connector_instance_id` reference.
// Used by `migrateLegacyConnectorInstancesToDefaultAccount` to rewrite ids
// atomically when a legacy compatibility row is migrated to a deterministic
// default-account connection id.
const LEGACY_REWRITE_INSTANCE_REFERENCE_TABLES = [
  "connector_state",
  "grant_connector_state",
  "records",
  "record_changes",
  "version_counter",
  "blobs",
  "blob_bindings",
  "lexical_search_index",
  "lexical_search_meta",
  "semantic_search_rowid",
  "semantic_search_blob",
  "semantic_search_meta",
  "semantic_search_backfill_progress",
  "connector_detail_gaps",
  "connector_summary_evidence",
  "manifest_write_violations",
  "connector_attention_records",
  "connector_schedules",
  "controller_active_runs",
  "scheduler_run_history",
  "scheduler_last_run_times",
  "device_source_instances",
];

interface LegacyConnectorMigrationContext {
  defaultBindingJson: string;
  deleteRow: SqliteStatement;
  existingTables: readonly string[];
  getDestination: SqliteStatement;
  raw: SqliteDatabase;
  renameDestination: SqliteStatement;
  updateDestination: SqliteStatement;
}

function rewriteLegacyTableReferences(raw: SqliteDatabase, table: string, oldId: string, destId: string): number {
  const conflictColumns = uniqueColumnsForTable(table);
  if (conflictColumns === null) {
    return raw
      .prepare(`UPDATE ${table} SET connector_instance_id = ? WHERE connector_instance_id = ?`)
      .run(destId, oldId).changes;
  }

  if (conflictColumns.length === 0) {
    const both = raw
      .prepare(
        `SELECT
         (SELECT 1 FROM ${table} WHERE connector_instance_id = ? LIMIT 1) AS legacy_present,
         (SELECT 1 FROM ${table} WHERE connector_instance_id = ? LIMIT 1) AS dest_present`
      )
      .get(oldId, destId);
    if (both?.legacy_present && both?.dest_present) {
      throw new Error(
        `Cannot migrate legacy connector_instance ${oldId} → ${destId}: both ids hold a row in ${table} keyed solely on connector_instance_id; manual reconciliation required.`
      );
    }
    if (both?.legacy_present) {
      return raw
        .prepare(`UPDATE ${table} SET connector_instance_id = ? WHERE connector_instance_id = ?`)
        .run(destId, oldId).changes;
    }
    return 0;
  }

  const keys = raw
    .prepare(`SELECT ${conflictColumns.join(", ")} FROM ${table} WHERE connector_instance_id = ?`)
    .all(oldId);
  for (const key of keys) {
    const values = conflictColumns.map((column) => key[column]);
    const conflictValues = values.flatMap((value) => [value, value]);
    const conflict = raw
      .prepare(
        `SELECT 1 FROM ${table}
        WHERE connector_instance_id = ?
          AND ${nullSafeSqliteWhere(conflictColumns)}
        LIMIT 1`
      )
      .get(destId, ...conflictValues);
    if (conflict) {
      throw new Error(
        `Cannot migrate legacy connector_instance ${oldId} → ${destId}: ${table} has a colliding row on (${conflictColumns.join(", ")}) = (${values.join(", ")}); manual reconciliation required.`
      );
    }
  }
  return raw.prepare(`UPDATE ${table} SET connector_instance_id = ? WHERE connector_instance_id = ?`).run(destId, oldId)
    .changes;
}

function rewriteLegacyConnectorReferences(
  raw: SqliteDatabase,
  existingTables: readonly string[],
  oldId: string,
  destId: string
): number {
  let rewrittenRows = 0;
  for (const table of existingTables) {
    rewrittenRows += rewriteLegacyTableReferences(raw, table, oldId, destId);
  }
  return rewrittenRows;
}

function rewriteLegacyConnectorReferencesAfterRename(
  raw: SqliteDatabase,
  existingTables: readonly string[],
  oldId: string,
  newId: string
): number {
  let rewrittenRows = 0;
  for (const table of existingTables) {
    rewrittenRows += raw
      .prepare(`UPDATE ${table} SET connector_instance_id = ? WHERE connector_instance_id = ?`)
      .run(newId, oldId).changes;
  }
  return rewrittenRows;
}

function rewriteLegacyConnectorInstance(
  context: LegacyConnectorMigrationContext,
  legacy: LegacyInstanceRow
): { rewrittenInstanceCount: number; rewrittenRows: number } {
  const oldId = legacy.connector_instance_id;
  const newId = makeDefaultAccountConnectorInstanceId(legacy.owner_subject_id, legacy.connector_id);
  const now = new Date().toISOString();
  const destination = context.getDestination.get<AccountDestinationRow>(legacy.owner_subject_id, legacy.connector_id);

  if (destination && destination.connector_instance_id === oldId) {
    context.updateDestination.run(context.defaultBindingJson, now, oldId);
    return { rewrittenInstanceCount: 1, rewrittenRows: 0 };
  }

  if (!destination) {
    if (oldId === newId) {
      context.updateDestination.run(context.defaultBindingJson, now, oldId);
      return { rewrittenInstanceCount: 1, rewrittenRows: 0 };
    }
    const conflict = context.raw
      .prepare("SELECT 1 FROM connector_instances WHERE connector_instance_id = ? LIMIT 1")
      .get(newId);
    if (conflict) {
      throw new Error(
        `Cannot migrate legacy connector_instance ${oldId} → ${newId}: destination id already exists for a non-default-account row.`
      );
    }
    context.renameDestination.run(newId, context.defaultBindingJson, now, oldId);
    return {
      rewrittenInstanceCount: 1,
      rewrittenRows: rewriteLegacyConnectorReferencesAfterRename(context.raw, context.existingTables, oldId, newId),
    };
  }

  const rewrittenRows = rewriteLegacyConnectorReferences(
    context.raw,
    context.existingTables,
    oldId,
    destination.connector_instance_id
  );
  context.deleteRow.run(oldId);
  return { rewrittenInstanceCount: 1, rewrittenRows };
}

function migrateLegacyConnectorInstancesToDefaultAccount(raw: SqliteDatabase, opts: MigrationOptions = {}) {
  if (!hasTableColumn(raw, "connector_instances", "source_kind")) {
    return { rewrittenInstanceCount: 0, rewrittenRows: 0 };
  }

  const legacyRows = raw
    .prepare(
      `SELECT connector_instance_id, owner_subject_id, connector_id, display_name, status, created_at, updated_at, revoked_at
       FROM connector_instances
      WHERE source_kind = 'legacy'
      ORDER BY connector_instance_id`
    )
    .all<LegacyInstanceRow>();
  if (legacyRows.length === 0) {
    return { rewrittenInstanceCount: 0, rewrittenRows: 0 };
  }

  const existingTables = LEGACY_REWRITE_INSTANCE_REFERENCE_TABLES.filter((table) =>
    hasTableColumn(raw, table, "connector_instance_id")
  );

  const migration = raw.transaction(() => {
    const getDestination = raw.prepare(
      `SELECT connector_instance_id, status, source_kind, source_binding_key
         FROM connector_instances
        WHERE owner_subject_id = ? AND connector_id = ? AND source_kind = 'account' AND source_binding_key = 'default'
        LIMIT 1`
    );
    const renameDestination = raw.prepare(
      `UPDATE connector_instances
          SET connector_instance_id = ?,
              source_kind = 'account',
              source_binding_key = 'default',
              source_binding_json = ?,
              updated_at = ?
        WHERE connector_instance_id = ?`
    );
    const updateDestination = raw.prepare(
      `UPDATE connector_instances
          SET source_kind = 'account',
              source_binding_key = 'default',
              source_binding_json = ?,
              updated_at = ?
        WHERE connector_instance_id = ?`
    );
    const deleteRow = raw.prepare("DELETE FROM connector_instances WHERE connector_instance_id = ?");

    const defaultBindingJson = stableJson({ kind: "default_account" });
    const context: LegacyConnectorMigrationContext = {
      defaultBindingJson,
      deleteRow,
      existingTables,
      getDestination,
      raw,
      renameDestination,
      updateDestination,
    };
    let rewrittenRows = 0;
    let rewrittenInstanceCount = 0;
    for (const legacy of legacyRows) {
      const result = rewriteLegacyConnectorInstance(context, legacy);
      rewrittenRows += result.rewrittenRows;
      rewrittenInstanceCount += result.rewrittenInstanceCount;
    }

    return { rewrittenInstanceCount, rewrittenRows };
  });

  const result = migration();
  if (typeof opts.onSchemaMigration === "function") {
    opts.onSchemaMigration({
      backfilledRows: result.rewrittenRows,
      name: "legacy_connector_instances_to_default_account",
      rebuilt: false,
      rewrittenInstanceCount: result.rewrittenInstanceCount,
    });
  }
  return result;
}

function uniqueColumnsForTable(table: string): string[] | null {
  switch (table) {
    case "connector_state":
      return ["stream"];
    case "grant_connector_state":
      return ["grant_id", "stream"];
    case "records":
      return ["stream", "record_key"];
    case "record_changes":
      return ["stream", "version"];
    case "version_counter":
      return ["stream"];
    case "blob_bindings":
      return ["blob_id", "stream", "record_key", "json_path"];
    case "lexical_search_index":
      return ["stream", "record_key", "field"];
    case "lexical_search_meta":
      return ["stream"];
    case "connector_detail_gaps":
      return ["grant_id", "stream", "parent_stream", "record_key", "detail_locator_json"];
    case "connector_summary_evidence":
      return [];
    case "manifest_write_violations":
      return ["stream", "manifest_generation"];
    case "semantic_search_meta":
      return ["stream"];
    case "semantic_search_backfill_progress":
      return ["stream"];
    case "semantic_search_rowid":
      return ["scope_key", "record_key"];
    case "semantic_search_blob":
      return ["scope_key", "record_key"];
    case "connector_schedules":
      return [];
    case "controller_active_runs":
      return [];
    case "scheduler_last_run_times":
      return [];
    default:
      return null;
  }
}

function nullSafeSqliteWhere(columns: readonly string[]): string {
  return columns.map((column) => `(${column} = ? OR (${column} IS NULL AND ? IS NULL))`).join(" AND ");
}

function migrateConnectorInstancesSourceKindCheck(raw: SqliteDatabase, opts: MigrationOptions = {}) {
  const table = raw
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'connector_instances'`)
    .get<SqliteMasterRow>();
  if (!table?.sql?.includes("'legacy'")) {
    return { backfilledRows: 0, rebuilt: false };
  }

  const remaining = raw
    .prepare(`SELECT COUNT(*) AS count FROM connector_instances WHERE source_kind = 'legacy'`)
    .get<SqliteCountRow>();
  if (Number(remaining?.count ?? 0) > 0) {
    throw new Error(
      `Cannot tighten connector_instances.source_kind CHECK: ${remaining?.count ?? 0} legacy connector instance rows remain.`
    );
  }

  const migration = raw.transaction(() => {
    raw.exec(`
      ALTER TABLE connector_instances RENAME TO connector_instances_old_source_kind;
      DROP INDEX IF EXISTS idx_connector_instances_owner_connector_status;

      CREATE TABLE connector_instances (
        connector_instance_id TEXT PRIMARY KEY,
        owner_subject_id      TEXT NOT NULL,
        connector_id          TEXT NOT NULL,
        display_name          TEXT NOT NULL,
        status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked')),
        source_kind           TEXT NOT NULL CHECK (source_kind IN ('account', 'local_device', 'browser_collector', 'manual')),
        source_binding_key    TEXT NOT NULL,
        source_binding_json   TEXT NOT NULL DEFAULT '{}',
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL,
        revoked_at            TEXT,
        UNIQUE(owner_subject_id, connector_id, source_kind, source_binding_key),
        FOREIGN KEY(connector_id) REFERENCES connectors(connector_id) ON DELETE RESTRICT
      );

      INSERT INTO connector_instances(
        connector_instance_id,
        owner_subject_id,
        connector_id,
        display_name,
        status,
        source_kind,
        source_binding_key,
        source_binding_json,
        created_at,
        updated_at,
        revoked_at
      )
      SELECT
        connector_instance_id,
        owner_subject_id,
        connector_id,
        display_name,
        status,
        source_kind,
        source_binding_key,
        source_binding_json,
        created_at,
        updated_at,
        revoked_at
      FROM connector_instances_old_source_kind;

      DROP TABLE connector_instances_old_source_kind;
      CREATE INDEX IF NOT EXISTS idx_connector_instances_owner_connector_status
        ON connector_instances(owner_subject_id, connector_id, status);
    `);
    return {
      backfilledRows: 0,
      rebuilt: true,
    };
  });

  const result = migration();
  if (typeof opts.onSchemaMigration === "function") {
    opts.onSchemaMigration({ name: "connector_instances_source_kind_check", ...result });
  }
  return result;
}

// Widen the connector_instances.source_kind CHECK to admit `browser_collector`
// alongside the existing account/local_device/manual kinds. A database created
// before the browser-collector enrollment primitive carries the narrower CHECK;
// rebuild the table so a `browser_collector` enrollment can persist. No-op once
// the constraint already names `browser_collector`. See
// add-browser-collector-enrollment-primitive design Decision 1/2.
function migrateConnectorInstancesSourceKindBrowserCollector(raw: SqliteDatabase, opts: MigrationOptions = {}) {
  const table = raw
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'connector_instances'`)
    .get<SqliteMasterRow>();
  if (!table?.sql || table.sql.includes("'browser_collector'")) {
    return { rebuilt: false };
  }

  const migration = raw.transaction(() => {
    raw.exec(`
      ALTER TABLE connector_instances RENAME TO connector_instances_old_browser_collector;
      DROP INDEX IF EXISTS idx_connector_instances_owner_connector_status;

      CREATE TABLE connector_instances (
        connector_instance_id TEXT PRIMARY KEY,
        owner_subject_id      TEXT NOT NULL,
        connector_id          TEXT NOT NULL,
        display_name          TEXT NOT NULL,
        status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked')),
        source_kind           TEXT NOT NULL CHECK (source_kind IN ('account', 'local_device', 'browser_collector', 'manual')),
        source_binding_key    TEXT NOT NULL,
        source_binding_json   TEXT NOT NULL DEFAULT '{}',
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL,
        revoked_at            TEXT,
        UNIQUE(owner_subject_id, connector_id, source_kind, source_binding_key),
        FOREIGN KEY(connector_id) REFERENCES connectors(connector_id) ON DELETE RESTRICT
      );

      INSERT INTO connector_instances(
        connector_instance_id,
        owner_subject_id,
        connector_id,
        display_name,
        status,
        source_kind,
        source_binding_key,
        source_binding_json,
        created_at,
        updated_at,
        revoked_at
      )
      SELECT
        connector_instance_id,
        owner_subject_id,
        connector_id,
        display_name,
        status,
        source_kind,
        source_binding_key,
        source_binding_json,
        created_at,
        updated_at,
        revoked_at
      FROM connector_instances_old_browser_collector;

      DROP TABLE connector_instances_old_browser_collector;
      CREATE INDEX IF NOT EXISTS idx_connector_instances_owner_connector_status
        ON connector_instances(owner_subject_id, connector_id, status);
    `);
    return { rebuilt: true };
  });

  const result = migration();
  if (typeof opts.onSchemaMigration === "function") {
    opts.onSchemaMigration({ name: "connector_instances_source_kind_browser_collector", ...result });
  }
  return result;
}

// Widen the connector_instances.status CHECK to admit `draft` alongside the
// existing active/paused/revoked statuses. A database created before the
// static-secret owner-session connect path carries the narrower CHECK; rebuild
// the table so a `draft` instance can persist. No-op once the constraint
// already names `draft`. See add-static-secret-owner-session-connect-path
// design Decision 1.
function migrateConnectorInstancesStatusDraft(raw: SqliteDatabase, opts: MigrationOptions = {}) {
  const table = raw
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'connector_instances'`)
    .get<SqliteMasterRow>();
  if (!table?.sql || table.sql.includes("'draft'")) {
    return { rebuilt: false };
  }

  const migration = raw.transaction(() => {
    raw.exec(`
      ALTER TABLE connector_instances RENAME TO connector_instances_old_status_draft;
      DROP INDEX IF EXISTS idx_connector_instances_owner_connector_status;

      CREATE TABLE connector_instances (
        connector_instance_id TEXT PRIMARY KEY,
        owner_subject_id      TEXT NOT NULL,
        connector_id          TEXT NOT NULL,
        display_name          TEXT NOT NULL,
        status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked', 'draft')),
        source_kind           TEXT NOT NULL CHECK (source_kind IN ('account', 'local_device', 'browser_collector', 'manual')),
        source_binding_key    TEXT NOT NULL,
        source_binding_json   TEXT NOT NULL DEFAULT '{}',
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL,
        revoked_at            TEXT,
        UNIQUE(owner_subject_id, connector_id, source_kind, source_binding_key),
        FOREIGN KEY(connector_id) REFERENCES connectors(connector_id) ON DELETE RESTRICT
      );

      INSERT INTO connector_instances(
        connector_instance_id,
        owner_subject_id,
        connector_id,
        display_name,
        status,
        source_kind,
        source_binding_key,
        source_binding_json,
        created_at,
        updated_at,
        revoked_at
      )
      SELECT
        connector_instance_id,
        owner_subject_id,
        connector_id,
        display_name,
        status,
        source_kind,
        source_binding_key,
        source_binding_json,
        created_at,
        updated_at,
        revoked_at
      FROM connector_instances_old_status_draft;

      DROP TABLE connector_instances_old_status_draft;
      CREATE INDEX IF NOT EXISTS idx_connector_instances_owner_connector_status
        ON connector_instances(owner_subject_id, connector_id, status);
    `);
    return { rebuilt: true };
  });

  const result = migration();
  if (typeof opts.onSchemaMigration === "function") {
    opts.onSchemaMigration({ name: "connector_instances_status_draft", ...result });
  }
  return result;
}

// Widen the connector_instance_credentials.credential_kind CHECK to admit the
// sealed multi-field bundle and username/password pair shapes needed to migrate
// every static-secret connector off deployment-wide env vars. Existing rows are
// copied byte-for-byte; only the CHECK vocabulary changes.
function migrateConnectorCredentialKindCheck(raw: SqliteDatabase, opts: MigrationOptions = {}) {
  const table = raw
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'connector_instance_credentials'`)
    .get<SqliteMasterRow>();
  if (!table?.sql || (table.sql.includes("'secret_bundle'") && table.sql.includes("'username_password'"))) {
    return { rebuilt: false };
  }

  const migration = raw.transaction(() => {
    raw.exec(`
      ALTER TABLE connector_instance_credentials RENAME TO connector_instance_credentials_old_kind;
      DROP INDEX IF EXISTS idx_connector_instance_credentials_owner_status;

      CREATE TABLE connector_instance_credentials (
        connector_instance_id TEXT PRIMARY KEY,
        owner_subject_id      TEXT NOT NULL,
        credential_kind       TEXT NOT NULL CHECK (credential_kind IN ('app_password', 'personal_access_token', 'secret_bundle', 'username_password')),
        sealed_secret         TEXT NOT NULL,
        fingerprint           TEXT,
        status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'rejected')),
        captured_at           TEXT NOT NULL,
        rotated_at            TEXT,
        revoked_at            TEXT,
        rejected_at           TEXT,
        rejection_reason      TEXT,
        FOREIGN KEY(connector_instance_id) REFERENCES connector_instances(connector_instance_id) ON DELETE CASCADE
      );

      INSERT INTO connector_instance_credentials(
        connector_instance_id,
        owner_subject_id,
        credential_kind,
        sealed_secret,
        fingerprint,
        status,
        captured_at,
        rotated_at,
        revoked_at,
        rejected_at,
        rejection_reason
      )
      SELECT
        connector_instance_id,
        owner_subject_id,
        credential_kind,
        sealed_secret,
        fingerprint,
        status,
        captured_at,
        rotated_at,
        revoked_at,
        NULL,
        NULL
      FROM connector_instance_credentials_old_kind;

      DROP TABLE connector_instance_credentials_old_kind;
      CREATE INDEX IF NOT EXISTS idx_connector_instance_credentials_owner_status
        ON connector_instance_credentials(owner_subject_id, status);
    `);
    return { rebuilt: true };
  });

  const result = migration();
  if (typeof opts.onSchemaMigration === "function") {
    opts.onSchemaMigration({ name: "connector_credential_kind_check", ...result });
  }
  return result;
}

// Widen the connector_instance_credentials.status CHECK to preserve the
// provider-rejected lifecycle separately from owner revocation. The two
// rejected_* columns carry bounded non-secret repair evidence; sealed_secret is
// copied byte-for-byte.
function migrateConnectorCredentialStatusRejected(raw: SqliteDatabase, opts: MigrationOptions = {}) {
  const table = raw
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'connector_instance_credentials'`)
    .get<SqliteMasterRow>();
  if (!table?.sql) {
    return { rebuilt: false };
  }
  const columns = raw.prepare("PRAGMA table_info(connector_instance_credentials)").all<{ name: string }>();
  const columnNames = new Set(columns.map((column) => column.name));
  const hasRejectedStatus = table.sql.includes("'rejected'");
  const hasRejectedAt = columnNames.has("rejected_at");
  const hasRejectionReason = columnNames.has("rejection_reason");
  if (hasRejectedStatus && hasRejectedAt && hasRejectionReason) {
    return { rebuilt: false };
  }

  const rejectedAtSelect = hasRejectedAt ? "rejected_at" : "NULL";
  const rejectionReasonSelect = hasRejectionReason ? "rejection_reason" : "NULL";
  const migration = raw.transaction(() => {
    raw.exec(`
      ALTER TABLE connector_instance_credentials RENAME TO connector_instance_credentials_old_status_rejected;
      DROP INDEX IF EXISTS idx_connector_instance_credentials_owner_status;

      CREATE TABLE connector_instance_credentials (
        connector_instance_id TEXT PRIMARY KEY,
        owner_subject_id      TEXT NOT NULL,
        credential_kind       TEXT NOT NULL CHECK (credential_kind IN ('app_password', 'personal_access_token', 'secret_bundle', 'username_password')),
        sealed_secret         TEXT NOT NULL,
        fingerprint           TEXT,
        status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'rejected')),
        captured_at           TEXT NOT NULL,
        rotated_at            TEXT,
        revoked_at            TEXT,
        rejected_at           TEXT,
        rejection_reason      TEXT,
        FOREIGN KEY(connector_instance_id) REFERENCES connector_instances(connector_instance_id) ON DELETE CASCADE
      );

      INSERT INTO connector_instance_credentials(
        connector_instance_id,
        owner_subject_id,
        credential_kind,
        sealed_secret,
        fingerprint,
        status,
        captured_at,
        rotated_at,
        revoked_at,
        rejected_at,
        rejection_reason
      )
      SELECT
        connector_instance_id,
        owner_subject_id,
        credential_kind,
        sealed_secret,
        fingerprint,
        status,
        captured_at,
        rotated_at,
        revoked_at,
        ${rejectedAtSelect},
        ${rejectionReasonSelect}
      FROM connector_instance_credentials_old_status_rejected;

      DROP TABLE connector_instance_credentials_old_status_rejected;
      CREATE INDEX IF NOT EXISTS idx_connector_instance_credentials_owner_status
        ON connector_instance_credentials(owner_subject_id, status);
    `);
    return { rebuilt: true };
  });

  const result = migration();
  if (typeof opts.onSchemaMigration === "function") {
    opts.onSchemaMigration({ name: "connector_credential_status_rejected", ...result });
  }
  return result;
}

// Boot-safe spine source schema migration (SQLite). Installs the
// `source_kind`/`source_id` columns and their index and drops the superseded
// `provider_id` column. Bounded, idempotent DDL only — it does NOT scan or
// rewrite `spine_events` rows.
//
// The per-row value backfill that previously lived here ran a full
// `SELECT … FROM spine_events` plus per-row `UPDATE` inside one transaction on
// every boot, never converging (legitimately sourceless events stay NULL). It
// now lives in an explicit operator maintenance script
// (`scripts/backfill-spine-source/`). NULL legacy `source_*` columns are
// tolerable because unfiltered summaries derive source from canonical event
// payloads or runtime actor fallback. The prior `user_version = 1` stamp gated
// nothing (the migration ran every boot
// regardless) and is removed to avoid implying convergence. See
// openspec/changes/harden-startup-data-backfills.
function migrateSpineSourceColumns(raw: SqliteDatabase, opts: MigrationOptions = {}): { droppedProviderId: boolean } {
  if (!tableColumns(raw, "spine_events").length) {
    return { droppedProviderId: false };
  }

  const hadProviderId = hasTableColumn(raw, "spine_events", "provider_id");
  const migration = raw.transaction(() => {
    addColumnIfMissing(raw, "spine_events", "source_kind", "TEXT");
    addColumnIfMissing(raw, "spine_events", "source_id", "TEXT");

    if (hadProviderId) {
      raw.exec("ALTER TABLE spine_events DROP COLUMN provider_id");
    }
    raw.exec(
      `CREATE INDEX IF NOT EXISTS idx_spine_events_source
        ON spine_events(source_kind, source_id, occurred_at, recorded_at)`
    );
    raw.exec(
      `CREATE INDEX IF NOT EXISTS idx_spine_events_source_run_summary
        ON spine_events(source_kind, source_id, run_id, occurred_at DESC)
        WHERE run_id IS NOT NULL`
    );

    return { droppedProviderId: hadProviderId };
  });

  const result = migration();
  if (typeof opts.onSchemaMigration === "function") {
    opts.onSchemaMigration({ name: "spine_events_source_columns", ...result });
  }
  return result;
}

// Terminal event types the connector-summary fold reads
// (connector-summary-read-model.ts's TERMINAL_RUN_EVENT_TYPES) — kept in
// exact sync so the backfill below only ever touches rows the fold itself
// would read, and the partial index it shares
// (idx_spine_events_terminal_seq) actually serves this UPDATE's WHERE
// clause instead of forcing a full-table scan.
const SPINE_TERMINAL_EVENT_TYPES_SQL = "('run.completed', 'run.failed', 'run.browser_surface_failed', 'run.cancelled')";

/**
 * Bounded, idempotent, set-based backfill of `spine_events.connector_instance_id`
 * for pre-existing TERMINAL rows whose identity already lives in
 * `data_json` (Sol fourth-verdict P1.1). A single `UPDATE ... WHERE
 * connector_instance_id IS NULL AND event_type IN (terminal types)` using
 * SQLite's `json_extract` — never a per-row SELECT+UPDATE app loop (the
 * exact anti-pattern `migrateSpineSourceColumns` above deliberately
 * abandoned for the non-critical `source_kind`/`source_id` columns).
 * Restricting to terminal event types bounds the scan to the same subset
 * `idx_spine_events_terminal_seq` already indexes — not the whole table —
 * and matching only `connector_instance_id IS NULL` rows makes the
 * `UPDATE` match zero rows (a cheap idempotent no-op) on every boot after
 * the first successful run, unlike the previously-rejected pattern that
 * genuinely never converged.
 *
 * Precedence matches `readEventConnectionId` in
 * connector-summary-read-model.ts exactly: `data.connector_instance_id`
 * first (when it is a non-empty JSON string), then `data.connection_id`.
 * A row with neither (a legitimately unattributable legacy event) is left
 * NULL — the fold's existing "refused" counter already treats that as
 * intentional, not an error.
 */
function migrateSpineEventsConnectorInstanceIdBackfill(
  raw: SqliteDatabase,
  opts: MigrationOptions = {}
): { backfilledRows: number } {
  if (!(tableColumns(raw, "spine_events").length && hasTableColumn(raw, "spine_events", "connector_instance_id"))) {
    return { backfilledRows: 0 };
  }
  const migration = raw.transaction(() => {
    const result = raw
      .prepare(
        `UPDATE spine_events
            SET connector_instance_id = COALESCE(
              NULLIF(json_extract(data_json, '$.connector_instance_id'), ''),
              NULLIF(json_extract(data_json, '$.connection_id'), '')
            )
          WHERE connector_instance_id IS NULL
            AND event_type IN ${SPINE_TERMINAL_EVENT_TYPES_SQL}
            AND (
              json_extract(data_json, '$.connector_instance_id') IS NOT NULL
              OR json_extract(data_json, '$.connection_id') IS NOT NULL
            )`
      )
      .run();
    return { backfilledRows: result.changes };
  });

  const result = migration();
  if (typeof opts.onSchemaMigration === "function") {
    opts.onSchemaMigration({ name: "spine_events_connector_instance_id_backfill", ...result });
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
 * See docs/reference/binary-content-invariant-design-brief.md §4.6.
 */
function migrateBlobBindingsJsonPath(raw: SqliteDatabase, opts: MigrationOptions = {}) {
  if (hasTableColumn(raw, "blob_bindings", "json_path")) {
    return { backfilledRows: 0, rebuilt: false };
  }

  const migration = raw.transaction(() => {
    const before = raw.prepare("SELECT COUNT(*) AS count FROM blob_bindings").get<SqliteCountRow>()?.count ?? 0;

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

    const after = raw.prepare("SELECT COUNT(*) AS count FROM blob_bindings").get<SqliteCountRow>()?.count ?? 0;
    if (before !== after) {
      throw new Error(`blob_bindings json_path migration row-count mismatch: before=${before} after=${after}`);
    }
    return { backfilledRows: after, rebuilt: true };
  });

  const result = migration();
  if (typeof opts.onSchemaMigration === "function") {
    opts.onSchemaMigration({ name: "blob_bindings_json_path", ...result });
  }
  return result;
}

function migrateSemanticSearchInstanceColumns(raw: SqliteDatabase, opts: MigrationOptions = {}) {
  const rowidHasInstance = hasTableColumn(raw, "semantic_search_rowid", "connector_instance_id");
  const blobHasInstance = hasTableColumn(raw, "semantic_search_blob", "connector_instance_id");
  const metaHasInstance = hasTableColumn(raw, "semantic_search_meta", "connector_instance_id");
  const progressHasInstance = hasTableColumn(raw, "semantic_search_backfill_progress", "connector_instance_id");
  if (rowidHasInstance && blobHasInstance && metaHasInstance && progressHasInstance) {
    return { backfilledRows: 0, rebuilt: false };
  }

  const migration = raw.transaction(() => {
    const rowids = raw
      .prepare(
        `SELECT ${rowidHasInstance ? "connector_instance_id," : ""} connector_id, scope_key, record_key, rowid
        FROM semantic_search_rowid`
      )
      .all<SemanticIndexRow>();
    const blobs = raw
      .prepare(
        `SELECT ${blobHasInstance ? "connector_instance_id," : ""} connector_id, scope_key, record_key, embedding
        FROM semantic_search_blob`
      )
      .all<SemanticIndexRow>();
    const metas = raw
      .prepare(
        `SELECT ${metaHasInstance ? "connector_instance_id," : ""} connector_id, stream, fields_fingerprint, model_id, dimensions, distance_metric, updated_at
        FROM semantic_search_meta`
      )
      .all<SemanticMetaRow>();
    const progressRows = raw
      .prepare(
        `SELECT ${progressHasInstance ? "connector_instance_id," : ""} connector_id, stream, fields_fingerprint, model_id, dimensions, distance_metric, updated_at
        FROM semantic_search_backfill_progress`
      )
      .all<SemanticMetaRow>();

    const instanceIds = new Map<string, string>();
    const resolveInstanceId = (row: ConnectorScopedRow): string => {
      if (typeof row.connector_instance_id === "string" && row.connector_instance_id.trim()) {
        return row.connector_instance_id.trim();
      }
      if (!instanceIds.has(row.connector_id)) {
        instanceIds.set(row.connector_id, defaultConnectorInstanceIdForBackfill(raw, row.connector_id));
      }
      return getMappedValue(instanceIds, row.connector_id);
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
    for (const row of rowids) {
      insertRowid.run(resolveInstanceId(row), row.connector_id, row.scope_key, row.record_key, row.rowid);
    }

    const insertBlob = raw.prepare(
      `INSERT INTO semantic_search_blob(connector_instance_id, connector_id, scope_key, record_key, embedding)
        VALUES(?, ?, ?, ?, ?)`
    );
    for (const row of blobs) {
      insertBlob.run(resolveInstanceId(row), row.connector_id, row.scope_key, row.record_key, row.embedding);
    }

    const insertMeta = raw.prepare(
      `INSERT INTO semantic_search_meta(connector_instance_id, connector_id, stream, fields_fingerprint, model_id, dimensions, distance_metric, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of metas) {
      insertMeta.run(
        resolveInstanceId(row),
        row.connector_id,
        row.stream,
        row.fields_fingerprint,
        row.model_id,
        row.dimensions,
        row.distance_metric,
        row.updated_at
      );
    }

    const insertProgress = raw.prepare(
      `INSERT INTO semantic_search_backfill_progress(connector_instance_id, connector_id, stream, fields_fingerprint, model_id, dimensions, distance_metric, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of progressRows) {
      insertProgress.run(
        resolveInstanceId(row),
        row.connector_id,
        row.stream,
        row.fields_fingerprint,
        row.model_id,
        row.dimensions,
        row.distance_metric,
        row.updated_at
      );
    }

    return { backfilledRows: rowids.length + blobs.length + metas.length + progressRows.length, rebuilt: true };
  });

  const result = migration();
  if (typeof opts.onSchemaMigration === "function") {
    opts.onSchemaMigration({ name: "semantic_search_instance_columns", ...result });
  }
  return result;
}

function loadVectorExtension(raw: SqliteDatabase): VectorIndexKind {
  try {
    loadSqliteVec(raw);
    // Confirm the extension is actually usable — load() can succeed but
    // vec_version() can still fail if the binary mismatches. Fail-closed:
    // any error here degrades to blob-flat rather than advertising
    // sqlite-vec and then crashing on first MATCH.
    raw.prepare("SELECT vec_version() AS v").get();
    return "sqlite-vec";
  } catch {
    return "blob-flat";
  }
}

export function initDb(path = ":memory:", opts: InitDbOptions = {}): DatabaseHandle {
  closeDb();
  const busyTimeoutMs = resolveSqliteBusyTimeoutMs(opts.busyTimeoutMs);
  const raw = new Database(path, { timeout: busyTimeoutMs }) as unknown as SqliteDatabase;
  sqliteStoreCacheGeneration += 1;
  sqliteStoreCacheIdentity = `sqlite:${String(path)}:${sqliteStoreCacheGeneration}`;
  raw.pragma(`busy_timeout = ${busyTimeoutMs}`);

  // Performance PRAGMAs — see openspec/changes/add-polyfill-connector-system/
  // design-notes/sqlite-performance-recommendations.md for rationale. WAL is
  // invalid on in-memory DBs.
  if (path !== ":memory:") {
    raw.pragma("journal_mode = WAL");
    raw.pragma("synchronous = NORMAL");
    raw.pragma("temp_store = MEMORY");
    raw.pragma("mmap_size = 268435456");
    raw.pragma("cache_size = -65536");
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
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, "pending_consents", "approval_id", "TEXT"));
  runWithSqliteBusyRetrySync(() =>
    addColumnIfMissing(raw, "pending_consents", "interval_seconds", "INTEGER NOT NULL DEFAULT 2")
  );
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, "pending_consents", "last_polled_at", "TEXT"));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, "owner_device_auth", "approval_id", "TEXT"));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, "device_exporters", "agent_version", "TEXT"));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, "device_exporters", "collector_protocol_version", "TEXT"));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, "device_exporters", "last_heartbeat_at", "TEXT"));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, "device_exporters", "last_error_json", "TEXT"));
  runWithSqliteBusyRetrySync(() =>
    addColumnIfMissing(raw, "device_enrollment_codes", "connector_id", "TEXT NOT NULL DEFAULT 'unknown'")
  );
  runWithSqliteBusyRetrySync(() =>
    addColumnIfMissing(raw, "device_enrollment_codes", "local_binding_id", "TEXT NOT NULL DEFAULT 'default'")
  );
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, "device_enrollment_codes", "display_name", "TEXT"));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, "device_source_instances", "connector_instance_id", "TEXT"));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, "device_source_instances", "source_kind", "TEXT"));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, "device_source_instances", "last_error_json", "TEXT"));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, "device_source_instances", "last_heartbeat_at", "TEXT"));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, "device_source_instances", "last_heartbeat_status", "TEXT"));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, "device_source_instances", "records_pending", "INTEGER"));
  runWithSqliteBusyRetrySync(() =>
    addColumnIfMissing(raw, "device_source_instances", "outbox_diagnostics_json", "TEXT")
  );
  runWithSqliteBusyRetrySync(() =>
    addColumnIfMissing(raw, "device_source_instances", "manifest_generation", "INTEGER")
  );
  runWithSqliteBusyRetrySync(() =>
    addColumnIfMissing(raw, "connector_instances", "manifest_generation", "INTEGER NOT NULL DEFAULT 0")
  );
  runWithSqliteBusyRetrySync(() =>
    addColumnIfMissing(raw, "connector_state", "manifest_generation", "INTEGER NOT NULL DEFAULT 0")
  );
  runWithSqliteBusyRetrySync(() =>
    addColumnIfMissing(raw, "grant_connector_state", "manifest_generation", "INTEGER NOT NULL DEFAULT 0")
  );
  runWithSqliteBusyRetrySync(() => migrateDeviceIngestBatchOutcomes(raw));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, "browser_surfaces", "surface_mode", "TEXT"));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, "browser_surfaces", "surface_subject_id", "TEXT"));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, "browser_surfaces", "surface_source", "TEXT"));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, "browser_surfaces", "stream_origin", "TEXT"));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, "browser_surfaces", "window_settle_endpoint", "TEXT"));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, "browser_surfaces", "container_name", "TEXT"));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, "browser_surfaces", "profile_dir", "TEXT"));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, "browser_surfaces", "profile_volume", "TEXT"));
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, "browser_surfaces", "browser_generation_hash", "TEXT"));
  // Dataset summary projection fencing: a `generation` column lets rebuild
  // and reconcile writers guard their final summary write against
  // concurrent record/blob delta writers. Pre-existing rows seed with 0;
  // any subsequent write bumps the counter so old captures cannot win.
  runWithSqliteBusyRetrySync(() =>
    addColumnIfMissing(raw, "dataset_summary_projection", "generation", "INTEGER NOT NULL DEFAULT 0")
  );
  runWithSqliteBusyRetrySync(() => migrateBrowserSurfaceLeaseEnumChecks(raw));
  runWithSqliteBusyRetrySync(() => ensureBrowserSurfaceLeaseIndexes(raw));
  runWithSqliteBusyRetrySync(() => ensureConnectorSummaryEvidenceColumns(raw));
  runWithSqliteBusyRetrySync(() => ensureConnectorMaintenanceCursorColumns(raw));
  runWithSqliteBusyRetrySync(() => migrateManifestWriteViolations(raw));
  runWithSqliteBusyRetrySync(() => ensureRecordResetGenerationColumn(raw));
  // Incremental add-source linkage: a later same-client ceremony records the
  // prior package it extends via `parent_package_id`. Pre-existing reference
  // DBs predate the column; add it non-destructively (NULL = a root package
  // with no prior linkage). It is cumulative-view/audit metadata only and
  // carries no source or stream authority — record access is still governed
  // solely by active child grants.
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, "grant_packages", "parent_package_id", "TEXT"));
  runWithSqliteBusyRetrySync(() => {
    raw.exec(
      `CREATE INDEX IF NOT EXISTS idx_grant_packages_parent
         ON grant_packages(parent_package_id)`
    );
  });
  // Disclosure-spine `event_seq` migration. Pre-existing reference DBs were
  // created before `event_seq` existed; add the column non-destructively and
  // seed it for any rows that lack a value. The seed orders by `rowid` —
  // SQLite's physical row identity at the moment of backfill — purely as a
  // one-shot reconstruction of historical append order. After backfill,
  // `event_seq` is the only ordering surface readers and cursors consult;
  // the cursor contract no longer reads `rowid`.
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, "spine_events", "event_seq", "INTEGER"));
  runWithSqliteBusyRetrySync(() => {
    raw.exec("UPDATE spine_events SET event_seq = rowid WHERE event_seq IS NULL");
  });
  runWithSqliteBusyRetrySync(() => migrateSpineSourceColumns(raw, opts));
  // blob_bindings gains a json_path column (RFC 6901 JSON Pointer or
  // '@record' pseudo-path). Required for lossless binary extraction
  // during sqlite→postgres migration; see
  // docs/reference/binary-content-invariant-design-brief.md §4.6. Legacy rows
  // backfill with '@record' (their existing record-level semantics).
  runWithSqliteBusyRetrySync(() => migrateBlobBindingsJsonPath(raw, opts));
  runWithSqliteBusyRetrySync(() => migrateConnectorSyncStateInstanceColumns(raw, opts));
  runWithSqliteBusyRetrySync(() => migrateConnectorDetailGapInstanceColumns(raw, opts));
  runWithSqliteBusyRetrySync(() => migrateRecordStorageInstanceColumns(raw, opts));
  runWithSqliteBusyRetrySync(() => migrateBlobOriginInstanceColumn(raw, opts));
  runWithSqliteBusyRetrySync(() => migrateSemanticSearchInstanceColumns(raw, opts));
  runWithSqliteBusyRetrySync(() => migrateLexicalSearchInstanceColumns(raw, opts));
  runWithSqliteBusyRetrySync(() => migrateLocalDeviceConnectorInstances(raw, opts));
  runWithSqliteBusyRetrySync(() => migrateRecordSemanticTimeColumn(raw));
  raw.exec(`
DROP INDEX IF EXISTS idx_records_lookup;
DROP INDEX IF EXISTS idx_records_version;
DROP INDEX IF EXISTS idx_record_changes_record;
DROP INDEX IF EXISTS idx_blob_bindings_record;
CREATE INDEX IF NOT EXISTS idx_records_lookup ON records(connector_instance_id, stream, record_key);
CREATE INDEX IF NOT EXISTS idx_records_version ON records(connector_instance_id, stream, version);
CREATE INDEX IF NOT EXISTS idx_records_semantic_time ON records(connector_instance_id, stream, (COALESCE(NULLIF(semantic_time, ''), emitted_at)) DESC, record_key DESC);
CREATE INDEX IF NOT EXISTS idx_record_changes_record ON record_changes(connector_instance_id, stream, record_key, version);
CREATE INDEX IF NOT EXISTS idx_record_changes_emitted ON record_changes(connector_instance_id, stream, emitted_at);
CREATE INDEX IF NOT EXISTS idx_blob_bindings_record ON blob_bindings(connector_instance_id, stream, record_key);
`);
  runWithSqliteBusyRetrySync(() => migrateSchedulerInstanceColumns(raw));
  runWithSqliteBusyRetrySync(() => migrateRunHistoryRename(raw));
  runWithSqliteBusyRetrySync(() => migrateRunHistoryCompletedAtNullable(raw));
  runWithSqliteBusyRetrySync(() => migrateConnectorMaintenanceCursorNameCheck(raw));
  runWithSqliteBusyRetrySync(() => migrateLegacyConnectorInstancesToDefaultAccount(raw, opts));
  runWithSqliteBusyRetrySync(() => migrateConnectorInstancesSourceKindCheck(raw, opts));
  runWithSqliteBusyRetrySync(() => migrateConnectorInstancesSourceKindBrowserCollector(raw, opts));
  runWithSqliteBusyRetrySync(() => migrateConnectorInstancesStatusDraft(raw, opts));
  runWithSqliteBusyRetrySync(() => migrateConnectorCredentialKindCheck(raw, opts));
  runWithSqliteBusyRetrySync(() => migrateConnectorCredentialStatusRejected(raw, opts));
  runWithSqliteBusyRetrySync(() => migrateClientEventSubscriptionAuthority(raw));
  runWithSqliteBusyRetrySync(() => ensureClientEventSubscriptionAuthorityIndex(raw));
  raw.exec(
    `CREATE INDEX IF NOT EXISTS idx_spine_events_run_terminal
      ON spine_events(run_id, event_type, event_seq DESC)
      WHERE run_id IS NOT NULL
        AND event_type IN ('run.completed', 'run.failed', 'run.browser_surface_failed', 'run.cancelled', 'run.abandoned')`
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
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_spine_events_seq ON spine_events(event_seq) WHERE event_seq IS NOT NULL"
  );
  // Terminal-run events are the fold source for the connector-summary
  // per-stream evidence; this seq-leading partial index serves the fold's
  // max-seq and delta-range reads (idx_spine_events_run_terminal leads with
  // run_id and cannot). Created here, AFTER the event_seq migration above —
  // a pre-event_seq legacy DB has no such column yet.
  raw.exec(
    `CREATE INDEX IF NOT EXISTS idx_spine_events_terminal_seq
      ON spine_events(event_seq)
      WHERE event_type IN ('run.completed', 'run.failed', 'run.browser_surface_failed', 'run.cancelled')`
  );
  // Scoped terminal-fact fold source: adds a first-class, indexed
  // connector_instance_id column to spine_events so the connector-summary
  // fold (connector-summary-read-model.ts) can filter its terminal high-water
  // and delta reads to exactly the requested connections at the SQL level,
  // instead of scanning every connection's terminal history in memory. The
  // column is additive/nullable — most spine event types (grants, tokens,
  // interactions, traces) legitimately carry no connection attribution and
  // stay NULL; the fold's existing "refused" counter already treats an
  // unattributed terminal event as intentionally unattributable, not an
  // error. Populated at write time in lib/spine.ts from the same
  // data.connector_instance_id/connection_id payload field
  // addRunConnectionIdentity already stamps onto run.* events — no new
  // write-path derivation, only promoting an existing value to a column.
  // Spec: openspec/changes/reconcile-active-summary-evidence/specs/
  //       reference-connector-instances/spec.md
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, "spine_events", "connector_instance_id", "TEXT"));
  // Terminal provenance is source-bound, not projection-bound. This trigger
  // shares SQLite's single-writer ordering with registry mutation. It accepts
  // the normalized column or the event payload identity, so every normal
  // terminal append reaches the same source boundary. Pre-column rows are
  // deliberately not backfilled with a generation and remain historical.
  runWithSqliteBusyRetrySync(() => addColumnIfMissing(raw, "spine_events", "manifest_generation", "INTEGER"));
  raw.exec(`
    DROP TRIGGER IF EXISTS stamp_terminal_manifest_generation;
    CREATE TRIGGER stamp_terminal_manifest_generation
    AFTER INSERT ON spine_events
    WHEN NEW.manifest_generation IS NULL
      AND NEW.event_type IN ('run.completed', 'run.failed', 'run.browser_surface_failed', 'run.cancelled')
    BEGIN
      UPDATE spine_events
         SET connector_instance_id = COALESCE(
               NULLIF(NEW.connector_instance_id, ''),
               NULLIF(json_extract(NEW.data_json, '$.connector_instance_id'), ''),
               NULLIF(json_extract(NEW.data_json, '$.connection_id'), '')
             ),
             manifest_generation = (
           SELECT manifest_generation
             FROM connector_instances
            WHERE connector_instance_id = COALESCE(
              NULLIF(NEW.connector_instance_id, ''),
              NULLIF(json_extract(NEW.data_json, '$.connector_instance_id'), ''),
              NULLIF(json_extract(NEW.data_json, '$.connection_id'), '')
            )
         )
       WHERE event_id = NEW.event_id;
    END;
  `);
  raw.exec(
    `CREATE INDEX IF NOT EXISTS idx_spine_events_terminal_instance_seq
      ON spine_events(connector_instance_id, event_seq)
      WHERE event_type IN ('run.completed', 'run.failed', 'run.browser_surface_failed', 'run.cancelled')
        AND connector_instance_id IS NOT NULL`
  );
  // Backfill connector_instance_id for pre-existing TERMINAL rows whose
  // identity already lives in data_json (Sol fourth-verdict P1.1): the
  // scoped fold filters exclusively on the new column, so a legacy
  // terminal row with the column NULL is invisible to the real
  // single-connection route and startup even though its data_json carries
  // a genuine connector_instance_id/connection_id. Unlike the REJECTED
  // per-row `source_kind`/`source_id` backfill pattern above (a full
  // `SELECT` + per-row `UPDATE` that never converged), this is a single
  // bounded, set-based `UPDATE` restricted to the four terminal event
  // types (using the same idx_spine_events_terminal_seq partial index the
  // fold itself relies on, not a full-table scan) and to rows the column
  // has not yet reached — naturally idempotent: after the first
  // successful run this `WHERE` clause matches zero rows on every
  // subsequent boot, so it is safe to run unconditionally every time.
  // Precedence matches `readEventConnectionId` in
  // connector-summary-read-model.ts exactly: `data.connector_instance_id`
  // first, then `data.connection_id`.
  runWithSqliteBusyRetrySync(() => migrateSpineEventsConnectorInstanceIdBackfill(raw, opts));
  // Index gives us a fast lookup-by-approval-id and approximates the
  // UNIQUE constraint on the column (the inline CREATE TABLE form
  // declares it UNIQUE; SQLite's ALTER TABLE ADD COLUMN does not
  // accept UNIQUE inline, so a partial unique index is the equivalent
  // for pre-existing DBs).
  raw.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_consents_approval_id ON pending_consents(approval_id) WHERE approval_id IS NOT NULL"
  );
  raw.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_owner_device_auth_approval_id ON owner_device_auth(approval_id) WHERE approval_id IS NOT NULL"
  );
  // Selection overrides predate reviewed episode batches. Keep legacy
  // single-target rows valid while making batch membership additive.
  runWithSqliteBusyRetrySync(() =>
    addColumnIfMissing(raw, "browser_surface_replacement_selection_overrides", "replacement_batch_id", "TEXT")
  );
  runWithSqliteBusyRetrySync(() =>
    addColumnIfMissing(
      raw,
      "browser_surface_replacement_selection_override_batches",
      "reviewed_artifact_sha256",
      "TEXT NOT NULL DEFAULT ''"
    )
  );
  raw.exec(`
CREATE INDEX IF NOT EXISTS idx_browser_surface_replacement_selection_override_batch
  ON browser_surface_replacement_selection_overrides(replacement_batch_id);
CREATE TABLE IF NOT EXISTS browser_surface_replacement_selection_override_batches (
  replacement_batch_id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  connector_id TEXT,
  profile_key TEXT NOT NULL,
  surface_subject_id TEXT,
  prior_failed_replacement_id TEXT NOT NULL,
  reviewed_artifact_sha256 TEXT NOT NULL,
  first_event_seq INTEGER NOT NULL,
  last_event_seq INTEGER NOT NULL,
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS browser_surface_replacement_selection_override_audit_outbox (
  audit_outbox_id TEXT PRIMARY KEY,
  replacement_batch_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('apply', 'revoke')),
  reviewed_artifact_sha256 TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  UNIQUE(replacement_batch_id, operation)
)`);
  // cimd_client_documents: added for CIMD operator-managed document service.
  // CREATE TABLE IF NOT EXISTS in the base schema handles fresh DBs; this
  // exec ensures the table exists for pre-existing DBs that lack it.
  raw.exec(`
CREATE TABLE IF NOT EXISTS cimd_client_documents (
  document_id    TEXT PRIMARY KEY,
  client_name    TEXT,
  redirect_uris  TEXT NOT NULL DEFAULT '[]',
  logo_uri       TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
)`);
  // run_generation fencing token: monotonic counter that increments each time a
  // new run is admitted for a connector_instance. Existing rows backfill to 1
  // (safe baseline — the column default also ensures new rows without an
  // explicit value start at 1). See docs/research/slvp-ideal-stuck-run-liveness-2026-06-14.md §2.6 / §8.
  runWithSqliteBusyRetrySync(() =>
    addColumnIfMissing(raw, "controller_active_runs", "run_generation", "INTEGER NOT NULL DEFAULT 1")
  );
  db = withCachedPrepare(raw);
  // Stamp the chosen vector-index backend onto the wrapped db so
  // search-semantic.js can select without re-probing. The Proxy's
  // get-handler falls through to Reflect for non-`prepare` properties,
  // so direct property reads like `db.vectorIndexKind` work.
  Object.defineProperty(raw, "vectorIndexKind", {
    configurable: false,
    enumerable: true,
    value: vectorIndexKind,
    writable: false,
  });
  return db;
}
