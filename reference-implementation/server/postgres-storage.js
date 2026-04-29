/**
 * Explicit Postgres runtime storage bootstrap for the final Postgres slice.
 *
 * SQLite remains the default runtime backend. This module only opens a pg pool
 * when `PDPP_STORAGE_BACKEND=postgres` (or the test opts equivalent) is set.
 *
 * Spec: openspec/changes/add-postgres-runtime-storage/
 */

import pg from 'pg';

const { Pool } = pg;

const VALID_BACKENDS = new Set(['sqlite', 'postgres']);

let activeBackend = 'sqlite';
let pool = null;

function normalizeBackend(value) {
  const normalized = String(value || 'sqlite').trim().toLowerCase();
  if (!VALID_BACKENDS.has(normalized)) {
    throw new Error(`Unsupported PDPP_STORAGE_BACKEND '${value}'. Expected 'sqlite' or 'postgres'.`);
  }
  return normalized;
}

export function resolveStorageBackend({ env = process.env, opts = {} } = {}) {
  const backend = normalizeBackend(opts.storageBackend ?? env.PDPP_STORAGE_BACKEND ?? 'sqlite');
  if (backend === 'sqlite') {
    return { backend };
  }

  const databaseUrl = opts.databaseUrl ?? env.PDPP_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('PDPP_STORAGE_BACKEND=postgres requires PDPP_DATABASE_URL.');
  }
  return { backend, databaseUrl };
}

export function getStorageBackendKind() {
  return activeBackend;
}

export function isPostgresStorageBackend() {
  return activeBackend === 'postgres';
}

export function getPostgresPool() {
  if (!pool) {
    throw new Error('Postgres storage has not been initialized.');
  }
  return pool;
}

export async function postgresQuery(sql, params = []) {
  return getPostgresPool().query(sql, params);
}

export async function withPostgresTransaction(fn) {
  const client = await getPostgresPool().connect();
  try {
    await client.query('BEGIN');
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw err;
  } finally {
    client.release();
  }
}

export async function initPostgresStorage(config) {
  if (!config || config.backend !== 'postgres') {
    activeBackend = 'sqlite';
    return null;
  }
  if (pool) {
    await closePostgresStorage();
  }

  pool = new Pool({ connectionString: config.databaseUrl });
  activeBackend = 'postgres';

  await bootstrapPostgresSchema();
  return pool;
}

export async function closePostgresStorage() {
  const current = pool;
  pool = null;
  activeBackend = 'sqlite';
  if (current) {
    await current.end();
  }
}

export async function bootstrapPostgresSchema() {
  const client = await getPostgresPool().connect();
  try {
    // pgvector is optional. Semantic fallback stores vectors as JSONB and
    // computes distances after grant-scoped candidate narrowing.
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    } catch {}

    await client.query(`
      CREATE TABLE IF NOT EXISTS connectors (
        connector_id TEXT PRIMARY KEY,
        manifest JSONB NOT NULL,
        created_at TEXT NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::text
      );

      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        registration_mode TEXT NOT NULL,
        token_endpoint_auth_method TEXT NOT NULL,
        client_secret TEXT,
        metadata_json JSONB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pg_oauth_clients_registration_mode
        ON oauth_clients(registration_mode, created_at);

      CREATE TABLE IF NOT EXISTS grants (
        grant_id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        storage_binding_json JSONB,
        grant_json JSONB NOT NULL,
        access_mode TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        consumed BOOLEAN NOT NULL DEFAULT FALSE,
        issued_at TEXT NOT NULL,
        expires_at TEXT,
        trace_id TEXT,
        scenario_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pg_grants_client_status
        ON grants(client_id, status, issued_at);

      CREATE TABLE IF NOT EXISTS tokens (
        token_id TEXT PRIMARY KEY,
        grant_id TEXT,
        subject_id TEXT NOT NULL,
        client_id TEXT,
        token_kind TEXT NOT NULL,
        expires_at TEXT,
        revoked BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TEXT NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::text
      );
      CREATE INDEX IF NOT EXISTS idx_pg_tokens_grant_id
        ON tokens(grant_id);
      CREATE INDEX IF NOT EXISTS idx_pg_tokens_client_id
        ON tokens(client_id);

      CREATE TABLE IF NOT EXISTS pending_consents (
        device_code TEXT PRIMARY KEY,
        user_code TEXT NOT NULL UNIQUE,
        params_json JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        subject_id TEXT,
        grant_id TEXT,
        token_id TEXT,
        ai_training_consented BOOLEAN,
        request_id TEXT,
        trace_id TEXT,
        scenario_id TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        approved_at TEXT,
        denied_at TEXT,
        approval_id TEXT UNIQUE
      );
      CREATE INDEX IF NOT EXISTS idx_pg_pending_consents_status_expires
        ON pending_consents(status, expires_at);

      CREATE TABLE IF NOT EXISTS owner_device_auth (
        device_code TEXT PRIMARY KEY,
        user_code TEXT NOT NULL UNIQUE,
        client_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        subject_id TEXT,
        token_id TEXT,
        interval_seconds INTEGER NOT NULL DEFAULT 5,
        last_polled_at TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        approved_at TEXT,
        denied_at TEXT,
        request_id TEXT,
        trace_id TEXT,
        scenario_id TEXT,
        approval_id TEXT UNIQUE
      );
      CREATE INDEX IF NOT EXISTS idx_pg_owner_device_auth_status_expires
        ON owner_device_auth(status, expires_at);

      CREATE TABLE IF NOT EXISTS connector_state (
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        state_json JSONB NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(connector_id, stream)
      );

      CREATE TABLE IF NOT EXISTS grant_connector_state (
        grant_id TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        state_json JSONB NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(grant_id, connector_id, stream)
      );

      CREATE TABLE IF NOT EXISTS connector_schedules (
        connector_id TEXT PRIMARY KEY,
        interval_seconds INTEGER NOT NULL,
        jitter_seconds INTEGER NOT NULL DEFAULT 0,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS controller_active_runs (
        connector_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE,
        trace_id TEXT NOT NULL,
        scenario_id TEXT NOT NULL,
        started_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS records (
        id BIGSERIAL PRIMARY KEY,
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        record_key TEXT NOT NULL,
        record_json JSONB NOT NULL,
        emitted_at TEXT NOT NULL,
        version BIGINT NOT NULL DEFAULT 1,
        deleted BOOLEAN NOT NULL DEFAULT FALSE,
        deleted_at TEXT,
        cursor_value TEXT,
        primary_key_text TEXT NOT NULL,
        UNIQUE(connector_id, stream, record_key)
      );
      CREATE INDEX IF NOT EXISTS idx_pg_records_lookup
        ON records(connector_id, stream, record_key);
      CREATE INDEX IF NOT EXISTS idx_pg_records_stream_version
        ON records(connector_id, stream, version);
      CREATE INDEX IF NOT EXISTS idx_pg_records_stream_cursor
        ON records(connector_id, stream, deleted, cursor_value, primary_key_text);

      CREATE TABLE IF NOT EXISTS record_changes (
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        record_key TEXT NOT NULL,
        version BIGINT NOT NULL,
        record_json JSONB,
        emitted_at TEXT NOT NULL,
        deleted BOOLEAN NOT NULL DEFAULT FALSE,
        deleted_at TEXT,
        PRIMARY KEY(connector_id, stream, version)
      );
      CREATE INDEX IF NOT EXISTS idx_pg_record_changes_record
        ON record_changes(connector_id, stream, record_key, version);

      CREATE TABLE IF NOT EXISTS version_counter (
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        max_version BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY(connector_id, stream)
      );

      CREATE TABLE IF NOT EXISTS blobs (
        blob_id TEXT PRIMARY KEY,
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        record_key TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes BIGINT NOT NULL,
        sha256 TEXT NOT NULL,
        data BYTEA
      );

      CREATE TABLE IF NOT EXISTS blob_bindings (
        blob_id TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        record_key TEXT NOT NULL,
        PRIMARY KEY(blob_id, connector_id, stream, record_key),
        FOREIGN KEY(blob_id) REFERENCES blobs(blob_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_pg_blob_bindings_record
        ON blob_bindings(connector_id, stream, record_key);

      CREATE TABLE IF NOT EXISTS spine_events (
        event_id TEXT PRIMARY KEY,
        event_seq BIGSERIAL UNIQUE,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        scenario_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        subject_type TEXT,
        subject_id TEXT,
        object_type TEXT NOT NULL,
        object_id TEXT NOT NULL,
        status TEXT NOT NULL,
        request_id TEXT,
        grant_id TEXT,
        run_id TEXT,
        provider_id TEXT,
        client_id TEXT,
        stream_id TEXT,
        token_id TEXT,
        interaction_id TEXT,
        data_json JSONB NOT NULL,
        version TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pg_spine_events_trace
        ON spine_events(trace_id, occurred_at, recorded_at);
      CREATE INDEX IF NOT EXISTS idx_pg_spine_events_run
        ON spine_events(run_id, occurred_at, recorded_at);
      CREATE INDEX IF NOT EXISTS idx_pg_spine_events_grant
        ON spine_events(grant_id, occurred_at, recorded_at);

      CREATE TABLE IF NOT EXISTS lexical_search_index (
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        record_key TEXT NOT NULL,
        field TEXT NOT NULL,
        value TEXT NOT NULL,
        document TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', value)) STORED,
        PRIMARY KEY(connector_id, stream, record_key, field)
      );
      CREATE INDEX IF NOT EXISTS idx_pg_lexical_search_document
        ON lexical_search_index USING GIN(document);

      CREATE TABLE IF NOT EXISTS lexical_search_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        query TEXT NOT NULL,
        plan_hash TEXT NOT NULL,
        results_json JSONB NOT NULL,
        created_at TEXT NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::text
      );

      CREATE TABLE IF NOT EXISTS lexical_search_meta (
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        fields_fingerprint TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(connector_id, stream)
      );

      CREATE TABLE IF NOT EXISTS semantic_search_blob (
        connector_id TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        record_key TEXT NOT NULL,
        embedding JSONB NOT NULL,
        PRIMARY KEY(connector_id, scope_key, record_key)
      );
      CREATE INDEX IF NOT EXISTS idx_pg_semantic_search_scope
        ON semantic_search_blob(connector_id, scope_key);

      CREATE TABLE IF NOT EXISTS semantic_search_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        query TEXT NOT NULL,
        plan_hash TEXT NOT NULL,
        results_json JSONB NOT NULL,
        created_at TEXT NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::text
      );

      CREATE TABLE IF NOT EXISTS semantic_search_meta (
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        fields_fingerprint TEXT NOT NULL,
        model_id TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        distance_metric TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(connector_id, stream)
      );

      CREATE TABLE IF NOT EXISTS semantic_search_backfill_progress (
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        model_id TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        distance_metric TEXT NOT NULL,
        cursor_key TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(connector_id, stream)
      );
    `);
  } finally {
    client.release();
  }
}
