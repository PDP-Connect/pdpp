/**
 * Explicit Postgres runtime storage bootstrap for the final Postgres slice.
 *
 * SQLite remains the default runtime backend. This module only opens a pg pool
 * when `PDPP_STORAGE_BACKEND=postgres` is set or when `PDPP_DATABASE_URL`
 * (or the platform-standard `DATABASE_URL`) is present and no explicit backend
 * opts out.
 *
 * Spec: openspec/changes/add-postgres-runtime-storage/
 */

import pg from 'pg';
import { createHash } from 'node:crypto';
import { canonicalConnectorKey } from './connector-key.js';
import {
  hashKey,
  deriveSpineSource,
  makeConnectorInstanceId,
  makeConnectorInstanceSourceBindingKey,
  nonEmptyString,
  stableJson,
} from './connector-instance-utils.ts';

const { Pool } = pg;

const VALID_BACKENDS = new Set(['sqlite', 'postgres']);
const LEGACY_SYNC_STATE_OWNER_SUBJECT_ID = 'owner_local';

let activeBackend = 'sqlite';
let pool = null;
let lockPool = null;
let lockPoolCapacity = 0;

// Semantic embedding storage mode, detected at bootstrap. 'vector' when the
// pgvector extension is available and `semantic_search_blob.embedding` carries
// the pgvector `vector` type; 'jsonb' otherwise (legacy/brute-force fallback).
// See openspec/changes/migrate-postgres-semantic-index-to-pgvector/.
let semanticEmbeddingColumnMode = 'jsonb';
// Whether the server supports `hnsw.iterative_scan` (pgvector >= 0.8), so
// filtered HNSW scans keep exact distance order without under-returning.
let semanticIterativeScanSupported = false;
let lexicalPgSearchAvailability = 'unavailable';

// Production embedding profile dimensionality (search-semantic.js profiles).
// The HNSW index is a partial expression index pinned at this width — the
// documented pgvector pattern for a dimension-untyped `vector` column. Rows of
// other dimensions (test stub backends) fall outside the partial index and are
// scanned exactly.
const SEMANTIC_VECTOR_INDEXED_DIMENSIONS = 384;
const SEMANTIC_HNSW_INDEX_NAME = 'idx_pg_semantic_search_embedding_hnsw';
const SEMANTIC_HOT_HNSW_INDEX_PREFIX = 'idx_pg_semantic_hnsw_hot_';
const RECORDS_BLOB_SEARCH_INDEX_LOCK_ID = '8022352479012001';

function semanticVectorMigrationBatchSize() {
  const parsed = Number.parseInt(process.env.PDPP_PG_SEMANTIC_MIGRATION_BATCH_SIZE || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 50_000;
}

function semanticHotHnswMinRows() {
  const parsed = Number.parseInt(process.env.PDPP_PG_SEMANTIC_HOT_INDEX_MIN_ROWS || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 10_000;
}

function semanticHotHnswMaxIndexes() {
  const parsed = Number.parseInt(process.env.PDPP_PG_SEMANTIC_HOT_INDEX_MAX_CONNECTIONS || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 32) : 8;
}

function semanticHotHnswMaxTableShare() {
  const parsed = Number.parseFloat(process.env.PDPP_PG_SEMANTIC_HOT_INDEX_MAX_TABLE_SHARE || '');
  if (Number.isFinite(parsed) && parsed > 0 && parsed <= 1) return parsed;
  return 0.1;
}

export function isPostgresSemanticVectorEmbedding() {
  return activeBackend === 'postgres' && semanticEmbeddingColumnMode === 'vector';
}

export function isPostgresSemanticIterativeScanSupported() {
  return semanticIterativeScanSupported;
}

export function postgresLexicalPgSearchRequested({ env = process.env } = {}) {
  const raw = String(env.PDPP_RS_SEARCH_POSTGRES_BM25_BACKEND || '').trim().toLowerCase();
  return raw === 'pg_search';
}

export function getPostgresLexicalBackendState({ env = process.env } = {}) {
  const requested = postgresLexicalPgSearchRequested({ env });
  if (activeBackend !== 'postgres') {
    return {
      active: 'sqlite_fts5',
      configured: requested,
      fallback: false,
      pg_search: {
        available: false,
        state: 'not_applicable',
      },
    };
  }
  const available = lexicalPgSearchAvailability === 'available';
  return {
    active: requested && available ? 'pg_search_bm25' : 'postgres_native_fts',
    configured: requested,
    fallback: requested && !available,
    pg_search: {
      available,
      state: requested ? (available ? 'enabled' : 'fallback_unavailable') : available ? 'available_disabled' : 'unavailable',
    },
  };
}

function normalizeBackend(value) {
  const normalized = String(value || 'sqlite').trim().toLowerCase();
  if (!VALID_BACKENDS.has(normalized)) {
    throw new Error(`Unsupported PDPP_STORAGE_BACKEND '${value}'. Expected 'sqlite' or 'postgres'.`);
  }
  return normalized;
}

export function resolveStorageBackend({ env = process.env, opts = {} } = {}) {
  const databaseUrl = opts.databaseUrl ?? env.PDPP_DATABASE_URL ?? env.DATABASE_URL;
  const explicitBackend = nonEmptyString(opts.storageBackend ?? env.PDPP_STORAGE_BACKEND);
  const backend = normalizeBackend(explicitBackend ?? (nonEmptyString(databaseUrl) ? 'postgres' : 'sqlite'));
  if (backend === 'sqlite') {
    return { backend };
  }

  if (!databaseUrl) {
    throw new Error('PDPP_STORAGE_BACKEND=postgres requires PDPP_DATABASE_URL or DATABASE_URL.');
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

export function getPostgresLockPool() {
  if (!lockPool) {
    throw new Error('Postgres lock pool has not been initialized.');
  }
  return lockPool;
}

export function getPostgresLockPoolCapacity() {
  if (lockPoolCapacity <= 0) {
    throw new Error('Postgres lock pool capacity has not been initialized.');
  }
  return lockPoolCapacity;
}

export async function postgresQuery(sql, params = []) {
  return getPostgresPool().query(sql, params);
}

// ─── Physical storage footprint (read-only operator diagnostics) ─────────────
//
// Surfaces the database's on-disk size so an operator can reconcile the
// logical retained payload (record/history/blob JSON byte length, reported by
// `/_ref/dataset/summary`) against what the database process actually occupies
// on disk. The two are deliberately different measurements: the physical
// number includes index storage (the `lexical_search_*` / `semantic_search_*`
// tables), the operational event log, TOAST overhead, page bloat, and free
// space — none of which the logical projection counts.
//
// Strictly read-only by construction: only the pure `pg_database_size` and
// `pg_total_relation_size` read functions are used. No DDL, no DML, no
// vacuum/analyze/reindex side effect. Surfacing footprint must never change
// footprint.
//
// Spec: openspec/changes/surface-database-physical-footprint/specs/
//       reference-implementation-architecture/spec.md

// Bound the relation list so the payload stays small and the operator gets the
// size drivers, not a full table census. The sizes are an approximate
// composition: they do not sum to pg_database_size (shared catalogs, the free
// space map, and WAL are not attributed per relation).
const PHYSICAL_FOOTPRINT_TOP_RELATIONS = 8;

/**
 * Read the physical on-disk database footprint for a Postgres backend.
 *
 * Returns `{ physical_bytes, top_relations }` where `physical_bytes` is
 * `pg_database_size(current_database())` and `top_relations` is the largest
 * relations by `pg_total_relation_size(relid)` (table + indexes + TOAST),
 * ordered largest-first and bounded to a small top-N.
 *
 * Honest about backend and absence: returns `{ physical_bytes: null,
 * top_relations: null }` on a non-Postgres backend and on any read failure,
 * mirroring the fail-open diagnostics stance. Never fabricates a `0`.
 *
 * @returns {Promise<{ physical_bytes: number | null, top_relations: Array<{ name: string, bytes: number }> | null }>}
 */
export async function collectPhysicalFootprint() {
  if (!isPostgresStorageBackend()) {
    return { physical_bytes: null, top_relations: null };
  }
  try {
    const totalResult = await postgresQuery(
      'SELECT pg_database_size(current_database()) AS bytes'
    );
    const physicalBytes = coerceByteCount(totalResult?.rows?.[0]?.bytes);
    if (physicalBytes === null) {
      // Could not read a usable total — degrade rather than report relations
      // against an unknown whole.
      return { physical_bytes: null, top_relations: null };
    }

    // `relkind = 'r'` restricts to ordinary tables; pg_total_relation_size
    // already folds in each table's indexes and TOAST, so we do not also
    // enumerate index relkinds (that would double-count). Catalog/system
    // relations under pg_catalog / information_schema are excluded so the
    // operator sees their own data relations.
    const relationsResult = await postgresQuery(
      `SELECT c.relname AS name,
              pg_total_relation_size(c.oid) AS bytes
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r'
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg_toast%'
        ORDER BY pg_total_relation_size(c.oid) DESC
        LIMIT $1`,
      [PHYSICAL_FOOTPRINT_TOP_RELATIONS]
    );
    const topRelations = [];
    for (const row of relationsResult?.rows ?? []) {
      const name = typeof row?.name === 'string' ? row.name : null;
      const bytes = coerceByteCount(row?.bytes);
      if (name === null || bytes === null) {
        continue;
      }
      topRelations.push({ name, bytes });
    }

    return { physical_bytes: physicalBytes, top_relations: topRelations };
  } catch {
    // Read failure (permissions, connection drop, etc.) surfaces as
    // unmeasured, not as a fabricated zero. The rest of diagnostics still
    // renders.
    return { physical_bytes: null, top_relations: null };
  }
}

// pg returns BIGINT as a string to avoid JS precision loss. The sizes here are
// well within Number.MAX_SAFE_INTEGER (a ~51 GB database is ~5.5e10, safe to
// ~9e15), so we coerce to a finite non-negative Number. Anything that does not
// coerce to a finite non-negative number degrades to `null`.
function coerceByteCount(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const n = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isFinite(n) || n < 0) {
    return null;
  }
  return n;
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

export async function initPostgresStorage(config, { log } = {}) {
  if (!config || config.backend !== 'postgres') {
    activeBackend = 'sqlite';
    return null;
  }
  if (pool) {
    await closePostgresStorage();
  }

  const lockPoolMax = Number.parseInt(process.env.PDPP_PG_INGEST_LOCK_POOL_SIZE || '', 10);
  const max = Number.isInteger(lockPoolMax) && lockPoolMax > 0 ? lockPoolMax : 4;
  pool = new Pool({ connectionString: config.databaseUrl });
  lockPool = new Pool({ connectionString: config.databaseUrl, max });
  lockPoolCapacity = max;
  activeBackend = 'postgres';

  await bootstrapPostgresSchema({ log });
  return pool;
}

export async function closePostgresStorage() {
  const current = pool;
  const currentLockPool = lockPool;
  pool = null;
  lockPool = null;
  lockPoolCapacity = 0;
  activeBackend = 'sqlite';
  semanticEmbeddingColumnMode = 'jsonb';
  semanticIterativeScanSupported = false;
  lexicalPgSearchAvailability = 'unavailable';
  if (current) {
    await current.end();
  }
  if (currentLockPool) {
    await currentLockPool.end();
  }
}

export async function bootstrapPostgresSchema({ log = () => {} } = {}) {
  const client = await getPostgresPool().connect();
  try {
    // pgvector is optional. When available, the boot migration below moves
    // semantic embeddings to the pgvector representation; without it the
    // semantic fallback stores vectors as JSONB and computes distances after
    // grant-scoped candidate narrowing.
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    } catch {}
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS btree_gin');
    } catch {}
    lexicalPgSearchAvailability = (await detectPgSearchExtension(client)) ? 'available' : 'unavailable';

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
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked', 'draft')),
        source_kind TEXT NOT NULL CHECK (source_kind IN ('account', 'local_device', 'browser_collector', 'manual')),
        source_binding_key TEXT NOT NULL,
        source_binding_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revoked_at TEXT,
        UNIQUE(owner_subject_id, connector_id, source_kind, source_binding_key)
      );
      CREATE INDEX IF NOT EXISTS idx_pg_connector_instances_owner_connector_status
        ON connector_instances(owner_subject_id, connector_id, status);

      -- Reset-safe record-source checkpoint: incremented by a supported
      -- stream/connector-wide reset over the distinct stream namespaces it
      -- touched, in the same transaction as the deletes. Combined with the
      -- per-stream version_counter vector this makes the composite checkpoint
      -- immune to the ABA collision a bare version vector has.
      -- Spec: openspec/changes/reconcile-active-summary-evidence/design.md
      ALTER TABLE connector_instances
        ADD COLUMN IF NOT EXISTS record_reset_generation BIGINT NOT NULL DEFAULT 0;

      -- Existing Postgres deployments may have been bootstrapped before the
      -- static-secret draft lifecycle existed. Widen the status CHECK in place
      -- so the live reference runtime can create invisible draft connections.
      DO $$
      DECLARE
        status_constraint_name TEXT;
        status_constraint_def TEXT;
      BEGIN
        FOR status_constraint_name, status_constraint_def IN
          SELECT conname, pg_get_constraintdef(oid)
            FROM pg_constraint
           WHERE conrelid = 'connector_instances'::regclass
             AND contype = 'c'
             AND pg_get_constraintdef(oid) LIKE '%status%'
             AND pg_get_constraintdef(oid) LIKE '%active%'
             AND pg_get_constraintdef(oid) LIKE '%paused%'
             AND pg_get_constraintdef(oid) LIKE '%revoked%'
        LOOP
          IF status_constraint_def NOT LIKE '%draft%' THEN
            EXECUTE format('ALTER TABLE connector_instances DROP CONSTRAINT %I', status_constraint_name);
          END IF;
        END LOOP;

        IF NOT EXISTS (
          SELECT 1
            FROM pg_constraint
           WHERE conrelid = 'connector_instances'::regclass
             AND contype = 'c'
             AND pg_get_constraintdef(oid) LIKE '%status%'
             AND pg_get_constraintdef(oid) LIKE '%draft%'
        ) THEN
          ALTER TABLE connector_instances
            ADD CONSTRAINT connector_instances_status_check
            CHECK (status IN ('active', 'paused', 'revoked', 'draft'));
        END IF;
      END $$;

      CREATE TABLE IF NOT EXISTS connector_instance_credentials (
        connector_instance_id TEXT PRIMARY KEY
          REFERENCES connector_instances(connector_instance_id) ON DELETE CASCADE,
        owner_subject_id TEXT NOT NULL,
        credential_kind TEXT NOT NULL CHECK (credential_kind IN ('app_password', 'personal_access_token', 'secret_bundle', 'username_password')),
        sealed_secret TEXT NOT NULL,
        fingerprint TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
        captured_at TEXT NOT NULL,
        rotated_at TEXT,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pg_connector_instance_credentials_owner_status
        ON connector_instance_credentials(owner_subject_id, status);

      CREATE TABLE IF NOT EXISTS acquisition_batches (
        batch_id TEXT PRIMARY KEY,
        owner_subject_id TEXT NOT NULL,
        connector_id TEXT NOT NULL REFERENCES connectors(connector_id) ON DELETE RESTRICT,
        connector_instance_id TEXT NOT NULL REFERENCES connector_instances(connector_instance_id) ON DELETE CASCADE,
        acquisition_method TEXT NOT NULL CHECK (acquisition_method IN ('provider_api', 'owner_artifact', 'device_sync', 'device_backup', 'browser_polyfill')),
        source_format TEXT,
        parser_version TEXT,
        artifact_sha256 TEXT,
        uploaded_file_name TEXT,
        status TEXT NOT NULL CHECK (status IN ('validated', 'committed', 'duplicate', 'failed')),
        event_time_start TEXT,
        event_time_end TEXT,
        parsed_count INTEGER,
        accepted_count INTEGER NOT NULL DEFAULT 0,
        duplicate_count INTEGER NOT NULL DEFAULT 0,
        skipped_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        media_coverage_json JSONB,
        warnings_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        receipt_json JSONB,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pg_acquisition_batches_connection_created
        ON acquisition_batches(connector_instance_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_acquisition_batches_owner_connector_artifact
        ON acquisition_batches(owner_subject_id, connector_id, artifact_sha256)
        WHERE artifact_sha256 IS NOT NULL;

      CREATE TABLE IF NOT EXISTS manual_upload_artifacts (
        artifact_id TEXT PRIMARY KEY,
        owner_subject_id TEXT NOT NULL,
        connector_id TEXT NOT NULL REFERENCES connectors(connector_id) ON DELETE RESTRICT,
        connector_instance_id TEXT REFERENCES connector_instances(connector_instance_id) ON DELETE SET NULL,
        file_name TEXT NOT NULL,
        staging_path TEXT NOT NULL,
        final_path TEXT,
        file_size_bytes INTEGER NOT NULL DEFAULT 0,
        artifact_sha256 TEXT,
        status TEXT NOT NULL CHECK (status IN ('uploaded', 'validating', 'staged', 'duplicate', 'failed')),
        acquisition_batch_id TEXT REFERENCES acquisition_batches(batch_id) ON DELETE SET NULL,
        validation_json JSONB,
        error_json JSONB,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pg_manual_upload_artifacts_connection_created
        ON manual_upload_artifacts(connector_instance_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS record_acquisition_provenance (
        connector_instance_id TEXT NOT NULL REFERENCES connector_instances(connector_instance_id) ON DELETE CASCADE,
        stream TEXT NOT NULL,
        record_key TEXT NOT NULL,
        batch_id TEXT NOT NULL REFERENCES acquisition_batches(batch_id) ON DELETE CASCADE,
        acquisition_method TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(connector_instance_id, stream, record_key, batch_id)
      );
      CREATE INDEX IF NOT EXISTS idx_pg_record_acquisition_provenance_record
        ON record_acquisition_provenance(connector_instance_id, stream, record_key);

      -- Existing Postgres deployments may carry the original two-kind CHECK.
      -- Widen it in place for sealed multi-field static-secret bundles and
      -- future username/password pairs, without touching stored ciphertext.
      DO $$
      DECLARE
        credential_kind_constraint_name TEXT;
        credential_kind_constraint_def TEXT;
      BEGIN
        FOR credential_kind_constraint_name, credential_kind_constraint_def IN
          SELECT conname, pg_get_constraintdef(oid)
            FROM pg_constraint
           WHERE conrelid = 'connector_instance_credentials'::regclass
             AND contype = 'c'
             AND pg_get_constraintdef(oid) LIKE '%credential_kind%'
             AND pg_get_constraintdef(oid) LIKE '%app_password%'
             AND pg_get_constraintdef(oid) LIKE '%personal_access_token%'
        LOOP
          IF credential_kind_constraint_def NOT LIKE '%secret_bundle%'
             OR credential_kind_constraint_def NOT LIKE '%username_password%' THEN
            EXECUTE format('ALTER TABLE connector_instance_credentials DROP CONSTRAINT %I', credential_kind_constraint_name);
          END IF;
        END LOOP;

        IF NOT EXISTS (
          SELECT 1
            FROM pg_constraint
           WHERE conrelid = 'connector_instance_credentials'::regclass
             AND contype = 'c'
             AND pg_get_constraintdef(oid) LIKE '%credential_kind%'
             AND pg_get_constraintdef(oid) LIKE '%secret_bundle%'
             AND pg_get_constraintdef(oid) LIKE '%username_password%'
        ) THEN
          ALTER TABLE connector_instance_credentials
            ADD CONSTRAINT connector_instance_credentials_credential_kind_check
            CHECK (credential_kind IN ('app_password', 'personal_access_token', 'secret_bundle', 'username_password'));
        END IF;
      END $$;

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

      CREATE TABLE IF NOT EXISTS cimd_client_documents (
        document_id TEXT PRIMARY KEY,
        client_name TEXT,
        redirect_uris JSONB NOT NULL DEFAULT '[]'::jsonb,
        logo_uri TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

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
        parent_package_id TEXT,
        trace_id TEXT,
        scenario_id TEXT,
        created_at TEXT NOT NULL,
        approved_at TEXT NOT NULL,
        revoked_at TEXT,
        CONSTRAINT grant_packages_parent_package_fk
          FOREIGN KEY(parent_package_id) REFERENCES grant_packages(package_id) ON DELETE SET NULL
      );
      -- Incremental add-source linkage; cumulative-view/audit metadata only,
      -- carries no source/stream authority. Added via ALTER for DBs created
      -- before the column existed; the explicit FK keeps migrated and fresh
      -- Postgres schemas aligned.
      ALTER TABLE grant_packages
        ADD COLUMN IF NOT EXISTS parent_package_id TEXT;
      UPDATE grant_packages child
         SET parent_package_id = NULL
       WHERE child.parent_package_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
             FROM grant_packages parent
            WHERE parent.package_id = child.parent_package_id
         );
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
            FROM pg_constraint
           WHERE conrelid = 'grant_packages'::regclass
             AND contype = 'f'
             AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (parent_package_id) REFERENCES grant_packages(package_id)%'
        ) THEN
          ALTER TABLE grant_packages
            ADD CONSTRAINT grant_packages_parent_package_fk
            FOREIGN KEY(parent_package_id)
            REFERENCES grant_packages(package_id)
            ON DELETE SET NULL;
        END IF;
      END $$;
      CREATE INDEX IF NOT EXISTS idx_pg_grant_packages_client_status
        ON grant_packages(client_id, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_pg_grant_packages_parent
        ON grant_packages(parent_package_id);

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
        interval_seconds INTEGER NOT NULL DEFAULT 2,
        last_polled_at TEXT,
        approval_id TEXT UNIQUE
      );
      CREATE INDEX IF NOT EXISTS idx_pg_pending_consents_status_expires
        ON pending_consents(status, expires_at);
      ALTER TABLE pending_consents
        ADD COLUMN IF NOT EXISTS interval_seconds INTEGER NOT NULL DEFAULT 2;
      ALTER TABLE pending_consents
        ADD COLUMN IF NOT EXISTS last_polled_at TEXT;

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
        connector_instance_id TEXT NOT NULL DEFAULT '',
        connector_id TEXT NOT NULL DEFAULT '',
        batch_seq INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        http_status INTEGER,
        response_json JSONB,
        record_count INTEGER NOT NULL DEFAULT 0,
        durable_prefix_count INTEGER NOT NULL DEFAULT 0,
        manifest_fingerprint TEXT NOT NULL DEFAULT '',
        semantic_capability_identity TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        accepted_at TEXT,
        CHECK (status IN ('processing', 'accepted')),
        CHECK (durable_prefix_count >= 0 AND durable_prefix_count <= record_count),
        CHECK (status <> 'accepted' OR durable_prefix_count = record_count),
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
      -- NOTE: the UNIQUE identity index is created by
      -- migratePostgresConnectorDetailGapInstanceColumns (always runs on init),
      -- which reconciles pre-existing locator-drift duplicates BEFORE building
      -- the index. Creating it here would run before that dedupe and could break
      -- on legacy duplicate rows.
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
        started_at TEXT NOT NULL,
        run_generation INTEGER NOT NULL DEFAULT 1
      );

      -- run_generation is the per-connection fencing token (Kleppmann): it
      -- increments each time a run is admitted so a reclaimed zombie run from
      -- an earlier generation cannot commit once a newer run is active. Added
      -- via ADD COLUMN IF NOT EXISTS so pre-fencing tables backfill to 1.
      ALTER TABLE controller_active_runs
        ADD COLUMN IF NOT EXISTS run_generation INTEGER NOT NULL DEFAULT 1;

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
        window_settle_endpoint TEXT,
        health TEXT NOT NULL CHECK (health IN ('starting', 'ready', 'unhealthy', 'stopping')),
        container_id TEXT,
        container_name TEXT,
        profile_dir TEXT,
        profile_volume TEXT,
        browser_generation_hash TEXT,
        active_lease_id TEXT,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_pg_browser_surfaces_profile_health
        ON browser_surfaces(backend, profile_key, health, last_used_at);

      CREATE INDEX IF NOT EXISTS idx_pg_browser_surfaces_active_lease
        ON browser_surfaces(active_lease_id)
        WHERE active_lease_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS presentation_screen_states (
        browser_session_id TEXT PRIMARY KEY,
        surface_id TEXT NOT NULL,
        lease_id TEXT,
        baseline_json JSONB NOT NULL,
        captured_at TEXT NOT NULL,
        resolved_at TEXT,
        resolution TEXT CHECK (resolution IS NULL OR resolution IN ('restored', 'recycled'))
      );

      CREATE INDEX IF NOT EXISTS idx_pg_presentation_screen_states_unrestored
        ON presentation_screen_states(captured_at)
        WHERE resolution IS NULL;

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
          'lease_wait_timeout',
          'retained_capacity_reserved'
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

      CREATE TABLE IF NOT EXISTS browser_surface_replacement_receipts (
        event_seq BIGSERIAL PRIMARY KEY,
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

      CREATE INDEX IF NOT EXISTS idx_pg_browser_surface_replacement_scope_order
        ON browser_surface_replacement_receipts(connection_id, surface_subject_id, event_seq, idempotency_key);

      CREATE INDEX IF NOT EXISTS idx_pg_browser_surface_replacement_surface_order
        ON browser_surface_replacement_receipts(surface_id, event_seq, idempotency_key);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_browser_surface_replacement_one_resolution
        ON browser_surface_replacement_receipts(replacement_id)
        WHERE phase IN ('completed', 'terminal');

      ALTER TABLE browser_surfaces
        ADD COLUMN IF NOT EXISTS surface_subject_id TEXT,
        ADD COLUMN IF NOT EXISTS surface_mode TEXT CHECK (surface_mode IS NULL OR surface_mode IN ('static', 'dynamic')),
        ADD COLUMN IF NOT EXISTS surface_source TEXT,
        ADD COLUMN IF NOT EXISTS stream_origin TEXT,
        ADD COLUMN IF NOT EXISTS window_settle_endpoint TEXT,
        ADD COLUMN IF NOT EXISTS container_name TEXT,
        ADD COLUMN IF NOT EXISTS profile_dir TEXT,
        ADD COLUMN IF NOT EXISTS profile_volume TEXT;

      ALTER TABLE browser_surfaces
        ADD COLUMN IF NOT EXISTS browser_generation_hash TEXT;

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
          'lease_wait_timeout',
          'retained_capacity_reserved'
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
        -- Record SEMANTIC time (manifest consent_time_field/cursor_field from
        -- record_json, coerced/epoch-aware, fallback emitted_at). Drives the
        -- Explore merged-timeline SORT; pagination/membership stays anchored on
        -- the monotonic id. Never null; defaults to '' at create, set at ingest.
        -- See docs/research/explore-semantic-time-sort-design-2026-06-20.md.
        semantic_time TEXT NOT NULL DEFAULT '',
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
      -- docs/reference/binary-content-invariant-design-brief.md §4.6.
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
      CREATE INDEX IF NOT EXISTS idx_pg_spine_events_trace_recent
        ON spine_events(occurred_at DESC, event_seq DESC, trace_id)
        WHERE trace_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_pg_spine_events_run
        ON spine_events(run_id, occurred_at, recorded_at);
      CREATE INDEX IF NOT EXISTS idx_pg_spine_events_run_recent
        ON spine_events(occurred_at DESC, event_seq DESC, run_id)
        WHERE run_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_pg_spine_events_source_run_summary
        ON spine_events(source_kind, source_id, run_id, occurred_at DESC)
        WHERE run_id IS NOT NULL;
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
      CREATE INDEX IF NOT EXISTS idx_pg_spine_events_grant_recent
        ON spine_events(occurred_at DESC, event_seq DESC, grant_id)
        WHERE grant_id IS NOT NULL;

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

      -- Connector-summary evidence read model (reference-only, owner-facing).
      -- See openspec/changes/maintain-connector-summary-read-model/ for spec
      -- delta. Mirrors the SQLite schema in db.js; same column meaning so the
      -- backend-agnostic projection module issues equivalent statements. Stores
      -- DURABLE evidence only — synthesized health/verdict is computed on read.
      CREATE TABLE IF NOT EXISTS connector_summary_evidence (
        connector_instance_id     TEXT PRIMARY KEY,
        connector_id              TEXT NOT NULL,
        display_name              TEXT NOT NULL DEFAULT '',
        status                    TEXT,
        source_kind               TEXT,
        revoked_at                TEXT,
        total_records             BIGINT NOT NULL DEFAULT 0,
        stream_count              BIGINT NOT NULL DEFAULT 0,
        last_record_updated_at    TEXT,
        stream_records_json       JSONB NOT NULL DEFAULT '[]'::jsonb,
        retained_bytes_json       JSONB NOT NULL DEFAULT '{"record_json_bytes":0,"record_changes_json_bytes":0,"blob_bytes":0,"total_bytes":0}'::jsonb,
        total_retained_bytes      BIGINT NOT NULL DEFAULT 0,
        dirty                     INTEGER NOT NULL DEFAULT 1,
        computed_at               TEXT,
        source_event_seq          BIGINT,
        state                     TEXT NOT NULL DEFAULT 'rebuilding',
        last_error                TEXT,
        manifest_generation_boundary_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pg_connector_summary_evidence_connector
        ON connector_summary_evidence(connector_id);

      CREATE TABLE IF NOT EXISTS manifest_write_violations (
        connector_instance_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        manifest_fingerprint TEXT NOT NULL,
        provenance TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        PRIMARY KEY(connector_instance_id, stream, manifest_fingerprint)
      );

      ALTER TABLE connector_summary_evidence
        ADD COLUMN IF NOT EXISTS last_record_updated_at TEXT;
      ALTER TABLE connector_summary_evidence
        ADD COLUMN IF NOT EXISTS stream_records_json JSONB NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE connector_summary_evidence
        ADD COLUMN IF NOT EXISTS retained_bytes_json JSONB NOT NULL DEFAULT '{"record_json_bytes":0,"record_changes_json_bytes":0,"blob_bytes":0,"total_bytes":0}'::jsonb;
      ALTER TABLE connector_summary_evidence
        ADD COLUMN IF NOT EXISTS total_retained_bytes BIGINT NOT NULL DEFAULT 0;
      -- Durable per-stream latest-attempt evidence: raw runtime facts from the
      -- newest terminal run that attempted each stream, keyed by stream, plus
      -- the highest terminal spine event_seq folded into the map. NULL seq =
      -- never folded (pre-change row); the reconcile pass backfills it from
      -- terminal events. Raw facts only — coverage is derived on read.
      ALTER TABLE connector_summary_evidence
        ADD COLUMN IF NOT EXISTS stream_latest_facts_json JSONB;
      ALTER TABLE connector_summary_evidence
        ADD COLUMN IF NOT EXISTS stream_facts_event_seq BIGINT;
      -- Fold-logic version this row's stream_latest_facts_json/stream_facts_event_seq
      -- were computed under. NULL/behind-current means the row's fold checkpoint is
      -- not trustworthy under the CURRENT fold semantics even though it is a real
      -- event_seq — the fold treats it exactly like a NULL checkpoint (re-derive
      -- from full history) so a fold-logic fix (e.g. the monotonic-coverage guard)
      -- self-heals every existing row on its next reconcile pass, not merely future
      -- terminal events. See STREAM_FACTS_FOLD_LOGIC_VERSION in
      -- connector-summary-read-model.ts.
      ALTER TABLE connector_summary_evidence
        ADD COLUMN IF NOT EXISTS stream_facts_fold_version INTEGER;
      -- Orthogonal typed evidence components (reconcile-active-summary-evidence):
      -- the exact normalized reset-safe checkpoint this row's record_snapshot
      -- was last computed against (for record_checkpoint_mismatch detection),
      -- the manifest declaration fingerprint this row's stream declarations
      -- were last computed against, and each component's independent
      -- current/unobserved/stale/failed state + sanitized reason code. Spec:
      -- openspec/changes/reconcile-active-summary-evidence/design.md
      ALTER TABLE connector_summary_evidence
        ADD COLUMN IF NOT EXISTS record_checkpoint_json JSONB;
      ALTER TABLE connector_summary_evidence
        ADD COLUMN IF NOT EXISTS manifest_fingerprint TEXT;
      ALTER TABLE connector_summary_evidence
        ADD COLUMN IF NOT EXISTS record_snapshot_state TEXT NOT NULL DEFAULT 'unobserved';
      ALTER TABLE connector_summary_evidence
        ADD COLUMN IF NOT EXISTS record_snapshot_reason_code TEXT;
      ALTER TABLE connector_summary_evidence
        ADD COLUMN IF NOT EXISTS terminal_facts_state TEXT NOT NULL DEFAULT 'unobserved';
      ALTER TABLE connector_summary_evidence
        ADD COLUMN IF NOT EXISTS terminal_facts_reason_code TEXT;
      ALTER TABLE connector_summary_evidence
        ADD COLUMN IF NOT EXISTS manifest_declaration_state TEXT NOT NULL DEFAULT 'unavailable';
      ALTER TABLE connector_summary_evidence
        ADD COLUMN IF NOT EXISTS manifest_declaration_reason_code TEXT;
      ALTER TABLE connector_summary_evidence
        ADD COLUMN IF NOT EXISTS retained_bytes_state TEXT NOT NULL DEFAULT 'unobserved';
      ALTER TABLE connector_summary_evidence
        ADD COLUMN IF NOT EXISTS retained_bytes_reason_code TEXT;
      ALTER TABLE connector_summary_evidence
        ADD COLUMN IF NOT EXISTS manifest_generation_boundary_at TEXT;
      -- Terminal-run events are the fold source for per-stream evidence; the
      -- partial index keeps the fold's max-seq and delta reads off the full
      -- spine.
      CREATE INDEX IF NOT EXISTS idx_pg_spine_events_terminal_seq
        ON spine_events(event_seq)
        WHERE event_type IN ('run.completed', 'run.failed', 'run.browser_surface_failed', 'run.cancelled');
      -- Scoped terminal-fact fold source: a first-class, indexed
      -- connector_instance_id column lets the connector-summary fold
      -- (connector-summary-read-model.ts) filter its terminal high-water and
      -- delta reads to exactly the requested connections at the SQL level
      -- instead of scanning every connection's terminal history in memory.
      -- Additive/nullable — most spine event types legitimately carry no
      -- connection attribution and stay NULL. Populated at write time from
      -- the same data.connector_instance_id/connection_id payload field
      -- addRunConnectionIdentity already stamps onto run.* events. Spec:
      -- openspec/changes/reconcile-active-summary-evidence/specs/
      -- reference-connector-instances/spec.md
      ALTER TABLE spine_events
        ADD COLUMN IF NOT EXISTS connector_instance_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_pg_spine_events_terminal_instance_seq
        ON spine_events(connector_instance_id, event_seq)
        WHERE event_type IN ('run.completed', 'run.failed', 'run.browser_surface_failed', 'run.cancelled')
          AND connector_instance_id IS NOT NULL;
      -- Backfill connector_instance_id for pre-existing TERMINAL rows whose
      -- identity already lives in data_json (Sol fourth-verdict P1.1): the
      -- scoped fold filters exclusively on the new column, so a legacy
      -- terminal row with the column NULL is invisible to the real
      -- single-connection route and startup even though its data_json
      -- carries a genuine connector_instance_id/connection_id. Bounded,
      -- set-based UPDATE restricted to the four terminal event types
      -- (the same subset idx_pg_spine_events_terminal_seq indexes) and to
      -- rows the column has not yet reached — naturally idempotent: after
      -- the first successful run this WHERE clause matches zero rows on
      -- every subsequent boot. Precedence matches readEventConnectionId
      -- in connector-summary-read-model.ts exactly:
      -- data->>'connector_instance_id' first, then data->>'connection_id'.
      UPDATE spine_events
         SET connector_instance_id = COALESCE(
           NULLIF(data_json->>'connector_instance_id', ''),
           NULLIF(data_json->>'connection_id', '')
         )
       WHERE connector_instance_id IS NULL
         AND event_type IN ('run.completed', 'run.failed', 'run.browser_surface_failed', 'run.cancelled')
         AND (
           data_json->>'connector_instance_id' IS NOT NULL
           OR data_json->>'connection_id' IS NOT NULL
         );

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
    await migratePostgresConnectorInstancesSourceKindBrowserCollector(client);
    await migratePostgresSemanticEmbeddingToVector(client, log);
    await ensurePostgresLexicalScopedGinIndex(client, log);
  } finally {
    client.release();
  }
}

async function hasPgvectorExtension(client) {
  const result = await client.query("SELECT 1 FROM pg_extension WHERE extname = 'vector' LIMIT 1");
  return result.rowCount > 0;
}

async function detectPgSearchExtension(client) {
  try {
    const result = await client.query(
      "SELECT 1 FROM pg_available_extensions WHERE name = 'pg_search' LIMIT 1",
    );
    return result.rowCount > 0;
  } catch {
    return false;
  }
}

async function postgresColumnUdtName(client, table, column) {
  const result = await client.query(
    `SELECT udt_name
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = $1
        AND column_name = $2
      LIMIT 1`,
    [table, column],
  );
  return result.rows[0]?.udt_name ?? null;
}

async function detectSemanticIterativeScanSupport(client) {
  // `hnsw.iterative_scan` exists from pgvector 0.8. SET + RESET outside a
  // transaction is harmless on this short-lived bootstrap client.
  try {
    await client.query("SET hnsw.iterative_scan = strict_order");
    await client.query('RESET hnsw.iterative_scan');
    return true;
  } catch {
    return false;
  }
}

async function ensureSemanticEmbeddingHnswIndex(client, log) {
  const existing = await client.query(
    `SELECT 1 FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'semantic_search_blob' AND indexname = $1
      LIMIT 1`,
    [SEMANTIC_HNSW_INDEX_NAME],
  );
  if (existing.rowCount > 0) return;

  // HNSW builds want the graph in maintenance_work_mem; the Postgres default
  // (64MB) forces a much slower build at the live table size. SET values
  // cannot be bound parameters; the value is validated against a strict
  // size-literal pattern before interpolation.
  const workMem = process.env.PDPP_PG_SEMANTIC_INDEX_MAINTENANCE_WORK_MEM || '256MB';
  const workMemValid = /^\d+(kB|MB|GB)$/.test(workMem);
  if (workMemValid) {
    await client.query(`SET maintenance_work_mem = '${workMem}'`);
  }
  // Parallel HNSW builds allocate dynamic shared memory proportional to
  // maintenance_work_mem; containerized Postgres commonly runs with the 64MB
  // /dev/shm default and dies with "could not resize shared memory segment".
  // Build serially — no DSM involved — so the boot migration succeeds in any
  // container (verified against pgvector/pgvector:pg16).
  await client.query('SET max_parallel_maintenance_workers = 0');
  log(`[PDPP] Semantic index migration: building HNSW index ${SEMANTIC_HNSW_INDEX_NAME} (cosine, ${SEMANTIC_VECTOR_INDEXED_DIMENSIONS} dims${workMemValid ? `, maintenance_work_mem=${workMem}` : ''}, serial build)`);
  const startedAt = Date.now();
  await client.query(
    `CREATE INDEX IF NOT EXISTS ${SEMANTIC_HNSW_INDEX_NAME}
       ON semantic_search_blob
       USING hnsw ((embedding::vector(${SEMANTIC_VECTOR_INDEXED_DIMENSIONS})) vector_cosine_ops)
       WHERE (vector_dims(embedding) = ${SEMANTIC_VECTOR_INDEXED_DIMENSIONS})`,
  );
  await client.query('RESET max_parallel_maintenance_workers');
  if (workMemValid) {
    await client.query('RESET maintenance_work_mem');
  }
  log(`[PDPP] Semantic index migration: HNSW index ready in ${Math.round((Date.now() - startedAt) / 1000)}s`);
}

function sqlIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function semanticHotHnswIndexName(connectorId, connectorInstanceId) {
  const connector = String(connectorId || 'connector')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24) || 'connector';
  const instance = String(connectorInstanceId || '')
    .replace(/^cin_/, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 8) || createHash('sha256').update(String(connectorInstanceId || '')).digest('hex').slice(0, 8);
  return `${SEMANTIC_HOT_HNSW_INDEX_PREFIX}${connector}_${instance}`.slice(0, 63);
}

async function ensureSemanticHotHnswIndexes(client, log = () => {}) {
  if (!(await hasPgvectorExtension(client))) return;
  const minRows = semanticHotHnswMinRows();
  const maxIndexes = semanticHotHnswMaxIndexes();
  if (maxIndexes <= 0) return;
  const totalResult = await client.query(
    `SELECT COUNT(*)::bigint AS n
       FROM semantic_search_blob
      WHERE vector_dims(embedding) = ${SEMANTIC_VECTOR_INDEXED_DIMENSIONS}`,
  );
  const totalRows = Number(totalResult.rows[0]?.n || 0);
  if (totalRows <= 0) return;
  const maxRows = Math.max(minRows, Math.floor(totalRows * semanticHotHnswMaxTableShare()));
  const hot = await client.query(
    `SELECT connector_id, connector_instance_id, SUM(record_count)::bigint AS indexed_rows
       FROM retained_size_stream
      WHERE dirty = 0
      GROUP BY connector_id, connector_instance_id
     HAVING SUM(record_count) >= $1
        AND SUM(record_count) <= $2
      ORDER BY SUM(record_count) DESC, connector_id ASC, connector_instance_id ASC
      LIMIT $3`,
    [minRows, maxRows, maxIndexes],
  );
  if (hot.rowCount === 0) return;
  for (const row of hot.rows) {
    const indexName = semanticHotHnswIndexName(row.connector_id, row.connector_instance_id);
    log(`[PDPP] Semantic index migration: ensuring hot-source HNSW index ${indexName} (${row.connector_id}, ${row.indexed_rows} rows)`);
    await client.query('SET max_parallel_maintenance_workers = 0');
    try {
      await client.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${sqlIdentifier(indexName)}
           ON semantic_search_blob
           USING hnsw ((embedding::vector(${SEMANTIC_VECTOR_INDEXED_DIMENSIONS})) vector_cosine_ops)
           WHERE connector_instance_id = ${sqlLiteral(row.connector_instance_id)}
             AND vector_dims(embedding) = ${SEMANTIC_VECTOR_INDEXED_DIMENSIONS}`,
      );
    } finally {
      await client.query('RESET max_parallel_maintenance_workers');
    }
  }
}

/**
 * Boot migration: move `semantic_search_blob.embedding` from the legacy JSONB
 * float-array representation to pgvector `vector` so semantic queries can use
 * the database's cosine-distance operator and HNSW index instead of fetching
 * candidate embeddings and scoring them in JS.
 *
 * Idempotent and resume-safe: every backfill batch is its own statement, the
 * column swap is one transaction, and re-running after an interruption picks
 * up at the remaining unconverted rows. When the pgvector extension is not
 * available the JSONB representation (and the JS brute-force read path) stays
 * in place unchanged.
 *
 * Spec: openspec/changes/migrate-postgres-semantic-index-to-pgvector/
 */
async function migratePostgresSemanticEmbeddingToVector(client, log = () => {}) {
  if (!(await hasPgvectorExtension(client))) {
    semanticEmbeddingColumnMode = 'jsonb';
    semanticIterativeScanSupported = false;
    return;
  }

  const udtName = await postgresColumnUdtName(client, 'semantic_search_blob', 'embedding');
  if (udtName === 'vector') {
    await ensureSemanticEmbeddingHnswIndex(client, log);
    await ensureSemanticHotHnswIndexes(client, log);
    semanticEmbeddingColumnMode = 'vector';
    semanticIterativeScanSupported = await detectSemanticIterativeScanSupport(client);
    return;
  }
  if (udtName !== 'jsonb') {
    // Unknown shape — leave it alone and keep the brute-force path honest.
    semanticEmbeddingColumnMode = 'jsonb';
    semanticIterativeScanSupported = false;
    return;
  }

  // Index rows are derived data (rebuilt by the semantic backfill machinery),
  // so rows that cannot cast to a vector — non-array payloads or arrays
  // containing null — are dropped rather than wedging boot forever.
  const garbage = await client.query(
    `DELETE FROM semantic_search_blob
      WHERE jsonb_typeof(embedding) <> 'array' OR embedding @> 'null'::jsonb`,
  );
  if (garbage.rowCount > 0) {
    log(`[PDPP] Semantic index migration: dropped ${garbage.rowCount} non-castable embedding rows (they will be rebuilt by the semantic backfill)`);
  }

  const totalResult = await client.query('SELECT COUNT(*) AS n FROM semantic_search_blob');
  const total = Number(totalResult.rows[0]?.n || 0);
  if (total > 0) {
    log(`[PDPP] Semantic index migration: converting semantic_search_blob.embedding JSONB → pgvector (${total} rows)`);
  }

  await client.query('ALTER TABLE semantic_search_blob ADD COLUMN IF NOT EXISTS embedding_vec vector');

  const batchSize = semanticVectorMigrationBatchSize();
  let migrated = 0;
  for (;;) {
    const batch = await client.query(
      `UPDATE semantic_search_blob
          SET embedding_vec = (embedding::text)::vector
        WHERE ctid IN (
          SELECT ctid FROM semantic_search_blob WHERE embedding_vec IS NULL LIMIT $1
        )`,
      [batchSize],
    );
    if (batch.rowCount === 0) break;
    migrated += batch.rowCount;
    log(`[PDPP] Semantic index migration: backfilled ${migrated} embeddings`);
  }

  await client.query('BEGIN');
  try {
    await client.query('ALTER TABLE semantic_search_blob DROP COLUMN embedding');
    await client.query('ALTER TABLE semantic_search_blob RENAME COLUMN embedding_vec TO embedding');
    await client.query('ALTER TABLE semantic_search_blob ALTER COLUMN embedding SET NOT NULL');
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw err;
  }

  await ensureSemanticEmbeddingHnswIndex(client, log);
  await ensureSemanticHotHnswIndexes(client, log);
  semanticEmbeddingColumnMode = 'vector';
  semanticIterativeScanSupported = await detectSemanticIterativeScanSupport(client);
  if (total > 0) {
    log('[PDPP] Semantic index migration: complete — semantic queries now use pgvector cosine distance');
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

  // Drop the identity index BEFORE reconciling duplicates so the DELETE can
  // collapse rows that would violate the new (locator-free) identity, then
  // recreate it. Wrapped in a transaction so the dedupe and index recreation are
  // atomic. The new identity excludes the volatile locator when a record_key is
  // present, so pre-existing rows differing ONLY in detail_locator_json (the
  // locator-schema-drift orphan class) now collide.
  await client.query('BEGIN');
  try {
    await client.query('DROP INDEX IF EXISTS uniq_pg_connector_detail_gaps_identity');
    await client.query('DROP INDEX IF EXISTS idx_pg_connector_detail_gaps_pending');
    // Reconcile pre-existing duplicate rows under the NEW identity: keep the most
    // resolved sibling per identity group (terminal > recovered > in_progress >
    // pending, then newest updated_at, then gap_id) and delete the rest. This
    // closes the immortal orphan pending rows recovered/terminalized under a
    // new-shape locator. NULL grant_id / parent_stream / record_key are
    // COALESCE/NULLIF-normalized so NULLs are not a uniqueness loophole (Postgres
    // treats bare NULLs as distinct in a UNIQUE index).
    await client.query(`
      DELETE FROM connector_detail_gaps
      WHERE gap_id IN (
        SELECT gap_id FROM (
          SELECT gap_id,
            ROW_NUMBER() OVER (
              PARTITION BY connector_instance_id, COALESCE(grant_id, ''), stream, COALESCE(parent_stream, ''),
                CASE WHEN NULLIF(record_key, '') IS NOT NULL THEN 'key:' || record_key ELSE 'loc:' || COALESCE(detail_locator_json::text, '') END
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
        ) ranked
        WHERE rank > 1
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_pg_connector_detail_gaps_identity
        ON connector_detail_gaps(connector_instance_id, COALESCE(grant_id, ''), stream, COALESCE(parent_stream, ''), (CASE WHEN NULLIF(record_key, '') IS NOT NULL THEN 'key:' || record_key ELSE 'loc:' || COALESCE(detail_locator_json::text, '') END))
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pg_connector_detail_gaps_pending
        ON connector_detail_gaps(connector_instance_id, grant_id, status, stream, next_attempt_after)
    `);
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw err;
  }
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

    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw err;
  }
  await ensurePostgresRecordsBlobSearchInstanceIndexes(client);
}

async function ensurePostgresRecordsBlobSearchInstanceIndexes(client) {
  await withPostgresAdvisoryLock(client, RECORDS_BLOB_SEARCH_INDEX_LOCK_ID, async () => {
    // semantic_time on EXISTING records tables: add (idempotent), DEFAULT '' so the
    // boot migration is O(1) (no mass UPDATE on the live multi-million-row table —
    // that bloat/lock is avoided). Existing rows keep ''; the substrate read
    // COALESCEs '' -> emitted_at, so the merged-timeline sort is no worse than the
    // prior order until the chunked per-record semantic backfill (Step B) populates
    // the real values. New writes set semantic_time at ingest.
    await client.query("ALTER TABLE records ADD COLUMN IF NOT EXISTS semantic_time TEXT NOT NULL DEFAULT ''");
    await ensurePostgresIndexDefinition(client, {
      name: 'idx_pg_records_lookup',
      createSql: 'CREATE INDEX IF NOT EXISTS idx_pg_records_lookup ON records(connector_instance_id, stream, record_key)',
      expectedFragments: ['records USING btree (connector_instance_id, stream, record_key)'],
    });
    await ensurePostgresIndexDefinition(client, {
      name: 'idx_pg_records_stream_version',
      createSql: 'CREATE INDEX IF NOT EXISTS idx_pg_records_stream_version ON records(connector_instance_id, stream, version)',
      expectedFragments: ['records USING btree (connector_instance_id, stream, version)'],
    });
    await ensurePostgresIndexDefinition(client, {
      name: 'idx_pg_records_stream_cursor',
      createSql: 'CREATE INDEX IF NOT EXISTS idx_pg_records_stream_cursor ON records(connector_instance_id, stream, deleted, cursor_value, primary_key_text)',
      expectedFragments: ['records USING btree (connector_instance_id, stream, deleted, cursor_value, primary_key_text)'],
    });
    await ensurePostgresIndexDefinition(client, {
      name: 'idx_pg_records_connector_stream_deleted',
      createSql: 'CREATE INDEX IF NOT EXISTS idx_pg_records_connector_stream_deleted ON records(connector_id, stream, deleted)',
      expectedFragments: ['records USING btree (connector_id, stream, deleted)'],
    });
    // EXPRESSION index matching the Explore read ORDER BY EXACTLY. The read sorts
    // by COALESCE(NULLIF(semantic_time, ''), emitted_at) (un-backfilled rows fall
    // back to emitted_at) — a plain semantic_time index does NOT back that
    // expression, so the planner would Seq Scan + Sort the whole records table on
    // every page. The expression index keeps the hot path index-backed BEFORE the
    // Step-B backfill. Verified via EXPLAIN: Index Scan, no Sort.
    await ensurePostgresIndexDefinition(client, {
      name: 'idx_pg_records_semantic_time',
      createSql: "CREATE INDEX IF NOT EXISTS idx_pg_records_semantic_time ON records(connector_instance_id, stream, (COALESCE(NULLIF(semantic_time, ''), emitted_at)) DESC, record_key DESC)",
      expectedFragments: [
        "records USING btree (connector_instance_id, stream, COALESCE(NULLIF(semantic_time, ''::text), emitted_at) DESC, record_key DESC)",
      ],
    });
    await ensurePostgresIndexDefinition(client, {
      name: 'idx_pg_record_changes_record',
      createSql: 'CREATE INDEX IF NOT EXISTS idx_pg_record_changes_record ON record_changes(connector_instance_id, stream, record_key, version)',
      expectedFragments: ['record_changes USING btree (connector_instance_id, stream, record_key, version)'],
    });
    // Covers the bounded version-stats hot path: MAX(emitted_at) / COUNT grouped
    // by (connector_instance_id, stream). The record-keyed index above omits
    // emitted_at, so MAX(emitted_at) otherwise forces a per-row heap visit.
    await ensurePostgresIndexDefinition(client, {
      name: 'idx_pg_record_changes_emitted',
      createSql: 'CREATE INDEX IF NOT EXISTS idx_pg_record_changes_emitted ON record_changes(connector_instance_id, stream, emitted_at)',
      expectedFragments: ['record_changes USING btree (connector_instance_id, stream, emitted_at)'],
    });
    await ensurePostgresIndexDefinition(client, {
      name: 'idx_pg_blob_bindings_record',
      createSql: 'CREATE INDEX IF NOT EXISTS idx_pg_blob_bindings_record ON blob_bindings(connector_instance_id, stream, record_key)',
      expectedFragments: ['blob_bindings USING btree (connector_instance_id, stream, record_key)'],
    });
    await ensurePostgresIndexDefinition(client, {
      name: 'idx_pg_semantic_search_scope',
      createSql: 'CREATE INDEX IF NOT EXISTS idx_pg_semantic_search_scope ON semantic_search_blob(connector_instance_id, scope_key)',
      expectedFragments: ['semantic_search_blob USING btree (connector_instance_id, scope_key)'],
    });
  });
}

async function withPostgresAdvisoryLock(client, lockId, fn) {
  await client.query('SELECT pg_advisory_lock($1::bigint)', [lockId]);
  try {
    return await fn();
  } finally {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [lockId]).catch(() => {});
  }
}

function normalizePostgresIndexDefinition(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function assertSafePostgresIndexName(indexName) {
  if (!/^[a-z][a-z0-9_]*$/.test(indexName)) {
    throw new Error(`unsafe postgres index name: ${indexName}`);
  }
}

async function readPostgresIndexDefinition(client, indexName) {
  const existing = await client.query(
    `SELECT pg_get_indexdef(idx.oid) AS definition, ix.indisvalid AS valid, ix.indisready AS ready
       FROM pg_class idx
       JOIN pg_namespace ns ON ns.oid = idx.relnamespace
       JOIN pg_index ix ON ix.indexrelid = idx.oid
      WHERE ns.nspname = current_schema()
        AND idx.relname = $1
      LIMIT 1`,
    [indexName],
  );
  return existing.rows[0] ?? null;
}

async function ensurePostgresIndexDefinition(client, { name, createSql, expectedFragments }) {
  assertSafePostgresIndexName(name);
  const existing = await readPostgresIndexDefinition(client, name);
  const normalizedDefinition = normalizePostgresIndexDefinition(existing?.definition);
  const matchesExpected =
    existing?.valid === true &&
    existing?.ready === true &&
    expectedFragments.every((fragment) =>
      normalizedDefinition.includes(normalizePostgresIndexDefinition(fragment))
    );

  if (matchesExpected) return;
  if (existing) {
    await client.query(`DROP INDEX IF EXISTS ${name}`);
  }
  await client.query(createSql);
}

async function ensurePostgresLexicalScopedGinIndex(client, log = () => {}) {
  const extension = await client.query("SELECT 1 FROM pg_extension WHERE extname = 'btree_gin' LIMIT 1");
  if (extension.rowCount === 0) {
    log('[PDPP] Lexical search scoped GIN index skipped: btree_gin extension is unavailable');
    return;
  }
  const existing = await client.query(
    `SELECT ix.indisvalid AS valid
       FROM pg_class idx
       JOIN pg_namespace ns ON ns.oid = idx.relnamespace
       JOIN pg_index ix ON ix.indexrelid = idx.oid
      WHERE ns.nspname = current_schema()
        AND idx.relname = 'idx_pg_lexical_search_scope_document'
      LIMIT 1`,
  );
  if (existing.rowCount > 0 && existing.rows[0]?.valid === true) return;
  if (existing.rowCount > 0) {
    log('[PDPP] Lexical search migration: dropping invalid scoped GIN index before rebuild');
    await client.query('DROP INDEX CONCURRENTLY IF EXISTS idx_pg_lexical_search_scope_document');
  }

  // Existing deployments can have millions of lexical rows. Build
  // concurrently so startup does not hold a table-wide write lock while the
  // reference remains otherwise readable.
  log('[PDPP] Lexical search migration: building scoped GIN index idx_pg_lexical_search_scope_document');
  const startedAt = Date.now();
  await client.query(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pg_lexical_search_scope_document
       ON lexical_search_index
       USING GIN (connector_instance_id, stream, document)`,
  );
  log(`[PDPP] Lexical search migration: scoped GIN index ready in ${Math.round((Date.now() - startedAt) / 1000)}s`);
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
         CHECK (source_kind IN ('account', 'local_device', 'browser_collector', 'manual'))
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

// Widen the source_kind CHECK to admit `browser_collector` alongside the
// existing account/local_device/manual kinds. Idempotent: no-op once the
// constraint already names `browser_collector`. A database created or last
// migrated before the browser-collector enrollment primitive carries the
// narrower CHECK; without this a `browser_collector` enrollment would be
// rejected by the constraint. See add-browser-collector-enrollment-primitive.
async function migratePostgresConnectorInstancesSourceKindBrowserCollector(client) {
  const checkInfo = await client.query(
    `SELECT conname, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conrelid = 'connector_instances'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) ILIKE '%source_kind%'`,
  );
  const alreadyWidened = checkInfo.rows.some((row) => String(row.def).includes('browser_collector'));
  if (alreadyWidened) {
    return;
  }
  await client.query('BEGIN');
  try {
    for (const row of checkInfo.rows) {
      await client.query(`ALTER TABLE connector_instances DROP CONSTRAINT IF EXISTS ${pgIdentifier(row.conname)}`);
    }
    await client.query(
      `ALTER TABLE connector_instances
         ADD CONSTRAINT connector_instances_source_kind_check
         CHECK (source_kind IN ('account', 'local_device', 'browser_collector', 'manual'))`,
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

// Boot-safe spine source schema migration. This installs the
// `source_kind`/`source_id` columns and their index and drops the superseded
// `provider_id` column. It is bounded, idempotent DDL only — it does NOT scan
// or rewrite `spine_events` rows.
//
// The per-row value backfill that previously lived here ran a full
// `SELECT … FROM spine_events` plus per-row `UPDATE` inside one long
// transaction on every boot. On a large spine (~361k rows on the public
// reference deployment) that stalled startup for ~90–120s and held a
// transaction whose locks blocked owner reads. It could never converge
// because ~8.9k events are legitimately sourceless (token/consent/disclosure
// events with no data source), so `deriveSpineSource` correctly returns null
// and they stay NULL forever. The backfill now lives in an explicit operator
// maintenance script (`scripts/backfill-spine-source/`).
//
// NULL legacy `source_*` columns are tolerable: unfiltered correlation
// summaries derive source from canonical event payloads or runtime actor
// fallback when the columns are NULL. Source-*filtered* spine correlations
// under-count not-yet-backfilled legacy rows, which the maintenance script
// repairs on demand. See
// openspec/changes/harden-startup-data-backfills.
async function migratePostgresSpineSourceColumns(client) {
  await client.query(`
    ALTER TABLE spine_events
      ADD COLUMN IF NOT EXISTS source_kind TEXT,
      ADD COLUMN IF NOT EXISTS source_id TEXT
  `);

  if (await hasPostgresColumn(client, 'spine_events', 'provider_id')) {
    await client.query('ALTER TABLE spine_events DROP COLUMN provider_id');
  }

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_pg_spine_events_source
      ON spine_events(source_kind, source_id, occurred_at, recorded_at)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_pg_spine_events_trace_recent
      ON spine_events(occurred_at DESC, event_seq DESC, trace_id)
      WHERE trace_id IS NOT NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_pg_spine_events_run_recent
      ON spine_events(occurred_at DESC, event_seq DESC, run_id)
      WHERE run_id IS NOT NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_pg_spine_events_grant_recent
      ON spine_events(occurred_at DESC, event_seq DESC, grant_id)
      WHERE grant_id IS NOT NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_pg_spine_events_source_run_summary
      ON spine_events(source_kind, source_id, run_id, occurred_at DESC)
      WHERE run_id IS NOT NULL
  `);
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
 * See docs/reference/binary-content-invariant-design-brief.md §4.6.
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
  await client.query(`
    ALTER TABLE device_ingest_batch_outcomes
      ADD COLUMN IF NOT EXISTS connector_instance_id TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS connector_id TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS batch_seq INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS record_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS durable_prefix_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS manifest_fingerprint TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS semantic_capability_identity TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS accepted_at TEXT
  `);
  await client.query(`
    ALTER TABLE device_ingest_batch_outcomes
      ALTER COLUMN http_status DROP NOT NULL,
      ALTER COLUMN response_json DROP NOT NULL
  `);
  await client.query(`
    UPDATE device_ingest_batch_outcomes
       SET status = 'accepted',
           accepted_at = COALESCE(accepted_at, created_at),
           record_count = CASE
             WHEN record_count > 0 THEN record_count
             WHEN response_json ? 'accepted_record_count'
               THEN GREATEST(0, COALESCE((response_json->>'accepted_record_count')::integer, 0))
             ELSE 0
           END,
           durable_prefix_count = CASE
             WHEN record_count > 0 THEN record_count
             WHEN response_json ? 'accepted_record_count'
               THEN GREATEST(0, COALESCE((response_json->>'accepted_record_count')::integer, 0))
             ELSE 0
           END
     WHERE status = 'accepted'
       AND accepted_at IS NULL
  `);
  await client.query(`
    DO $$
    DECLARE constraint_row record;
    BEGIN
      FOR constraint_row IN
        SELECT conname
          FROM pg_constraint
         WHERE conrelid = 'device_ingest_batch_outcomes'::regclass
           AND contype = 'c'
           AND (
             pg_get_constraintdef(oid) LIKE '%status%'
             OR pg_get_constraintdef(oid) LIKE '%durable_prefix_count%'
           )
      LOOP
        EXECUTE format('ALTER TABLE device_ingest_batch_outcomes DROP CONSTRAINT %I', constraint_row.conname);
      END LOOP;
    END $$;
    ALTER TABLE device_ingest_batch_outcomes
      ADD CONSTRAINT device_ingest_batch_outcomes_state_check
        CHECK (status IN ('processing', 'accepted')),
      ADD CONSTRAINT device_ingest_batch_outcomes_prefix_check
        CHECK (durable_prefix_count >= 0 AND durable_prefix_count <= record_count),
      ADD CONSTRAINT device_ingest_batch_outcomes_accepted_complete_check
        CHECK (status <> 'accepted' OR durable_prefix_count = record_count);
  `);
}
