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

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isSourceKind(value) {
  return value === 'connector' || value === 'provider_native';
}

function parseSpineSourceShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const canonicalKind = nonEmptyString(value.kind);
  const canonicalId = nonEmptyString(value.id);
  if (isSourceKind(canonicalKind) && canonicalId) {
    return { kind: canonicalKind, id: canonicalId };
  }

  const legacyKind = nonEmptyString(value.binding_kind);
  if (legacyKind === 'connector') {
    const id = nonEmptyString(value.connector_id);
    if (id) return { kind: 'connector', id };
  }
  if (legacyKind === 'provider_native') {
    const id = nonEmptyString(value.provider_id);
    if (id) return { kind: 'provider_native', id };
  }

  const connectorId = nonEmptyString(value.connector_id);
  const providerId = nonEmptyString(value.provider_id);
  if (connectorId && !providerId) return { kind: 'connector', id: connectorId };
  if (providerId && !connectorId) return { kind: 'provider_native', id: providerId };

  return null;
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

      CREATE TABLE IF NOT EXISTS device_exporters (
        device_id TEXT PRIMARY KEY,
        owner_subject_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        agent_version TEXT,
        last_heartbeat_at TEXT,
        last_error_json JSONB,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pg_device_exporters_owner_status
        ON device_exporters(owner_subject_id, status, created_at);

      CREATE TABLE IF NOT EXISTS device_ingest_credentials (
        credential_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES device_exporters(device_id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pg_device_ingest_credentials_device_status
        ON device_ingest_credentials(device_id, status);

      CREATE TABLE IF NOT EXISTS device_enrollment_codes (
        enrollment_code_id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        owner_subject_id TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        local_binding_id TEXT NOT NULL,
        display_name TEXT,
        device_id TEXT REFERENCES device_exporters(device_id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pg_device_enrollment_codes_owner_status
        ON device_enrollment_codes(owner_subject_id, status, expires_at);

      CREATE TABLE IF NOT EXISTS device_source_instances (
        source_instance_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES device_exporters(device_id) ON DELETE CASCADE,
        connector_id TEXT NOT NULL,
        local_binding_id TEXT NOT NULL,
        display_name TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        last_error_json JSONB,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revoked_at TEXT,
        UNIQUE(device_id, connector_id, local_binding_id),
        UNIQUE(device_id, source_instance_id)
      );
      CREATE INDEX IF NOT EXISTS idx_pg_device_source_instances_device_status
        ON device_source_instances(device_id, status);

      CREATE TABLE IF NOT EXISTS device_ingest_batch_outcomes (
        device_id TEXT NOT NULL REFERENCES device_exporters(device_id) ON DELETE CASCADE,
        batch_id TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        source_instance_id TEXT NOT NULL,
        status TEXT NOT NULL,
        http_status INTEGER NOT NULL,
        response_json JSONB NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(device_id, batch_id, body_hash),
        UNIQUE(device_id, batch_id)
      );
      CREATE INDEX IF NOT EXISTS idx_pg_device_ingest_batch_outcomes_source
        ON device_ingest_batch_outcomes(device_id, source_instance_id, created_at);

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

      CREATE TABLE IF NOT EXISTS scheduler_run_history (
        id BIGSERIAL PRIMARY KEY,
        connector_id TEXT NOT NULL,
        source_json JSONB NOT NULL,
        status TEXT NOT NULL,
        records_emitted INTEGER NOT NULL DEFAULT 0,
        reported_records_emitted INTEGER,
        checkpoint_summary_json JSONB,
        known_gaps_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        connector_error_json JSONB,
        run_id TEXT,
        trace_id TEXT,
        failure_reason TEXT,
        terminal_reason TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        error TEXT,
        attempt INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_pg_scheduler_run_history_connector_completed
        ON scheduler_run_history(connector_id, completed_at, id);

      CREATE TABLE IF NOT EXISTS scheduler_last_run_times (
        connector_id TEXT PRIMARY KEY,
        last_run_time_ms BIGINT NOT NULL,
        updated_at TEXT NOT NULL
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

      -- blob_bindings.json_path: either an RFC 6901 JSON Pointer naming the
      -- record_json leaf the blob replaces (e.g. '/output_preview') or the
      -- reserved pseudo-path '@record' for record-level bindings that
      -- aren't tied to a specific field. See
      -- docs/binary-content-invariant-design-brief.md §4.6.
      CREATE TABLE IF NOT EXISTS blob_bindings (
        blob_id TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        record_key TEXT NOT NULL,
        json_path TEXT NOT NULL DEFAULT '@record',
        PRIMARY KEY(blob_id, connector_id, stream, record_key, json_path),
        FOREIGN KEY(blob_id) REFERENCES blobs(blob_id) ON DELETE CASCADE,
        CONSTRAINT blob_bindings_json_path_shape
          CHECK (json_path = '@record' OR json_path LIKE '/%')
      );
      CREATE INDEX IF NOT EXISTS idx_pg_blob_bindings_record
        ON blob_bindings(connector_id, stream, record_key);

      -- sha256 uniqueness is implied by the blob_id = 'blob_sha256_<hex>'
      -- naming + PRIMARY KEY on blob_id. Making it explicit at the
      -- schema layer protects against future drift.
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_blobs_sha256
        ON blobs(sha256);

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
        source_kind TEXT,
        source_id TEXT,
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
      CREATE INDEX IF NOT EXISTS idx_pg_spine_events_run_terminal
        ON spine_events(run_id, event_type, event_seq DESC)
        WHERE run_id IS NOT NULL
          AND event_type IN ('run.completed', 'run.failed', 'run.cancelled', 'run.abandoned');
      -- Boot-epoch reconciliation idempotency: at most one run.abandoned
      -- per orphan run.started.event_id. The constraint name
      -- spine_run_abandoned_cause_unique is referenced by the runtime
      -- error handler (catch by name, not by SQLSTATE 23505 blanket).
      -- See docs/run-reconciliation-design-brief.md section 3.5.
      CREATE UNIQUE INDEX IF NOT EXISTS spine_run_abandoned_cause_unique
        ON spine_events ((data_json->>'caused_by_event_id'))
        WHERE event_type = 'run.abandoned';
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
    await migratePostgresSpineSourceColumns(client);
    await migratePostgresDeviceExporterColumns(client);
    await migratePostgresBlobBindingsJsonPath(client);
  } finally {
    client.release();
  }
}

async function hasPostgresColumn(client, table, column) {
  const result = await client.query(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = $1
        AND column_name = $2
      LIMIT 1`,
    [table, column],
  );
  return result.rowCount > 0;
}

async function migratePostgresSpineSourceColumns(client) {
  const hadProviderId = await hasPostgresColumn(client, 'spine_events', 'provider_id');
  await client.query('BEGIN');
  try {
    const before = await client.query('SELECT COUNT(*)::int AS count FROM spine_events');
    await client.query(`
      ALTER TABLE spine_events
        ADD COLUMN IF NOT EXISTS source_kind TEXT,
        ADD COLUMN IF NOT EXISTS source_id TEXT
    `);

    const providerProjection = hadProviderId ? ', provider_id' : '';
    const rows = await client.query(
      `SELECT event_id, actor_type, actor_id, data_json, source_kind, source_id${providerProjection} FROM spine_events`
    );

    for (const row of rows.rows) {
      const payload = row.data_json && typeof row.data_json === 'object' && !Array.isArray(row.data_json)
        ? row.data_json
        : {};
      const source = deriveSpineSource(payload, row);
      if (!source) {
        continue;
      }
      const dataJson = { ...payload, source };
      if (
        row.source_kind !== source.kind
        || row.source_id !== source.id
        || JSON.stringify(payload.source) !== JSON.stringify(source)
      ) {
        await client.query(
          `UPDATE spine_events
              SET source_kind = $1, source_id = $2, data_json = $3::jsonb
            WHERE event_id = $4`,
          [source.kind, source.id, JSON.stringify(dataJson), row.event_id],
        );
      }
    }

    if (hadProviderId) {
      await client.query('ALTER TABLE spine_events DROP COLUMN provider_id');
    }
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pg_spine_events_source
        ON spine_events(source_kind, source_id, occurred_at, recorded_at)
    `);

    const after = await client.query('SELECT COUNT(*)::int AS count FROM spine_events');
    if (before.rows[0].count !== after.rows[0].count) {
      throw new Error(
        `spine_events source migration row-count mismatch: before=${before.rows[0].count} after=${after.rows[0].count}`
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw err;
  }
}

/**
 * Migrate `blob_bindings` to include `json_path` in the primary key.
 *
 * Pre-migration: PRIMARY KEY (blob_id, connector_id, stream, record_key).
 * Post-migration: PRIMARY KEY (blob_id, connector_id, stream, record_key, json_path)
 * with json_path TEXT NOT NULL DEFAULT '@record' and a CHECK constraint
 * enforcing json_path = '@record' OR json_path LIKE '/%'.
 *
 * Legacy rows backfill via the column DEFAULT ('@record') — matches their
 * existing record-level semantics. Also installs the explicit
 * `uniq_blobs_sha256` UNIQUE index on `blobs(sha256)`.
 *
 * Idempotent: skips when json_path is already present.
 *
 * See docs/binary-content-invariant-design-brief.md §4.6.
 */
async function migratePostgresBlobBindingsJsonPath(client) {
  const hasJsonPath = await hasPostgresColumn(client, 'blob_bindings', 'json_path');
  if (hasJsonPath) {
    // Even if the column exists, make sure the sha256 unique index is in
    // place (cheap idempotent step).
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uniq_blobs_sha256 ON blobs(sha256)`
    );
    return;
  }

  await client.query('BEGIN');
  try {
    // 1) Add the column with a backfill default. NOT NULL is satisfied by
    //    the DEFAULT for every existing row.
    await client.query(`
      ALTER TABLE blob_bindings
        ADD COLUMN IF NOT EXISTS json_path TEXT NOT NULL DEFAULT '@record'
    `);

    // 2) Replace the primary key. Postgres lets us drop + add the PK
    //    constraint without rebuilding the table.
    await client.query(`
      ALTER TABLE blob_bindings
        DROP CONSTRAINT IF EXISTS blob_bindings_pkey
    `);
    await client.query(`
      ALTER TABLE blob_bindings
        ADD CONSTRAINT blob_bindings_pkey
        PRIMARY KEY (blob_id, connector_id, stream, record_key, json_path)
    `);

    // 3) Install the CHECK constraint. Use a guard query so re-runs on a
    //    DB where the constraint already exists no-op cleanly.
    const existingCheck = await client.query(
      `SELECT 1 FROM pg_constraint
        WHERE conname = 'blob_bindings_json_path_shape'`
    );
    if (existingCheck.rows.length === 0) {
      await client.query(`
        ALTER TABLE blob_bindings
          ADD CONSTRAINT blob_bindings_json_path_shape
          CHECK (json_path = '@record' OR json_path LIKE '/%')
      `);
    }

    // 4) Sha256 uniqueness — make the existing implicit guarantee explicit.
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uniq_blobs_sha256 ON blobs(sha256)`
    );

    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw err;
  }
}

async function migratePostgresDeviceExporterColumns(client) {
  await client.query(`
    ALTER TABLE device_exporters
      ADD COLUMN IF NOT EXISTS agent_version TEXT,
      ADD COLUMN IF NOT EXISTS last_heartbeat_at TEXT,
      ADD COLUMN IF NOT EXISTS last_error_json JSONB
  `);
  await client.query(`
    ALTER TABLE device_enrollment_codes
      ADD COLUMN IF NOT EXISTS connector_id TEXT NOT NULL DEFAULT 'unknown',
      ADD COLUMN IF NOT EXISTS local_binding_id TEXT NOT NULL DEFAULT 'default',
      ADD COLUMN IF NOT EXISTS display_name TEXT
  `);
  await client.query(`
    ALTER TABLE device_source_instances
      ADD COLUMN IF NOT EXISTS last_error_json JSONB
  `);
}
