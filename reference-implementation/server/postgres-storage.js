/**
 * Explicit Postgres runtime storage bootstrap for the final Postgres slice.
 *
 * SQLite remains the default runtime backend. This module only opens a pg pool
 * when `PDPP_STORAGE_BACKEND=postgres` (or the test opts equivalent) is set.
 *
 * Spec: openspec/changes/add-postgres-runtime-storage/
 */

import pg from 'pg';
import { createHash } from 'node:crypto';
import { canonicalConnectorKey } from './connector-key.js';

const { Pool } = pg;

const VALID_BACKENDS = new Set(['sqlite', 'postgres']);
const LEGACY_SYNC_STATE_OWNER_SUBJECT_ID = 'owner_local';

let activeBackend = 'sqlite';
let pool = null;

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isSourceKind(value) {
  return value === 'connector' || value === 'provider_native';
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

function makeConnectorInstanceSourceBindingKey(sourceBinding) {
  return hashKey(stableJson(sourceBinding ?? {}));
}

function makeConnectorInstanceId(ownerSubjectId, connectorId, sourceKind, sourceBindingKey) {
  return `cin_${hashKey(`${ownerSubjectId}\n${connectorId}\n${sourceKind}\n${sourceBindingKey}`).slice(0, 24)}`;
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

      CREATE TABLE IF NOT EXISTS connector_instances (
        connector_instance_id TEXT PRIMARY KEY,
        owner_subject_id TEXT NOT NULL,
        connector_id TEXT NOT NULL REFERENCES connectors(connector_id) ON DELETE RESTRICT,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked')),
        source_kind TEXT NOT NULL CHECK (source_kind IN ('account', 'local_device', 'manual')),
        source_binding_key TEXT NOT NULL,
        source_binding_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revoked_at TEXT,
        UNIQUE(owner_subject_id, connector_id, source_kind, source_binding_key)
      );
      CREATE INDEX IF NOT EXISTS idx_pg_connector_instances_owner_connector_status
        ON connector_instances(owner_subject_id, connector_id, status);

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

      CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
        id TEXT PRIMARY KEY,
        device_code TEXT NOT NULL UNIQUE,
        code TEXT UNIQUE,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        state TEXT,
        code_challenge TEXT NOT NULL,
        code_challenge_method TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        grant_id TEXT,
        token_id TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        issued_at TEXT,
        consumed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pg_oauth_authorization_codes_code
        ON oauth_authorization_codes(code);
      CREATE INDEX IF NOT EXISTS idx_pg_oauth_authorization_codes_client_status
        ON oauth_authorization_codes(client_id, status, expires_at);

      CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
        refresh_token_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        expires_at TEXT,
        last_used_at TEXT,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pg_oauth_refresh_tokens_grant
        ON oauth_refresh_tokens(grant_id, status);
      CREATE INDEX IF NOT EXISTS idx_pg_oauth_refresh_tokens_client_status
        ON oauth_refresh_tokens(client_id, status, expires_at);

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
        package_id TEXT,
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

      CREATE TABLE IF NOT EXISTS grant_packages (
        package_id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        package_json JSONB NOT NULL,
        trace_id TEXT,
        scenario_id TEXT,
        created_at TEXT NOT NULL,
        approved_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pg_grant_packages_client_status
        ON grant_packages(client_id, status, created_at);

      CREATE TABLE IF NOT EXISTS grant_package_members (
        package_id TEXT NOT NULL REFERENCES grant_packages(package_id) ON DELETE CASCADE,
        grant_id TEXT NOT NULL REFERENCES grants(grant_id) ON DELETE CASCADE,
        token_id TEXT NOT NULL,
        source_json JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        added_at TEXT NOT NULL,
        revoked_at TEXT,
        PRIMARY KEY(package_id, grant_id)
      );
      CREATE INDEX IF NOT EXISTS idx_pg_grant_package_members_grant
        ON grant_package_members(grant_id, status);

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

      ALTER TABLE tokens
        ADD COLUMN IF NOT EXISTS package_id TEXT;
      ALTER TABLE oauth_authorization_codes
        ADD COLUMN IF NOT EXISTS package_id TEXT;
      ALTER TABLE oauth_refresh_tokens
        ADD COLUMN IF NOT EXISTS package_id TEXT;
      ALTER TABLE oauth_refresh_tokens
        ALTER COLUMN grant_id DROP NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_pg_tokens_package_id
        ON tokens(package_id);
      CREATE INDEX IF NOT EXISTS idx_pg_oauth_refresh_tokens_package
        ON oauth_refresh_tokens(package_id, status);
      CREATE INDEX IF NOT EXISTS idx_pg_oauth_authorization_codes_package
        ON oauth_authorization_codes(package_id, status);

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

      CREATE TABLE IF NOT EXISTS web_push_subscriptions (
        id TEXT PRIMARY KEY,
        owner_subject_id TEXT NOT NULL,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revoked_at TEXT,
        last_success_at TEXT,
        last_failure_at TEXT,
        last_failure_reason TEXT,
        last_used_at TEXT,
        user_agent TEXT,
        platform TEXT,
        device_label TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pg_web_push_subscriptions_owner_active
        ON web_push_subscriptions(owner_subject_id, revoked_at, updated_at);

      CREATE TABLE IF NOT EXISTS device_exporters (
        device_id TEXT PRIMARY KEY,
        owner_subject_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        agent_version TEXT,
        collector_protocol_version TEXT,
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
        connector_instance_id TEXT,
        local_binding_id TEXT NOT NULL,
        display_name TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        last_error_json JSONB,
        last_heartbeat_at TEXT,
        last_heartbeat_status TEXT,
        records_pending INTEGER,
        outbox_diagnostics_json JSONB,
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

      CREATE TABLE IF NOT EXISTS source_webhook_events (
        source_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        received_at TEXT NOT NULL,
        PRIMARY KEY(source_id, event_id)
      );

      CREATE TABLE IF NOT EXISTS connector_state (
        connector_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        state_json JSONB NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(connector_instance_id, stream)
      );

      CREATE TABLE IF NOT EXISTS grant_connector_state (
        grant_id TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        state_json JSONB NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(grant_id, connector_instance_id, stream)
      );

      CREATE TABLE IF NOT EXISTS connector_detail_gaps (
        gap_id TEXT PRIMARY KEY,
        connector_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        grant_id TEXT,
        source_json JSONB NOT NULL,
        stream TEXT NOT NULL,
        parent_stream TEXT,
        record_key TEXT,
        detail_locator_json JSONB,
        list_cursor_json JSONB,
        scope_json JSONB,
        reason TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'recovered', 'terminal')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        next_attempt_after TEXT,
        last_error_json JSONB,
        discovered_run_id TEXT,
        last_run_id TEXT,
        recovered_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_pg_connector_detail_gaps_identity
        ON connector_detail_gaps(connector_id, COALESCE(grant_id, ''), stream, COALESCE(parent_stream, ''), COALESCE(record_key, ''), COALESCE(detail_locator_json::text, ''));
      CREATE INDEX IF NOT EXISTS idx_pg_connector_detail_gaps_pending
        ON connector_detail_gaps(connector_id, grant_id, status, stream, next_attempt_after);

      CREATE TABLE IF NOT EXISTS connector_attention_records (
        attention_id TEXT PRIMARY KEY,
        dedupe_key TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        run_id TEXT,
        reason_code TEXT NOT NULL,
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('open', 'acknowledged', 'in_progress', 'resolved', 'expired', 'cancelled', 'superseded')),
        sensitivity TEXT NOT NULL CHECK (sensitivity IN ('none', 'non_secret', 'secret')),
        expires_at TEXT,
        record_json JSONB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pg_connector_attention_open
        ON connector_attention_records(connector_id, connector_instance_id, lifecycle, updated_at);
      CREATE INDEX IF NOT EXISTS idx_pg_connector_attention_dedupe
        ON connector_attention_records(connector_id, connector_instance_id, dedupe_key, lifecycle);

      CREATE TABLE IF NOT EXISTS connector_schedules (
        connector_instance_id TEXT PRIMARY KEY,
        connector_id TEXT NOT NULL,
        interval_seconds INTEGER NOT NULL,
        jitter_seconds INTEGER NOT NULL DEFAULT 0,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS controller_active_runs (
        connector_instance_id TEXT PRIMARY KEY,
        connector_id TEXT NOT NULL,
        run_id TEXT NOT NULL UNIQUE,
        trace_id TEXT NOT NULL,
        scenario_id TEXT NOT NULL,
        started_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_pg_controller_active_runs_run_id
        ON controller_active_runs(run_id);

      CREATE TABLE IF NOT EXISTS browser_surfaces (
        surface_id TEXT PRIMARY KEY,
        backend TEXT NOT NULL CHECK (backend IN ('neko')),
        profile_key TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        surface_subject_id TEXT,
        account_key TEXT,
        surface_mode TEXT CHECK (surface_mode IS NULL OR surface_mode IN ('static', 'dynamic')),
        surface_source TEXT,
        cdp_url TEXT NOT NULL,
        stream_base_url TEXT NOT NULL,
        stream_origin TEXT,
        health TEXT NOT NULL CHECK (health IN ('starting', 'ready', 'unhealthy', 'stopping')),
        container_id TEXT,
        container_name TEXT,
        profile_dir TEXT,
        profile_volume TEXT,
        active_lease_id TEXT,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_pg_browser_surfaces_profile_health
        ON browser_surfaces(backend, profile_key, health, last_used_at);

      CREATE INDEX IF NOT EXISTS idx_pg_browser_surfaces_active_lease
        ON browser_surfaces(active_lease_id)
        WHERE active_lease_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS browser_surface_leases (
        lease_id TEXT PRIMARY KEY,
        surface_id TEXT REFERENCES browser_surfaces(surface_id),
        connector_id TEXT NOT NULL,
        profile_key TEXT NOT NULL,
        surface_subject_id TEXT,
        account_key TEXT,
        run_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'waiting_for_browser_surface',
          'starting_surface',
          'leased',
          'released',
          'expired',
          'deferred',
          'cancelled',
          'surface_failed'
        )),
        priority_class TEXT NOT NULL CHECK (priority_class IN ('owner_interactive', 'scheduled_refresh')),
        requested_at TEXT NOT NULL,
        leased_at TEXT,
        released_at TEXT,
        expires_at TEXT NOT NULL,
        fencing_token INTEGER NOT NULL,
        wait_reason TEXT CHECK (wait_reason IS NULL OR wait_reason IN (
          'capacity_full',
          'surface_starting',
          'surface_unhealthy',
          'surface_start_failed',
          'surface_readiness_timeout',
          'incompatible_static_profile',
          'launch_precondition_failed',
          'lease_wait_timeout'
        ))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_browser_surface_leases_one_non_terminal_run
        ON browser_surface_leases(run_id)
        WHERE status NOT IN ('released', 'expired', 'deferred', 'cancelled', 'surface_failed');

      CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_browser_surface_leases_one_active_surface
        ON browser_surface_leases(surface_id)
        WHERE surface_id IS NOT NULL AND status = 'leased';

      ALTER TABLE browser_surface_leases
        ADD COLUMN IF NOT EXISTS surface_subject_id TEXT;

      DROP INDEX IF EXISTS idx_pg_browser_surface_leases_one_pending_connector_profile;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_browser_surface_leases_one_pending_connector_profile
        ON browser_surface_leases(connector_id, profile_key, COALESCE(surface_subject_id, ''), COALESCE(account_key, ''))
        WHERE status IN ('waiting_for_browser_surface', 'starting_surface');

      CREATE INDEX IF NOT EXISTS idx_pg_browser_surface_leases_non_terminal
        ON browser_surface_leases(status, priority_class, requested_at);

      ALTER TABLE browser_surfaces
        ADD COLUMN IF NOT EXISTS surface_subject_id TEXT,
        ADD COLUMN IF NOT EXISTS surface_mode TEXT CHECK (surface_mode IS NULL OR surface_mode IN ('static', 'dynamic')),
        ADD COLUMN IF NOT EXISTS surface_source TEXT,
        ADD COLUMN IF NOT EXISTS stream_origin TEXT,
        ADD COLUMN IF NOT EXISTS container_name TEXT,
        ADD COLUMN IF NOT EXISTS profile_dir TEXT,
        ADD COLUMN IF NOT EXISTS profile_volume TEXT;

      ALTER TABLE browser_surface_leases
        DROP CONSTRAINT IF EXISTS browser_surface_leases_status_check,
        DROP CONSTRAINT IF EXISTS browser_surface_leases_wait_reason_check;

      ALTER TABLE browser_surface_leases
        ADD CONSTRAINT browser_surface_leases_status_check CHECK (status IN (
          'waiting_for_browser_surface',
          'starting_surface',
          'leased',
          'released',
          'expired',
          'deferred',
          'cancelled',
          'surface_failed'
        )),
        ADD CONSTRAINT browser_surface_leases_wait_reason_check CHECK (wait_reason IS NULL OR wait_reason IN (
          'capacity_full',
          'surface_starting',
          'surface_unhealthy',
          'surface_start_failed',
          'surface_readiness_timeout',
          'incompatible_static_profile',
          'launch_precondition_failed',
          'lease_wait_timeout'
        ));

      CREATE TABLE IF NOT EXISTS scheduler_run_history (
        id BIGSERIAL PRIMARY KEY,
        connector_instance_id TEXT NOT NULL,
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
        connector_instance_id TEXT PRIMARY KEY,
        connector_id TEXT NOT NULL,
        last_run_time_ms BIGINT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS records (
        id BIGSERIAL PRIMARY KEY,
        connector_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        record_key TEXT NOT NULL,
        record_json JSONB NOT NULL,
        emitted_at TEXT NOT NULL,
        version BIGINT NOT NULL DEFAULT 1,
        deleted BOOLEAN NOT NULL DEFAULT FALSE,
        deleted_at TEXT,
        cursor_value TEXT,
        primary_key_text TEXT NOT NULL,
        UNIQUE(connector_instance_id, stream, record_key)
      );
      CREATE TABLE IF NOT EXISTS record_changes (
        connector_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        record_key TEXT NOT NULL,
        version BIGINT NOT NULL,
        record_json JSONB,
        emitted_at TEXT NOT NULL,
        deleted BOOLEAN NOT NULL DEFAULT FALSE,
        deleted_at TEXT,
        PRIMARY KEY(connector_instance_id, stream, version)
      );
      CREATE TABLE IF NOT EXISTS version_counter (
        connector_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        max_version BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY(connector_instance_id, stream)
      );

      CREATE TABLE IF NOT EXISTS blobs (
        blob_id TEXT PRIMARY KEY,
        connector_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
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
        connector_instance_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        record_key TEXT NOT NULL,
        json_path TEXT NOT NULL DEFAULT '@record',
        PRIMARY KEY(blob_id, connector_instance_id, stream, record_key, json_path),
        FOREIGN KEY(blob_id) REFERENCES blobs(blob_id) ON DELETE CASCADE,
        CONSTRAINT blob_bindings_json_path_shape
          CHECK (json_path = '@record' OR json_path LIKE '/%')
      );
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
        connector_instance_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        record_key TEXT NOT NULL,
        field TEXT NOT NULL,
        value TEXT NOT NULL,
        document TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', value)) STORED,
        PRIMARY KEY(connector_instance_id, stream, record_key, field)
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
        connector_instance_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        fields_fingerprint TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(connector_instance_id, stream)
      );

      CREATE TABLE IF NOT EXISTS semantic_search_blob (
        connector_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        record_key TEXT NOT NULL,
        embedding JSONB NOT NULL,
        PRIMARY KEY(connector_instance_id, scope_key, record_key)
      );
      CREATE TABLE IF NOT EXISTS semantic_search_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        query TEXT NOT NULL,
        plan_hash TEXT NOT NULL,
        results_json JSONB NOT NULL,
        created_at TEXT NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::text
      );

      CREATE TABLE IF NOT EXISTS semantic_search_meta (
        connector_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        fields_fingerprint TEXT NOT NULL,
        model_id TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        distance_metric TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(connector_instance_id, stream)
      );

      CREATE TABLE IF NOT EXISTS semantic_search_backfill_progress (
        connector_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        fields_fingerprint TEXT NOT NULL,
        model_id TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        distance_metric TEXT NOT NULL,
        cursor_key TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(connector_instance_id, stream)
      );

      -- Retained-size read model (reference-only, owner-facing).
      -- See openspec/changes/add-retained-size-read-model/ for spec delta.
      -- Mirrors the SQLite schema in db.js; same column meaning so the
      -- backend-agnostic projection module can issue the same statements.
      CREATE TABLE IF NOT EXISTS retained_size_global (
        projection_key            TEXT PRIMARY KEY,
        current_record_json_bytes BIGINT NOT NULL DEFAULT 0,
        record_history_json_bytes BIGINT NOT NULL DEFAULT 0,
        blob_bytes                BIGINT NOT NULL DEFAULT 0,
        record_count              BIGINT NOT NULL DEFAULT 0,
        record_history_count      BIGINT NOT NULL DEFAULT 0,
        blob_count                BIGINT NOT NULL DEFAULT 0,
        dirty                     INTEGER NOT NULL DEFAULT 1,
        computed_at               TEXT,
        metadata_json             JSONB
      );

      CREATE TABLE IF NOT EXISTS retained_size_connection (
        connector_instance_id     TEXT PRIMARY KEY,
        connector_id              TEXT NOT NULL,
        current_record_json_bytes BIGINT NOT NULL DEFAULT 0,
        record_history_json_bytes BIGINT NOT NULL DEFAULT 0,
        blob_bytes                BIGINT NOT NULL DEFAULT 0,
        record_count              BIGINT NOT NULL DEFAULT 0,
        record_history_count      BIGINT NOT NULL DEFAULT 0,
        blob_count                BIGINT NOT NULL DEFAULT 0,
        dirty                     INTEGER NOT NULL DEFAULT 1,
        computed_at               TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pg_retained_size_connection_connector
        ON retained_size_connection(connector_id);

      CREATE TABLE IF NOT EXISTS retained_size_stream (
        connector_instance_id     TEXT NOT NULL,
        connector_id              TEXT NOT NULL,
        stream                    TEXT NOT NULL,
        current_record_json_bytes BIGINT NOT NULL DEFAULT 0,
        record_history_json_bytes BIGINT NOT NULL DEFAULT 0,
        blob_bytes                BIGINT NOT NULL DEFAULT 0,
        record_count              BIGINT NOT NULL DEFAULT 0,
        record_history_count      BIGINT NOT NULL DEFAULT 0,
        blob_count                BIGINT NOT NULL DEFAULT 0,
        dirty                     INTEGER NOT NULL DEFAULT 1,
        computed_at               TEXT,
        PRIMARY KEY(connector_instance_id, stream)
      );

      CREATE TABLE IF NOT EXISTS retained_size_record_family (
        connector_instance_id     TEXT NOT NULL,
        connector_id              TEXT NOT NULL,
        stream                    TEXT NOT NULL,
        record_family             TEXT NOT NULL,
        current_record_json_bytes BIGINT NOT NULL DEFAULT 0,
        record_history_json_bytes BIGINT NOT NULL DEFAULT 0,
        blob_bytes                BIGINT NOT NULL DEFAULT 0,
        record_count              BIGINT NOT NULL DEFAULT 0,
        record_history_count      BIGINT NOT NULL DEFAULT 0,
        blob_count                BIGINT NOT NULL DEFAULT 0,
        dirty                     INTEGER NOT NULL DEFAULT 1,
        computed_at               TEXT,
        PRIMARY KEY(connector_instance_id, stream, record_family)
      );

      CREATE TABLE IF NOT EXISTS retained_size_top_rows (
        scope                     TEXT NOT NULL,
        measure                   TEXT NOT NULL,
        rank                      INTEGER NOT NULL,
        grain_key                 TEXT NOT NULL,
        connector_instance_id     TEXT,
        connector_id              TEXT,
        stream                    TEXT,
        record_key                TEXT,
        blob_id                   TEXT,
        current_record_json_bytes BIGINT NOT NULL DEFAULT 0,
        record_history_json_bytes BIGINT NOT NULL DEFAULT 0,
        blob_bytes                BIGINT NOT NULL DEFAULT 0,
        total_retained_bytes      BIGINT NOT NULL DEFAULT 0,
        record_count              BIGINT NOT NULL DEFAULT 0,
        record_history_count      BIGINT NOT NULL DEFAULT 0,
        blob_count                BIGINT NOT NULL DEFAULT 0,
        dirty                     INTEGER NOT NULL DEFAULT 1,
        computed_at               TEXT,
        metadata_json             JSONB,
        PRIMARY KEY(scope, measure, rank)
      );
      CREATE INDEX IF NOT EXISTS idx_pg_retained_size_top_rows_lookup
        ON retained_size_top_rows(scope, measure, total_retained_bytes DESC, rank ASC);

      -- Outbound event subscriptions (RI extension). Client subscriptions are
      -- grant-scoped; trusted owner-agent subscriptions are owner-scoped.
      -- Mirrors the SQLite schema in db.js; the Postgres-backed store applies
      -- the same operation semantics over pg.
      CREATE TABLE IF NOT EXISTS client_event_subscriptions (
        subscription_id        TEXT PRIMARY KEY,
        authority_kind         TEXT NOT NULL DEFAULT 'client_grant' CHECK (
          authority_kind IN ('client_grant', 'trusted_owner_agent')
        ),
        grant_id               TEXT,
        client_id              TEXT NOT NULL,
        subject_id             TEXT NOT NULL,
        callback_url           TEXT NOT NULL,
        secret_hash            TEXT NOT NULL,
        secret_text            TEXT NOT NULL,
        scope_json             JSONB NOT NULL,
        status                 TEXT NOT NULL CHECK (status IN (
          'pending_verification',
          'active',
          'disabled',
          'disabled_failure',
          'disabled_revoked',
          'deleted'
        )),
        verification_challenge TEXT,
        created_at             TEXT NOT NULL,
        updated_at             TEXT NOT NULL,
        disabled_at            TEXT,
        disabled_reason        TEXT,
        CHECK (
          (authority_kind = 'client_grant' AND grant_id IS NOT NULL)
          OR (authority_kind = 'trusted_owner_agent' AND grant_id IS NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS idx_pg_client_event_subscriptions_client
        ON client_event_subscriptions(client_id, status);
      CREATE INDEX IF NOT EXISTS idx_pg_client_event_subscriptions_grant
        ON client_event_subscriptions(grant_id);

      CREATE TABLE IF NOT EXISTS client_event_queue (
        queue_id        BIGSERIAL PRIMARY KEY,
        subscription_id TEXT NOT NULL,
        event_id        TEXT NOT NULL UNIQUE,
        event_type      TEXT NOT NULL,
        payload_json    JSONB NOT NULL,
        enqueued_at     TEXT NOT NULL,
        next_attempt_at TEXT NOT NULL,
        attempt_count   INTEGER NOT NULL DEFAULT 0,
        status          TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'final_failure', 'dropped')),
        last_error      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pg_client_event_queue_due
        ON client_event_queue(status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_pg_client_event_queue_subscription
        ON client_event_queue(subscription_id, status);

      CREATE TABLE IF NOT EXISTS client_event_attempts (
        attempt_id       BIGSERIAL PRIMARY KEY,
        queue_id         BIGINT NOT NULL,
        attempted_at     TEXT NOT NULL,
        status_code      INTEGER,
        ok               INTEGER NOT NULL DEFAULT 0,
        latency_ms       INTEGER,
        error            TEXT,
        response_snippet TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pg_client_event_attempts_queue
        ON client_event_attempts(queue_id, attempt_id);
    `);
    await migratePostgresSpineSourceColumns(client);
    await migratePostgresDeviceExporterColumns(client);
    await migratePostgresBlobBindingsJsonPath(client);
    await migratePostgresConnectorSyncStateInstanceColumns(client);
    await migratePostgresConnectorDetailGapInstanceColumns(client);
    await migratePostgresSchedulerInstanceColumns(client);
    await migratePostgresRecordsBlobSearchInstanceColumns(client);
    await migratePostgresClientEventSubscriptionAuthority(client);
    await migratePostgresLocalDeviceConnectorInstances(client);
    await migratePostgresLegacyConnectorInstancesToDefaultAccount(client);
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

async function migratePostgresClientEventSubscriptionAuthority(client) {
  await client.query(
    `ALTER TABLE client_event_subscriptions
       ADD COLUMN IF NOT EXISTS authority_kind TEXT NOT NULL DEFAULT 'client_grant'`,
  );
  await client.query(
    `UPDATE client_event_subscriptions
        SET authority_kind = 'client_grant'
      WHERE authority_kind IS NULL`,
  );
  await client.query(`ALTER TABLE client_event_subscriptions ALTER COLUMN grant_id DROP NOT NULL`);
  await client.query(
    `ALTER TABLE client_event_subscriptions
       DROP CONSTRAINT IF EXISTS client_event_subscriptions_authority_kind_check`,
  );
  await client.query(
    `ALTER TABLE client_event_subscriptions
       ADD CONSTRAINT client_event_subscriptions_authority_kind_check
       CHECK (authority_kind IN ('client_grant', 'trusted_owner_agent'))`,
  );
  await client.query(
    `ALTER TABLE client_event_subscriptions
       DROP CONSTRAINT IF EXISTS client_event_subscriptions_authority_grant_check`,
  );
  await client.query(
    `ALTER TABLE client_event_subscriptions
       ADD CONSTRAINT client_event_subscriptions_authority_grant_check
       CHECK (
         (authority_kind = 'client_grant' AND grant_id IS NOT NULL)
         OR (authority_kind = 'trusted_owner_agent' AND grant_id IS NULL)
       )`,
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_pg_client_event_subscriptions_authority
       ON client_event_subscriptions(authority_kind, subject_id, client_id, status)`,
  );
}

function makeDefaultAccountConnectorInstanceId(ownerSubjectId, connectorId) {
  const hash = hashKey(`${ownerSubjectId}\n${connectorId}\naccount\ndefault`);
  return `cin_${hash.slice(0, 24)}`;
}

async function defaultConnectorInstanceIdForBackfill(client, connectorId) {
  const result = await client.query(
    `SELECT connector_instance_id
       FROM connector_instances
      WHERE connector_id = $1
      ORDER BY connector_instance_id`,
    [connectorId],
  );
  if (result.rows.length === 1) {
    return result.rows[0].connector_instance_id;
  }
  return makeDefaultAccountConnectorInstanceId(LEGACY_SYNC_STATE_OWNER_SUBJECT_ID, connectorId);
}

async function migratePostgresConnectorSyncStateInstanceColumns(client) {
  const hasOwnerColumn = await hasPostgresColumn(client, 'connector_state', 'connector_instance_id');
  const hasGrantColumn = await hasPostgresColumn(client, 'grant_connector_state', 'connector_instance_id');
  if (hasOwnerColumn && hasGrantColumn) {
    return;
  }

  await client.query('BEGIN');
  try {
    const ownerRows = hasOwnerColumn
      ? { rows: [] }
      : await client.query(
          `SELECT connector_id, stream, state_json, updated_at
             FROM connector_state
            ORDER BY connector_id, stream`
        );
    const grantRows = hasGrantColumn
      ? { rows: [] }
      : await client.query(
          `SELECT grant_id, connector_id, stream, state_json, updated_at
             FROM grant_connector_state
            ORDER BY grant_id, connector_id, stream`
        );
    const instanceIds = new Map();
    const resolveInstanceId = async (connectorId) => {
      if (!instanceIds.has(connectorId)) {
        instanceIds.set(connectorId, await defaultConnectorInstanceIdForBackfill(client, connectorId));
      }
      return instanceIds.get(connectorId);
    };

    if (!hasOwnerColumn) {
      await client.query('ALTER TABLE connector_state DROP CONSTRAINT IF EXISTS connector_state_pkey');
      await client.query('ALTER TABLE connector_state ADD COLUMN connector_instance_id TEXT');
      for (const row of ownerRows.rows) {
        await client.query(
          `UPDATE connector_state
              SET connector_instance_id = $1
            WHERE connector_id = $2 AND stream = $3`,
          [await resolveInstanceId(row.connector_id), row.connector_id, row.stream],
        );
      }
      await client.query('ALTER TABLE connector_state ALTER COLUMN connector_instance_id SET NOT NULL');
      await client.query('ALTER TABLE connector_state ADD CONSTRAINT connector_state_pkey PRIMARY KEY (connector_instance_id, stream)');
    }

    if (!hasGrantColumn) {
      await client.query('ALTER TABLE grant_connector_state DROP CONSTRAINT IF EXISTS grant_connector_state_pkey');
      await client.query('ALTER TABLE grant_connector_state ADD COLUMN connector_instance_id TEXT');
      for (const row of grantRows.rows) {
        await client.query(
          `UPDATE grant_connector_state
              SET connector_instance_id = $1
            WHERE grant_id = $2 AND connector_id = $3 AND stream = $4`,
          [await resolveInstanceId(row.connector_id), row.grant_id, row.connector_id, row.stream],
        );
      }
      await client.query('ALTER TABLE grant_connector_state ALTER COLUMN connector_instance_id SET NOT NULL');
      await client.query('ALTER TABLE grant_connector_state ADD CONSTRAINT grant_connector_state_pkey PRIMARY KEY (grant_id, connector_instance_id, stream)');
    }

    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw err;
  }
}

async function migratePostgresConnectorDetailGapInstanceColumns(client) {
  const hasInstance = await hasPostgresColumn(client, 'connector_detail_gaps', 'connector_instance_id');
  if (!hasInstance) {
    await client.query('ALTER TABLE connector_detail_gaps ADD COLUMN connector_instance_id TEXT');
    const rows = await client.query('SELECT gap_id, connector_id FROM connector_detail_gaps ORDER BY gap_id');
    const instanceIds = new Map();
    const resolveInstanceId = async (connectorId) => {
      if (!instanceIds.has(connectorId)) {
        instanceIds.set(connectorId, await defaultConnectorInstanceIdForBackfill(client, connectorId));
      }
      return instanceIds.get(connectorId);
    };
    for (const row of rows.rows) {
      await client.query(
        'UPDATE connector_detail_gaps SET connector_instance_id = $1 WHERE gap_id = $2',
        [await resolveInstanceId(row.connector_id), row.gap_id],
      );
    }
    await client.query('ALTER TABLE connector_detail_gaps ALTER COLUMN connector_instance_id SET NOT NULL');
  }

  await client.query('DROP INDEX IF EXISTS uniq_pg_connector_detail_gaps_identity');
  await client.query('DROP INDEX IF EXISTS idx_pg_connector_detail_gaps_pending');
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_pg_connector_detail_gaps_identity
      ON connector_detail_gaps(connector_instance_id, COALESCE(grant_id, ''), stream, COALESCE(parent_stream, ''), COALESCE(record_key, ''), COALESCE(detail_locator_json::text, ''))
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_pg_connector_detail_gaps_pending
      ON connector_detail_gaps(connector_instance_id, grant_id, status, stream, next_attempt_after)
  `);
}

async function migratePostgresSchedulerInstanceColumns(client) {
  const scheduleHasInstance = await hasPostgresColumn(client, 'connector_schedules', 'connector_instance_id');
  const activeRunHasInstance = await hasPostgresColumn(client, 'controller_active_runs', 'connector_instance_id');
  const historyHasInstance = await hasPostgresColumn(client, 'scheduler_run_history', 'connector_instance_id');
  const lastRunHasInstance = await hasPostgresColumn(client, 'scheduler_last_run_times', 'connector_instance_id');
  if (scheduleHasInstance && activeRunHasInstance && historyHasInstance && lastRunHasInstance) {
    return;
  }

  await client.query('BEGIN');
  try {
    const instanceIds = new Map();
    const resolveInstanceId = async (connectorId) => {
      if (!instanceIds.has(connectorId)) {
        instanceIds.set(connectorId, await defaultConnectorInstanceIdForBackfill(client, connectorId));
      }
      return instanceIds.get(connectorId);
    };

    if (!scheduleHasInstance) {
      const rows = await client.query('SELECT connector_id FROM connector_schedules ORDER BY connector_id');
      await client.query('ALTER TABLE connector_schedules DROP CONSTRAINT IF EXISTS connector_schedules_pkey');
      await client.query('ALTER TABLE connector_schedules ADD COLUMN connector_instance_id TEXT');
      for (const row of rows.rows) {
        await client.query(
          'UPDATE connector_schedules SET connector_instance_id = $1 WHERE connector_id = $2',
          [await resolveInstanceId(row.connector_id), row.connector_id],
        );
      }
      await client.query('ALTER TABLE connector_schedules ALTER COLUMN connector_instance_id SET NOT NULL');
      await client.query('ALTER TABLE connector_schedules ADD CONSTRAINT connector_schedules_pkey PRIMARY KEY (connector_instance_id)');
    }

    if (!activeRunHasInstance) {
      const rows = await client.query('SELECT connector_id FROM controller_active_runs ORDER BY connector_id');
      await client.query('ALTER TABLE controller_active_runs DROP CONSTRAINT IF EXISTS controller_active_runs_pkey');
      await client.query('ALTER TABLE controller_active_runs ADD COLUMN connector_instance_id TEXT');
      for (const row of rows.rows) {
        await client.query(
          'UPDATE controller_active_runs SET connector_instance_id = $1 WHERE connector_id = $2',
          [await resolveInstanceId(row.connector_id), row.connector_id],
        );
      }
      await client.query('ALTER TABLE controller_active_runs ALTER COLUMN connector_instance_id SET NOT NULL');
      await client.query('ALTER TABLE controller_active_runs ADD CONSTRAINT controller_active_runs_pkey PRIMARY KEY (connector_instance_id)');
    }

    if (!historyHasInstance) {
      const rows = await client.query('SELECT id, connector_id FROM scheduler_run_history ORDER BY id');
      await client.query('ALTER TABLE scheduler_run_history ADD COLUMN connector_instance_id TEXT');
      for (const row of rows.rows) {
        await client.query(
          'UPDATE scheduler_run_history SET connector_instance_id = $1 WHERE id = $2',
          [await resolveInstanceId(row.connector_id), row.id],
        );
      }
      await client.query('ALTER TABLE scheduler_run_history ALTER COLUMN connector_instance_id SET NOT NULL');
    }

    if (!lastRunHasInstance) {
      const rows = await client.query('SELECT connector_id FROM scheduler_last_run_times ORDER BY connector_id');
      await client.query('ALTER TABLE scheduler_last_run_times DROP CONSTRAINT IF EXISTS scheduler_last_run_times_pkey');
      await client.query('ALTER TABLE scheduler_last_run_times ADD COLUMN connector_instance_id TEXT');
      for (const row of rows.rows) {
        await client.query(
          'UPDATE scheduler_last_run_times SET connector_instance_id = $1 WHERE connector_id = $2',
          [await resolveInstanceId(row.connector_id), row.connector_id],
        );
      }
      await client.query('ALTER TABLE scheduler_last_run_times ALTER COLUMN connector_instance_id SET NOT NULL');
      await client.query('ALTER TABLE scheduler_last_run_times ADD CONSTRAINT scheduler_last_run_times_pkey PRIMARY KEY (connector_instance_id)');
    }

    await client.query('DROP INDEX IF EXISTS idx_pg_scheduler_run_history_connector_completed');
    await client.query('CREATE INDEX IF NOT EXISTS idx_pg_scheduler_run_history_connector_completed ON scheduler_run_history(connector_instance_id, completed_at, id)');
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw err;
  }
}

async function migratePostgresRecordsBlobSearchInstanceColumns(client) {
  const checks = [];
  for (const table of [
    'records',
    'record_changes',
    'version_counter',
    'blobs',
    'blob_bindings',
    'lexical_search_index',
    'lexical_search_meta',
    'semantic_search_blob',
    'semantic_search_meta',
    'semantic_search_backfill_progress',
  ]) {
    checks.push(await hasPostgresColumn(client, table, 'connector_instance_id'));
  }
  await client.query("ALTER TABLE semantic_search_backfill_progress ADD COLUMN IF NOT EXISTS fields_fingerprint TEXT");
  if (checks.every(Boolean)) {
    await ensurePostgresRecordsBlobSearchInstanceIndexes(client);
    return;
  }

  await client.query('BEGIN');
  try {
    const instanceIds = new Map();
    const resolveInstanceId = async (connectorId) => {
      if (!instanceIds.has(connectorId)) {
        instanceIds.set(connectorId, await defaultConnectorInstanceIdForBackfill(client, connectorId));
      }
      return instanceIds.get(connectorId);
    };

    const backfillTableByConnector = async (table, connectorColumn = 'connector_id') => {
      const rows = await client.query(`SELECT DISTINCT ${connectorColumn} AS connector_id FROM ${table} WHERE connector_instance_id IS NULL ORDER BY ${connectorColumn}`);
      for (const row of rows.rows) {
        await client.query(
          `UPDATE ${table} SET connector_instance_id = $1 WHERE ${connectorColumn} = $2 AND connector_instance_id IS NULL`,
          [await resolveInstanceId(row.connector_id), row.connector_id],
        );
      }
    };

    if (!checks[0]) {
      await client.query('ALTER TABLE records DROP CONSTRAINT IF EXISTS records_connector_id_stream_record_key_key');
      await client.query('ALTER TABLE records ADD COLUMN connector_instance_id TEXT');
      await backfillTableByConnector('records');
      await client.query('ALTER TABLE records ALTER COLUMN connector_instance_id SET NOT NULL');
      await client.query('ALTER TABLE records ADD CONSTRAINT records_connector_instance_stream_key UNIQUE(connector_instance_id, stream, record_key)');
    }

    if (!checks[1]) {
      await client.query('ALTER TABLE record_changes DROP CONSTRAINT IF EXISTS record_changes_pkey');
      await client.query('ALTER TABLE record_changes ADD COLUMN connector_instance_id TEXT');
      await backfillTableByConnector('record_changes');
      await client.query('ALTER TABLE record_changes ALTER COLUMN connector_instance_id SET NOT NULL');
      await client.query('ALTER TABLE record_changes ADD CONSTRAINT record_changes_pkey PRIMARY KEY(connector_instance_id, stream, version)');
    }

    if (!checks[2]) {
      await client.query('ALTER TABLE version_counter DROP CONSTRAINT IF EXISTS version_counter_pkey');
      await client.query('ALTER TABLE version_counter ADD COLUMN connector_instance_id TEXT');
      await backfillTableByConnector('version_counter');
      await client.query('ALTER TABLE version_counter ALTER COLUMN connector_instance_id SET NOT NULL');
      await client.query('ALTER TABLE version_counter ADD CONSTRAINT version_counter_pkey PRIMARY KEY(connector_instance_id, stream)');
    }

    if (!checks[3]) {
      await client.query('ALTER TABLE blobs ADD COLUMN connector_instance_id TEXT');
      await backfillTableByConnector('blobs');
      await client.query('ALTER TABLE blobs ALTER COLUMN connector_instance_id SET NOT NULL');
    }

    if (!checks[4]) {
      await client.query('ALTER TABLE blob_bindings DROP CONSTRAINT IF EXISTS blob_bindings_pkey');
      await client.query('ALTER TABLE blob_bindings ADD COLUMN connector_instance_id TEXT');
      await backfillTableByConnector('blob_bindings');
      await client.query('ALTER TABLE blob_bindings ALTER COLUMN connector_instance_id SET NOT NULL');
      await client.query('ALTER TABLE blob_bindings ADD CONSTRAINT blob_bindings_pkey PRIMARY KEY(blob_id, connector_instance_id, stream, record_key, json_path)');
    }

    if (!checks[5]) {
      await client.query('ALTER TABLE lexical_search_index DROP CONSTRAINT IF EXISTS lexical_search_index_pkey');
      await client.query('ALTER TABLE lexical_search_index ADD COLUMN connector_instance_id TEXT');
      await backfillTableByConnector('lexical_search_index');
      await client.query('ALTER TABLE lexical_search_index ALTER COLUMN connector_instance_id SET NOT NULL');
      await client.query('ALTER TABLE lexical_search_index ADD CONSTRAINT lexical_search_index_pkey PRIMARY KEY(connector_instance_id, stream, record_key, field)');
    }

    if (!checks[6]) {
      await client.query('ALTER TABLE lexical_search_meta DROP CONSTRAINT IF EXISTS lexical_search_meta_pkey');
      await client.query('ALTER TABLE lexical_search_meta ADD COLUMN connector_instance_id TEXT');
      await backfillTableByConnector('lexical_search_meta');
      await client.query('ALTER TABLE lexical_search_meta ALTER COLUMN connector_instance_id SET NOT NULL');
      await client.query('ALTER TABLE lexical_search_meta ADD CONSTRAINT lexical_search_meta_pkey PRIMARY KEY(connector_instance_id, stream)');
    }

    if (!checks[7]) {
      await client.query('ALTER TABLE semantic_search_blob DROP CONSTRAINT IF EXISTS semantic_search_blob_pkey');
      await client.query('ALTER TABLE semantic_search_blob ADD COLUMN connector_instance_id TEXT');
      await backfillTableByConnector('semantic_search_blob');
      await client.query('ALTER TABLE semantic_search_blob ALTER COLUMN connector_instance_id SET NOT NULL');
      await client.query('ALTER TABLE semantic_search_blob ADD CONSTRAINT semantic_search_blob_pkey PRIMARY KEY(connector_instance_id, scope_key, record_key)');
    }

    if (!checks[8]) {
      await client.query('ALTER TABLE semantic_search_meta DROP CONSTRAINT IF EXISTS semantic_search_meta_pkey');
      await client.query('ALTER TABLE semantic_search_meta ADD COLUMN connector_instance_id TEXT');
      await backfillTableByConnector('semantic_search_meta');
      await client.query('ALTER TABLE semantic_search_meta ALTER COLUMN connector_instance_id SET NOT NULL');
      await client.query('ALTER TABLE semantic_search_meta ADD CONSTRAINT semantic_search_meta_pkey PRIMARY KEY(connector_instance_id, stream)');
    }

    if (!checks[9]) {
      await client.query('ALTER TABLE semantic_search_backfill_progress DROP CONSTRAINT IF EXISTS semantic_search_backfill_progress_pkey');
      await client.query('ALTER TABLE semantic_search_backfill_progress ADD COLUMN connector_instance_id TEXT');
      await backfillTableByConnector('semantic_search_backfill_progress');
      await client.query('ALTER TABLE semantic_search_backfill_progress ALTER COLUMN connector_instance_id SET NOT NULL');
      await client.query('ALTER TABLE semantic_search_backfill_progress ADD CONSTRAINT semantic_search_backfill_progress_pkey PRIMARY KEY(connector_instance_id, stream)');
    }

    await ensurePostgresRecordsBlobSearchInstanceIndexes(client);
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw err;
  }
}

async function ensurePostgresRecordsBlobSearchInstanceIndexes(client) {
  await client.query('DROP INDEX IF EXISTS idx_pg_records_lookup');
  await client.query('DROP INDEX IF EXISTS idx_pg_records_stream_version');
  await client.query('DROP INDEX IF EXISTS idx_pg_records_stream_cursor');
  await client.query('DROP INDEX IF EXISTS idx_pg_record_changes_record');
  await client.query('DROP INDEX IF EXISTS idx_pg_blob_bindings_record');
  await client.query('DROP INDEX IF EXISTS idx_pg_semantic_search_scope');
  await client.query('CREATE INDEX IF NOT EXISTS idx_pg_records_lookup ON records(connector_instance_id, stream, record_key)');
  await client.query('CREATE INDEX IF NOT EXISTS idx_pg_records_stream_version ON records(connector_instance_id, stream, version)');
  await client.query('CREATE INDEX IF NOT EXISTS idx_pg_records_stream_cursor ON records(connector_instance_id, stream, deleted, cursor_value, primary_key_text)');
  await client.query('CREATE INDEX IF NOT EXISTS idx_pg_records_connector_stream_deleted ON records(connector_id, stream, deleted)');
  await client.query('CREATE INDEX IF NOT EXISTS idx_pg_record_changes_record ON record_changes(connector_instance_id, stream, record_key, version)');
  await client.query('CREATE INDEX IF NOT EXISTS idx_pg_blob_bindings_record ON blob_bindings(connector_instance_id, stream, record_key)');
  await client.query('CREATE INDEX IF NOT EXISTS idx_pg_semantic_search_scope ON semantic_search_blob(connector_instance_id, scope_key)');
}

function localDeviceConnectorId(connectorId) {
  return `local-device:${encodeURIComponent(connectorId)}`;
}

function legacyLocalDeviceConnectorId(connectorId, sourceInstanceId) {
  return `${localDeviceConnectorId(connectorId)}:${encodeURIComponent(sourceInstanceId)}`;
}

async function migratePostgresLocalDeviceConnectorInstances(client) {
  const rows = await client.query(`
    SELECT
      dsi.source_instance_id,
      dsi.device_id,
      dsi.connector_id,
      dsi.connector_instance_id,
      dsi.local_binding_id,
      COALESCE(dsi.display_name, de.display_name, dsi.local_binding_id) AS display_name,
      dsi.status,
      dsi.created_at,
      dsi.updated_at,
      dsi.revoked_at,
      de.owner_subject_id
    FROM device_source_instances dsi
    JOIN device_exporters de ON de.device_id = dsi.device_id
    ORDER BY dsi.created_at, dsi.source_instance_id
  `);

  if (rows.rows.length === 0) {
    return;
  }

  await client.query('BEGIN');
  try {
    for (const row of rows.rows) {
      const sourceBinding = {
        kind: 'local_device',
        device_id: row.device_id,
        local_binding_name: row.local_binding_id,
        source_instance_id: row.source_instance_id,
      };
      const sourceBindingKey = makeConnectorInstanceSourceBindingKey(sourceBinding);
      // Relocate legacy `local-device:<id>:<source>` rows to the bare canonical
      // connector key, mirroring the SQLite migration and the live ingest/read
      // paths. Connection isolation is carried by connector_instance_id. See
      // canonicalize-connector-keys design Decision 7.
      const connectorKey = canonicalConnectorKey(row.connector_id) ?? row.connector_id;
      const newConnectorId = connectorKey;
      const oldConnectorId = legacyLocalDeviceConnectorId(row.connector_id, row.source_instance_id);

      const legacyIds = await client.query(
        `SELECT DISTINCT connector_instance_id
           FROM (
             SELECT connector_instance_id FROM records WHERE connector_id = $1
             UNION
             SELECT connector_instance_id FROM connector_state WHERE connector_id = $1
             UNION
             SELECT connector_instance_id FROM connector_schedules WHERE connector_id = $1
             UNION
             SELECT connector_instance_id FROM controller_active_runs WHERE connector_id = $1
             UNION
             SELECT connector_instance_id FROM scheduler_run_history WHERE connector_id = $1
             UNION
             SELECT connector_instance_id FROM scheduler_last_run_times WHERE connector_id = $1
           ) legacy_ids
          WHERE connector_instance_id IS NOT NULL
          ORDER BY connector_instance_id
          LIMIT 2`,
        [oldConnectorId],
      );
      if (legacyIds.rows.length > 1 && !row.connector_instance_id) {
        throw new Error(`Ambiguous local-device connector instance migration for ${oldConnectorId}`);
      }

      const existingBinding = await client.query(
        `SELECT connector_instance_id
           FROM connector_instances
          WHERE owner_subject_id = $1
            AND connector_id = $2
            AND source_kind = 'local_device'
            AND source_binding_key = $3
          LIMIT 1`,
        [row.owner_subject_id, connectorKey, sourceBindingKey],
      );
      const existingBindingInstanceId = existingBinding.rows[0]?.connector_instance_id || null;
      const legacyInstanceId = legacyIds.rows[0]?.connector_instance_id || null;
      if (row.connector_instance_id && existingBindingInstanceId && existingBindingInstanceId !== row.connector_instance_id) {
        throw new Error(`Conflicting local-device connector instance migration for ${oldConnectorId}`);
      }
      if (legacyInstanceId && existingBindingInstanceId && existingBindingInstanceId !== legacyInstanceId) {
        throw new Error(`Conflicting legacy local-device rows for ${oldConnectorId}`);
      }

      const connectorInstanceId = row.connector_instance_id
        || existingBindingInstanceId
        || legacyInstanceId
        || makeConnectorInstanceId(row.owner_subject_id, connectorKey, 'local_device', sourceBindingKey);
      const now = new Date().toISOString();
      const manifest = {
        connector_id: connectorKey,
        display_name: row.display_name || connectorKey,
        streams: [],
      };

      await client.query(
        `INSERT INTO connectors(connector_id, manifest, created_at)
         VALUES($1, $2::jsonb, $3)
         ON CONFLICT(connector_id) DO NOTHING`,
        [connectorKey, JSON.stringify(manifest), row.created_at || now],
      );

      await client.query(
        `INSERT INTO connector_instances(
           connector_instance_id, owner_subject_id, connector_id, display_name, status,
           source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         )
         VALUES($1, $2, $3, $4, $5, 'local_device', $6, $7::jsonb, $8, $9, $10)
         ON CONFLICT (connector_instance_id) DO UPDATE
           SET owner_subject_id = EXCLUDED.owner_subject_id,
               connector_id = EXCLUDED.connector_id,
               display_name = EXCLUDED.display_name,
               status = EXCLUDED.status,
               source_kind = EXCLUDED.source_kind,
               source_binding_key = EXCLUDED.source_binding_key,
               source_binding_json = EXCLUDED.source_binding_json,
               updated_at = EXCLUDED.updated_at,
               revoked_at = EXCLUDED.revoked_at`,
        [
          connectorInstanceId,
          row.owner_subject_id,
          connectorKey,
          row.display_name,
          row.status === 'revoked' ? 'revoked' : 'active',
          sourceBindingKey,
          JSON.stringify(sourceBinding),
          row.created_at,
          row.updated_at || now,
          row.status === 'revoked' ? (row.revoked_at || row.updated_at || now) : null,
        ],
      );

      await client.query(
        `UPDATE device_source_instances
            SET connector_instance_id = $1,
                connector_id = $2,
                updated_at = CASE WHEN updated_at > $3 THEN updated_at ELSE $3 END
          WHERE device_id = $4 AND source_instance_id = $5`,
        [connectorInstanceId, connectorKey, now, row.device_id, row.source_instance_id],
      );

      for (const table of [
        'connector_state',
        'grant_connector_state',
        'connector_detail_gaps',
        'records',
        'record_changes',
        'version_counter',
        'blobs',
        'blob_bindings',
        'lexical_search_index',
        'lexical_search_meta',
        'semantic_search_blob',
        'semantic_search_meta',
        'semantic_search_backfill_progress',
        'connector_schedules',
        'controller_active_runs',
        'scheduler_run_history',
        'scheduler_last_run_times',
      ]) {
        await client.query(
          `UPDATE ${table}
              SET connector_id = $1
            WHERE connector_id = $2 AND connector_instance_id = $3`,
          [newConnectorId, oldConnectorId, connectorInstanceId],
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw err;
  }
}

const PG_LEGACY_REWRITE_INSTANCE_REFERENCE_TABLES = [
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
  'connector_attention_records',
  'connector_schedules',
  'controller_active_runs',
  'scheduler_run_history',
  'scheduler_last_run_times',
  'device_source_instances',
];

function pgUniqueColumnsForLegacyRewrite(table) {
  switch (table) {
    case 'connector_state':
      return ['stream'];
    case 'grant_connector_state':
      return ['grant_id', 'stream'];
    case 'records':
      return ['stream', 'record_key'];
    case 'record_changes':
      return ['stream', 'version'];
    case 'version_counter':
      return ['stream'];
    case 'blob_bindings':
      return ['blob_id', 'stream', 'record_key', 'json_path'];
    case 'lexical_search_index':
      return ['stream', 'record_key', 'field'];
    case 'lexical_search_meta':
      return ['stream'];
    case 'connector_detail_gaps':
      return ['grant_id', 'stream', 'parent_stream', 'record_key', 'detail_locator_json'];
    case 'semantic_search_meta':
      return ['stream'];
    case 'semantic_search_backfill_progress':
      return ['stream'];
    case 'semantic_search_rowid':
      return ['scope_key', 'record_key'];
    case 'semantic_search_blob':
      return ['scope_key', 'record_key'];
    case 'connector_schedules':
      return [];
    case 'controller_active_runs':
      return [];
    case 'scheduler_last_run_times':
      return [];
    default:
      return null;
  }
}

function pgIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

async function migratePostgresLegacyConnectorInstancesToDefaultAccount(client) {
  await client.query('BEGIN');
  try {
    // Relax/replace the source_kind CHECK constraint inside the same
    // transaction as the rewrite. A failed rewrite must not leave schema
    // DDL advanced while data remains unmigrated.
    const checkInfo = await client.query(
      `SELECT conname
         FROM pg_constraint
        WHERE conrelid = 'connector_instances'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%source_kind%'`,
    );
    for (const row of checkInfo.rows) {
      await client.query(`ALTER TABLE connector_instances DROP CONSTRAINT IF EXISTS ${pgIdentifier(row.conname)}`);
    }
    await client.query(
      `ALTER TABLE connector_instances
         ADD CONSTRAINT connector_instances_source_kind_check
         CHECK (source_kind IN ('account', 'local_device', 'manual'))
         NOT VALID`,
    );

    const legacyRows = await client.query(
      `SELECT connector_instance_id, owner_subject_id, connector_id, display_name, status, created_at, updated_at, revoked_at
         FROM connector_instances
        WHERE source_kind = 'legacy'
        ORDER BY connector_instance_id`,
    );

    // Determine which referencing tables actually have a connector_instance_id column.
    const existingTables = [];
    for (const table of PG_LEGACY_REWRITE_INSTANCE_REFERENCE_TABLES) {
      if (await hasPostgresColumn(client, table, 'connector_instance_id')) {
        existingTables.push(table);
      }
    }

    for (const legacy of legacyRows.rows) {
      const oldId = legacy.connector_instance_id;
      const newId = makeDefaultAccountConnectorInstanceId(legacy.owner_subject_id, legacy.connector_id);
      const now = new Date().toISOString();
      const dest = await client.query(
        `SELECT connector_instance_id
           FROM connector_instances
          WHERE owner_subject_id = $1
            AND connector_id = $2
            AND source_kind = 'account'
            AND source_binding_key = 'default'
          LIMIT 1`,
        [legacy.owner_subject_id, legacy.connector_id],
      );

      if (dest.rows.length === 0) {
        if (oldId === newId) {
          await client.query(
            `UPDATE connector_instances
                SET source_kind = 'account',
                    source_binding_key = 'default',
                    source_binding_json = $1::jsonb,
                    updated_at = $2
              WHERE connector_instance_id = $3`,
            ['{"kind":"default_account"}', now, oldId],
          );
          continue;
        }
        const conflict = await client.query(
          `SELECT 1 FROM connector_instances WHERE connector_instance_id = $1 LIMIT 1`,
          [newId],
        );
        if (conflict.rowCount > 0) {
          throw new Error(
            `Cannot migrate legacy connector_instance ${oldId} → ${newId}: destination id already exists for a non-default-account row.`,
          );
        }
        await client.query(
          `UPDATE connector_instances
              SET connector_instance_id = $1,
                  source_kind = 'account',
                  source_binding_key = 'default',
                  source_binding_json = $2::jsonb,
                  updated_at = $3
            WHERE connector_instance_id = $4`,
          [newId, '{"kind":"default_account"}', now, oldId],
        );
        for (const table of existingTables) {
          await client.query(
            `UPDATE ${table} SET connector_instance_id = $1 WHERE connector_instance_id = $2`,
            [newId, oldId],
          );
        }
        continue;
      }

      const destId = dest.rows[0].connector_instance_id;
      for (const table of existingTables) {
        const uniqueCols = pgUniqueColumnsForLegacyRewrite(table);
        if (uniqueCols === null) {
          await client.query(
            `UPDATE ${table} SET connector_instance_id = $1 WHERE connector_instance_id = $2`,
            [destId, oldId],
          );
          continue;
        }
        if (uniqueCols.length === 0) {
          const both = await client.query(
            `SELECT
               EXISTS(SELECT 1 FROM ${table} WHERE connector_instance_id = $1) AS legacy_present,
               EXISTS(SELECT 1 FROM ${table} WHERE connector_instance_id = $2) AS dest_present`,
            [oldId, destId],
          );
          if (both.rows[0].legacy_present && both.rows[0].dest_present) {
            throw new Error(
              `Cannot migrate legacy connector_instance ${oldId} → ${destId}: both ids hold a row in ${table} keyed solely on connector_instance_id; manual reconciliation required.`,
            );
          }
          if (both.rows[0].legacy_present) {
            await client.query(
              `UPDATE ${table} SET connector_instance_id = $1 WHERE connector_instance_id = $2`,
              [destId, oldId],
            );
          }
          continue;
        }
        const keys = await client.query(
          `SELECT ${uniqueCols.join(', ')} FROM ${table} WHERE connector_instance_id = $1`,
          [oldId],
        );
        for (const k of keys.rows) {
          const params = [destId, ...uniqueCols.map((c) => k[c])];
          const whereClause = uniqueCols.map((c, i) => `${c} IS NOT DISTINCT FROM $${i + 2}`).join(' AND ');
          const conflict = await client.query(
            `SELECT 1 FROM ${table}
              WHERE connector_instance_id = $1 AND ${whereClause}
              LIMIT 1`,
            params,
          );
          if (conflict.rowCount > 0) {
            throw new Error(
              `Cannot migrate legacy connector_instance ${oldId} → ${destId}: ${table} has a colliding row on (${uniqueCols.join(', ')}) = (${uniqueCols.map((c) => k[c]).join(', ')}); manual reconciliation required.`,
            );
          }
        }
        await client.query(
          `UPDATE ${table} SET connector_instance_id = $1 WHERE connector_instance_id = $2`,
          [destId, oldId],
        );
      }
      await client.query(`DELETE FROM connector_instances WHERE connector_instance_id = $1`, [oldId]);
    }
    await client.query(`ALTER TABLE connector_instances VALIDATE CONSTRAINT connector_instances_source_kind_check`);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
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
      ADD COLUMN IF NOT EXISTS collector_protocol_version TEXT,
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
      ADD COLUMN IF NOT EXISTS connector_instance_id TEXT,
      ADD COLUMN IF NOT EXISTS last_error_json JSONB,
      ADD COLUMN IF NOT EXISTS last_heartbeat_at TEXT,
      ADD COLUMN IF NOT EXISTS last_heartbeat_status TEXT,
      ADD COLUMN IF NOT EXISTS records_pending INTEGER,
      ADD COLUMN IF NOT EXISTS outbox_diagnostics_json JSONB
  `);
}
