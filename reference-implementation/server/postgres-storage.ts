// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { type Pool as PgPool, Pool, type PoolClient, type QueryResultRow } from "pg";
import {
  hashKey,
  makeConnectorInstanceId,
  makeConnectorInstanceSourceBindingKey,
  nonEmptyString,
  stableJson,
} from "./connector-instance-utils.ts";
import {
  ConnectorInstanceAdmissionError,
  connectorInstanceAdvisoryLockKey,
  connectorInstanceLockWaitMs,
} from "./connector-instance-write-coordinator.ts";
import { canonicalConnectorKey } from "./connector-key.ts";
import {
  advancePostgresMigrationCursor,
  blockPostgresMigration,
  claimPostgresMigration,
  completePostgresMigration,
  ensurePostgresMigrationLedger,
  LOCAL_DEVICE_CANONICALIZATION_MIGRATION_ID,
  readPostgresMigrationLedgerRow,
} from "./postgres-migration-ledger.ts";
import {
  assertTestDatabase,
  claimAlreadyAdmittedTestDatabaseChildAttachment,
  testDatabaseGuardActive,
} from "./postgres-test-database-guard.ts";
import { RECORD_REJECTION_GENERATION, recordRejectionReplayKey } from "./record-rejection-replay-key.ts";
import { bumpStorageGeneration } from "./storage-generation.ts";

const VALID_BACKENDS = new Set(["sqlite", "postgres"]);
const LEGACY_SYNC_STATE_OWNER_SUBJECT_ID = "owner_local";
// Distinguishes two boots of the same pid (container restart, pid reuse) in
// the migration ledger's lease_owner. Diagnostic only: the advisory bootstrap
// lock, not this string, is what serializes concurrent boots.
const POSTGRES_MIGRATION_LEASE_OWNER_NONCE = createHash("sha256")
  .update(`${process.pid}:${Date.now()}:${Math.random()}`)
  .digest("hex")
  .slice(0, 12);

type StorageBackend = "postgres" | "sqlite";
type StorageLog = (message: string) => void;
const NOOP_STORAGE_LOG: StorageLog = () => {
  /* no-op */
};

interface ConstraintRow extends QueryResultRow {
  conname: string;
  definition: string;
}

interface IndexDefinitionRow extends QueryResultRow {
  indexdef: string;
}

interface LocalDeviceMigrationRow extends QueryResultRow {
  connector_id: string;
  connector_instance_id: string | null;
  device_id: string;
  local_binding_id: string;
  owner_subject_id: string;
  source_instance_id: string;
}

interface StorageConfig {
  backend: "postgres";
  databaseUrl: string;
}

interface StorageOptions {
  env?: NodeJS.ProcessEnv;
  opts?: {
    databaseUrl?: string;
    storageBackend?: string;
  };
}

let activeBackend: StorageBackend = "sqlite";
let pool: PgPool | null = null;
let bulkPool: PgPool | null = null;
let lockPool: PgPool | null = null;
let lockPoolCapacity = 0;

/**
 * Connection-lane sizing, 2026-08-21. The RI runs the HTTP server, the run
 * scheduler and the connector/embedding runtime in ONE Node process sharing
 * ONE node-postgres Pool that never set `max` — so the library default of 10
 * connections was the entire budget for interactive request handlers AND the
 * background ingest/backfill pipeline together. A burst of bulk work could
 * therefore starve an interactive handler of a connection outright, which is
 * a QUEUEING failure independent of how long any single statement runs (and
 * so is not fixed by the keyset index that precedes this change, nor by the
 * per-statement bound below).
 *
 * Splitting the single pool in two is the node-postgres-layer equivalent of
 * PgBouncer's pool-alias partitioning, without adding PgBouncer to a
 * single-process deployment. `max_connections` on this instance is 100, so
 * 8 + 3 + 1 is nowhere near the server ceiling; the point is not to conserve
 * connections but to make the interactive lane's supply independent of bulk
 * demand.
 */
const POSTGRES_INTERACTIVE_POOL_MAX = 8;
const POSTGRES_BULK_POOL_MAX = 3;

/**
 * Hard per-statement ceiling for the bulk lane. Postgres cannot preempt a
 * transaction once admitted (see the PostgreSQL wiki's own "Priorities"
 * page: there are no facilities to limit or prioritize resources per
 * user/query), so a client-side pacer can decline to start the NEXT unit of
 * work but can never shorten one already running. `statement_timeout` is the
 * only mechanism that bounds an in-flight statement from outside it.
 *
 * Applied as `SET LOCAL` inside each bulk transaction rather than
 * `ALTER ROLE ... SET`, deliberately: this deployment has exactly ONE role
 * (`pdpp`) serving both interactive and bulk traffic, so a role-scoped
 * timeout would apply the bulk bound to the owner's page loads too. `SET
 * LOCAL` reverts at transaction end and therefore cannot leak onto whichever
 * pooled client picks the connection up next — the same rule
 * `postgresQueryBounded` already documents and its test already proves.
 *
 * 15s, not the 2-5s the design sketch suggested: measured bulk statements on
 * this instance (live pg_stat_activity sampling during a real re-ingest) run
 * ~0.5-1.1s for the semantic and lexical writes once the keyset index lands.
 * A bound must be a BACKSTOP against pathology, not a routine cliff — set it
 * near the routine cost and an ordinary slow page turns a recoverable delay
 * into a failed backfill. 15s is ~14x the observed write cost and still an
 * order of magnitude under the 44.5s incident.
 */
const POSTGRES_BULK_STATEMENT_TIMEOUT_MS = 15_000;
/**
 * Bulk work must not sit in a lock queue either. Kept well under the
 * statement bound so a contended chunk fails fast and is retried on the next
 * pass rather than occupying a bulk-lane connection while it waits.
 */
const POSTGRES_BULK_LOCK_TIMEOUT_MS = 3000;

// Semantic embedding storage mode, detected at bootstrap. 'vector' when the
// pgvector extension is available and `semantic_search_blob.embedding` carries
// the pgvector `vector` type; 'jsonb' otherwise (legacy/brute-force fallback).
// See openspec/changes/migrate-postgres-semantic-index-to-pgvector/.
let semanticEmbeddingColumnMode = "jsonb";
// Whether the server supports `hnsw.iterative_scan` (pgvector >= 0.8), so
// filtered HNSW scans keep exact distance order without under-returning.
let semanticIterativeScanSupported = false;
let lexicalPgSearchAvailability = "unavailable";

// Production embedding profile dimensionality (search-semantic.js profiles).
// The HNSW index is a partial expression index pinned at this width — the
// documented pgvector pattern for a dimension-untyped `vector` column. Rows of
// other dimensions (test stub backends) fall outside the partial index and are
// scanned exactly.
const SEMANTIC_VECTOR_INDEXED_DIMENSIONS = 384;
const SEMANTIC_HNSW_INDEX_NAME = "idx_pg_semantic_search_embedding_hnsw";
const SEMANTIC_HOT_HNSW_INDEX_PREFIX = "idx_pg_semantic_hnsw_hot_";

/**
 * The catalog shape a semantic HNSW index must have to accelerate the
 * production read path. `indisvalid`/`indisready` plus the substring "hnsw"
 * is not enough: a same-name index built over the wrong dimension, the wrong
 * operator class, or the wrong partial predicate is valid and ready in the
 * catalog while accelerating nothing. Treating it as ready is a silent
 * readiness lie, so repair compares these fields and rebuilds on any mismatch.
 *
 * The comparison is structural rather than a diff of `pg_get_indexdef` text.
 * Generated SQL varies with things that do not change what the index means —
 * a schema needing quotes renders as `"My-Schema".semantic_search_blob`, and
 * an operator-supplied `WITH (m='32')` tuning clause is emitted verbatim.
 * Text equality would drop and rebuild those correct indexes on every startup.
 */
interface SemanticHnswIndexShape {
  accessMethod: string;
  indexExpression: string | null;
  indexPredicate: string | null;
  keyColumnCount: number;
  operatorClass: string | null;
  ready: boolean;
  tableName: string;
  totalColumnCount: number;
  valid: boolean;
}

/**
 * Select the structural shape of a same-name index. Returns at most one row;
 * no row means no index of that name exists in the current schema.
 */
const SEMANTIC_HNSW_INDEX_SHAPE_QUERY = `
  SELECT ix.indisvalid AS valid,
         ix.indisready AS ready,
         am.amname AS access_method,
         tbl.relname AS table_name,
         ix.indnkeyatts AS key_column_count,
         ix.indnatts AS total_column_count,
         (SELECT opc.opcname FROM pg_opclass opc WHERE opc.oid = ix.indclass[0]) AS operator_class,
         pg_get_expr(ix.indexprs, ix.indrelid) AS index_expression,
         pg_get_expr(ix.indpred, ix.indrelid) AS index_predicate
    FROM pg_class idx
    JOIN pg_namespace ns ON ns.oid = idx.relnamespace
    JOIN pg_index ix ON ix.indexrelid = idx.oid
    JOIN pg_am am ON am.oid = idx.relam
    JOIN pg_class tbl ON tbl.oid = ix.indrelid
   WHERE ns.nspname = current_schema() AND idx.relname = $1
   LIMIT 1`;

/** Keep SQL NULL distinct from the empty string: a missing predicate is not "". */
function nullableCatalogText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function readSemanticHnswIndexShape(row: Record<string, unknown> | undefined): SemanticHnswIndexShape | null {
  if (!row) {
    return null;
  }
  return {
    accessMethod: String(row.access_method ?? ""),
    indexExpression: nullableCatalogText(row.index_expression),
    indexPredicate: nullableCatalogText(row.index_predicate),
    keyColumnCount: Number(row.key_column_count ?? 0),
    operatorClass: nullableCatalogText(row.operator_class),
    ready: row.ready === true,
    tableName: String(row.table_name ?? ""),
    totalColumnCount: Number(row.total_column_count ?? 0),
    valid: row.valid === true,
  };
}

/**
 * `pg_get_expr` renders the 384-dimension cast as `(embedding)::vector(384)`.
 * Compare against that canonical rendering so a `vector(3)` index, a cast of
 * a different column, or a multi-expression index all fail the check.
 */
const SEMANTIC_HNSW_CANONICAL_EXPRESSION = `(embedding)::vector(${SEMANTIC_VECTOR_INDEXED_DIMENSIONS})`;
const SEMANTIC_HNSW_CANONICAL_OPERATOR_CLASS = "vector_cosine_ops";
const SEMANTIC_HNSW_DIMENSION_PREDICATE = `(vector_dims(embedding) = ${SEMANTIC_VECTOR_INDEXED_DIMENSIONS})`;

/** True when the index accelerates the production semantic read path as built. */
function isSemanticHnswIndexUsable(shape: SemanticHnswIndexShape | null, expectedPredicate: string): boolean {
  if (shape === null) {
    return false;
  }
  return (
    shape.valid &&
    shape.ready &&
    shape.accessMethod === "hnsw" &&
    shape.tableName === "semantic_search_blob" &&
    shape.keyColumnCount === 1 &&
    shape.totalColumnCount === 1 &&
    shape.operatorClass === SEMANTIC_HNSW_CANONICAL_OPERATOR_CLASS &&
    shape.indexExpression === SEMANTIC_HNSW_CANONICAL_EXPRESSION &&
    shape.indexPredicate === expectedPredicate
  );
}

/**
 * Name the first field that makes an existing index unusable, so the drop log
 * says why the index is being rebuilt instead of only that it was.
 */
function describeSemanticHnswIndexMismatch(shape: SemanticHnswIndexShape, expectedPredicate: string): string {
  if (!shape.valid) {
    return "not valid";
  }
  if (!shape.ready) {
    return "not ready";
  }
  if (shape.accessMethod !== "hnsw") {
    return `access method ${shape.accessMethod || "unknown"}, expected hnsw`;
  }
  if (shape.tableName !== "semantic_search_blob") {
    return `table ${shape.tableName || "unknown"}, expected semantic_search_blob`;
  }
  if (shape.keyColumnCount !== 1 || shape.totalColumnCount !== 1) {
    return `${shape.totalColumnCount} indexed columns, expected 1`;
  }
  if (shape.operatorClass !== SEMANTIC_HNSW_CANONICAL_OPERATOR_CLASS) {
    return `operator class ${shape.operatorClass ?? "none"}, expected ${SEMANTIC_HNSW_CANONICAL_OPERATOR_CLASS}`;
  }
  if (shape.indexExpression !== SEMANTIC_HNSW_CANONICAL_EXPRESSION) {
    return `expression ${shape.indexExpression ?? "none"}, expected ${SEMANTIC_HNSW_CANONICAL_EXPRESSION}`;
  }
  if (shape.indexPredicate !== expectedPredicate) {
    return `predicate ${shape.indexPredicate ?? "none"}, expected ${expectedPredicate}`;
  }
  return "definition mismatch";
}

/** Required partial predicate for the global (all-connectors) HNSW index. */
function semanticGlobalHnswPredicate(): string {
  return SEMANTIC_HNSW_DIMENSION_PREDICATE;
}

/**
 * Required partial predicate for one hot-source HNSW index. `pg_get_expr`
 * renders the connector filter with an explicit `::text` cast and wraps the
 * conjunction, so the expected text is built to match that rendering.
 */
function semanticHotHnswPredicate(connectorInstanceId: string): string {
  return (
    `((connector_instance_id = '${connectorInstanceId.replaceAll("'", "''")}'::text) ` +
    `AND ${SEMANTIC_HNSW_DIMENSION_PREDICATE})`
  );
}
const POSTGRES_SEMANTIC_HNSW_BUILD_LOCK = [482_571, 152];
const POSTGRES_SEMANTIC_HNSW_BUILD_TIMEOUT_ENV = "PDPP_PG_SEMANTIC_HNSW_BUILD_TIMEOUT_MS";
const POSTGRES_SEMANTIC_HNSW_BUILD_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const POSTGRES_SEMANTIC_HNSW_BUILD_HARD_MAX_TIMEOUT_MS = 30 * 60 * 1000;
const POSTGRES_SEMANTIC_HNSW_BUILD_LOCK_TIMEOUT_MS = 15_000;
const RECORDS_BLOB_SEARCH_INDEX_LOCK_ID = "8022352479012001";
const POSTGRES_DIRECT_PRIORITY_IN = /^CHECK \(\(?priority_class IN \([^)]*\)\)?\)$/i;
const POSTGRES_DIRECT_PRIORITY_ANY = /^CHECK \(\(?priority_class = ANY \(ARRAY\[[^\]]*\]\)\)?\)$/i;
const POSTGRES_WORK_MEM_LITERAL = /^\d+(kB|MB|GB)$/;
const CONNECTOR_INSTANCE_PREFIX = /^cin_/;
const CONNECTOR_INSTANCE_SAFE_CHARS = /[^a-zA-Z0-9]/g;
const POSTGRES_INDEX_NAME = /^[a-z][a-z0-9_]*$/;
const SEMANTIC_CONNECTOR_SAFE_CHARS = /[^a-z0-9]+/g;
const SEMANTIC_CONNECTOR_TRIM = /^_+|_+$/g;

export function resolvePostgresSemanticHnswBuildTimeoutMs({ env = process.env }: { env?: NodeJS.ProcessEnv } = {}) {
  const configured = Number(env[POSTGRES_SEMANTIC_HNSW_BUILD_TIMEOUT_ENV]);
  if (Number.isInteger(configured) && configured > 0) {
    return Math.min(configured, POSTGRES_SEMANTIC_HNSW_BUILD_HARD_MAX_TIMEOUT_MS);
  }
  return POSTGRES_SEMANTIC_HNSW_BUILD_DEFAULT_TIMEOUT_MS;
}

async function sequentially<T>(items: readonly T[], visit: (item: T) => Promise<void>): Promise<void> {
  const item = items.at(0);
  if (item === undefined) {
    return;
  }
  await visit(item);
  await sequentially(items.slice(1), visit);
}

function semanticVectorMigrationBatchSize() {
  const parsed = Number.parseInt(process.env.PDPP_PG_SEMANTIC_MIGRATION_BATCH_SIZE || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 50_000;
}

function semanticHotHnswMinRows() {
  const parsed = Number.parseInt(process.env.PDPP_PG_SEMANTIC_HOT_INDEX_MIN_ROWS || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 10_000;
}

function semanticHotHnswMaxIndexes() {
  const parsed = Number.parseInt(process.env.PDPP_PG_SEMANTIC_HOT_INDEX_MAX_CONNECTIONS || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 32) : 8;
}

function semanticHotHnswMaxTableShare() {
  const parsed = Number.parseFloat(process.env.PDPP_PG_SEMANTIC_HOT_INDEX_MAX_TABLE_SHARE || "");
  if (Number.isFinite(parsed) && parsed > 0 && parsed <= 1) {
    return parsed;
  }
  return 0.1;
}

export function isPostgresSemanticVectorEmbedding() {
  return activeBackend === "postgres" && semanticEmbeddingColumnMode === "vector";
}

export function isPostgresSemanticIterativeScanSupported() {
  return semanticIterativeScanSupported;
}

export function postgresLexicalPgSearchRequested({ env = process.env } = {}) {
  const raw = String(env.PDPP_RS_SEARCH_POSTGRES_BM25_BACKEND || "")
    .trim()
    .toLowerCase();
  return raw === "pg_search";
}

export function getPostgresLexicalBackendState({ env = process.env } = {}) {
  const requested = postgresLexicalPgSearchRequested({ env });
  if (activeBackend !== "postgres") {
    return {
      active: "sqlite_fts5",
      configured: requested,
      fallback: false,
      pg_search: {
        available: false,
        state: "not_applicable",
      },
    };
  }
  const available = lexicalPgSearchAvailability === "available";
  const state = (
    {
      "false:false": "unavailable",
      "false:true": "available_disabled",
      "true:false": "fallback_unavailable",
      "true:true": "enabled",
    } as const
  )[`${requested}:${available}` as `${boolean}:${boolean}`];
  return {
    active: requested && available ? "pg_search_bm25" : "postgres_native_fts",
    configured: requested,
    fallback: requested && !available,
    pg_search: {
      available,
      state,
    },
  };
}

function normalizeBackend(value: unknown): StorageBackend {
  const normalized = String(value || "sqlite")
    .trim()
    .toLowerCase();
  if (!VALID_BACKENDS.has(normalized)) {
    throw new Error(`Unsupported PDPP_STORAGE_BACKEND '${value}'. Expected 'sqlite' or 'postgres'.`);
  }
  return normalized as StorageBackend;
}

/**
 * The env var by which a deployment ARTIFACT asserts "records for this
 * deployment live in Postgres". It is an assertion about the surrounding
 * deployment that the runtime cannot observe for itself, in the same vein as
 * `PDPP_LOCAL_TRANSFORMER_SUPERVISOR_RESTART_CONTRACT` — and like that flag it
 * is set by the artifact itself, never by the operator-supplied env file whose
 * absence is the failure being guarded against.
 *
 * Deliberately NOT inferred. A `postgres` service sitting in the same compose
 * file, or a `depends_on` on it, does not declare storage intent: the root
 * compose brings that service up for env-gated conformance proofs and its own
 * comment says the reference "falls back to the SQLite default" without the
 * backend vars. Only this explicit declaration counts.
 */
const DEPLOYMENT_STORAGE_CONTRACT_ENV = "PDPP_DEPLOYMENT_STORAGE_CONTRACT";

export function resolveStorageBackend({ env = process.env, opts = {} }: StorageOptions = {}) {
  const databaseUrl = opts.databaseUrl ?? env.PDPP_DATABASE_URL ?? env.DATABASE_URL;
  const explicitBackend = nonEmptyString(opts.storageBackend ?? env.PDPP_STORAGE_BACKEND);
  const backend = normalizeBackend(explicitBackend ?? (nonEmptyString(databaseUrl) ? "postgres" : "sqlite"));
  if (backend === "sqlite") {
    // A deployment whose own artifact declares Postgres must never be served
    // from SQLite. Reaching here with that contract set means the config the
    // contract promised did not arrive — most often a hand-rolled
    // `docker compose up` without the `--env-file` that supplies it. Serving
    // anyway creates an EMPTY database behind the deployment's real URL and
    // returns HTTP 200 over it while the actual records sit untouched in
    // Postgres, which is worse than not starting.
    //
    // Only an explicit contract fails closed. With no contract at all this
    // returns SQLite exactly as before: the single-container product is a
    // legitimate deployment that runs with no storage config, and treating an
    // unset backend as fatal would break it.
    // `explicitBackend` is the operator answering the question deliberately —
    // that is a choice, not the silent fallback. Only ABSENT config trips the
    // guard, which is exactly the ruling's boundary.
    if (!explicitBackend) {
      assertDeploymentStorageContractSatisfied(env);
    }
    return { backend };
  }

  if (!databaseUrl) {
    throw new Error("PDPP_STORAGE_BACKEND=postgres requires PDPP_DATABASE_URL or DATABASE_URL.");
  }
  return { backend, databaseUrl };
}

/**
 * Fail closed when the deployment's artifact declared Postgres but the config
 * that declaration promised is absent. Names the two vars that were expected,
 * because the operator's next action is to supply them (or the `--env-file`
 * carrying them), not to debug the runtime.
 */
function assertDeploymentStorageContractSatisfied(env: NodeJS.ProcessEnv): void {
  const declared = nonEmptyString(env[DEPLOYMENT_STORAGE_CONTRACT_ENV])?.trim().toLowerCase();
  if (declared !== "postgres") {
    return;
  }
  throw new Error(
    `Refusing to start: ${DEPLOYMENT_STORAGE_CONTRACT_ENV}=postgres declares this deployment stores records in Postgres, but neither PDPP_STORAGE_BACKEND=postgres nor PDPP_DATABASE_URL/DATABASE_URL is set, so the runtime would silently fall back to SQLite and serve an empty database behind this deployment's URL. Supply the backend configuration (for the reference stack, that is the '--env-file .env.docker' the canonical 'scripts/reference-stack.sh up' always passes), or remove ${DEPLOYMENT_STORAGE_CONTRACT_ENV} if this deployment really is SQLite-backed.`
  );
}

export function getStorageBackendKind() {
  return activeBackend;
}

export function isPostgresStorageBackend() {
  return activeBackend === "postgres";
}

export function getPostgresPool(): PgPool {
  if (!pool) {
    throw new Error("Postgres storage has not been initialized.");
  }
  return pool;
}

/**
 * The bulk lane: ingest/backfill/embedding work. Separate from the
 * interactive pool so a burst of bulk statements cannot exhaust the
 * connections HTTP handlers need. Callers should reach this through
 * `postgresBulkQuery` rather than using the pool directly, so the bulk
 * statement/lock bounds are applied uniformly.
 */
export function getPostgresBulkPool(): PgPool {
  if (!bulkPool) {
    throw new Error("Postgres storage has not been initialized.");
  }
  return bulkPool;
}

export function getPostgresLockPool(): PgPool {
  if (!lockPool) {
    throw new Error("Postgres lock pool has not been initialized.");
  }
  return lockPool;
}

export function getPostgresLockPoolCapacity(): number {
  if (lockPoolCapacity <= 0) {
    throw new Error("Postgres lock pool capacity has not been initialized.");
  }
  return lockPoolCapacity;
}

const POSTGRES_LEASE_PRIORITY_CURRENT = ["interactive", "background"];
const POSTGRES_LEASE_PRIORITY_LEGACY = ["owner_interactive", "scheduled_refresh"];
const POSTGRES_LEASE_PRIORITY_MIXED = ["owner_interactive", "scheduled_refresh", "interactive", "background"];
// Stable, migration-specific key. This serializes only the durable lease
// priority conversion, not unrelated bootstrap work or ordinary lease I/O.
const POSTGRES_LEASE_PRIORITY_MIGRATION_LOCK = [482_571, 151];
// The public initializer also runs older additive migrations which are not
// individually concurrency-safe. Keep their DDL from racing a fully
// bootstrapped legacy-priority starter; the priority migration retains its own
// transaction-scoped lock below so its catalog decision is independently safe.
const POSTGRES_BOOTSTRAP_SERIALIZATION_LOCK = [482_571, 150];
const POSTGRES_BOOTSTRAP_LOCK_INITIAL_DELAY_MS = 25;
const POSTGRES_BOOTSTRAP_LOCK_MAX_DELAY_MS = 250;
// The bootstrap DDL batch takes an AccessExclusiveLock on tables (connectors,
// connector_instances, ...) that an ordinary connector-registration write
// (persistManifestAndAdvanceGenerations) also touches at row level. Postgres
// can build a genuine wait-for cycle between the two -- the DDL waiting on
// the row lock, the row writer waiting on the table lock the DDL has already
// begun to escalate toward -- and resolves it by aborting one side with
// SQLSTATE 40P01. This is a real rolling/blue-green-restart shape (a fresh
// instance bootstraps schema while an already-running instance still serves
// writes against the same database), not a test-only artifact. The
// serialization advisory lock above only serializes concurrent BOOTSTRAP
// callers against each other; it does nothing against an ordinary write
// transaction that predates the lock acquisition. Retrying the whole
// bootstrap attempt after Postgres aborts one side of the cycle is the
// standard resolution for a detected deadlock -- see
// bootstrapPostgresSchema's retry wrapper below.
const POSTGRES_BOOTSTRAP_DEADLOCK_SQLSTATE = "40P01";
const POSTGRES_BOOTSTRAP_DEADLOCK_MAX_ATTEMPTS = 4;
const POSTGRES_BOOTSTRAP_DEADLOCK_INITIAL_DELAY_MS = 50;
const POSTGRES_BOOTSTRAP_DEADLOCK_MAX_DELAY_MS = 400;
const POSTGRES_BOOTSTRAP_LOCK_TIMEOUT_ENV = "PDPP_POSTGRES_BOOTSTRAP_LOCK_TIMEOUT_MS";
const POSTGRES_BOOTSTRAP_LOCK_EMPTY_DATABASE_TIMEOUT_MS = 2 * 60 * 1000;
const POSTGRES_BOOTSTRAP_LOCK_POPULATED_DATABASE_TIMEOUT_MS = 10 * 60 * 1000;
const POSTGRES_BOOTSTRAP_LOCK_HARD_MAX_TIMEOUT_MS = 30 * 60 * 1000;
const POSTGRES_BOOTSTRAP_LOCK_POPULATED_DATABASE_BYTES = 64 * 1024 * 1024;
const POSTGRES_BOOTSTRAP_LOCK_PROGRESS_INTERVAL_MS = 5 * 1000;
const POSTGRES_BOOTSTRAP_LOCK_TIMEOUT_PATTERN = /^\d+$/;

export interface PostgresBootstrapLockBudget {
  databaseSizeBytes: number | null;
  timeoutMs: number;
}

export function resolvePostgresBootstrapLockTimeoutMs({
  databaseSizeBytes = null,
  env = process.env,
  overrideMs,
}: {
  databaseSizeBytes?: number | null;
  env?: NodeJS.ProcessEnv;
  overrideMs?: number;
} = {}): number {
  const configuredValue = overrideMs ?? env[POSTGRES_BOOTSTRAP_LOCK_TIMEOUT_ENV];
  let configured = Number.NaN;
  if (typeof configuredValue === "number") {
    configured = configuredValue;
  } else if (POSTGRES_BOOTSTRAP_LOCK_TIMEOUT_PATTERN.test(configuredValue?.trim() ?? "")) {
    configured = Number(configuredValue);
  }
  if (Number.isFinite(configured) && configured > 0) {
    return Math.min(configured, POSTGRES_BOOTSTRAP_LOCK_HARD_MAX_TIMEOUT_MS);
  }
  return (databaseSizeBytes ?? POSTGRES_BOOTSTRAP_LOCK_POPULATED_DATABASE_BYTES) >=
    POSTGRES_BOOTSTRAP_LOCK_POPULATED_DATABASE_BYTES
    ? POSTGRES_BOOTSTRAP_LOCK_POPULATED_DATABASE_TIMEOUT_MS
    : POSTGRES_BOOTSTRAP_LOCK_EMPTY_DATABASE_TIMEOUT_MS;
}

function samePostgresEnumMembers(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value) => expected.includes(value));
}

function postgresCheckLiterals(definition: string): string[] {
  return [...definition.matchAll(/'((?:''|[^'])*)'/g)].map((match) => (match[1] ?? "").replaceAll("''", "'"));
}

// pg_get_constraintdef renders an IN check as either IN (...) or = ANY (ARRAY[...])
// depending on the server version. Accept only those complete, direct enum forms:
// a compound check mentioning priority_class must never be rewritten by this migration.
function postgresDirectPriorityEnum(definition: string): string[] | null {
  const compact = definition
    .replace(/::text\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const isDirectIn = POSTGRES_DIRECT_PRIORITY_IN.test(compact);
  const isDirectAny = POSTGRES_DIRECT_PRIORITY_ANY.test(compact);
  return isDirectIn || isDirectAny ? postgresCheckLiterals(compact) : null;
}

function quotePostgresIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * Migrate only the known, direct priority enum check. Catalog discovery is
 * deliberately narrower than a text search: application-owned compound checks
 * remain untouched, and a current schema takes no priority DDL path at all.
 */
async function migratePostgresBrowserSurfaceLeasePriority(client: PoolClient): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", POSTGRES_LEASE_PRIORITY_MIGRATION_LOCK);
    // Read only after taking the migration lock. A waiting second starter must
    // classify the schema the first starter committed, not stale constraint
    // names it observed before the first ALTER TABLE.
    const table = await client.query("SELECT to_regclass('public.browser_surface_leases') AS table_name");
    if (!table.rows[0]?.table_name) {
      await client.query("COMMIT");
      return;
    }
    const constraints = await client.query<ConstraintRow>(`
      SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'browser_surface_leases'::regclass AND contype = 'c'
    `);
    const direct = constraints.rows
      .map((constraint) => ({
        ...constraint,
        values: postgresDirectPriorityEnum(constraint.definition),
      }))
      .filter((constraint): constraint is typeof constraint & { values: string[] } => Array.isArray(constraint.values));
    const legacy = direct.filter(
      (constraint) =>
        samePostgresEnumMembers(constraint.values, POSTGRES_LEASE_PRIORITY_LEGACY) ||
        samePostgresEnumMembers(constraint.values, POSTGRES_LEASE_PRIORITY_MIXED)
    );
    const current = direct.filter((constraint) =>
      samePostgresEnumMembers(constraint.values, POSTGRES_LEASE_PRIORITY_CURRENT)
    );
    const oldRows = await client.query(`
      SELECT 1 FROM browser_surface_leases
      WHERE priority_class IN ('owner_interactive', 'scheduled_refresh') LIMIT 1
    `);

    if (legacy.length === 0) {
      if ((oldRows.rowCount ?? 0) > 0 || current.length === 0) {
        throw new Error("Unsupported browser_surface_leases priority CHECK shape; refusing an unsafe migration.");
      }
      await client.query("COMMIT");
      return;
    }
    await legacy.reduce(async (previous, constraint) => {
      await previous;
      await client.query(
        `ALTER TABLE browser_surface_leases DROP CONSTRAINT ${quotePostgresIdentifier(constraint.conname)}`
      );
    }, Promise.resolve());
    await client.query(`
      UPDATE browser_surface_leases
      SET priority_class = CASE priority_class
        WHEN 'owner_interactive' THEN 'interactive'
        WHEN 'scheduled_refresh' THEN 'background'
        ELSE priority_class
      END
      WHERE priority_class IN ('owner_interactive', 'scheduled_refresh')
    `);
    if (current.length === 0) {
      await client.query(`
        ALTER TABLE browser_surface_leases
          ADD CONSTRAINT browser_surface_leases_priority_class_check
          CHECK (priority_class IN ('interactive', 'background'))
      `);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

// Add the durable next-page limit used by the resumable connector-summary
// repair scan. This is additive scheduling state: existing chunk receipts
// remain valid and use the default page size until their first timeout teaches
// the scan a smaller limit for this database.
async function migratePostgresConnectorSummaryEvidenceRepairChunkPageSize(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE connector_summary_evidence_repair_chunk
      ADD COLUMN IF NOT EXISTS page_size INTEGER
  `);
}

async function migratePostgresStreamEvidenceRunRegistry(client: PoolClient): Promise<void> {
  // Legacy claims remain spent. Nullable columns are deliberate: an old row
  // cannot be safely upgraded into terminal evidence, so the store rejects it
  // rather than inventing a replay payload.
  await client.query("ALTER TABLE stream_evidence_run_registry ADD COLUMN IF NOT EXISTS payload_json TEXT");
  await client.query("ALTER TABLE stream_evidence_run_registry ADD COLUMN IF NOT EXISTS replay_identity_json TEXT");
  await client.query("ALTER TABLE stream_evidence_run_registry ADD COLUMN IF NOT EXISTS payload_digest TEXT");
  await client.query("ALTER TABLE stream_evidence_run_registry ADD COLUMN IF NOT EXISTS event_id TEXT");
}

async function migratePostgresBrowserSurfaceLeaseLifecycleChecks(client: PoolClient): Promise<void> {
  const constraints = await client.query<ConstraintRow>(`
    SELECT conname, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid = 'browser_surface_leases'::regclass AND contype = 'c'
      AND conname IN ('browser_surface_leases_status_check', 'browser_surface_leases_wait_reason_check')
  `);
  const byName = new Map(constraints.rows.map((constraint) => [constraint.conname, constraint.definition]));
  const status = byName.get("browser_surface_leases_status_check");
  const waitReason = byName.get("browser_surface_leases_wait_reason_check");
  const needsStatus = status && !status.includes("'starting_surface'");
  const needsWaitReason = waitReason && !waitReason.includes("'retained_capacity_reserved'");
  if (!(needsStatus || needsWaitReason)) {
    return;
  }
  await client.query("BEGIN");
  try {
    if (needsStatus) {
      await client.query("ALTER TABLE browser_surface_leases DROP CONSTRAINT browser_surface_leases_status_check");
      await client.query(`ALTER TABLE browser_surface_leases ADD CONSTRAINT browser_surface_leases_status_check CHECK (status IN (
        'waiting_for_browser_surface', 'starting_surface', 'leased', 'released',
        'expired', 'deferred', 'cancelled', 'surface_failed'
      ))`);
    }
    if (needsWaitReason) {
      await client.query("ALTER TABLE browser_surface_leases DROP CONSTRAINT browser_surface_leases_wait_reason_check");
      await client.query(`ALTER TABLE browser_surface_leases ADD CONSTRAINT browser_surface_leases_wait_reason_check CHECK (wait_reason IS NULL OR wait_reason IN (
        'capacity_full', 'surface_starting', 'surface_unhealthy', 'surface_start_failed',
        'surface_readiness_timeout', 'incompatible_static_profile',
        'launch_precondition_failed', 'lease_wait_timeout', 'retained_capacity_reserved'
      ))`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function ensurePostgresBrowserSurfaceLeaseColumnsAndIndexes(client: PoolClient): Promise<void> {
  const column = await client.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'browser_surface_leases'
      AND column_name = 'surface_subject_id'
  `);
  if (column.rowCount === 0) {
    await client.query("ALTER TABLE browser_surface_leases ADD COLUMN surface_subject_id TEXT");
  }
  const index = await client.query<IndexDefinitionRow>(`
    SELECT indexdef FROM pg_indexes
    WHERE schemaname = current_schema() AND tablename = 'browser_surface_leases'
      AND indexname = 'idx_pg_browser_surface_leases_one_pending_connector_profile'
  `);
  if ((index.rowCount ?? 0) > 0 && index.rows[0]?.indexdef.includes("surface_subject_id")) {
    return;
  }
  await client.query("BEGIN");
  try {
    if ((index.rowCount ?? 0) > 0) {
      await client.query("DROP INDEX idx_pg_browser_surface_leases_one_pending_connector_profile");
    }
    await client.query(`
      CREATE UNIQUE INDEX idx_pg_browser_surface_leases_one_pending_connector_profile
      ON browser_surface_leases(connector_id, profile_key, COALESCE(surface_subject_id, ''), COALESCE(account_key, ''))
      WHERE status IN ('waiting_for_browser_surface', 'starting_surface')
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/**
 * Widen the config-revision status CHECK to admit `'rejected'`.
 *
 * An existing deployment carries the four-value constraint, so the owner's
 * refusal would be rejected by the DATABASE even with the store and route in
 * place (reproduced 2026-08-26: `CHECK constraint failed: status IN
 * ('proposed', 'active', 'superseded', 'quarantined')`). Widening only ADDS an
 * allowed value — no existing row can violate the new constraint, so this is
 * safe to run against live data and needs no backfill.
 */
async function migratePostgresConfigRevisionRejectedStatus(client: PoolClient): Promise<void> {
  const constraints = await client.query<ConstraintRow>(`
    SELECT conname, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid = 'connector_instance_config_revisions'::regclass AND contype = 'c'
      AND conname = 'connector_instance_config_revisions_status_check'
  `);
  const definition = constraints.rows[0]?.definition;
  if (!definition || definition.includes("'rejected'")) {
    return;
  }
  await client.query("BEGIN");
  try {
    await client.query(
      "ALTER TABLE connector_instance_config_revisions DROP CONSTRAINT connector_instance_config_revisions_status_check"
    );
    await client.query(
      `ALTER TABLE connector_instance_config_revisions ADD CONSTRAINT connector_instance_config_revisions_status_check
       CHECK (status IN ('proposed', 'active', 'superseded', 'quarantined', 'rejected'))`
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function migratePostgresRetainedSizeRejectionColumns(client: PoolClient): Promise<void> {
  const existingColumn = await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'retained_size_global'
        AND column_name = 'record_rejection_payload_bytes'`
  );
  for (const table of [
    "retained_size_global",
    "retained_size_connection",
    "retained_size_stream",
    "retained_size_record_family",
    "retained_size_top_rows",
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: one PoolClient is already inside bootstrap transaction scope; pg warns on concurrent queries on the same client.
    await client.query(
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS record_rejection_payload_bytes BIGINT NOT NULL DEFAULT 0`
    );
    await client.query(
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS record_rejection_count BIGINT NOT NULL DEFAULT 0`
    );
  }
  if ((existingColumn.rowCount ?? 0) > 0) {
    return;
  }
  await client.query(`
    INSERT INTO retained_size_stream(connector_instance_id, connector_id, stream, dirty)
    SELECT connector_instance_id, MAX(connector_id), stream, 1
      FROM record_rejections
     GROUP BY connector_instance_id, stream
    ON CONFLICT(connector_instance_id, stream) DO UPDATE SET dirty = 1;
    INSERT INTO retained_size_connection(connector_instance_id, connector_id, dirty)
    SELECT connector_instance_id, MAX(connector_id), 1
      FROM record_rejections
     GROUP BY connector_instance_id
    ON CONFLICT(connector_instance_id) DO UPDATE SET dirty = 1;
    UPDATE retained_size_global
       SET dirty = 1
     WHERE EXISTS (SELECT 1 FROM record_rejections)
  `);
}

export function postgresQuery<Row extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) {
  return getPostgresPool().query<Row>(sql, params);
}

async function migratePostgresRecordRejectionBytePayload(client: PoolClient): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(`
    ALTER TABLE record_rejection_quota
      ADD COLUMN IF NOT EXISTS pending_receipt_count BIGINT NOT NULL DEFAULT 0 CHECK (pending_receipt_count >= 0)
  `);
    await client.query("ALTER TABLE record_rejections ADD COLUMN IF NOT EXISTS payload BYTEA");
    await client.query(
      "ALTER TABLE record_rejections ADD COLUMN IF NOT EXISTS rejection_generation TEXT NOT NULL DEFAULT 'record-rejection-v1'"
    );
    await client.query("ALTER TABLE record_rejections ADD COLUMN IF NOT EXISTS first_run_id TEXT");
    await client.query("ALTER TABLE record_rejections ADD COLUMN IF NOT EXISTS latest_run_id TEXT");
    await client.query("ALTER TABLE record_rejections ADD COLUMN IF NOT EXISTS accepted_run_id TEXT");
    await client.query("ALTER TABLE record_rejections ADD COLUMN IF NOT EXISTS accepted_record_key TEXT");
    await client.query("ALTER TABLE record_rejections ADD COLUMN IF NOT EXISTS accepted_at TEXT");
    await client.query(
      "UPDATE record_rejections SET first_run_id = COALESCE(first_run_id, run_id), latest_run_id = COALESCE(latest_run_id, run_id)"
    );
    await client.query("ALTER TABLE record_rejections DROP CONSTRAINT IF EXISTS record_rejections_status_check");
    await client.query(
      "ALTER TABLE record_rejections ADD CONSTRAINT record_rejections_status_check CHECK (status IN ('pending', 'stale_after_acceptance'))"
    );
    const legacyTextColumn = await client.query(
      `SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'record_rejections'
        AND column_name = 'payload_text'
      LIMIT 1`
    );
    if ((legacyTextColumn.rowCount ?? 0) > 0) {
      await client.query(
        "UPDATE record_rejections SET payload = convert_to(payload_text, 'UTF8') WHERE payload IS NULL"
      );
    }
    await client.query(`
    UPDATE record_rejection_quota
       SET pending_payload_bytes = counts.payload_bytes,
           pending_receipt_count = counts.receipt_count
      FROM (
        SELECT owner_subject_id,
               COALESCE(SUM(payload_bytes), 0)::bigint AS payload_bytes,
               COUNT(*)::bigint AS receipt_count
          FROM record_rejections
         GROUP BY owner_subject_id
      ) counts
     WHERE record_rejection_quota.owner_subject_id = counts.owner_subject_id
       AND (
         record_rejection_quota.pending_payload_bytes IS DISTINCT FROM counts.payload_bytes
         OR record_rejection_quota.pending_receipt_count IS DISTINCT FROM counts.receipt_count
       )
  `);
    await client.query("ALTER TABLE record_rejections ALTER COLUMN payload SET NOT NULL");
    if ((legacyTextColumn.rowCount ?? 0) > 0) {
      await client.query("ALTER TABLE record_rejections DROP COLUMN payload_text");
    }
    const rows = await client.query<{
      connector_instance_id: string;
      owner_subject_id: string;
      payload: Buffer;
      reason_code: string;
      receipt_id: string;
      stream: string;
    }>(
      `SELECT receipt_id, owner_subject_id, connector_instance_id, stream, payload, reason_code
         FROM record_rejections
        WHERE rejection_generation <> $1`,
      [RECORD_REJECTION_GENERATION]
    );
    for (const row of rows.rows) {
      // biome-ignore lint/performance/noAwaitInLoops: Migration updates stay ordered inside the explicit transaction.
      await client.query(
        "UPDATE record_rejections SET replay_key = $1, rejection_generation = $2 WHERE receipt_id = $3",
        [
          recordRejectionReplayKey({
            connectorInstanceId: row.connector_instance_id,
            ownerSubjectId: row.owner_subject_id,
            payload: row.payload,
            reasonCode: row.reason_code,
            stream: row.stream,
          }),
          RECORD_REJECTION_GENERATION,
          row.receipt_id,
        ]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

// Postgres SQLSTATE raised when a statement is cancelled by `statement_timeout`.
const POSTGRES_STATEMENT_TIMEOUT_SQLSTATE = "57014";

/**
 * Thrown by `postgresQueryBounded` when Postgres itself cancelled the
 * statement because it exceeded the per-unit `SET LOCAL statement_timeout`.
 * Distinct from an ordinary query error: this is the per-unit HARD bound
 * (design review P1-2's second contract) actually firing, not a query
 * defect. Callers in a bounded reconciliation loop should treat it like any
 * other repair/discovery failure for this unit (fail this candidate/pass
 * closed; the row stays dirty and is retried on a later round), never let
 * it propagate as an unhandled rejection.
 */
export class PostgresStatementTimeoutError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      "Postgres statement exceeded its per-unit admission allowance and was cancelled by statement_timeout.",
      options
    );
    this.name = "PostgresStatementTimeoutError";
  }
}

/** Translate Postgres's SQLSTATE into the bounded-query contract at every client-query seam. */
export function asPostgresStatementTimeoutError(err: unknown): PostgresStatementTimeoutError | undefined {
  if ((err as { code?: string } | null)?.code !== POSTGRES_STATEMENT_TIMEOUT_SQLSTATE) {
    return undefined;
  }
  return new PostgresStatementTimeoutError({ cause: err });
}

/**
 * Runs exactly one statement under a Postgres-ENFORCED, connection-scoped
 * `SET LOCAL statement_timeout` — the per-unit HARD bound design review
 * P1-2 requires. `postgresQuery`/`pool.query()` above run bare, with no
 * explicit transaction: `SET LOCAL` requires an open transaction to scope
 * to, and a bare (non-`LOCAL`) `SET statement_timeout` on a pooled
 * connection would leak onto whatever OTHER caller the pool hands that same
 * physical connection to next once this call returns it. This function
 * therefore opens its own short-lived `BEGIN`/`COMMIT` around exactly one
 * statement — same connection-acquisition/release shape as
 * `withPostgresTransaction` above, so the timeout is provably confined to
 * this one statement on this one connection and the connection is always
 * released back to the pool (`finally`) regardless of outcome.
 *
 * `timeoutMs` must be derived by the CALLER from its own remaining
 * cooperative admission allowance (`deadline - Date.now()`), never a fixed
 * constant — a unit starting with 40ms left on the round's soft deadline
 * must not get the same server-side ceiling as one starting with 1900ms
 * left. Passing `timeoutMs <= 0` still issues `SET LOCAL statement_timeout`
 * with that value, which Postgres treats as invalid/disabled rather than
 * "expire immediately" — callers must check their own remaining budget
 * before calling this at all, exactly like every other admission point in
 * the bounded sweep; this function does not itself decide whether a unit is
 * still admissible.
 */
export async function postgresQueryBounded<Row extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[],
  timeoutMs: number
): Promise<{ rowCount: number | null; rows: Row[] }> {
  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);
    const result = await client.query<Row>(sql, params);
    await client.query("COMMIT");
    return { rowCount: result.rowCount, rows: result.rows };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Rollback failure must not hide the original statement/timeout error.
    }
    const statementTimeout = asPostgresStatementTimeoutError(err);
    if (statementTimeout) {
      throw statementTimeout;
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Runs one bulk-lane statement: on the BULK pool (so it cannot consume an
 * interactive connection) and under a `SET LOCAL` statement/lock timeout (so
 * it cannot run unbounded once Postgres has admitted it).
 *
 * This is the backstop half of the 2026-08-21 contention fix. The bulk
 * ingest/backfill path was ALREADY chunked before this change — the semantic
 * rebuild pages `records` 500 rows at a time and issues each page's read and
 * write as its own autocommit statement, holding no transaction across
 * pages. What it lacked was a lane of its own and a ceiling: every page
 * competed for the same 10 shared connections as the owner's page loads, and
 * nothing bounded a page that went pathological. Both gaps are what this
 * closes; the dominant COST of those pages was the missing keyset index,
 * fixed in the preceding commit.
 *
 * A `PostgresStatementTimeoutError` here means the bulk bound fired. Bulk
 * callers should treat it as "this chunk did not land, retry it on the next
 * pass" — never as data loss, since each chunk commits independently and the
 * keyset cursor simply does not advance past an uncommitted page.
 */
export async function postgresBulkQuery<Row extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = []
): Promise<{ rowCount: number | null; rows: Row[] }> {
  const client = await getPostgresBulkPool().connect();
  try {
    await client.query("BEGIN");
    // SET LOCAL, never bare SET: it reverts at COMMIT/ROLLBACK and so cannot
    // leak this bulk ceiling onto whichever caller the pool hands this
    // physical connection to next.
    await client.query(`SET LOCAL statement_timeout = ${POSTGRES_BULK_STATEMENT_TIMEOUT_MS}`);
    await client.query(`SET LOCAL lock_timeout = ${POSTGRES_BULK_LOCK_TIMEOUT_MS}`);
    const result = await client.query<Row>(sql, params);
    await client.query("COMMIT");
    return { rowCount: result.rowCount, rows: result.rows };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Rollback failure must not hide the original statement/timeout error.
    }
    if ((err as { code?: string } | null)?.code === POSTGRES_STATEMENT_TIMEOUT_SQLSTATE) {
      // biome-ignore lint/style/useErrorCause: cause is threaded through PostgresStatementTimeoutError's own constructor (matches postgresQueryBounded's identical established pattern) — biome cannot trace it through a custom Error subclass.
      throw new PostgresStatementTimeoutError({ cause: err });
    }
    throw err;
  } finally {
    client.release();
  }
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
    const totalResult = await postgresQuery("SELECT pg_database_size(current_database()) AS bytes");
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
    const topRelations: Array<{ bytes: number; name: string }> = [];
    for (const row of relationsResult?.rows ?? []) {
      const name = typeof row?.name === "string" ? row.name : null;
      const bytes = coerceByteCount(row?.bytes);
      if (name === null || bytes === null) {
        continue;
      }
      topRelations.push({ bytes, name });
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
function coerceByteCount(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const n = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isFinite(n) || n < 0) {
    return null;
  }
  return n;
}

// Postgres SQLSTATE raised when `SET LOCAL lock_timeout` expires waiting on
// any lock, including `pg_advisory_xact_lock` — see acquireConnectorInstanceXactLock.
const POSTGRES_LOCK_NOT_AVAILABLE_SQLSTATE = "55P03";

/**
 * Acquires a TRANSACTION-scoped connector-instance advisory lock
 * (`pg_advisory_xact_lock`) as the first statement inside an open
 * transaction. Unlike the session-scoped `pg_try_advisory_lock` this
 * subsystem used before, the lock releases itself automatically at this
 * transaction's COMMIT or ROLLBACK — no separate unlock call, no dedicated
 * connection, no risk of leaking a lock if the process holding it dies
 * mid-callback. It rides the SAME connection `withPostgresTransaction`
 * already checked out, so a caller acquiring this lock costs zero additional
 * Postgres pool connections.
 *
 * Bounded wait: `SET LOCAL lock_timeout` (scoped to this transaction only)
 * makes the subsequent blocking `pg_advisory_xact_lock` call fail fast with
 * SQLSTATE 55P03 instead of queuing indefinitely at the Postgres lock
 * manager. Translated to `ConnectorInstanceAdmissionError` so callers keep
 * today's external contract (HTTP 503, `connector_instance_busy`).
 *
 * Concurrent transactions locking the SAME connector instance serialize FIFO
 * at the Postgres lock manager — identical ordering guarantee to the prior
 * session-scoped design, just transaction-scoped instead of session-scoped.
 * See harden-connector-instance-write-fence-transaction-native.
 */
async function acquireConnectorInstanceXactLock(client: PoolClient, connectorInstanceId: string): Promise<void> {
  const key = connectorInstanceAdvisoryLockKey(connectorInstanceId);
  await client.query(`SET LOCAL lock_timeout = '${connectorInstanceLockWaitMs()}ms'`);
  try {
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [key]);
  } catch (err) {
    if ((err as { code?: string } | null)?.code === POSTGRES_LOCK_NOT_AVAILABLE_SQLSTATE) {
      // ConnectorInstanceAdmissionError's constructor takes no arguments
      // (matching its every other throw site in
      // connector-instance-write-coordinator.ts), so the original
      // lock_timeout error is not chained via `cause` — it carries no
      // information beyond the SQLSTATE already checked above.
      // biome-ignore lint/style/useErrorCause: matches ConnectorInstanceAdmissionError's existing no-arg constructor contract.
      throw new ConnectorInstanceAdmissionError();
    }
    throw err;
  }
}

/**
 * Acquire a class of connector-instance locks in one stable order.  A class
 * merge must never acquire A then B while another transaction acquires B then
 * A: sorting the identity values makes that order independent of discovery.
 */
async function acquireConnectorInstanceXactLocks(
  client: PoolClient,
  connectorInstanceIds: readonly string[]
): Promise<void> {
  const ids = [...new Set(connectorInstanceIds)].sort();
  for (const connectorInstanceId of ids) {
    // biome-ignore lint/performance/noAwaitInLoops: advisory locks must be acquired in one deterministic order.
    await acquireConnectorInstanceXactLock(client, connectorInstanceId);
  }
}

/**
 * Test-only direct-invocation seam for `acquireConnectorInstanceXactLock`
 * (2026-08-10 red-team follow-up): the prior dedicated-lock-pool design had
 * a deterministic default-CI test (`__setConnectorInstancePostgresLockPoolForTest`)
 * proving exactly-once advisory-lock acquisition against a fake pool/client.
 * That whole mechanism was removed with the dedicated pool itself, leaving
 * NO default-CI coverage of this module's real acquisition sequence (the
 * `SET LOCAL lock_timeout` statement, the `pg_advisory_xact_lock` call with
 * the derived key, and the `55P03` -> `ConnectorInstanceAdmissionError`
 * translation) — only the dedicated-Postgres-gated tests in
 * connector-instance-write-coordinator.test.ts exercise it, and those are
 * skipped by default. Exporting the function itself (rather than an
 * injectable fake pool) lets a test drive it directly against a fake
 * `PoolClient`-shaped object with no real Postgres connection at all, which
 * is both simpler than resurrecting a fake-pool seam and more precisely
 * targeted at the one thing this module actually still does: the per-call
 * (not per-batch) lock statement sequence.
 */
export function __acquireConnectorInstanceXactLockForTest(
  client: PoolClient,
  connectorInstanceId: string
): Promise<void> {
  return acquireConnectorInstanceXactLock(client, connectorInstanceId);
}

/** The client type `withPostgresTransaction`'s callback receives — shared so callers that thread a client through several functions (e.g. version-gated derived-index publish) don't each redeclare it. */
export type PostgresTransactionClient = PoolClient;

export async function withPostgresTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  options?: { lockConnectorInstanceId?: string; lockConnectorInstanceIds?: readonly string[] }
): Promise<T> {
  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN");
    if (options?.lockConnectorInstanceId) {
      await acquireConnectorInstanceXactLock(client, options.lockConnectorInstanceId);
    }
    if (options?.lockConnectorInstanceIds) {
      await acquireConnectorInstanceXactLocks(client, options.lockConnectorInstanceIds);
    }
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Rollback failure must not hide the original transaction error.
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Read an already-initialized deployment without bootstrap DDL or migrations. */
export async function withPostgresReadOnlyTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Rollback failure must not hide the original transaction error.
    }
    throw err;
  } finally {
    client.release();
  }
}

const REPAIR_REQUIRED_TABLES = [
  "browser_surface_replacement_receipts",
  "browser_surface_replacement_selection_overrides",
  "browser_surface_replacement_selection_override_batches",
  "browser_surface_replacement_selection_override_audit_outbox",
  "spine_events",
] as const;

export const POSTGRES_DETAIL_GAP_REPAIR_REQUIRED_TABLES = ["connector_detail_gaps", "records"] as const;

/**
 * Open only an existing repair schema. Absence of a caller-declared required
 * table fails closed; this intentionally never runs application bootstrap,
 * DDL, extensions, migrations, or indexes.
 */
export async function initExistingPostgresRepairStorage(
  config: StorageConfig | null | undefined,
  { requiredTables = REPAIR_REQUIRED_TABLES }: { requiredTables?: readonly string[] } = {}
) {
  if (config?.backend !== "postgres") {
    throw new Error("existing PostgreSQL repair storage requires a PostgreSQL database URL");
  }
  if (pool) {
    await closePostgresStorage();
  }
  pool = new Pool({ connectionString: config.databaseUrl, max: POSTGRES_INTERACTIVE_POOL_MAX });
  bulkPool = new Pool({ connectionString: config.databaseUrl, max: POSTGRES_BULK_POOL_MAX });
  lockPoolCapacity = 1;
  lockPool = new Pool({ connectionString: config.databaseUrl, max: lockPoolCapacity });
  activeBackend = "postgres";
  try {
    const result = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name = ANY($1::text[])",
      [requiredTables]
    );
    const present = new Set(result.rows.map((row) => row.table_name));
    const missing = requiredTables.filter((table) => !present.has(table));
    if (missing.length) {
      throw new Error(`existing PostgreSQL repair schema is missing required table(s): ${missing.join(", ")}`);
    }
    return pool;
  } catch (error) {
    await closePostgresStorage();
    throw error;
  }
}

export async function initPostgresStorage(
  config: StorageConfig | null | undefined,
  {
    log = () => {
      /* no-op */
    },
    bootstrapLockTimeoutMs,
    testOnlyAlreadyAdmittedChildAttachment,
  }: { log?: StorageLog; bootstrapLockTimeoutMs?: number; testOnlyAlreadyAdmittedChildAttachment?: string } = {}
) {
  if (config?.backend !== "postgres") {
    activeBackend = "sqlite";
    return null;
  }

  // Test-lane admission. Every Postgres-backed test path -- whether it goes
  // through the RI test runner or is invoked directly as `node --test file` --
  // reaches Postgres through THIS function, so this is the one chokepoint
  // where a test can be stopped before it writes into a real database. A test
  // lane must prove its target is a provisioned scratch database; an unmarked
  // database (production included) is refused loudly. Product/production boots
  // do not set the test env vars and are untouched.
  // See server/postgres-test-database-guard.ts for why this is a sentinel
  // rather than a production-URL blacklist.
  if (testDatabaseGuardActive()) {
    if (testOnlyAlreadyAdmittedChildAttachment === undefined) {
      await assertTestDatabase(config.databaseUrl);
    } else {
      await claimAlreadyAdmittedTestDatabaseChildAttachment(config.databaseUrl, testOnlyAlreadyAdmittedChildAttachment);
    }
  }

  if (pool) {
    await closePostgresStorage();
  }

  // Two lanes, not one shared pool: see POSTGRES_INTERACTIVE_POOL_MAX.
  pool = new Pool({ connectionString: config.databaseUrl, max: POSTGRES_INTERACTIVE_POOL_MAX });
  bulkPool = new Pool({ connectionString: config.databaseUrl, max: POSTGRES_BULK_POOL_MAX });
  lockPoolCapacity = 1;
  lockPool = new Pool({ connectionString: config.databaseUrl, max: lockPoolCapacity });
  activeBackend = "postgres";
  // Storage-lifecycle fence (server/storage-generation.ts): a fresh pool
  // means any deferred work scheduled against a prior pool (this function's
  // own closePostgresStorage() call above, or a prior SQLite epoch) must
  // never touch this new one.
  bumpStorageGeneration();

  await bootstrapPostgresSchema({ log, ...(bootstrapLockTimeoutMs === undefined ? {} : { bootstrapLockTimeoutMs }) });
  return pool;
}

export async function closePostgresStorage() {
  const current = pool;
  const currentBulkPool = bulkPool;
  const currentLockPool = lockPool;
  pool = null;
  bulkPool = null;
  lockPool = null;
  lockPoolCapacity = 0;
  activeBackend = "sqlite";
  semanticEmbeddingColumnMode = "jsonb";
  semanticIterativeScanSupported = false;
  // The verified-index cache describes the database being closed, not whatever
  // database a later initPostgresStorage() attaches.
  semanticGlobalHnswVerifiedUsable = false;
  lexicalPgSearchAvailability = "unavailable";
  // Storage-lifecycle fence: any deferred index-maintenance work scheduled
  // against the pool this just closed must never run against whatever pool
  // a later initPostgresStorage() creates.
  bumpStorageGeneration();
  if (current) {
    await current.end();
  }
  if (currentBulkPool) {
    await currentBulkPool.end();
  }
  if (currentLockPool) {
    await currentLockPool.end();
  }
}

/**
 * Runs the full bootstrap DDL/migration batch exactly once, against a fresh
 * checked-out client. Split out of `bootstrapPostgresSchema` so the retry
 * wrapper below can re-run the WHOLE attempt -- including the advisory-lock
 * acquisition and client checkout -- after a detected deadlock, rather than
 * resuming mid-batch against a client Postgres may have already aborted.
 */
async function bootstrapPostgresSchemaOnce({
  log = (() => {
    /* no-op */
  }) as StorageLog,
  bootstrapLockTimeoutMs,
}: {
  log?: StorageLog;
  bootstrapLockTimeoutMs?: number;
} = {}): Promise<void> {
  const client = await getPostgresPool().connect();
  let bootstrapLockHeld = false;
  try {
    const databaseSizeBytes = await readPostgresDatabaseSize(client);
    const lockBudget = {
      databaseSizeBytes,
      timeoutMs: resolvePostgresBootstrapLockTimeoutMs({
        databaseSizeBytes,
        ...(bootstrapLockTimeoutMs === undefined ? {} : { overrideMs: bootstrapLockTimeoutMs }),
      }),
    };
    log(
      `postgres bootstrap lock wait budget: ${lockBudget.timeoutMs}ms (database_size_bytes=${lockBudget.databaseSizeBytes ?? "unknown"}, source=${bootstrapLockTimeoutMs === undefined ? "data-aware/default" : "configured"})`
    );
    await acquirePostgresBootstrapLock(client, { budget: lockBudget, log });
    bootstrapLockHeld = true;
    // pgvector is optional. When available, the boot migration below moves
    // semantic embeddings to the pgvector representation; without it the
    // semantic fallback stores vectors as JSONB and computes distances after
    // grant-scoped candidate narrowing.
    try {
      await client.query("CREATE EXTENSION IF NOT EXISTS vector");
    } catch {
      // Optional extension installation is intentionally fail-open.
    }
    try {
      await client.query("CREATE EXTENSION IF NOT EXISTS btree_gin");
    } catch {
      // Optional extension installation is intentionally fail-open.
    }
    lexicalPgSearchAvailability = (await detectPgSearchExtension(client)) ? "available" : "unavailable";

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
        manifest_generation BIGINT NOT NULL DEFAULT 0,
        -- Monotonic per-instance receipt advanced by the source-boundary
        -- triggers installed after bootstrap migrations. Readers cast it to
        -- text so BIGINT values never narrow through JavaScript Number.
        source_revision BIGINT NOT NULL DEFAULT 0,
        UNIQUE(owner_subject_id, connector_id, source_kind, source_binding_key)
      );
      CREATE INDEX IF NOT EXISTS idx_pg_connector_instances_owner_connector_status
        ON connector_instances(owner_subject_id, connector_id, status);
      CREATE INDEX IF NOT EXISTS idx_pg_connector_instances_owner_identity_page
        ON connector_instances(owner_subject_id, connector_id, created_at, connector_instance_id);

      CREATE TABLE IF NOT EXISTS record_rejection_quota (
        owner_subject_id TEXT PRIMARY KEY,
        pending_payload_bytes BIGINT NOT NULL DEFAULT 0 CHECK (pending_payload_bytes >= 0),
        pending_receipt_count BIGINT NOT NULL DEFAULT 0 CHECK (pending_receipt_count >= 0),
        updated_at TEXT NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::text
      );

      CREATE TABLE IF NOT EXISTS record_rejections (
        receipt_id TEXT PRIMARY KEY,
        owner_subject_id TEXT NOT NULL REFERENCES record_rejection_quota(owner_subject_id) ON DELETE RESTRICT,
        connector_instance_id TEXT NOT NULL REFERENCES connector_instances(connector_instance_id) ON DELETE CASCADE,
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        run_id TEXT,
        first_input_index BIGINT NOT NULL CHECK (first_input_index >= 0),
        latest_input_index BIGINT NOT NULL CHECK (latest_input_index >= 0),
        first_run_id TEXT,
        latest_run_id TEXT,
        reason_code TEXT NOT NULL,
        payload BYTEA NOT NULL,
        payload_sha256 TEXT NOT NULL,
        payload_bytes BIGINT NOT NULL CHECK (payload_bytes >= 0),
        rejection_generation TEXT NOT NULL DEFAULT '${RECORD_REJECTION_GENERATION}',
        replay_key TEXT NOT NULL UNIQUE,
        replay_count BIGINT NOT NULL DEFAULT 0 CHECK (replay_count >= 0),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'stale_after_acceptance')),
        accepted_run_id TEXT,
        accepted_record_key TEXT,
        accepted_at TEXT,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pg_record_rejections_connection_page
        ON record_rejections(owner_subject_id, connector_instance_id, created_at, receipt_id);
      CREATE INDEX IF NOT EXISTS idx_pg_record_rejections_connection_receipt
        ON record_rejections(owner_subject_id, connector_instance_id, receipt_id);

      -- Durable record that a connector-instance IDENTITY was owner-deleted.
      -- See the SQLite arm (server/db.js) for the full rationale: the
      -- deterministic connector_instance_id/binding key would otherwise let a
      -- later upsert (e.g. device-exporter re-enrollment) silently
      -- resurrect a deleted identity once its row is gone. Identity + a
      -- timestamp only. See openspec/changes/fix-owner-delete-resurrection.
      CREATE TABLE IF NOT EXISTS connector_instance_tombstones (
        connector_instance_id TEXT PRIMARY KEY,
        owner_subject_id TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_binding_key TEXT NOT NULL,
        deleted_at TEXT NOT NULL,
        UNIQUE(owner_subject_id, connector_id, source_kind, source_binding_key)
      );

      -- Postgres mirror of the SQLite connector_instance_groups table (see
      -- server/db.ts for the full rationale). Reversible alias/read-model
      -- grouping only -- never a physical rehome of records or a rewrite of
      -- a fragment's own connector_instance_id.
      CREATE TABLE IF NOT EXISTS connector_instance_groups (
        connector_instance_id TEXT PRIMARY KEY,
        canonical_connector_instance_id TEXT NOT NULL,
        owner_subject_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        evidence TEXT NOT NULL DEFAULT '{}',
        grouped_by TEXT NOT NULL,
        grouped_at TEXT NOT NULL,
        CHECK (connector_instance_id <> canonical_connector_instance_id)
      );
      CREATE INDEX IF NOT EXISTS idx_pg_connector_instance_groups_owner
        ON connector_instance_groups(owner_subject_id);
      CREATE INDEX IF NOT EXISTS idx_pg_connector_instance_groups_canonical
        ON connector_instance_groups(canonical_connector_instance_id);

      -- Reset-safe record-source checkpoint: incremented by a supported
      -- stream/connector-wide reset over the distinct stream namespaces it
      -- touched, in the same transaction as the deletes. Combined with the
      -- per-stream version_counter vector this makes the composite checkpoint
      -- immune to the ABA collision a bare version vector has.
      -- Spec: openspec/changes/reconcile-active-summary-evidence/design.md
      ALTER TABLE connector_instances
        ADD COLUMN IF NOT EXISTS record_reset_generation BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE connector_instances
        ADD COLUMN IF NOT EXISTS manifest_generation BIGINT NOT NULL DEFAULT 0;
      -- Generic, connector-agnostic record-identity-generation checkpoint:
      -- see ensureRecordIdentityGenerationColumn's doc comment in db.ts for
      -- the full design (compared against a manifest's own declared
      -- capabilities.record_identity.generation at reconcile time).
      ALTER TABLE connector_instances
        ADD COLUMN IF NOT EXISTS record_identity_generation BIGINT NOT NULL DEFAULT 0;

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
        credential_kind TEXT NOT NULL CHECK (credential_kind IN ('access_token', 'api_key', 'app_password', 'personal_access_token', 'secret_bundle', 'username_password')),
        sealed_secret TEXT NOT NULL,
        fingerprint TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'rejected')),
        captured_at TEXT NOT NULL,
        rotated_at TEXT,
        revoked_at TEXT,
        rejected_at TEXT,
        rejection_reason TEXT,
        state_change_json JSONB
      );
      ALTER TABLE connector_instance_credentials
        ADD COLUMN IF NOT EXISTS rejected_at TEXT;
      ALTER TABLE connector_instance_credentials
        ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
      ALTER TABLE connector_instance_credentials
        ADD COLUMN IF NOT EXISTS state_change_json JSONB;
      CREATE INDEX IF NOT EXISTS idx_pg_connector_instance_credentials_owner_status
        ON connector_instance_credentials(owner_subject_id, status);

      -- Durable, provenance-bearing connector configuration: immutable
      -- per-connection revision ledger + current-pointer. See the matching
      -- comment above connector_instance_config_revisions in db.ts
      -- (SQLite) for the full rationale; kept in sync by hand across both
      -- backends.
      CREATE TABLE IF NOT EXISTS connector_instance_config_revisions (
        connector_instance_id TEXT NOT NULL
          REFERENCES connector_instances(connector_instance_id) ON DELETE CASCADE,
        revision BIGINT NOT NULL,
        config_json JSONB NOT NULL,
        config_contract_id TEXT NOT NULL,
        config_contract_version BIGINT NOT NULL,
        option_kind TEXT NOT NULL CHECK (option_kind IN ('collection_scope', 'transport')),
        origin TEXT NOT NULL CHECK (origin IN ('owner', 'agent', 'migration', 'default')),
        is_explicit BOOLEAN NOT NULL,
        status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'active', 'superseded', 'quarantined', 'rejected')),
        collection_boundary_fingerprint TEXT,
        source_of_change TEXT NOT NULL,
        set_by TEXT NOT NULL,
        set_at TEXT NOT NULL,
        confirmed_by TEXT,
        confirmed_at TEXT,
        PRIMARY KEY (connector_instance_id, revision)
      );

      CREATE INDEX IF NOT EXISTS idx_pg_connector_instance_config_revisions_instance
        ON connector_instance_config_revisions(connector_instance_id, revision);

      CREATE TABLE IF NOT EXISTS connector_instance_config_current (
        connector_instance_id TEXT PRIMARY KEY
          REFERENCES connector_instances(connector_instance_id) ON DELETE CASCADE,
        active_revision BIGINT NOT NULL,
        storage_epoch BIGINT NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (connector_instance_id, active_revision)
          REFERENCES connector_instance_config_revisions(connector_instance_id, revision)
      );

      -- Existing Postgres deployments may have the original active/revoked
      -- credential status CHECK. Widen it in place so rejected credentials
      -- preserve the same lifecycle contract as the SQLite store.
      DO $$
      DECLARE
        credential_status_constraint_name TEXT;
        credential_status_constraint_def TEXT;
      BEGIN
        FOR credential_status_constraint_name, credential_status_constraint_def IN
          SELECT conname, pg_get_constraintdef(oid)
            FROM pg_constraint
           WHERE conrelid = 'connector_instance_credentials'::regclass
             AND contype = 'c'
             AND pg_get_constraintdef(oid) LIKE '%status%'
             AND pg_get_constraintdef(oid) LIKE '%active%'
             AND pg_get_constraintdef(oid) LIKE '%revoked%'
        LOOP
          IF credential_status_constraint_def NOT LIKE '%rejected%' THEN
            EXECUTE format('ALTER TABLE connector_instance_credentials DROP CONSTRAINT %I', credential_status_constraint_name);
          END IF;
        END LOOP;

        IF NOT EXISTS (
          SELECT 1
            FROM pg_constraint
           WHERE conrelid = 'connector_instance_credentials'::regclass
             AND contype = 'c'
             AND pg_get_constraintdef(oid) LIKE '%status%'
             AND pg_get_constraintdef(oid) LIKE '%active%'
             AND pg_get_constraintdef(oid) LIKE '%revoked%'
             AND pg_get_constraintdef(oid) LIKE '%rejected%'
        ) THEN
          ALTER TABLE connector_instance_credentials
            ADD CONSTRAINT connector_instance_credentials_status_check
            CHECK (status IN ('active', 'revoked', 'rejected'));
        END IF;
      END $$;

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
        updated_at TEXT NOT NULL,
        owner_epoch TEXT
      );
      -- The boot epoch of the process that owns this in-flight upload; an
      -- artifact whose owner_epoch is not the current one is provably
      -- orphaned. Added via ADD COLUMN IF NOT EXISTS so pre-existing rows
      -- backfill to NULL, which the sweep also treats as orphaned.
      ALTER TABLE manual_upload_artifacts
        ADD COLUMN IF NOT EXISTS owner_epoch TEXT;
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

      -- Widen again for 'access_token' / 'api_key' — the credential_capture.kind
      -- shapes declared by GroupMe, Steam, and Jellyfin's manifests.
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
             AND pg_get_constraintdef(oid) LIKE '%secret_bundle%'
             AND pg_get_constraintdef(oid) LIKE '%username_password%'
        LOOP
          IF credential_kind_constraint_def NOT LIKE '%access_token%'
             OR credential_kind_constraint_def NOT LIKE '%api_key%' THEN
            EXECUTE format('ALTER TABLE connector_instance_credentials DROP CONSTRAINT %I', credential_kind_constraint_name);
          END IF;
        END LOOP;

        IF NOT EXISTS (
          SELECT 1
            FROM pg_constraint
           WHERE conrelid = 'connector_instance_credentials'::regclass
             AND contype = 'c'
             AND pg_get_constraintdef(oid) LIKE '%credential_kind%'
             AND pg_get_constraintdef(oid) LIKE '%access_token%'
             AND pg_get_constraintdef(oid) LIKE '%api_key%'
        ) THEN
          ALTER TABLE connector_instance_credentials
            ADD CONSTRAINT connector_instance_credentials_credential_kind_check
            CHECK (credential_kind IN ('access_token', 'api_key', 'app_password', 'personal_access_token', 'secret_bundle', 'username_password'));
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
        family_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        parent_generation INTEGER,
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
      -- Absent-only grant expiry: grants issued before that normalization
      -- persisted an explicit JSON null expires_at in grant_json. Null and
      -- absent both mean "no expiry", so dropping the member is a
      -- representation change, not an authorization change. Scoped to the
      -- JSON-null case so string expiries are never touched, and idempotent
      -- so repeated startups are no-ops.
      UPDATE grants
        SET grant_json = grant_json - 'expires_at'
        WHERE jsonb_typeof(grant_json->'expires_at') = 'null';

      CREATE TABLE IF NOT EXISTS tokens (
        token_id TEXT PRIMARY KEY,
        grant_id TEXT,
        package_id TEXT,
        refresh_family_id TEXT,
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
      CREATE TABLE IF NOT EXISTS consent_exchange_codes (
        code_hash TEXT PRIMARY KEY,
        proof_hash TEXT,
        token_id TEXT NOT NULL REFERENCES tokens(token_id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        redeemed_at TEXT
      );
      ALTER TABLE consent_exchange_codes
        ADD COLUMN IF NOT EXISTS proof_hash TEXT;
      CREATE INDEX IF NOT EXISTS idx_pg_consent_exchange_codes_expiry
        ON consent_exchange_codes(expires_at);

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
        approval_review_revision TEXT,
        approval_review_digest TEXT,
        approval_review_json JSONB,
        approval_id TEXT UNIQUE
      );
      CREATE INDEX IF NOT EXISTS idx_pg_pending_consents_status_expires
        ON pending_consents(status, expires_at);
      ALTER TABLE pending_consents
        ADD COLUMN IF NOT EXISTS interval_seconds INTEGER NOT NULL DEFAULT 2;
      ALTER TABLE pending_consents
        ADD COLUMN IF NOT EXISTS last_polled_at TEXT;
      ALTER TABLE pending_consents
        ADD COLUMN IF NOT EXISTS approval_review_revision TEXT;
      ALTER TABLE pending_consents
        ADD COLUMN IF NOT EXISTS approval_review_digest TEXT;
      ALTER TABLE pending_consents
        ADD COLUMN IF NOT EXISTS approval_review_json JSONB;

      CREATE TABLE IF NOT EXISTS agent_connect_attempts (
        id TEXT PRIMARY KEY,
        request_uri TEXT NOT NULL,
        client_id TEXT,
        polling_code_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        approval_url TEXT NOT NULL,
        token_url TEXT NOT NULL,
        interval_seconds INTEGER NOT NULL DEFAULT 2,
        created_at TEXT NOT NULL,
        expires_at_ms BIGINT NOT NULL,
        completed_at TEXT,
        grant_id TEXT,
        grant_json JSONB,
        token TEXT,
        response_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pg_agent_connect_attempts_request_uri
        ON agent_connect_attempts(request_uri, status);
      CREATE INDEX IF NOT EXISTS idx_pg_agent_connect_attempts_status_expires
        ON agent_connect_attempts(status, expires_at_ms);

      ALTER TABLE tokens
        ADD COLUMN IF NOT EXISTS package_id TEXT;
      ALTER TABLE tokens
        ADD COLUMN IF NOT EXISTS refresh_family_id TEXT;
      ALTER TABLE oauth_authorization_codes
        ADD COLUMN IF NOT EXISTS package_id TEXT;
      ALTER TABLE oauth_refresh_tokens
        ADD COLUMN IF NOT EXISTS package_id TEXT;
      ALTER TABLE oauth_refresh_tokens
        ADD COLUMN IF NOT EXISTS family_id TEXT;
      ALTER TABLE oauth_refresh_tokens
        ADD COLUMN IF NOT EXISTS generation INTEGER;
      ALTER TABLE oauth_refresh_tokens
        ADD COLUMN IF NOT EXISTS parent_generation INTEGER;
      ALTER TABLE oauth_refresh_tokens
        ADD COLUMN IF NOT EXISTS superseded_at TEXT;
      ALTER TABLE oauth_refresh_tokens
        ALTER COLUMN grant_id DROP NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_pg_tokens_package_id
        ON tokens(package_id);
      CREATE INDEX IF NOT EXISTS idx_pg_tokens_refresh_family
        ON tokens(refresh_family_id, revoked);
      UPDATE tokens AS bearer
         SET revoked = TRUE
       WHERE bearer.revoked = FALSE
         AND (
           bearer.grant_id IN (
             SELECT legacy.grant_id
               FROM oauth_refresh_tokens AS legacy
              WHERE legacy.grant_id IS NOT NULL
                AND legacy.status <> 'revoked'
                AND NOT EXISTS (
                  SELECT 1 FROM tokens AS linked WHERE linked.refresh_family_id = legacy.family_id
                )
           )
           OR bearer.package_id IN (
             SELECT legacy.package_id
               FROM oauth_refresh_tokens AS legacy
              WHERE legacy.package_id IS NOT NULL
                AND legacy.status <> 'revoked'
                AND NOT EXISTS (
                  SELECT 1 FROM tokens AS linked WHERE linked.refresh_family_id = legacy.family_id
                )
           )
         );
      UPDATE oauth_refresh_tokens AS legacy
         SET status = 'revoked',
             revoked_at = COALESCE(
               legacy.revoked_at,
               TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
             )
       WHERE legacy.status <> 'revoked'
         AND NOT EXISTS (
           SELECT 1 FROM tokens AS linked WHERE linked.refresh_family_id = legacy.family_id
         );
      CREATE INDEX IF NOT EXISTS idx_pg_oauth_refresh_tokens_package
        ON oauth_refresh_tokens(package_id, status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_oauth_refresh_tokens_family_generation
        ON oauth_refresh_tokens(family_id, generation);
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
        revoked_at TEXT,
        collection_scope_json JSONB
      );
      CREATE INDEX IF NOT EXISTS idx_pg_device_enrollment_codes_owner_status
        ON device_enrollment_codes(owner_subject_id, status, expires_at);

      CREATE TABLE IF NOT EXISTS device_source_instances (
        source_instance_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES device_exporters(device_id) ON DELETE CASCADE,
        connector_id TEXT NOT NULL,
        connector_instance_id TEXT,
        local_binding_id TEXT NOT NULL,
        source_kind TEXT,
        display_name TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        last_error_json JSONB,
        last_heartbeat_at TEXT,
        last_heartbeat_status TEXT,
        records_pending INTEGER,
        outbox_diagnostics_json JSONB,
        manifest_generation BIGINT,
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

      CREATE TABLE IF NOT EXISTS source_webhook_run_receipts (
        source_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        owner_subject_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action = 'schedule_run'),
        run_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        automation_mode TEXT,
        automation_summary TEXT,
        started_at TEXT NOT NULL,
        PRIMARY KEY(source_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_pg_source_webhook_run_receipts_run
        ON source_webhook_run_receipts(run_id, connector_instance_id);

      CREATE TABLE IF NOT EXISTS connector_state (
        connector_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        state_json JSONB NOT NULL,
        updated_at TEXT NOT NULL,
        manifest_generation BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY(connector_instance_id, stream)
      );

      CREATE TABLE IF NOT EXISTS grant_connector_state (
        grant_id TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        state_json JSONB NOT NULL,
        updated_at TEXT NOT NULL,
        manifest_generation BIGINT NOT NULL DEFAULT 0,
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
        lease_run_id TEXT,
        lease_id TEXT,
        lease_attempted INTEGER NOT NULL DEFAULT 0,
        lease_expires_at TEXT,
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

      -- Provider coverage-horizon/provenance disclosure — see the matching
      -- SQLite DDL comment in server/db.ts (connector_coverage_horizons) for
      -- the full rationale. Append-only, reversible-by-supersession; a
      -- horizon never rewrites/deletes retained records and never by itself
      -- marks a connection unhealthy.
      CREATE TABLE IF NOT EXISTS connector_coverage_horizons (
        horizon_id TEXT PRIMARY KEY,
        connector_instance_id TEXT NOT NULL REFERENCES connector_instances(connector_instance_id) ON DELETE CASCADE,
        stream TEXT NOT NULL DEFAULT '*',
        earliest_available TEXT,
        confirmed_at TEXT NOT NULL,
        basis TEXT NOT NULL CHECK (basis IN ('provider_stated', 'provider_confirmed', 'inferred_from_stable_boundary')),
        reason TEXT NOT NULL CHECK (reason IN ('provider_retention_policy', 'provider_deleted_history', 'provider_never_had_data', 'consent_window')),
        confirmed_by TEXT NOT NULL,
        note TEXT,
        superseded_at TEXT,
        superseded_by_horizon_id TEXT,
        created_at TEXT NOT NULL DEFAULT (now()::text)
      );

      -- At most one CURRENT (non-superseded) horizon per (connection, stream).
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_connector_coverage_horizons_current
        ON connector_coverage_horizons(connector_instance_id, stream)
        WHERE superseded_at IS NULL;

      CREATE INDEX IF NOT EXISTS idx_pg_connector_coverage_horizons_instance
        ON connector_coverage_horizons(connector_instance_id);

      -- Cross-invocation STREAM_EVIDENCE duplicate registry — see the
      -- matching SQLite DDL comment in server/db.ts
      -- (stream_evidence_run_registry) for the full rationale. Primary key
      -- is EXACTLY (run_id, stream), matching spec-collection-profile.md
      -- rule 5's scope; connector_instance_id is informational only. No
      -- TTL/reap.
      CREATE TABLE IF NOT EXISTS stream_evidence_run_registry (
        run_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        payload_json TEXT,
        replay_identity_json TEXT,
        payload_digest TEXT,
        event_id TEXT,
        created_at TEXT NOT NULL DEFAULT (now()::text),
        PRIMARY KEY (run_id, stream)
      );

      CREATE INDEX IF NOT EXISTS idx_pg_stream_evidence_run_registry_instance
        ON stream_evidence_run_registry(connector_instance_id);

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

      -- The deployment's durable controller identity; see the matching
      -- comment in server/db.ts for why it is a table and not an env var.
      -- Exactly one row (id = 'singleton'), written on the first boot that
      -- finds it empty and read unchanged by every boot after that.
      CREATE TABLE IF NOT EXISTS controller_identity (
        id TEXT PRIMARY KEY,
        controller_id TEXT NOT NULL,
        created_at TEXT NOT NULL
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
        priority_class TEXT NOT NULL CHECK (priority_class IN ('interactive', 'background')),
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
      ALTER TABLE browser_surface_replacement_selection_overrides
        ADD COLUMN IF NOT EXISTS replacement_batch_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_pg_browser_surface_replacement_selection_override_batch
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
        first_event_seq BIGINT NOT NULL,
        last_event_seq BIGINT NOT NULL,
        first_observed_at TEXT NOT NULL,
        last_observed_at TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        revoked_at TEXT
      );
      ALTER TABLE browser_surface_replacement_selection_override_batches
        ADD COLUMN IF NOT EXISTS reviewed_artifact_sha256 TEXT NOT NULL DEFAULT '';
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

      -- Kind-neutral, run-grain durable projection. Historically
      -- scheduler-only (scheduler_run_history); generalized so the
      -- general run executor writes one row per run
      -- (scheduled/manual/browser/cancelled) -- see
      -- openspec/changes/generalize-run-history-write-authority.
      -- completed_at is nullable to hold the row created at
      -- run.started (status 'running') before the terminal write
      -- finalizes it; existing scheduler-era readers filter
      -- status <> 'running' so their visible output is unchanged.
      CREATE TABLE IF NOT EXISTS run_history (
        id BIGSERIAL PRIMARY KEY,
        run_id TEXT,
        connector_instance_id TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        trigger_kind TEXT,
        source_json JSONB NOT NULL,
        status TEXT NOT NULL,
        records_emitted INTEGER NOT NULL DEFAULT 0,
        reported_records_emitted INTEGER,
        checkpoint_summary_json JSONB,
        known_gaps_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        connector_error_json JSONB,
        trace_id TEXT,
        failure_reason TEXT,
        terminal_reason TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT,
        attempt INTEGER NOT NULL DEFAULT 1,
        facts_json JSONB,
        -- Provenance flag: true only for rows the SCHEDULER's own write
        -- path has touched (server/stores/scheduler-store.ts
        -- appendRunHistory). The run.started/terminal spine-event hook
        -- (server/stores/run-history-writer.ts) sets this false. Scheduler
        -- cadence/backoff readers filter on this column — see
        -- terminal-read-architecture-fable-0730.md R7.5.
        scheduler_managed BOOLEAN NOT NULL DEFAULT false
      );

      CREATE INDEX IF NOT EXISTS idx_pg_run_history_connector_completed
        ON run_history(connector_id, completed_at, id);

      -- run_id alone is NOT globally unique: two different connections
      -- can independently mint the same run_id (Date.now()-based
      -- generators with no connection-scoped entropy — confirmed live).
      -- (run_id, connector_instance_id) is the real identity. See
      -- openspec/changes/run-history-backfill-list-cutover.
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_pg_run_history_run_id_instance
        ON run_history(run_id, connector_instance_id) WHERE run_id IS NOT NULL;

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

      -- One durable optional-maintenance job for the global and hot-source
      -- HNSW catalog indexes. The row is scheduling/diagnostic state only;
      -- vector reads remain correct while the state is pending or failed.
      CREATE TABLE IF NOT EXISTS semantic_hnsw_index_build (
        build_key TEXT PRIMARY KEY CHECK (build_key = 'semantic_hnsw'),
        state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'ready', 'unavailable', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        started_at TEXT,
        completed_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
      INSERT INTO semantic_hnsw_index_build(build_key, state, updated_at)
      VALUES ('semantic_hnsw', 'pending', (now() AT TIME ZONE 'utc')::text)
      ON CONFLICT (build_key) DO NOTHING;

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
        record_rejection_payload_bytes BIGINT NOT NULL DEFAULT 0,
        record_count              BIGINT NOT NULL DEFAULT 0,
        record_history_count      BIGINT NOT NULL DEFAULT 0,
        blob_count                BIGINT NOT NULL DEFAULT 0,
        record_rejection_count    BIGINT NOT NULL DEFAULT 0,
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
        record_rejection_payload_bytes BIGINT NOT NULL DEFAULT 0,
        record_count              BIGINT NOT NULL DEFAULT 0,
        record_history_count      BIGINT NOT NULL DEFAULT 0,
        blob_count                BIGINT NOT NULL DEFAULT 0,
        record_rejection_count    BIGINT NOT NULL DEFAULT 0,
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
        record_rejection_payload_bytes BIGINT NOT NULL DEFAULT 0,
        record_count              BIGINT NOT NULL DEFAULT 0,
        record_history_count      BIGINT NOT NULL DEFAULT 0,
        blob_count                BIGINT NOT NULL DEFAULT 0,
        record_rejection_count    BIGINT NOT NULL DEFAULT 0,
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
        record_rejection_payload_bytes BIGINT NOT NULL DEFAULT 0,
        record_count              BIGINT NOT NULL DEFAULT 0,
        record_history_count      BIGINT NOT NULL DEFAULT 0,
        blob_count                BIGINT NOT NULL DEFAULT 0,
        record_rejection_count    BIGINT NOT NULL DEFAULT 0,
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
        record_rejection_payload_bytes BIGINT NOT NULL DEFAULT 0,
        total_retained_bytes      BIGINT NOT NULL DEFAULT 0,
        record_count              BIGINT NOT NULL DEFAULT 0,
        record_history_count      BIGINT NOT NULL DEFAULT 0,
        blob_count                BIGINT NOT NULL DEFAULT 0,
        record_rejection_count    BIGINT NOT NULL DEFAULT 0,
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
        canonical_evidence_revision BIGINT NOT NULL DEFAULT 0,
        -- NULL is legacy/unknown and is rendered stale until a successful
        -- source-revision-aware repair writes the captured receipt.
        source_revision BIGINT,
        manifest_generation BIGINT NOT NULL DEFAULT 0,
        schedule_checkpoint TEXT NOT NULL DEFAULT 'unobserved',
        run_lifecycle_event_seq BIGINT,
        -- Reason code only: the projection payload columns were removed
        -- 2026-08-28 because their read was gated on a state value nothing
        -- wrote. See the matching SQLite column comment in server/db.ts.
        list_summary_projection_reason_code TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pg_connector_summary_evidence_connector
        ON connector_summary_evidence(connector_id);

      -- Scheduling state only: name-keyed cursors resume bounded maintenance
      -- passes after restart without becoming evidence or owner-visible data.
      CREATE TABLE IF NOT EXISTS connector_maintenance_cursor (
        name TEXT PRIMARY KEY CHECK(name IN ('connector_summary_evidence', 'run_history_backfill')),
        resume_after_id TEXT,
        updated_at TEXT NOT NULL,
        generation BIGINT NOT NULL DEFAULT 0,
        lease_token TEXT,
        lease_expires_at TEXT
      );

      -- Durable per-connection resume state for a canonical-count repair scan
      -- that could not finish inside one bounded admission (a "whale"
      -- connection with millions of live records). Keyed by
      -- connector_instance_id, NOT by name like connector_maintenance_cursor
      -- above -- that table models fleet-wide sweep cursors, a different
      -- resource; this one is scoped to exactly the connection whose own
      -- repair is too large for a single statement_timeout admission.
      -- Scheduling/accumulation state only, never evidence about the owner's
      -- data: a row here asserts nothing until the scan completes and
      -- buildRepairedRow's normal upsert publishes it.
      CREATE TABLE IF NOT EXISTS connector_summary_evidence_repair_chunk (
        connector_instance_id TEXT PRIMARY KEY,
        resume_after_id BIGINT,
        accumulator_json JSONB NOT NULL,
        -- The source_revision observed while this boundary was advanced. It
        -- is a diagnostic/final-publication receipt, not resume eligibility:
        -- records triggers invalidate the chunk only when a mutation touches
        -- its proven id prefix, so an append above resume_after_id remains
        -- resumable.
        source_revision TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        -- Next page limit after a statement_timeout. Scheduling state only;
        -- NULL on a legacy row means the scan uses the default first.
        page_size INTEGER
      );

      CREATE TABLE IF NOT EXISTS manifest_write_violations (
        connector_instance_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        manifest_generation BIGINT NOT NULL,
        provenance TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        PRIMARY KEY(connector_instance_id, stream, manifest_generation)
      );

      -- Scope-keyed (never per-record) dirty flag for lexical+semantic
      -- derived index maintenance. See server/db.ts for the SQLite mirror
      -- and full rationale, including why revision (not marked_at) is
      -- the clear's CAS token: two durable marks can land within the same
      -- millisecond and receive an identical marked_at ISO string, but
      -- revision is atomically incremented once per mark and can never
      -- collide.
      CREATE TABLE IF NOT EXISTS search_index_dirty (
        connector_instance_id TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        dirty INTEGER NOT NULL DEFAULT 1,
        marked_at TEXT NOT NULL,
        revision BIGINT NOT NULL DEFAULT 0,
        reconciled_at TEXT,
        last_error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        PRIMARY KEY(connector_instance_id, stream)
      );
      CREATE INDEX IF NOT EXISTS idx_pg_search_index_dirty_pending
        ON search_index_dirty(dirty);
      ALTER TABLE search_index_dirty ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE search_index_dirty ADD COLUMN IF NOT EXISTS next_attempt_at TEXT;
      ALTER TABLE search_index_dirty ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 0;

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
        ADD COLUMN IF NOT EXISTS canonical_evidence_revision BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE connector_summary_evidence
        ADD COLUMN IF NOT EXISTS manifest_generation BIGINT NOT NULL DEFAULT 0;
      -- Terminal-gate revision (2026-07-29): durable repair-receipt
      -- checkpoints consumed by the maintenance sweep — see the matching
      -- SQLite column comments in server/db.ts for the full rationale.
      ALTER TABLE connector_summary_evidence
        ADD COLUMN IF NOT EXISTS schedule_checkpoint TEXT NOT NULL DEFAULT 'unobserved';
      ALTER TABLE connector_summary_evidence
        ADD COLUMN IF NOT EXISTS run_lifecycle_event_seq BIGINT;
      ALTER TABLE connector_summary_evidence
        ADD COLUMN IF NOT EXISTS list_summary_projection_reason_code TEXT;
      -- Drop the unreachable list-summary projection cache (2026-08-28): its
      -- payload read was gated on list_summary_projection_state = 'current',
      -- which no write ever produced. Bounded, idempotent DDL — it does not
      -- scan or rewrite rows. See the matching SQLite migration in
      -- server/db.ts.
      ALTER TABLE connector_summary_evidence
        DROP COLUMN IF EXISTS list_summary_projection_json,
        DROP COLUMN IF EXISTS list_summary_projection_state,
        DROP COLUMN IF EXISTS list_summary_projection_computed_at;
      ALTER TABLE connector_maintenance_cursor
        ADD COLUMN IF NOT EXISTS generation BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE connector_maintenance_cursor
        ADD COLUMN IF NOT EXISTS lease_token TEXT;
      ALTER TABLE connector_maintenance_cursor
        ADD COLUMN IF NOT EXISTS lease_expires_at TEXT;
      ALTER TABLE connector_state
        ADD COLUMN IF NOT EXISTS manifest_generation BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE grant_connector_state
        ADD COLUMN IF NOT EXISTS manifest_generation BIGINT NOT NULL DEFAULT 0;
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
      -- Registry mutation takes an update lock on this same connection row;
      -- the trigger's share lock gives terminal append and mutation one
      -- authoritative serialization order. Legacy rows remain NULL.
      ALTER TABLE spine_events
        ADD COLUMN IF NOT EXISTS manifest_generation BIGINT;
      CREATE OR REPLACE FUNCTION stamp_terminal_manifest_generation()
      RETURNS trigger AS $$
      DECLARE terminal_instance_id TEXT;
      BEGIN
        IF NEW.manifest_generation IS NULL
          AND NEW.event_type IN ('run.completed', 'run.failed', 'run.browser_surface_failed', 'run.cancelled')
        THEN
          terminal_instance_id := COALESCE(
            NULLIF(NEW.connector_instance_id, ''),
            NULLIF(NEW.data_json->>'connector_instance_id', ''),
            NULLIF(NEW.data_json->>'connection_id', '')
          );
          NEW.connector_instance_id := terminal_instance_id;
          -- Do not lock the instance row from this BEFORE INSERT trigger.
          -- Concurrent terminal inserts can otherwise hold share locks while
          -- the source-revision AFTER trigger waits to upgrade the same row,
          -- producing a PostgreSQL 40P01 cycle. The terminal event is already
          -- scoped by its identity; generation reconciliation remains a
          -- disposable read-model concern.
          SELECT manifest_generation
            INTO NEW.manifest_generation
            FROM connector_instances
           WHERE connector_instance_id = terminal_instance_id;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS stamp_terminal_manifest_generation ON spine_events;
      CREATE TRIGGER stamp_terminal_manifest_generation
        BEFORE INSERT ON spine_events
        FOR EACH ROW EXECUTE FUNCTION stamp_terminal_manifest_generation();
      CREATE INDEX IF NOT EXISTS idx_pg_spine_events_terminal_instance_seq
        ON spine_events(connector_instance_id, event_seq)
        WHERE event_type IN ('run.completed', 'run.failed', 'run.browser_surface_failed', 'run.cancelled')
          AND connector_instance_id IS NOT NULL;
      -- readPostgresDiscoveryContext's per-connection lifecycle-checkpoint
      -- read (connector-summary-evidence-engine.ts, maxLifecycleSeqResult)
      -- is MAX(event_seq) ... GROUP BY connector_instance_id over EVERY
      -- event type, not just the four terminal outcomes the index above
      -- covers, so that read fell through to a full parallel seq scan on
      -- every discovery pass. Production, 2026-08-18 (immediately after
      -- a5505bb59 removed the redundant records count that had been
      -- masking this): measured 1.5-1.9s / ~117k buffers (~940 MB) via
      -- EXPLAIN (ANALYZE, BUFFERS) against 1.4M spine_events rows, with
      -- the scoped = ANY(...) form no faster than the unscoped one (the
      -- planner cannot prune a scan on an unindexed column). That routinely
      -- exceeded discovery's remaining per-pass admission allowance
      -- (MIN_STATEMENT_TIMEOUT_MS), and -- because readPostgresDiscovery
      -- Context issues its queries with no per-query isolation, unlike
      -- repairCandidate -- the cancellation propagated out of
      -- discoverCandidates and aborted the ENTIRE batch before
      -- classifyCandidate ran for any row (92c9fc83e's existing
      -- discovery-level catch converts this into a clean candidates_
      -- inspected: 0, incomplete: true pass rather than a crash, but a
      -- durably-dirty backlog got zero candidates selected pass after pass
      -- regardless). A general, unfiltered index on the exact
      -- (connector_instance_id, event_seq) shape this query groups by lets
      -- Postgres answer it with a per-group index scan instead of a full
      -- table scan, the same fix already proven for the terminal-scoped
      -- case above.
      CREATE INDEX IF NOT EXISTS idx_pg_spine_events_instance_seq
        ON spine_events(connector_instance_id, event_seq)
        WHERE connector_instance_id IS NOT NULL;
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

    // Deployment-scoped provider app config (e.g. a shared OAuth client
    // id/secret), keyed generically by (identity_group, logical_key) --
    // never by an env-var literal. Mirrors the SQLite `provider_app_config`
    // table (server/db.ts). See provider-app-config-store.ts.
    await client.query(`
      CREATE TABLE IF NOT EXISTS provider_app_config (
        identity_group TEXT NOT NULL,
        logical_key    TEXT NOT NULL,
        sealed_value   TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        PRIMARY KEY (identity_group, logical_key)
      );
    `);

    await ensurePostgresBrowserSurfaceLeaseColumnsAndIndexes(client);
    await migratePostgresBrowserSurfaceLeaseLifecycleChecks(client);
    await migratePostgresBrowserSurfaceLeasePriority(client);
    await migratePostgresRecordRejectionBytePayload(client);
    await migratePostgresConfigRevisionRejectedStatus(client);
    await migratePostgresRetainedSizeRejectionColumns(client);
    await migratePostgresSpineSourceColumns(client);
    await migratePostgresDeviceExporterColumns(client);
    await migratePostgresManifestWriteViolations(client);
    await migratePostgresBlobBindingsJsonPath(client);
    await migratePostgresConnectorSyncStateInstanceColumns(client);
    await migratePostgresConnectorDetailGapInstanceColumns(client);
    await migratePostgresSchedulerInstanceColumns(client);
    await migratePostgresRunHistoryRename(client);
    await migratePostgresRunHistoryCompletedAtNullable(client);
    await migratePostgresConnectorMaintenanceCursorNameCheck(client);
    await migratePostgresRecordsBlobSearchInstanceColumns(client);
    await migratePostgresClientEventSubscriptionAuthority(client);
    // Install the ledger BEFORE the first data migration that consults it.
    // A migration that reads a missing ledger table would have to guess its
    // own completion, which is the defect the ledger exists to remove.
    await ensurePostgresMigrationLedger(client);
    await migratePostgresLocalDeviceConnectorInstances(client, { log });
    await migratePostgresLegacyConnectorInstancesToDefaultAccount(client);
    await migratePostgresConnectorInstancesSourceKindBrowserCollector(client);
    await migratePostgresConnectorSummaryEvidenceRepairChunkPageSize(client);
    await migratePostgresStreamEvidenceRunRegistry(client);
    await migratePostgresSemanticEmbeddingToVector(client, log);
    await ensurePostgresLexicalScopedGinIndex(client, log);
    await ensurePostgresRecordsCanonicalCountIndex(client, log);
    await ensurePostgresRecordsInstanceStreamIdIndex(client, log);
    await ensurePostgresRecordsInstanceDeletedIdIndex(client, log);
    await ensurePostgresConnectorSummarySourceRevisionPrimitive(client);
  } finally {
    try {
      if (bootstrapLockHeld) {
        await client.query("SELECT pg_advisory_unlock($1, $2)", POSTGRES_BOOTSTRAP_SERIALIZATION_LOCK);
      }
    } finally {
      client.release();
    }
  }
}

function bootstrapDeadlockRetryDelay(attempt: number): number {
  return Math.min(
    POSTGRES_BOOTSTRAP_DEADLOCK_MAX_DELAY_MS,
    POSTGRES_BOOTSTRAP_DEADLOCK_INITIAL_DELAY_MS * 2 ** Math.min(attempt, 4)
  );
}

interface BootstrapDeadlockRetryOptions {
  bootstrapLockTimeoutMs?: number;
  log?: StorageLog;
  runOnce?: (opts: { log: StorageLog; bootstrapLockTimeoutMs?: number }) => Promise<void>;
  sleep?: (delayMs: number) => Promise<void>;
}

/**
 * Bounded retry of the WHOLE bootstrap attempt, scoped to exactly one
 * failure mode: SQLSTATE 40P01 (Postgres-detected deadlock) surfacing from
 * `bootstrapPostgresSchemaOnce`'s DDL batch. This happens when the batch's
 * AccessExclusiveLock on connectors/connector_instances forms a wait-for
 * cycle with an ordinary, unrelated connector-registration write already in
 * flight against the same database -- a real shape under rolling/blue-green
 * restarts, where a starting instance's bootstrap can overlap an
 * already-running instance's writes. Postgres resolves the cycle itself by
 * aborting one side; retrying the aborted side is the standard recovery, not
 * a workaround.
 *
 * Every retry re-runs the FULL attempt (fresh client checkout, fresh
 * advisory-lock acquisition, the entire DDL/migration batch) after
 * `bootstrapPostgresSchemaOnce`'s own `finally` has already released the
 * advisory lock and the client back to the pool -- so a retry never resumes
 * mid-batch against a connection Postgres may have already aborted, and
 * never holds the serialization lock across the retry boundary.
 *
 * Any other error -- including every other SQLSTATE -- rethrows immediately
 * on the first attempt. This is not a general-purpose retry: retrying an
 * arbitrary bootstrap failure could mask a real migration defect instead of
 * a transient lock-ordering race.
 */
export async function bootstrapPostgresSchema({
  log = NOOP_STORAGE_LOG,
  bootstrapLockTimeoutMs,
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  runOnce = bootstrapPostgresSchemaOnce,
}: BootstrapDeadlockRetryOptions = {}): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: bounded retry loop -- each attempt must finish before deciding whether to retry.
      await runOnce({ log, ...(bootstrapLockTimeoutMs === undefined ? {} : { bootstrapLockTimeoutMs }) });
      if (attempt > 0) {
        log(`postgres bootstrap succeeded after ${attempt} deadlock retr${attempt === 1 ? "y" : "ies"}`);
      }
      return;
    } catch (err) {
      const sqlstate = (err as { code?: string } | null)?.code;
      if (sqlstate !== POSTGRES_BOOTSTRAP_DEADLOCK_SQLSTATE) {
        throw err;
      }
      if (attempt + 1 >= POSTGRES_BOOTSTRAP_DEADLOCK_MAX_ATTEMPTS) {
        log(
          `postgres bootstrap deadlock (40P01) on attempt ${attempt + 1}/${POSTGRES_BOOTSTRAP_DEADLOCK_MAX_ATTEMPTS}: retry budget exhausted, rethrowing`
        );
        throw err;
      }
      const delayMs = bootstrapDeadlockRetryDelay(attempt);
      log(
        `postgres bootstrap deadlock (40P01) on attempt ${attempt + 1}/${POSTGRES_BOOTSTRAP_DEADLOCK_MAX_ATTEMPTS}: retrying whole bootstrap attempt in ${delayMs}ms`
      );
      await sleep(delayMs);
    }
  }
}

/**
 * Install the provider-neutral PostgreSQL source-revision boundary after all
 * legacy column migrations. The instance row is the single monotonic receipt;
 * the nullable evidence copy records the revision a built row absorbed. The
 * installation runs as one DDL/data transaction while an access-exclusive
 * lock excludes live writers. Source triggers advance only the canonical
 * receipt; evidence invalidation remains best effort and cannot reject the
 * canonical write that caused it.
 */
async function ensurePostgresConnectorSummarySourceRevisionPrimitive(client: PoolClient): Promise<void> {
  const sourceTables = [
    "records",
    "version_counter",
    "connector_schedules",
    "controller_active_runs",
    // Spine rows are append/delete lifecycle facts. The terminal manifest
    // stamp is an internal INSERT-time correction, so UPDATE is excluded to
    // keep it from double-touching the receipt (SQLite has the same boundary).
    "spine_events",
    "retained_size_connection",
    "retained_size_stream",
    "manifest_write_violations",
  ] as const;
  const legacySourceTables = [
    "record_changes",
    "blobs",
    "blob_bindings",
    "run_history",
    "retained_size_record_family",
    "retained_size_top_rows",
  ] as const;
  await client.query("BEGIN");
  try {
    await client.query(`
      LOCK TABLE
        connector_instances,
        connector_summary_evidence,
        connectors,
        records,
        version_counter,
        connector_schedules,
        controller_active_runs,
        spine_events,
        retained_size_connection,
        retained_size_stream,
        manifest_write_violations
      IN ACCESS EXCLUSIVE MODE;

      ALTER TABLE connector_instances
        ADD COLUMN IF NOT EXISTS source_revision BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE connector_summary_evidence
        ADD COLUMN IF NOT EXISTS source_revision BIGINT;
      UPDATE connector_instances SET source_revision = 0 WHERE source_revision IS NULL;
    `);
    const markerPath = process.env.PDPP_TEST_SOURCE_REVISION_INSTALL_LOCK_PATH;
    if (markerPath) {
      writeFileSync(markerPath, `${process.pid}\n`, "utf8");
    }

    await client.query(`
      CREATE OR REPLACE FUNCTION pdpp_advance_connector_summary_source_revision(target_id TEXT)
      RETURNS VOID
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF target_id IS NULL OR target_id = '' THEN
          RETURN;
        END IF;
        UPDATE connector_instances
           SET source_revision = CASE
             WHEN source_revision IS NULL THEN 0
             WHEN source_revision < 9223372036854775807::bigint THEN source_revision + 1
             ELSE 9223372036854775807::bigint
           END
         WHERE connector_instance_id = target_id;
      END;
      $function$;

      CREATE OR REPLACE FUNCTION pdpp_touch_connector_summary_source_row()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $function$
      DECLARE
        new_id TEXT;
        old_id TEXT;
        new_record_id BIGINT;
        old_record_id BIGINT;
        new_row JSONB;
        old_row JSONB;
      BEGIN
        IF TG_OP <> 'DELETE' THEN
          new_row := to_jsonb(NEW);
          new_id := NULLIF(new_row->>'connector_instance_id', '');
          IF TG_TABLE_NAME = 'spine_events' THEN
            new_id := COALESCE(
              new_id,
              NULLIF(new_row->'data_json'->>'connector_instance_id', ''),
              NULLIF(new_row->'data_json'->>'connection_id', '')
            );
          END IF;
          IF TG_TABLE_NAME = 'records' THEN
            new_record_id := NULLIF(new_row->>'id', '')::bigint;
          END IF;
        END IF;
        IF TG_OP <> 'INSERT' THEN
          old_row := to_jsonb(OLD);
          old_id := NULLIF(old_row->>'connector_instance_id', '');
          IF TG_TABLE_NAME = 'spine_events' THEN
            old_id := COALESCE(
              old_id,
              NULLIF(old_row->'data_json'->>'connector_instance_id', ''),
              NULLIF(old_row->'data_json'->>'connection_id', '')
            );
          END IF;
          IF TG_TABLE_NAME = 'records' THEN
            old_record_id := NULLIF(old_row->>'id', '')::bigint;
          END IF;
        END IF;
        IF new_id IS NOT NULL THEN
          PERFORM pdpp_advance_connector_summary_source_revision(new_id);
        END IF;
        IF old_id IS NOT NULL AND old_id IS DISTINCT FROM new_id THEN
          PERFORM pdpp_advance_connector_summary_source_revision(old_id);
        END IF;
        -- A chunk receipt proves only its id prefix. A records append above
        -- the boundary may advance the broad source_revision but leaves that
        -- prefix intact; a mutation at or below it must delete the receipt in
        -- this same writer transaction so the next page restarts from zero.
        IF TG_TABLE_NAME = 'records' THEN
          IF new_id IS NOT NULL AND new_record_id IS NOT NULL THEN
            DELETE FROM connector_summary_evidence_repair_chunk
             WHERE connector_instance_id = new_id
               AND new_record_id <= resume_after_id;
          END IF;
          IF old_id IS NOT NULL AND old_record_id IS NOT NULL THEN
            DELETE FROM connector_summary_evidence_repair_chunk
             WHERE connector_instance_id = old_id
               AND old_record_id <= resume_after_id;
          END IF;
        END IF;
        IF TG_OP = 'DELETE' THEN
          RETURN OLD;
        END IF;
        RETURN NEW;
      END;
      $function$;

      CREATE OR REPLACE FUNCTION pdpp_touch_connector_summary_instance()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        PERFORM pdpp_advance_connector_summary_source_revision(NEW.connector_instance_id);
        RETURN NEW;
      END;
      $function$;

      CREATE OR REPLACE FUNCTION pdpp_touch_connector_summary_manifest()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $function$
      DECLARE
        instance_id TEXT;
      BEGIN
        IF TG_OP <> 'DELETE' THEN
          FOR instance_id IN
            SELECT connector_instance_id FROM connector_instances WHERE connector_id = NEW.connector_id
          LOOP
            PERFORM pdpp_advance_connector_summary_source_revision(instance_id);
          END LOOP;
        END IF;
        IF TG_OP = 'DELETE' THEN
          FOR instance_id IN
            SELECT connector_instance_id FROM connector_instances WHERE connector_id = OLD.connector_id
          LOOP
            PERFORM pdpp_advance_connector_summary_source_revision(instance_id);
          END LOOP;
        ELSIF TG_OP = 'UPDATE' AND OLD.connector_id IS DISTINCT FROM NEW.connector_id THEN
          FOR instance_id IN
            SELECT connector_instance_id FROM connector_instances WHERE connector_id = OLD.connector_id
          LOOP
            PERFORM pdpp_advance_connector_summary_source_revision(instance_id);
          END LOOP;
        END IF;
        IF TG_OP = 'DELETE' THEN
          RETURN OLD;
        END IF;
        RETURN NEW;
      END;
      $function$;
    `);

    // Trigger names intentionally enumerate the source boundary. The instance
    // trigger excludes source_revision itself, preventing recursive self-touches.
    await client.query(`
      DROP TRIGGER IF EXISTS pdpp_source_revision_connector_instances_update ON connector_instances;
      CREATE TRIGGER pdpp_source_revision_connector_instances_update
        AFTER UPDATE OF owner_subject_id, connector_id, display_name, status,
          source_kind, source_binding_key, source_binding_json, created_at,
          updated_at, revoked_at, manifest_generation, record_reset_generation,
          record_identity_generation
        ON connector_instances
        FOR EACH ROW EXECUTE FUNCTION pdpp_touch_connector_summary_instance();

      DROP TRIGGER IF EXISTS pdpp_source_revision_connectors_update ON connectors;
      DROP TRIGGER IF EXISTS pdpp_source_revision_connectors_insert ON connectors;
      DROP TRIGGER IF EXISTS pdpp_source_revision_connectors_delete ON connectors;
      CREATE TRIGGER pdpp_source_revision_connectors_update
        AFTER UPDATE OF connector_id, manifest ON connectors
        FOR EACH ROW EXECUTE FUNCTION pdpp_touch_connector_summary_manifest();
      CREATE TRIGGER pdpp_source_revision_connectors_insert
        AFTER INSERT ON connectors
        FOR EACH ROW EXECUTE FUNCTION pdpp_touch_connector_summary_manifest();
      CREATE TRIGGER pdpp_source_revision_connectors_delete
        AFTER DELETE ON connectors
        FOR EACH ROW EXECUTE FUNCTION pdpp_touch_connector_summary_manifest();
    `);

    for (const table of sourceTables) {
      const trigger = `pdpp_source_revision_${table}`;
      const timing = table === "spine_events" ? "BEFORE" : "AFTER";
      const operations = table === "spine_events" ? "INSERT OR DELETE" : "INSERT OR UPDATE OR DELETE";
      // biome-ignore lint/performance/noAwaitInLoops: trigger DDL must run sequentially inside one transaction.
      await client.query(`
        DROP TRIGGER IF EXISTS ${trigger} ON ${table};
        CREATE TRIGGER ${trigger}
          ${timing} ${operations} ON ${table}
          FOR EACH ROW EXECUTE FUNCTION pdpp_touch_connector_summary_source_row();
      `);
    }

    for (const table of legacySourceTables) {
      // biome-ignore lint/performance/noAwaitInLoops: obsolete trigger cleanup is part of one ordered migration transaction.
      await client.query(`DROP TRIGGER IF EXISTS pdpp_source_revision_${table} ON ${table}`);
    }

    // A complete reinstall is itself a knowledge boundary. Existing evidence
    // must be rebuilt after the last trigger is present; otherwise a writer
    // could have landed in an installation gap and left a clean-looking row.
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Rollback failure must not hide the migration error.
    }
    throw error;
  }
}

function bootstrapLockDelay(attempt: number): number {
  return Math.min(
    POSTGRES_BOOTSTRAP_LOCK_MAX_DELAY_MS,
    POSTGRES_BOOTSTRAP_LOCK_INITIAL_DELAY_MS * 2 ** Math.min(attempt, 4)
  );
}

async function readPostgresDatabaseSize(client: PoolClient): Promise<number | null> {
  try {
    const result = await client.query("SELECT pg_database_size(current_database()) AS bytes");
    const bytes = Number(result.rows[0]?.bytes);
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
  } catch {
    // The size probe is advisory. A restricted Postgres role can still run the
    // schema bootstrap, so an unavailable probe must not turn into a boot
    // failure. The resolver uses the populated-database budget when unknown.
    return null;
  }
}

/**
 * Names who is holding the bootstrap lock, for the timeout error only.
 *
 * A bare "timed out" tells an operator nothing actionable: the server exits,
 * the supervisor restarts it, and the next attempt times out on the same
 * unnamed holder. Observed cost, 2026-08-17: a wedged `DELETE FROM records`
 * left over from a killed process held a conflicting lock on
 * `connector_instances`, so every boot queued behind it and the reference
 * listener never bound. Rolling the image back did not help, because the
 * blocker lived in Postgres rather than in the container. Diagnosing it by
 * hand took ~20 minutes of downtime; Postgres could have answered in one
 * query.
 *
 * Best-effort and deliberately non-fatal: this runs on a path that is
 * already failing, so a diagnostic that throws would replace a useful error
 * with a worse one. Truncated, and reports only pid/state/wait event and how
 * long the statement has run -- never query text, which can carry record
 * values.
 */
async function describeBootstrapLockHolders(client: PoolClient): Promise<string> {
  try {
    const result = await client.query(
      `SELECT a.pid, a.state, a.wait_event_type, round(extract(epoch FROM now() - a.query_start)) AS seconds
       FROM pg_locks l JOIN pg_stat_activity a USING (pid)
       WHERE l.locktype = 'advisory' AND l.objid = $2 AND l.granted AND a.pid <> pg_backend_pid()
       LIMIT 5`,
      POSTGRES_BOOTSTRAP_SERIALIZATION_LOCK
    );
    if (result.rows.length === 0) {
      return " No advisory-lock holder was visible; the contention may be a table-level lock from another session.";
    }
    const held = result.rows
      .map(
        (row) =>
          `pid ${row.pid} (${row.state ?? "unknown"}${row.wait_event_type ? `, waiting on ${row.wait_event_type}` : ""}, ${row.seconds ?? "?"}s)`
      )
      .join(", ");
    return ` Held by: ${held}. Terminate the blocking session, or wait for it to finish, before restarting.`;
  } catch {
    return "";
  }
}

interface BootstrapLockWaitOptions {
  budget: PostgresBootstrapLockBudget;
  log?: StorageLog;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}

async function acquirePostgresBootstrapLock(
  client: PoolClient,
  {
    budget,
    log = NOOP_STORAGE_LOG,
    now = () => performance.now(),
    sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  }: BootstrapLockWaitOptions
): Promise<void> {
  const startedAt = now();
  const deadline = startedAt + budget.timeoutMs;
  let attempt = 0;
  let nextProgressAt = startedAt;

  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: This is the bounded polling loop whose deadline is the behavior under test.
    const result = await client.query(
      "SELECT pg_try_advisory_lock($1, $2) AS locked",
      POSTGRES_BOOTSTRAP_SERIALIZATION_LOCK
    );
    if (result.rows[0]?.locked === true) {
      log(`postgres bootstrap lock acquired after ${now() - startedAt}ms (attempt=${attempt})`);
      return;
    }

    // pg_try_advisory_lock completes before this application-side sleep. A
    // contender therefore has no active virtual transaction that could block
    // CREATE/DROP INDEX CONCURRENTLY in the lock holder.
    const current = now();
    const remainingMs = deadline - current;
    if (remainingMs <= 0) {
      break;
    }
    if (current >= nextProgressAt) {
      log(
        `postgres bootstrap lock waiting (attempt=${attempt}, elapsed_ms=${current - startedAt}, remaining_ms=${remainingMs}, database_size_bytes=${budget.databaseSizeBytes ?? "unknown"})`
      );
      nextProgressAt = current + POSTGRES_BOOTSTRAP_LOCK_PROGRESS_INTERVAL_MS;
    }
    await sleep(Math.min(bootstrapLockDelay(attempt), remainingMs));
    attempt += 1;
  }

  throw new Error(
    `Timed out waiting for PostgreSQL bootstrap serialization lock after ${budget.timeoutMs}ms.${await describeBootstrapLockHolders(client)}`
  );
}

/** Test-only seam for the real deadline loop; production uses bootstrapPostgresSchema. */
export function __acquirePostgresBootstrapLockForTest(
  client: PoolClient,
  options: BootstrapLockWaitOptions
): Promise<void> {
  return acquirePostgresBootstrapLock(client, options);
}

async function hasPgvectorExtension(client: PoolClient): Promise<boolean> {
  const result = await client.query("SELECT 1 FROM pg_extension WHERE extname = 'vector' LIMIT 1");
  return (result.rowCount ?? 0) > 0;
}

async function detectPgSearchExtension(client: PoolClient): Promise<boolean> {
  try {
    const result = await client.query("SELECT 1 FROM pg_available_extensions WHERE name = 'pg_search' LIMIT 1");
    return (result.rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}

async function postgresColumnUdtName(client: PoolClient, table: string, column: string): Promise<string | null> {
  const result = await client.query(
    `SELECT udt_name
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = $1
        AND column_name = $2
      LIMIT 1`,
    [table, column]
  );
  return result.rows[0]?.udt_name ?? null;
}

async function detectSemanticIterativeScanSupport(client: PoolClient): Promise<boolean> {
  // `hnsw.iterative_scan` exists from pgvector 0.8. SET + RESET outside a
  // transaction is harmless on this short-lived bootstrap client.
  try {
    await client.query("SET hnsw.iterative_scan = strict_order");
    await client.query("RESET hnsw.iterative_scan");
    return true;
  } catch {
    return false;
  }
}

async function setSemanticHnswStatementTimeout(client: PoolClient, deadline: number): Promise<void> {
  const remainingMs = Math.floor(deadline - Date.now());
  if (remainingMs <= 0) {
    throw new Error("semantic HNSW maintenance attempt deadline exceeded");
  }
  await client.query(`SET statement_timeout = ${remainingMs}`);
}

async function ensureSemanticEmbeddingHnswIndex(client: PoolClient, log: StorageLog, deadline: number): Promise<void> {
  const existing = await client.query(SEMANTIC_HNSW_INDEX_SHAPE_QUERY, [SEMANTIC_HNSW_INDEX_NAME]);
  const shape = readSemanticHnswIndexShape(existing.rows[0]);
  if (isSemanticHnswIndexUsable(shape, semanticGlobalHnswPredicate())) {
    return;
  }
  // The index is about to be absent or replaced; searches must fall back to
  // the exact scoped scan until a rebuilt index is verified canonical again.
  semanticGlobalHnswVerifiedUsable = false;
  if (shape !== null) {
    log(
      `[PDPP] Semantic index maintenance: dropping unusable HNSW index ${SEMANTIC_HNSW_INDEX_NAME} (${describeSemanticHnswIndexMismatch(shape, semanticGlobalHnswPredicate())})`
    );
    await setSemanticHnswStatementTimeout(client, deadline);
    await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${sqlIdentifier(SEMANTIC_HNSW_INDEX_NAME)}`);
  }

  // HNSW builds want the graph in maintenance_work_mem; the Postgres default
  // (64MB) forces a much slower build at the live table size. SET values
  // cannot be bound parameters; the value is validated against a strict
  // size-literal pattern before interpolation.
  const workMem = process.env.PDPP_PG_SEMANTIC_INDEX_MAINTENANCE_WORK_MEM || "256MB";
  const workMemValid = POSTGRES_WORK_MEM_LITERAL.test(workMem);
  try {
    if (workMemValid) {
      await client.query(`SET maintenance_work_mem = '${workMem}'`);
    }
    // Parallel HNSW builds allocate dynamic shared memory proportional to
    // maintenance_work_mem; containerized Postgres commonly runs with the 64MB
    // /dev/shm default. Build serially so this optional job is safe in the
    // smallest supported container.
    await client.query("SET max_parallel_maintenance_workers = 0");
    log(
      `[PDPP] Semantic index maintenance: building HNSW index ${SEMANTIC_HNSW_INDEX_NAME} (cosine, ${SEMANTIC_VECTOR_INDEXED_DIMENSIONS} dims${workMemValid ? `, maintenance_work_mem=${workMem}` : ""}, serial build)`
    );
    const startedAt = Date.now();
    await setSemanticHnswStatementTimeout(client, deadline);
    await client.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${SEMANTIC_HNSW_INDEX_NAME}
         ON semantic_search_blob
         USING hnsw ((embedding::vector(${SEMANTIC_VECTOR_INDEXED_DIMENSIONS})) vector_cosine_ops)
         WHERE (vector_dims(embedding) = ${SEMANTIC_VECTOR_INDEXED_DIMENSIONS})`
    );
    log(`[PDPP] Semantic index maintenance: HNSW index ready in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  } finally {
    await client.query("RESET max_parallel_maintenance_workers").catch(() => undefined);
    if (workMemValid) {
      await client.query("RESET maintenance_work_mem").catch(() => undefined);
    }
  }
}

function sqlIdentifier(value: string): string {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function sqlLiteral(value: string): string {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function semanticHotHnswIndexName(connectorId: string, connectorInstanceId: string): string {
  const connector =
    String(connectorId || "connector")
      .toLowerCase()
      .replace(SEMANTIC_CONNECTOR_SAFE_CHARS, "_")
      .replace(SEMANTIC_CONNECTOR_TRIM, "")
      .slice(0, 24) || "connector";
  const instance =
    String(connectorInstanceId || "")
      .replace(CONNECTOR_INSTANCE_PREFIX, "")
      .replace(CONNECTOR_INSTANCE_SAFE_CHARS, "")
      .slice(0, 8) ||
    createHash("sha256")
      .update(String(connectorInstanceId || ""))
      .digest("hex")
      .slice(0, 8);
  return `${SEMANTIC_HOT_HNSW_INDEX_PREFIX}${connector}_${instance}`.slice(0, 63);
}

async function ensureSemanticHotHnswIndexes(client: PoolClient, log: StorageLog, deadline: number): Promise<void> {
  if (!(await hasPgvectorExtension(client))) {
    return;
  }
  const minRows = semanticHotHnswMinRows();
  const maxIndexes = semanticHotHnswMaxIndexes();
  if (maxIndexes <= 0) {
    return;
  }
  const totalResult = await client.query(
    `SELECT COUNT(*)::bigint AS n
       FROM semantic_search_blob
      WHERE vector_dims(embedding) = ${SEMANTIC_VECTOR_INDEXED_DIMENSIONS}`
  );
  const totalRows = Number(totalResult.rows[0]?.n || 0);
  if (totalRows <= 0) {
    return;
  }
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
    [minRows, maxRows, maxIndexes]
  );
  if (hot.rowCount === 0) {
    return;
  }
  await hot.rows.reduce(async (previous, row) => {
    await previous;
    const indexName = semanticHotHnswIndexName(row.connector_id, row.connector_instance_id);
    log(
      `[PDPP] Semantic index migration: ensuring hot-source HNSW index ${indexName} (${row.connector_id}, ${row.indexed_rows} rows)`
    );
    const existing = await client.query(SEMANTIC_HNSW_INDEX_SHAPE_QUERY, [indexName]);
    const shape = readSemanticHnswIndexShape(existing.rows[0]);
    const expectedPredicate = semanticHotHnswPredicate(String(row.connector_instance_id));
    if (isSemanticHnswIndexUsable(shape, expectedPredicate)) {
      return;
    }
    if (shape !== null) {
      log(
        `[PDPP] Semantic index maintenance: dropping unusable hot-source index ${indexName} (${describeSemanticHnswIndexMismatch(shape, expectedPredicate)})`
      );
      await setSemanticHnswStatementTimeout(client, deadline);
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${sqlIdentifier(indexName)}`);
    }
    await client.query("SET max_parallel_maintenance_workers = 0");
    try {
      await setSemanticHnswStatementTimeout(client, deadline);
      await client.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${sqlIdentifier(indexName)}
           ON semantic_search_blob
           USING hnsw ((embedding::vector(${SEMANTIC_VECTOR_INDEXED_DIMENSIONS})) vector_cosine_ops)
           WHERE connector_instance_id = ${sqlLiteral(row.connector_instance_id)}
             AND vector_dims(embedding) = ${SEMANTIC_VECTOR_INDEXED_DIMENSIONS}`
      );
    } finally {
      await client.query("RESET max_parallel_maintenance_workers");
    }
  }, Promise.resolve());
}

interface PostgresSemanticHnswMaintenanceOptions {
  log?: StorageLog;
}

async function updateSemanticHnswBuildState(
  client: PoolClient,
  values: {
    state: "pending" | "running" | "ready" | "unavailable" | "failed";
    incrementAttempts?: boolean;
    startedAt?: string | null;
    completedAt?: string | null;
    lastError?: string | null;
  }
): Promise<void> {
  await client.query(
    `UPDATE semantic_hnsw_index_build
        SET state = $1,
            attempts = attempts + CASE WHEN $2 THEN 1 ELSE 0 END,
            started_at = COALESCE($3, started_at),
            completed_at = $4,
            last_error = $5,
            updated_at = (now() AT TIME ZONE 'utc')::text
      WHERE build_key = 'semantic_hnsw'`,
    [
      values.state,
      values.incrementAttempts === true,
      values.startedAt ?? null,
      values.completedAt ?? null,
      values.lastError ?? null,
    ]
  );
}

function postgresMaintenanceErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2000);
}

/**
 * Run one bounded, durable HNSW attempt. This function is intentionally
 * separate from bootstrap: the graph is a catalog acceleration, while the
 * vector column and its read semantics are required storage state.
 */
export async function runPostgresSemanticHnswMaintenance({
  log = NOOP_STORAGE_LOG,
}: PostgresSemanticHnswMaintenanceOptions = {}): Promise<void> {
  if (!isPostgresStorageBackend()) {
    return;
  }
  const client = await getPostgresLockPool().connect();
  let lockHeld = false;
  let sessionSettingsApplied = false;
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock($1, $2) AS locked", POSTGRES_SEMANTIC_HNSW_BUILD_LOCK);
    if (lock.rows[0]?.locked !== true) {
      log("[PDPP] Semantic index maintenance: HNSW builder already owned by another process");
      return;
    }
    lockHeld = true;

    const startedAt = new Date().toISOString();
    await updateSemanticHnswBuildState(client, { incrementAttempts: true, startedAt, state: "running" });
    if (!(await hasPgvectorExtension(client))) {
      await updateSemanticHnswBuildState(client, {
        completedAt: null,
        lastError: null,
        state: "unavailable",
      });
      log("[PDPP] Semantic index maintenance: pgvector is unavailable; exact semantic reads remain active");
      return;
    }

    const timeoutMs = resolvePostgresSemanticHnswBuildTimeoutMs();
    const deadline = Date.now() + timeoutMs;
    await client.query(`SET statement_timeout = ${timeoutMs}`);
    sessionSettingsApplied = true;
    await client.query(`SET lock_timeout = ${POSTGRES_SEMANTIC_HNSW_BUILD_LOCK_TIMEOUT_MS}`);
    await ensureSemanticEmbeddingHnswIndex(client, log, deadline);
    await ensureSemanticHotHnswIndexes(client, log, deadline);
    await updateSemanticHnswBuildState(client, {
      completedAt: new Date().toISOString(),
      lastError: null,
      state: "ready",
    });
    log("[PDPP] Semantic index maintenance: HNSW builder completed");
  } catch (error) {
    const message = postgresMaintenanceErrorMessage(error);
    await updateSemanticHnswBuildState(client, {
      completedAt: null,
      lastError: message,
      state: "failed",
    }).catch(() => undefined);
    log(`[PDPP] Semantic index maintenance: HNSW builder failed (retryable): ${message}`);
  } finally {
    if (sessionSettingsApplied) {
      await client.query("RESET statement_timeout").catch(() => undefined);
      await client.query("RESET lock_timeout").catch(() => undefined);
    }
    if (lockHeld) {
      await client.query("SELECT pg_advisory_unlock($1, $2)", POSTGRES_SEMANTIC_HNSW_BUILD_LOCK).catch(() => undefined);
    }
    client.release();
  }
}

/**
 * Whether the global semantic HNSW index is present in the catalog with the
 * canonical shape. The search path uses this to decide whether it may take the
 * bounded ANN candidate window; while the answer is false it must stay on the
 * exact scoped scan, which is slower but cannot under-return.
 *
 * Only the positive answer is cached. A verified-canonical index is dropped
 * only by this module's own maintenance (which clears the cache), so caching
 * `true` cannot outlive the index. A negative answer is never cached, so a
 * search issued while the builder is still running picks the index up on the
 * first call after the build commits.
 */
let semanticGlobalHnswVerifiedUsable = false;

export function __resetPostgresSemanticHnswReadinessCacheForTest(): void {
  semanticGlobalHnswVerifiedUsable = false;
}

export async function isPostgresSemanticGlobalHnswUsable(): Promise<boolean> {
  if (!isPostgresStorageBackend()) {
    return false;
  }
  if (semanticGlobalHnswVerifiedUsable) {
    return true;
  }
  try {
    const existing = await postgresQuery(SEMANTIC_HNSW_INDEX_SHAPE_QUERY, [SEMANTIC_HNSW_INDEX_NAME]);
    const usable = isSemanticHnswIndexUsable(
      readSemanticHnswIndexShape(existing.rows[0] as Record<string, unknown> | undefined),
      semanticGlobalHnswPredicate()
    );
    semanticGlobalHnswVerifiedUsable = usable;
    return usable;
  } catch {
    // A catalog read failure must not upgrade the read path to the
    // possibly-truncating candidate window.
    return false;
  }
}

/** Schedule the optional builder without adding it to the readiness await chain. */
export function schedulePostgresSemanticHnswMaintenance({
  log = NOOP_STORAGE_LOG,
  run = runPostgresSemanticHnswMaintenance,
}: PostgresSemanticHnswMaintenanceOptions & {
  run?: (options: PostgresSemanticHnswMaintenanceOptions) => Promise<void>;
} = {}): Promise<void> {
  log("[PDPP] Semantic index maintenance: HNSW builder scheduled after AS/RS listen");
  return new Promise((resolve) => setImmediate(resolve))
    .then(() => run({ log }))
    .catch((error) => {
      log(`[PDPP] Semantic index maintenance: HNSW scheduler failed after listeners (retryable): ${error}`);
    });
}

/** Test-only seam for proving the scheduler is outside the readiness chain. */
export function __schedulePostgresSemanticHnswMaintenanceForTest(options: {
  log: StorageLog;
  run: (options: PostgresSemanticHnswMaintenanceOptions) => Promise<void>;
}): Promise<void> {
  return schedulePostgresSemanticHnswMaintenance(options);
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
async function migratePostgresSemanticEmbeddingToVector(
  client: PoolClient,
  log: StorageLog = () => {
    /* no-op */
  }
): Promise<void> {
  if (!(await hasPgvectorExtension(client))) {
    semanticEmbeddingColumnMode = "jsonb";
    semanticIterativeScanSupported = false;
    return;
  }

  const udtName = await postgresColumnUdtName(client, "semantic_search_blob", "embedding");
  if (udtName === "vector") {
    semanticEmbeddingColumnMode = "vector";
    semanticIterativeScanSupported = await detectSemanticIterativeScanSupport(client);
    return;
  }
  if (udtName !== "jsonb") {
    // Unknown shape — leave it alone and keep the brute-force path honest.
    semanticEmbeddingColumnMode = "jsonb";
    semanticIterativeScanSupported = false;
    return;
  }

  // Index rows are derived data (rebuilt by the semantic backfill machinery),
  // so rows that cannot cast to a vector — non-array payloads or arrays
  // containing null — are dropped rather than wedging boot forever.
  const garbage = await client.query(
    `DELETE FROM semantic_search_blob
      WHERE jsonb_typeof(embedding) <> 'array' OR embedding @> 'null'::jsonb`
  );
  if ((garbage.rowCount ?? 0) > 0) {
    log(
      `[PDPP] Semantic index migration: dropped ${garbage.rowCount ?? 0} non-castable embedding rows (they will be rebuilt by the semantic backfill)`
    );
  }

  const totalResult = await client.query("SELECT COUNT(*) AS n FROM semantic_search_blob");
  const total = Number(totalResult.rows[0]?.n || 0);
  if (total > 0) {
    log(`[PDPP] Semantic index migration: converting semantic_search_blob.embedding JSONB → pgvector (${total} rows)`);
  }

  await client.query("ALTER TABLE semantic_search_blob ADD COLUMN IF NOT EXISTS embedding_vec vector");

  const batchSize = semanticVectorMigrationBatchSize();
  let migrated = 0;
  const migrateBatch = async (): Promise<void> => {
    const batch = await client.query(
      `UPDATE semantic_search_blob
          SET embedding_vec = (embedding::text)::vector
        WHERE ctid IN (
          SELECT ctid FROM semantic_search_blob WHERE embedding_vec IS NULL LIMIT $1
        )`,
      [batchSize]
    );
    if ((batch.rowCount ?? 0) === 0) {
      return;
    }
    migrated += batch.rowCount ?? 0;
    log(`[PDPP] Semantic index migration: backfilled ${migrated} embeddings`);
    await migrateBatch();
  };
  await migrateBatch();

  await client.query("BEGIN");
  try {
    await client.query("ALTER TABLE semantic_search_blob DROP COLUMN embedding");
    await client.query("ALTER TABLE semantic_search_blob RENAME COLUMN embedding_vec TO embedding");
    await client.query("ALTER TABLE semantic_search_blob ALTER COLUMN embedding SET NOT NULL");
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Rollback failure must not hide the original migration error.
    }
    throw err;
  }

  semanticEmbeddingColumnMode = "vector";
  semanticIterativeScanSupported = await detectSemanticIterativeScanSupport(client);
  if (total > 0) {
    log("[PDPP] Semantic index migration: complete — semantic queries now use pgvector cosine distance");
  }
}

async function hasPostgresTable(client: PoolClient, table: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
       FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name = $1
      LIMIT 1`,
    [table]
  );
  return (result.rowCount ?? 0) > 0;
}

async function hasPostgresColumn(client: PoolClient, table: string, column: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = $1
        AND column_name = $2
      LIMIT 1`,
    [table, column]
  );
  return (result.rowCount ?? 0) > 0;
}

async function migratePostgresClientEventSubscriptionAuthority(client: PoolClient): Promise<void> {
  await client.query(
    `ALTER TABLE client_event_subscriptions
       ADD COLUMN IF NOT EXISTS authority_kind TEXT NOT NULL DEFAULT 'client_grant'`
  );
  await client.query(
    `UPDATE client_event_subscriptions
        SET authority_kind = 'client_grant'
      WHERE authority_kind IS NULL`
  );
  await client.query("ALTER TABLE client_event_subscriptions ALTER COLUMN grant_id DROP NOT NULL");
  await client.query(
    `ALTER TABLE client_event_subscriptions
       DROP CONSTRAINT IF EXISTS client_event_subscriptions_authority_kind_check`
  );
  await client.query(
    `ALTER TABLE client_event_subscriptions
       ADD CONSTRAINT client_event_subscriptions_authority_kind_check
       CHECK (authority_kind IN ('client_grant', 'trusted_owner_agent'))`
  );
  await client.query(
    `ALTER TABLE client_event_subscriptions
       DROP CONSTRAINT IF EXISTS client_event_subscriptions_authority_grant_check`
  );
  await client.query(
    `ALTER TABLE client_event_subscriptions
       ADD CONSTRAINT client_event_subscriptions_authority_grant_check
       CHECK (
         (authority_kind = 'client_grant' AND grant_id IS NOT NULL)
         OR (authority_kind = 'trusted_owner_agent' AND grant_id IS NULL)
       )`
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_pg_client_event_subscriptions_authority
       ON client_event_subscriptions(authority_kind, subject_id, client_id, status)`
  );
}

function makeDefaultAccountConnectorInstanceId(ownerSubjectId: string, connectorId: string): string {
  const hash = hashKey(`${ownerSubjectId}\n${connectorId}\naccount\ndefault`);
  return `cin_${hash.slice(0, 24)}`;
}

async function defaultConnectorInstanceIdForBackfill(client: PoolClient, connectorId: string): Promise<string> {
  const result = await client.query(
    `SELECT connector_instance_id
       FROM connector_instances
      WHERE connector_id = $1
      ORDER BY connector_instance_id`,
    [connectorId]
  );
  if (result.rows.length === 1) {
    return result.rows[0].connector_instance_id;
  }
  return makeDefaultAccountConnectorInstanceId(LEGACY_SYNC_STATE_OWNER_SUBJECT_ID, connectorId);
}

async function migratePostgresConnectorSyncStateInstanceColumns(client: PoolClient): Promise<void> {
  const hasOwnerColumn = await hasPostgresColumn(client, "connector_state", "connector_instance_id");
  const hasGrantColumn = await hasPostgresColumn(client, "grant_connector_state", "connector_instance_id");
  if (hasOwnerColumn && hasGrantColumn) {
    return;
  }

  await client.query("BEGIN");
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
    const resolveInstanceId = async (connectorId: string): Promise<string> => {
      if (!instanceIds.has(connectorId)) {
        instanceIds.set(connectorId, await defaultConnectorInstanceIdForBackfill(client, connectorId));
      }
      return instanceIds.get(connectorId);
    };

    if (!hasOwnerColumn) {
      await client.query("ALTER TABLE connector_state DROP CONSTRAINT IF EXISTS connector_state_pkey");
      await client.query("ALTER TABLE connector_state ADD COLUMN connector_instance_id TEXT");
      await sequentially(ownerRows.rows, async (row) => {
        await client.query(
          `UPDATE connector_state
              SET connector_instance_id = $1
            WHERE connector_id = $2 AND stream = $3`,
          [await resolveInstanceId(row.connector_id), row.connector_id, row.stream]
        );
      });
      await client.query("ALTER TABLE connector_state ALTER COLUMN connector_instance_id SET NOT NULL");
      await client.query(
        "ALTER TABLE connector_state ADD CONSTRAINT connector_state_pkey PRIMARY KEY (connector_instance_id, stream)"
      );
    }

    if (!hasGrantColumn) {
      await client.query("ALTER TABLE grant_connector_state DROP CONSTRAINT IF EXISTS grant_connector_state_pkey");
      await client.query("ALTER TABLE grant_connector_state ADD COLUMN connector_instance_id TEXT");
      await sequentially(grantRows.rows, async (row) => {
        await client.query(
          `UPDATE grant_connector_state
              SET connector_instance_id = $1
            WHERE grant_id = $2 AND connector_id = $3 AND stream = $4`,
          [await resolveInstanceId(row.connector_id), row.grant_id, row.connector_id, row.stream]
        );
      });
      await client.query("ALTER TABLE grant_connector_state ALTER COLUMN connector_instance_id SET NOT NULL");
      await client.query(
        "ALTER TABLE grant_connector_state ADD CONSTRAINT grant_connector_state_pkey PRIMARY KEY (grant_id, connector_instance_id, stream)"
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Optional cleanup is fail-open during additive migration.
    }
    throw err;
  }
}

async function migratePostgresConnectorDetailGapInstanceColumns(client: PoolClient): Promise<void> {
  // A pre-lease schema can contain interrupted in_progress rows with no owner
  // tuple. Bootstrap is the bounded recovery point: deployment requires zero
  // active runs and a single-version restart, not mixed-version operation.
  const needsLeaseMigration = !(
    (await hasPostgresColumn(client, "connector_detail_gaps", "lease_run_id")) &&
    (await hasPostgresColumn(client, "connector_detail_gaps", "lease_id")) &&
    (await hasPostgresColumn(client, "connector_detail_gaps", "lease_attempted")) &&
    (await hasPostgresColumn(client, "connector_detail_gaps", "lease_expires_at"))
  );
  if (needsLeaseMigration) {
    const activeRuns = await client.query("SELECT COUNT(*)::integer AS count FROM controller_active_runs");
    if (Number(activeRuns.rows[0]?.count || 0) > 0) {
      throw new Error(
        "detail-gap lease migration requires zero active connector runs; drain runs and perform a single-version restart"
      );
    }
  }
  if (!(await hasPostgresColumn(client, "connector_detail_gaps", "lease_run_id"))) {
    await client.query("ALTER TABLE connector_detail_gaps ADD COLUMN lease_run_id TEXT");
  }
  if (!(await hasPostgresColumn(client, "connector_detail_gaps", "lease_id"))) {
    await client.query("ALTER TABLE connector_detail_gaps ADD COLUMN lease_id TEXT");
  }
  if (!(await hasPostgresColumn(client, "connector_detail_gaps", "lease_attempted"))) {
    await client.query("ALTER TABLE connector_detail_gaps ADD COLUMN lease_attempted INTEGER NOT NULL DEFAULT 0");
  }
  if (!(await hasPostgresColumn(client, "connector_detail_gaps", "lease_expires_at"))) {
    await client.query("ALTER TABLE connector_detail_gaps ADD COLUMN lease_expires_at TEXT");
  }
  await client.query(`
    UPDATE connector_detail_gaps
    SET status = 'pending', lease_attempted = 0
    WHERE status = 'in_progress'
      AND lease_run_id IS NULL AND lease_id IS NULL AND lease_expires_at IS NULL
  `);
  const hasInstance = await hasPostgresColumn(client, "connector_detail_gaps", "connector_instance_id");
  if (!hasInstance) {
    await client.query("ALTER TABLE connector_detail_gaps ADD COLUMN connector_instance_id TEXT");
    const rows = await client.query("SELECT gap_id, connector_id FROM connector_detail_gaps ORDER BY gap_id");
    const instanceIds = new Map();
    const resolveInstanceId = async (connectorId: string): Promise<string> => {
      if (!instanceIds.has(connectorId)) {
        instanceIds.set(connectorId, await defaultConnectorInstanceIdForBackfill(client, connectorId));
      }
      return instanceIds.get(connectorId);
    };
    await sequentially(rows.rows, async (row) => {
      await client.query("UPDATE connector_detail_gaps SET connector_instance_id = $1 WHERE gap_id = $2", [
        await resolveInstanceId(row.connector_id),
        row.gap_id,
      ]);
    });
    await client.query("ALTER TABLE connector_detail_gaps ALTER COLUMN connector_instance_id SET NOT NULL");
  }

  // Drop the identity index BEFORE reconciling duplicates so the DELETE can
  // collapse rows that would violate the new (locator-free) identity, then
  // recreate it. Wrapped in a transaction so the dedupe and index recreation are
  // atomic. The new identity excludes the volatile locator when a record_key is
  // present, so pre-existing rows differing ONLY in detail_locator_json (the
  // locator-schema-drift orphan class) now collide.
  await client.query("BEGIN");
  try {
    await client.query("DROP INDEX IF EXISTS uniq_pg_connector_detail_gaps_identity");
    await client.query("DROP INDEX IF EXISTS idx_pg_connector_detail_gaps_pending");
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
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Optional cleanup is fail-open during additive migration.
    }
    throw err;
  }
}

async function migratePostgresSchedulerInstanceColumns(client: PoolClient): Promise<void> {
  // A fresh install's run_history table (created directly by the CREATE
  // TABLE IF NOT EXISTS above) already has connector_instance_id NOT NULL
  // from the start — this legacy scheduler_run_history-specific backfill
  // block only applies when that old table name still exists.
  const legacyHistoryTableExists = await hasPostgresTable(client, "scheduler_run_history");
  const scheduleHasInstance = await hasPostgresColumn(client, "connector_schedules", "connector_instance_id");
  const activeRunHasInstance = await hasPostgresColumn(client, "controller_active_runs", "connector_instance_id");
  const historyHasInstance = legacyHistoryTableExists
    ? await hasPostgresColumn(client, "scheduler_run_history", "connector_instance_id")
    : true;
  const lastRunHasInstance = await hasPostgresColumn(client, "scheduler_last_run_times", "connector_instance_id");
  if (scheduleHasInstance && activeRunHasInstance && historyHasInstance && lastRunHasInstance) {
    return;
  }

  await client.query("BEGIN");
  try {
    const instanceIds = new Map();
    const resolveInstanceId = async (connectorId: string): Promise<string> => {
      if (!instanceIds.has(connectorId)) {
        instanceIds.set(connectorId, await defaultConnectorInstanceIdForBackfill(client, connectorId));
      }
      return instanceIds.get(connectorId);
    };

    if (!scheduleHasInstance) {
      const rows = await client.query("SELECT connector_id FROM connector_schedules ORDER BY connector_id");
      await client.query("ALTER TABLE connector_schedules DROP CONSTRAINT IF EXISTS connector_schedules_pkey");
      await client.query("ALTER TABLE connector_schedules ADD COLUMN connector_instance_id TEXT");
      await sequentially(rows.rows, async (row) => {
        await client.query("UPDATE connector_schedules SET connector_instance_id = $1 WHERE connector_id = $2", [
          await resolveInstanceId(row.connector_id),
          row.connector_id,
        ]);
      });
      await client.query("ALTER TABLE connector_schedules ALTER COLUMN connector_instance_id SET NOT NULL");
      await client.query(
        "ALTER TABLE connector_schedules ADD CONSTRAINT connector_schedules_pkey PRIMARY KEY (connector_instance_id)"
      );
    }

    if (!activeRunHasInstance) {
      const rows = await client.query("SELECT connector_id FROM controller_active_runs ORDER BY connector_id");
      await client.query("ALTER TABLE controller_active_runs DROP CONSTRAINT IF EXISTS controller_active_runs_pkey");
      await client.query("ALTER TABLE controller_active_runs ADD COLUMN connector_instance_id TEXT");
      await sequentially(rows.rows, async (row) => {
        await client.query("UPDATE controller_active_runs SET connector_instance_id = $1 WHERE connector_id = $2", [
          await resolveInstanceId(row.connector_id),
          row.connector_id,
        ]);
      });
      await client.query("ALTER TABLE controller_active_runs ALTER COLUMN connector_instance_id SET NOT NULL");
      await client.query(
        "ALTER TABLE controller_active_runs ADD CONSTRAINT controller_active_runs_pkey PRIMARY KEY (connector_instance_id)"
      );
    }

    if (!historyHasInstance) {
      const rows = await client.query("SELECT id, connector_id FROM scheduler_run_history ORDER BY id");
      await client.query("ALTER TABLE scheduler_run_history ADD COLUMN connector_instance_id TEXT");
      await sequentially(rows.rows, async (row) => {
        await client.query("UPDATE scheduler_run_history SET connector_instance_id = $1 WHERE id = $2", [
          await resolveInstanceId(row.connector_id),
          row.id,
        ]);
      });
      await client.query("ALTER TABLE scheduler_run_history ALTER COLUMN connector_instance_id SET NOT NULL");
    }

    if (!lastRunHasInstance) {
      const rows = await client.query("SELECT connector_id FROM scheduler_last_run_times ORDER BY connector_id");
      await client.query(
        "ALTER TABLE scheduler_last_run_times DROP CONSTRAINT IF EXISTS scheduler_last_run_times_pkey"
      );
      await client.query("ALTER TABLE scheduler_last_run_times ADD COLUMN connector_instance_id TEXT");
      await sequentially(rows.rows, async (row) => {
        await client.query("UPDATE scheduler_last_run_times SET connector_instance_id = $1 WHERE connector_id = $2", [
          await resolveInstanceId(row.connector_id),
          row.connector_id,
        ]);
      });
      await client.query("ALTER TABLE scheduler_last_run_times ALTER COLUMN connector_instance_id SET NOT NULL");
      await client.query(
        "ALTER TABLE scheduler_last_run_times ADD CONSTRAINT scheduler_last_run_times_pkey PRIMARY KEY (connector_instance_id)"
      );
    }

    await client.query("DROP INDEX IF EXISTS idx_pg_scheduler_run_history_connector_completed");
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_pg_scheduler_run_history_connector_completed ON scheduler_run_history(connector_instance_id, completed_at, id)"
    );
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Optional cleanup is fail-open during additive migration.
    }
    throw err;
  }
}

// Rename `scheduler_run_history` -> `run_history` and add the columns the
// generalized run-grain writer needs. Must run after
// `migratePostgresSchedulerInstanceColumns` (which still assumes the
// legacy name). A pure rename plus `ADD COLUMN` is safe and lossless.
// Guarded so it is a no-op once the legacy table no longer exists (fresh
// installs get `run_history` directly from the CREATE TABLE IF NOT EXISTS
// above; a DB already migrated has nothing left under the old name).
//
// The legacy-table check MUST come first: the CREATE TABLE IF NOT EXISTS
// run_history above always runs earlier in the same schema-bootstrap
// pass, so on a database that still has `scheduler_run_history`, that
// statement will have already created a second, EMPTY `run_history` by
// the time this function runs. If this function bailed out on
// `run_history` existing, the real data would be stranded under the old
// name forever. Instead, drop that empty placeholder (verified empty
// first) and proceed with the rename.
// SECOND LIVE CANARY REVISE (2026-07-30): an interrupted migration attempt
// can leave a database with BOTH scheduler_run_history (still receiving
// live scheduler writes from a rolled-back-to older revision that has no
// idea run_history/the rename ever existed) AND a non-empty run_history
// (frozen at whatever the interrupted candidate's brief live window
// produced — a rename + backfill + some live writer rows). This is a
// genuine, provable, lossless-mergeable state, not an anomaly to refuse:
// scheduler_run_history's rows are reconciled INTO run_history via the
// SAME (run_id, connector_instance_id) upsert contract
// insert-run-history.sql already establishes for "a scheduler row meets an
// existing run_history row" (scheduler-owned fields win via
// excluded.field; facts_json/trigger_kind, which scheduler_run_history
// never carried, are left untouched) — see reconcilePostgresLegacySchedulerRunHistory.
// scheduler_run_history's own numeric `id` values are NEVER reused (they
// collide with run_history's own id sequence on a real interrupted
// migration — confirmed live) — every merged row gets a fresh run_history
// id from that table's own sequence.
//
// Crash/idempotency: the caller wraps this merge, the verification below,
// and the eventual DROP TABLE scheduler_run_history in ONE transaction.
// Either everything commits together, or Postgres rolls the whole
// transaction back and scheduler_run_history is untouched for the next
// boot to retry fresh. Table existence itself is therefore the only
// idempotency marker needed — no persisted provenance marker on
// run_history rows, and no run_id-IS-NULL special case: a rolled-back
// attempt leaves nothing partially merged to re-guard against.
async function reconcilePostgresLegacySchedulerRunHistory(client: PoolClient): Promise<void> {
  // Snapshot run_history's OWN pre-existing run_id-IS-NULL row count
  // before the merge — needed below to isolate exactly how many NULL rows
  // this merge itself added, since run_history may already carry its own
  // NULL-run_id rows (e.g. from the interrupted candidate's own
  // backfill/live writes) that predate this reconciliation entirely.
  const preMergeNullCount = await client.query<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM run_history WHERE run_id IS NULL"
  );
  const rhNullCountBefore = Number(preMergeNullCount.rows[0]?.n ?? "0");

  // Composite-identity rows (run_id IS NOT NULL): reuse the exact upsert
  // contract insert-run-history.sql already defines for this conflict
  // shape. FOURTH-PASS GATE FIX (2026-07-30): scheduler_run_history itself
  // can contain MULTIPLE rows sharing the identical (run_id,
  // connector_instance_id) pair — the pre-generalization scheduler writer
  // at the rolled-back revision (1392a386f) does a plain INSERT with no
  // ON CONFLICT clause at all, so a retried/duplicate scheduled-run
  // completion under that currently-live writer produces exactly this
  // shape. Postgres's INSERT ... SELECT ... ON CONFLICT DO UPDATE throws
  // "ON CONFLICT DO UPDATE command cannot affect row a second time"
  // whenever two rows in the SAME statement's source set target the same
  // conflict key — this is a hard Postgres restriction, unrelated to
  // ORDER BY. The source is therefore pre-deduplicated via SELECT
  // DISTINCT ON, keeping only the highest `id` (the latest write) per
  // composite key — the same "scheduler's newer write wins" semantics
  // this merge already establishes for the cross-table overlap case
  // (ON CONFLICT DO UPDATE), extended to the intra-table case.
  await client.query(`
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
      started_at, completed_at, error, attempt, true
    FROM (
      SELECT DISTINCT ON (run_id, connector_instance_id) *
      FROM scheduler_run_history
      WHERE run_id IS NOT NULL
      ORDER BY run_id, connector_instance_id, id DESC
    ) deduped
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
      scheduler_managed = true
  `);

  // run_id IS NULL rows (e.g. skipped runs never assigned a run_id) can
  // never conflict under a WHERE run_id IS NOT NULL partial unique index,
  // so they always insert as new rows — exactly once, since this whole
  // function only ever runs inside the caller's single all-or-nothing
  // transaction.
  await client.query(`
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
      started_at, completed_at, error, attempt, true
    FROM scheduler_run_history
    WHERE run_id IS NULL
    ORDER BY id ASC
  `);

  // Verify the invariant before the caller is permitted to drop
  // scheduler_run_history — a genuine count-based proof, not an
  // assumption that the two INSERTs above "must have worked":
  //  - every run_id IS NOT NULL legacy row must be traceable by composite
  //    identity in run_history (the ON CONFLICT upsert guarantees exactly
  //    one row per distinct (run_id, connector_instance_id) pair, so an
  //    existence check is exact, not merely a count).
  //  - every run_id IS NULL legacy row was copied by an unconditional,
  //    unfiltered INSERT ... SELECT (no WHERE NOT EXISTS narrowing — see
  //    the header above for why that is safe here), so the exact number
  //    of NULL rows this merge added to run_history (its post-merge NULL
  //    count minus the pre-merge snapshot taken above) must equal
  //    scheduler_run_history's own NULL row count.
  const unreconciledNamed = await client.query<{ n: string }>(`
    SELECT COUNT(*)::text AS n
    FROM scheduler_run_history srh
    WHERE srh.run_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM run_history rh
        WHERE rh.run_id = srh.run_id AND rh.connector_instance_id = srh.connector_instance_id
      )
  `);
  const unreconciledNamedCount = Number(unreconciledNamed.rows[0]?.n ?? "1");
  if (unreconciledNamedCount > 0) {
    throw new Error(
      `reconcilePostgresLegacySchedulerRunHistory: ${unreconciledNamedCount} scheduler_run_history row(s) with a run_id could not be verified present in run_history after the merge — refusing to drop scheduler_run_history with unreconciled data. This should never happen (the merge INSERT above covers every run_id IS NOT NULL row); investigate before retrying.`
    );
  }

  const postMergeNullCount = await client.query<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM run_history WHERE run_id IS NULL"
  );
  const rhNullCountAfter = Number(postMergeNullCount.rows[0]?.n ?? "0");
  const srhNullCount = await client.query<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM scheduler_run_history WHERE run_id IS NULL"
  );
  const srhNullCountValue = Number(srhNullCount.rows[0]?.n ?? "0");
  const nullRowsAddedByThisMerge = rhNullCountAfter - rhNullCountBefore;
  if (nullRowsAddedByThisMerge !== srhNullCountValue) {
    throw new Error(
      `reconcilePostgresLegacySchedulerRunHistory: this merge added ${nullRowsAddedByThisMerge} run_id-IS-NULL row(s) to run_history but scheduler_run_history has ${srhNullCountValue} — refusing to drop scheduler_run_history with unreconciled data. This should never happen (the merge INSERT above is unconditional and unfiltered); investigate before retrying.`
    );
  }
}

async function migratePostgresRunHistoryRename(client: PoolClient): Promise<void> {
  const legacyExists = await hasPostgresTable(client, "scheduler_run_history");
  if (!legacyExists) {
    return;
  }

  await client.query("BEGIN");
  try {
    const runHistoryExists = await hasPostgresTable(client, "run_history");
    if (runHistoryExists) {
      const countResult = await client.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM run_history");
      const rowCount = Number(countResult.rows[0]?.n ?? "0");
      if (rowCount > 0) {
        // Interrupted-migration state: both tables carry real data.
        // Reconcile losslessly (below) rather than refuse — see
        // reconcilePostgresLegacySchedulerRunHistory's own header for the
        // full incident/design rationale. run_history already carries the
        // full current column set (it exists and is non-empty, so its own
        // CREATE TABLE IF NOT EXISTS or an earlier completed rename
        // already established it) — only the merge and the legacy DROP
        // are needed here, not the ALTER/ADD COLUMN/index-rename steps
        // the fresh-rename branch below performs on a table that just
        // became run_history for the first time.
        await reconcilePostgresLegacySchedulerRunHistory(client);
        await client.query("DROP TABLE scheduler_run_history");
      } else {
        await client.query("DROP TABLE run_history");
        await client.query("ALTER TABLE scheduler_run_history RENAME TO run_history");
        await client.query("ALTER TABLE run_history ADD COLUMN IF NOT EXISTS trigger_kind TEXT");
        await client.query("ALTER TABLE run_history ADD COLUMN IF NOT EXISTS facts_json JSONB");
        // Every pre-existing row was written exclusively by the scheduler's
        // own appendRunHistory (the generalized writer did not exist yet)
        // — mark them scheduler_managed=true so cadence/backoff readers
        // keep seeing exactly the rows they saw before this migration.
        await client.query(
          "ALTER TABLE run_history ADD COLUMN IF NOT EXISTS scheduler_managed BOOLEAN NOT NULL DEFAULT true"
        );
        await client.query("DROP INDEX IF EXISTS idx_pg_scheduler_run_history_connector_completed");
        await client.query(
          "CREATE INDEX IF NOT EXISTS idx_pg_run_history_connector_completed ON run_history(connector_id, completed_at, id)"
        );
      }
    } else {
      await client.query("ALTER TABLE scheduler_run_history RENAME TO run_history");
      await client.query("ALTER TABLE run_history ADD COLUMN IF NOT EXISTS trigger_kind TEXT");
      await client.query("ALTER TABLE run_history ADD COLUMN IF NOT EXISTS facts_json JSONB");
      await client.query(
        "ALTER TABLE run_history ADD COLUMN IF NOT EXISTS scheduler_managed BOOLEAN NOT NULL DEFAULT true"
      );
      // completed_at nullability is repaired separately by
      // migratePostgresRunHistoryCompletedAtNullable, called
      // unconditionally (not gated on legacyExists) right after this
      // function — see that function's own header for why the repair
      // cannot live inside this legacy-table-gated branch.
      await client.query("DROP INDEX IF EXISTS idx_pg_scheduler_run_history_connector_completed");
      await client.query(
        "CREATE INDEX IF NOT EXISTS idx_pg_run_history_connector_completed ON run_history(connector_id, completed_at, id)"
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Rollback failure must not hide the original migration error.
    }
    throw err;
  }

  // Separate, non-transactional step, mirroring the original migration's
  // shape. run_id alone is NOT globally unique — two different
  // connections can legitimately share a run_id (confirmed live; a
  // production instance hit exactly this: two connections' runs sharing
  // a run_id caused this CREATE UNIQUE INDEX to fail with 42P10, and every
  // subsequent ON CONFLICT(run_id) writer/backfill insert then failed the
  // same way — see openspec/changes/run-history-backfill-list-cutover).
  // The real identity, and the only key this index can be built on
  // without colliding on legitimate historical data, is (run_id,
  // connector_instance_id). Unlike the bare-run_id index this replaces,
  // this is NOT wrapped in a swallow-and-log try/catch: a duplicate
  // (run_id, connector_instance_id) pair would be a genuine data anomaly
  // (the same connection's same run recorded twice under different
  // rows), which must fail the migration loudly rather than leave the
  // writer's ON CONFLICT target unindexed and silently degraded.
  await client.query("DROP INDEX IF EXISTS uniq_pg_run_history_run_id");
  await client.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS uniq_pg_run_history_run_id_instance ON run_history(run_id, connector_instance_id) WHERE run_id IS NOT NULL"
  );
}

// REVISE fix (fleet-migration gap, 2026-07-30 second gate pass): the
// completed_at nullable repair e44bf3391 added lived INSIDE
// migratePostgresRunHistoryRename's `legacyExists`-gated branch, which
// returns immediately once `scheduler_run_history` no longer exists
// (line ~2871 above). A database whose scheduler_run_history -> run_history
// rename already executed under an EARLIER deployment of this migration
// (i.e. before e44bf3391 shipped the completed_at fix) is permanently
// stuck on the legacy NOT NULL constraint: the repair's own guard
// (`legacyExists`) is false by the time that fix ships, so the repair
// never reaches it, and every run.started write throws forever on that
// database. This is a distinct, unconditional repair: it runs whenever
// `run_history` exists and its completed_at column is still NOT NULL,
// independent of whether scheduler_run_history exists. Idempotent (a
// second run finds completed_at already nullable and no-ops); a no-op on
// fresh installs (run_history is created nullable from the start, so the
// `information_schema` check below is false immediately).
async function migratePostgresRunHistoryCompletedAtNullable(client: PoolClient): Promise<void> {
  const runHistoryExists = await hasPostgresTable(client, "run_history");
  if (!runHistoryExists) {
    return;
  }
  const result = await client.query<{ is_nullable: string }>(
    `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'run_history' AND column_name = 'completed_at'`
  );
  const isNullable = result.rows[0]?.is_nullable;
  if (isNullable !== "NO") {
    // Nullable already (the common case), or the column is missing
    // entirely (should not happen once run_history exists, but fail open
    // rather than throw on an unexpected shape) — nothing to repair.
    return;
  }
  await client.query("ALTER TABLE run_history ALTER COLUMN completed_at DROP NOT NULL");
}

// Widens `connector_maintenance_cursor.name`'s CHECK to admit the
// `run_history_backfill` cursor row alongside the existing
// `connector_summary_evidence` one. No-op once the constraint already
// admits both names (checked via pg_get_constraintdef, since the
// auto-generated constraint name is stable but its definition is what
// actually matters here).
async function migratePostgresConnectorMaintenanceCursorNameCheck(client: PoolClient): Promise<void> {
  const result = await client.query<{ conname: string; definition: string }>(
    `SELECT conname, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conrelid = 'connector_maintenance_cursor'::regclass
        AND contype = 'c'`
  );
  const alreadyWidened = result.rows.some((row) => row.definition.includes("run_history_backfill"));
  if (alreadyWidened) {
    return;
  }
  for (const row of result.rows) {
    // biome-ignore lint/performance/noAwaitInLoops: one-time migration over a table CHECK constraint list of size 0 or 1; sequential DDL, not a hot path.
    await client.query(
      `ALTER TABLE connector_maintenance_cursor DROP CONSTRAINT ${quotePostgresIdentifier(row.conname)}`
    );
  }
  await client.query(
    `ALTER TABLE connector_maintenance_cursor
       ADD CONSTRAINT connector_maintenance_cursor_name_check
       CHECK (name IN ('connector_summary_evidence', 'run_history_backfill'))`
  );
}

async function migratePostgresRecordsBlobSearchInstanceColumns(client: PoolClient): Promise<void> {
  const checks: boolean[] = [];
  await sequentially(
    [
      "records",
      "record_changes",
      "version_counter",
      "blobs",
      "blob_bindings",
      "lexical_search_index",
      "lexical_search_meta",
      "semantic_search_blob",
      "semantic_search_meta",
      "semantic_search_backfill_progress",
    ],
    async (table) => {
      checks.push(await hasPostgresColumn(client, table, "connector_instance_id"));
    }
  );
  await client.query("ALTER TABLE semantic_search_backfill_progress ADD COLUMN IF NOT EXISTS fields_fingerprint TEXT");
  if (checks.every(Boolean)) {
    await ensurePostgresRecordsBlobSearchInstanceIndexes(client);
    return;
  }

  await client.query("BEGIN");
  try {
    const instanceIds = new Map();
    const resolveInstanceId = async (connectorId: string): Promise<string> => {
      if (!instanceIds.has(connectorId)) {
        instanceIds.set(connectorId, await defaultConnectorInstanceIdForBackfill(client, connectorId));
      }
      return instanceIds.get(connectorId);
    };

    const backfillTableByConnector = async (table: string, connectorColumn = "connector_id"): Promise<void> => {
      const rows = await client.query(
        `SELECT DISTINCT ${connectorColumn} AS connector_id FROM ${table} WHERE connector_instance_id IS NULL ORDER BY ${connectorColumn}`
      );
      await sequentially(rows.rows, async (row) => {
        await client.query(
          `UPDATE ${table} SET connector_instance_id = $1 WHERE ${connectorColumn} = $2 AND connector_instance_id IS NULL`,
          [await resolveInstanceId(row.connector_id), row.connector_id]
        );
      });
    };

    if (!checks[0]) {
      await client.query("ALTER TABLE records DROP CONSTRAINT IF EXISTS records_connector_id_stream_record_key_key");
      await client.query("ALTER TABLE records ADD COLUMN connector_instance_id TEXT");
      await backfillTableByConnector("records");
      await client.query("ALTER TABLE records ALTER COLUMN connector_instance_id SET NOT NULL");
      await client.query(
        "ALTER TABLE records ADD CONSTRAINT records_connector_instance_stream_key UNIQUE(connector_instance_id, stream, record_key)"
      );
    }

    if (!checks[1]) {
      await client.query("ALTER TABLE record_changes DROP CONSTRAINT IF EXISTS record_changes_pkey");
      await client.query("ALTER TABLE record_changes ADD COLUMN connector_instance_id TEXT");
      await backfillTableByConnector("record_changes");
      await client.query("ALTER TABLE record_changes ALTER COLUMN connector_instance_id SET NOT NULL");
      await client.query(
        "ALTER TABLE record_changes ADD CONSTRAINT record_changes_pkey PRIMARY KEY(connector_instance_id, stream, version)"
      );
    }

    if (!checks[2]) {
      await client.query("ALTER TABLE version_counter DROP CONSTRAINT IF EXISTS version_counter_pkey");
      await client.query("ALTER TABLE version_counter ADD COLUMN connector_instance_id TEXT");
      await backfillTableByConnector("version_counter");
      await client.query("ALTER TABLE version_counter ALTER COLUMN connector_instance_id SET NOT NULL");
      await client.query(
        "ALTER TABLE version_counter ADD CONSTRAINT version_counter_pkey PRIMARY KEY(connector_instance_id, stream)"
      );
    }

    if (!checks[3]) {
      await client.query("ALTER TABLE blobs ADD COLUMN connector_instance_id TEXT");
      await backfillTableByConnector("blobs");
      await client.query("ALTER TABLE blobs ALTER COLUMN connector_instance_id SET NOT NULL");
    }

    if (!checks[4]) {
      await client.query("ALTER TABLE blob_bindings DROP CONSTRAINT IF EXISTS blob_bindings_pkey");
      await client.query("ALTER TABLE blob_bindings ADD COLUMN connector_instance_id TEXT");
      await backfillTableByConnector("blob_bindings");
      await client.query("ALTER TABLE blob_bindings ALTER COLUMN connector_instance_id SET NOT NULL");
      await client.query(
        "ALTER TABLE blob_bindings ADD CONSTRAINT blob_bindings_pkey PRIMARY KEY(blob_id, connector_instance_id, stream, record_key, json_path)"
      );
    }

    if (!checks[5]) {
      await client.query("ALTER TABLE lexical_search_index DROP CONSTRAINT IF EXISTS lexical_search_index_pkey");
      await client.query("ALTER TABLE lexical_search_index ADD COLUMN connector_instance_id TEXT");
      await backfillTableByConnector("lexical_search_index");
      await client.query("ALTER TABLE lexical_search_index ALTER COLUMN connector_instance_id SET NOT NULL");
      await client.query(
        "ALTER TABLE lexical_search_index ADD CONSTRAINT lexical_search_index_pkey PRIMARY KEY(connector_instance_id, stream, record_key, field)"
      );
    }

    if (!checks[6]) {
      await client.query("ALTER TABLE lexical_search_meta DROP CONSTRAINT IF EXISTS lexical_search_meta_pkey");
      await client.query("ALTER TABLE lexical_search_meta ADD COLUMN connector_instance_id TEXT");
      await backfillTableByConnector("lexical_search_meta");
      await client.query("ALTER TABLE lexical_search_meta ALTER COLUMN connector_instance_id SET NOT NULL");
      await client.query(
        "ALTER TABLE lexical_search_meta ADD CONSTRAINT lexical_search_meta_pkey PRIMARY KEY(connector_instance_id, stream)"
      );
    }

    if (!checks[7]) {
      await client.query("ALTER TABLE semantic_search_blob DROP CONSTRAINT IF EXISTS semantic_search_blob_pkey");
      await client.query("ALTER TABLE semantic_search_blob ADD COLUMN connector_instance_id TEXT");
      await backfillTableByConnector("semantic_search_blob");
      await client.query("ALTER TABLE semantic_search_blob ALTER COLUMN connector_instance_id SET NOT NULL");
      await client.query(
        "ALTER TABLE semantic_search_blob ADD CONSTRAINT semantic_search_blob_pkey PRIMARY KEY(connector_instance_id, scope_key, record_key)"
      );
    }

    if (!checks[8]) {
      await client.query("ALTER TABLE semantic_search_meta DROP CONSTRAINT IF EXISTS semantic_search_meta_pkey");
      await client.query("ALTER TABLE semantic_search_meta ADD COLUMN connector_instance_id TEXT");
      await backfillTableByConnector("semantic_search_meta");
      await client.query("ALTER TABLE semantic_search_meta ALTER COLUMN connector_instance_id SET NOT NULL");
      await client.query(
        "ALTER TABLE semantic_search_meta ADD CONSTRAINT semantic_search_meta_pkey PRIMARY KEY(connector_instance_id, stream)"
      );
    }

    if (!checks[9]) {
      await client.query(
        "ALTER TABLE semantic_search_backfill_progress DROP CONSTRAINT IF EXISTS semantic_search_backfill_progress_pkey"
      );
      await client.query("ALTER TABLE semantic_search_backfill_progress ADD COLUMN connector_instance_id TEXT");
      await backfillTableByConnector("semantic_search_backfill_progress");
      await client.query(
        "ALTER TABLE semantic_search_backfill_progress ALTER COLUMN connector_instance_id SET NOT NULL"
      );
      await client.query(
        "ALTER TABLE semantic_search_backfill_progress ADD CONSTRAINT semantic_search_backfill_progress_pkey PRIMARY KEY(connector_instance_id, stream)"
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Optional cleanup is fail-open during additive migration.
    }
    throw err;
  }
  await ensurePostgresRecordsBlobSearchInstanceIndexes(client);
}

async function ensurePostgresRecordsBlobSearchInstanceIndexes(client: PoolClient): Promise<void> {
  await withPostgresAdvisoryLock(client, RECORDS_BLOB_SEARCH_INDEX_LOCK_ID, async () => {
    // semantic_time on EXISTING records tables: add (idempotent), DEFAULT '' so the
    // boot migration is O(1) (no mass UPDATE on the live multi-million-row table —
    // that bloat/lock is avoided). Existing rows keep ''; the substrate read
    // COALESCEs '' -> emitted_at, so the merged-timeline sort is no worse than the
    // prior order until the chunked per-record semantic backfill (Step B) populates
    // the real values. New writes set semantic_time at ingest.
    await client.query("ALTER TABLE records ADD COLUMN IF NOT EXISTS semantic_time TEXT NOT NULL DEFAULT ''");
    await ensurePostgresIndexDefinition(client, {
      createSql:
        "CREATE INDEX IF NOT EXISTS idx_pg_records_lookup ON records(connector_instance_id, stream, record_key)",
      expectedFragments: ["records USING btree (connector_instance_id, stream, record_key)"],
      name: "idx_pg_records_lookup",
    });
    await ensurePostgresIndexDefinition(client, {
      createSql:
        "CREATE INDEX IF NOT EXISTS idx_pg_records_stream_version ON records(connector_instance_id, stream, version)",
      expectedFragments: ["records USING btree (connector_instance_id, stream, version)"],
      name: "idx_pg_records_stream_version",
    });
    await ensurePostgresIndexDefinition(client, {
      createSql:
        "CREATE INDEX IF NOT EXISTS idx_pg_records_stream_cursor ON records(connector_instance_id, stream, deleted, cursor_value, primary_key_text)",
      expectedFragments: [
        "records USING btree (connector_instance_id, stream, deleted, cursor_value, primary_key_text)",
      ],
      name: "idx_pg_records_stream_cursor",
    });
    await ensurePostgresIndexDefinition(client, {
      createSql:
        "CREATE INDEX IF NOT EXISTS idx_pg_records_connector_stream_deleted ON records(connector_id, stream, deleted)",
      expectedFragments: ["records USING btree (connector_id, stream, deleted)"],
      name: "idx_pg_records_connector_stream_deleted",
    });
    // EXPRESSION index matching the Explore read ORDER BY EXACTLY. The read sorts
    // by COALESCE(NULLIF(semantic_time, ''), emitted_at) (un-backfilled rows fall
    // back to emitted_at) — a plain semantic_time index does NOT back that
    // expression, so the planner would Seq Scan + Sort the whole records table on
    // every page. The expression index keeps the hot path index-backed BEFORE the
    // Step-B backfill. Verified via EXPLAIN: Index Scan, no Sort.
    await ensurePostgresIndexDefinition(client, {
      createSql:
        "CREATE INDEX IF NOT EXISTS idx_pg_records_semantic_time ON records(connector_instance_id, stream, (COALESCE(NULLIF(semantic_time, ''), emitted_at)) DESC, record_key DESC)",
      expectedFragments: [
        "records USING btree (connector_instance_id, stream, COALESCE(NULLIF(semantic_time, ''::text), emitted_at) DESC, record_key DESC)",
      ],
      name: "idx_pg_records_semantic_time",
    });
    await ensurePostgresIndexDefinition(client, {
      createSql:
        "CREATE INDEX IF NOT EXISTS idx_pg_record_changes_record ON record_changes(connector_instance_id, stream, record_key, version)",
      expectedFragments: ["record_changes USING btree (connector_instance_id, stream, record_key, version)"],
      name: "idx_pg_record_changes_record",
    });
    // Covers the bounded version-stats hot path: MAX(emitted_at) / COUNT grouped
    // by (connector_instance_id, stream). The record-keyed index above omits
    // emitted_at, so MAX(emitted_at) otherwise forces a per-row heap visit.
    await ensurePostgresIndexDefinition(client, {
      createSql:
        "CREATE INDEX IF NOT EXISTS idx_pg_record_changes_emitted ON record_changes(connector_instance_id, stream, emitted_at)",
      expectedFragments: ["record_changes USING btree (connector_instance_id, stream, emitted_at)"],
      name: "idx_pg_record_changes_emitted",
    });
    await ensurePostgresIndexDefinition(client, {
      createSql:
        "CREATE INDEX IF NOT EXISTS idx_pg_blob_bindings_record ON blob_bindings(connector_instance_id, stream, record_key)",
      expectedFragments: ["blob_bindings USING btree (connector_instance_id, stream, record_key)"],
      name: "idx_pg_blob_bindings_record",
    });
    await ensurePostgresIndexDefinition(client, {
      createSql:
        "CREATE INDEX IF NOT EXISTS idx_pg_semantic_search_scope ON semantic_search_blob(connector_instance_id, scope_key)",
      expectedFragments: ["semantic_search_blob USING btree (connector_instance_id, scope_key)"],
      name: "idx_pg_semantic_search_scope",
    });
  });
}

async function withPostgresAdvisoryLock(
  client: PoolClient,
  lockId: string,
  fn: () => Promise<unknown>
): Promise<unknown> {
  await client.query("SELECT pg_advisory_lock($1::bigint)", [lockId]);
  try {
    return await fn();
  } finally {
    await client.query("SELECT pg_advisory_unlock($1::bigint)", [lockId]).catch(() => {
      // The session is being released; unlock failure is intentionally ignored.
    });
  }
}

function normalizePostgresIndexDefinition(value: unknown): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function assertSafePostgresIndexName(indexName: string): void {
  if (!POSTGRES_INDEX_NAME.test(indexName)) {
    throw new Error(`unsafe postgres index name: ${indexName}`);
  }
}

interface PostgresIndexDefinition {
  definition: string;
  ready: boolean;
  valid: boolean;
}

async function readPostgresIndexDefinition(
  client: PoolClient,
  indexName: string
): Promise<PostgresIndexDefinition | null> {
  const existing = await client.query<PostgresIndexDefinition>(
    `SELECT pg_get_indexdef(idx.oid) AS definition, ix.indisvalid AS valid, ix.indisready AS ready
       FROM pg_class idx
       JOIN pg_namespace ns ON ns.oid = idx.relnamespace
       JOIN pg_index ix ON ix.indexrelid = idx.oid
      WHERE ns.nspname = current_schema()
        AND idx.relname = $1
      LIMIT 1`,
    [indexName]
  );
  return existing.rows[0] ?? null;
}

async function ensurePostgresIndexDefinition(
  client: PoolClient,
  { name, createSql, expectedFragments }: { name: string; createSql: string; expectedFragments: readonly string[] }
): Promise<void> {
  assertSafePostgresIndexName(name);
  const existing = await readPostgresIndexDefinition(client, name);
  const normalizedDefinition = normalizePostgresIndexDefinition(existing?.definition);
  const matchesExpected =
    existing?.valid === true &&
    existing?.ready === true &&
    expectedFragments.every((fragment) => normalizedDefinition.includes(normalizePostgresIndexDefinition(fragment)));

  if (matchesExpected) {
    return;
  }
  if (existing) {
    await client.query(`DROP INDEX IF EXISTS ${name}`);
  }
  await client.query(createSql);
}

async function ensurePostgresLexicalScopedGinIndex(
  client: PoolClient,
  log: StorageLog = NOOP_STORAGE_LOG
): Promise<void> {
  // This includes both the invalid-index DROP CONCURRENTLY recovery path and
  // the CREATE CONCURRENTLY path. Both execute under bootstrap's polling lock.
  const extension = await client.query("SELECT 1 FROM pg_extension WHERE extname = 'btree_gin' LIMIT 1");
  if (extension.rowCount === 0) {
    log("[PDPP] Lexical search scoped GIN index skipped: btree_gin extension is unavailable");
    return;
  }
  const existing = await client.query(
    `SELECT ix.indisvalid AS valid
       FROM pg_class idx
       JOIN pg_namespace ns ON ns.oid = idx.relnamespace
       JOIN pg_index ix ON ix.indexrelid = idx.oid
      WHERE ns.nspname = current_schema()
        AND idx.relname = 'idx_pg_lexical_search_scope_document'
      LIMIT 1`
  );
  if ((existing.rowCount ?? 0) > 0 && existing.rows[0]?.valid === true) {
    return;
  }
  if ((existing.rowCount ?? 0) > 0) {
    log("[PDPP] Lexical search migration: dropping invalid scoped GIN index before rebuild");
    await client.query("DROP INDEX CONCURRENTLY IF EXISTS idx_pg_lexical_search_scope_document");
  }

  // Existing deployments can have millions of lexical rows. Build
  // concurrently so startup does not hold a table-wide write lock while the
  // reference remains otherwise readable.
  log("[PDPP] Lexical search migration: building scoped GIN index idx_pg_lexical_search_scope_document");
  const startedAt = Date.now();
  await client.query(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pg_lexical_search_scope_document
       ON lexical_search_index
       USING GIN (connector_instance_id, stream, document)`
  );
  log(`[PDPP] Lexical search migration: scoped GIN index ready in ${Math.round((Date.now() - startedAt) / 1000)}s`);
}

/**
 * Production incident, 2026-08-18 (found chasing a5505bb59/this branch's own
 * discovery-side fix): `repairCandidatePostgres`'s per-connection canonical
 * read -- `SELECT stream, COUNT(*)::int, MAX(emitted_at) FROM records WHERE
 * connector_instance_id = $1 AND deleted = FALSE GROUP BY stream`
 * (connector-summary-evidence-engine.ts, `canonicalResult`) -- was judged
 * "legitimate, necessary, cheap" earlier in this same investigation without
 * measuring it against a real multi-million-row connection. It is not cheap:
 * measured directly against production (READ-ONLY, `EXPLAIN (ANALYZE,
 * BUFFERS)`) for the fleet's two largest connections (2.42M and 1.30M live
 * records out of 5.46M total), this query took 3.67-4.07 SECONDS each,
 * `Parallel Seq Scan`-ing ~584k buffers (~4.5 GB) -- none of `records`'
 * existing seven indexes cover `(connector_instance_id, deleted)` without a
 * `stream` predicate this GROUP-BY query cannot supply. Both connections
 * were repeatedly selected as repair candidates, cancelled by the per-unit
 * `statement_timeout` floor every pass, and left `dirty` forever: the
 * existing per-connection catch (`reasonCodeForRepairFailure`/
 * `logRepairFailure`) correctly avoids marking evidence `failed` on a
 * cancellation, but "correctly deferred, forever, on the same two rows" is
 * still an unbounded backlog, not a fix.
 *
 * REJECTED alternatives (see connector-summary-evidence-lifecycle-seq-index
 * test file's sibling investigation and this commit's message for the full
 * comparison): raising `MIN_STATEMENT_TIMEOUT_MS`, or giving repair a larger
 * bound than discovery, both re-trap on the NEXT connection to cross
 * whatever new ceiling is picked -- this query's cost is O(row count) with
 * no upper bound, so any fixed timeout is a matter of when, not if. A
 * maintained counter (`retained_size_stream.record_count`, already
 * incrementally upserted on every write) was close but rejected as the
 * primary fix: it carries no `last_updated`/`MAX(emitted_at)` column at all
 * (a schema change of its own), and its row-presence semantics differ from
 * this sparse `GROUP BY` in a way `buildRepairedRow`'s `known_zero` vs
 * `unobserved` distinction depends on -- reusing it would change repair's
 * classification logic, a larger and riskier change than closing an
 * honestly-measured index gap.
 *
 * This index closes the gap the SAME way as this table's other five
 * `connector_instance_id`-leading indexes above: `(connector_instance_id,
 * deleted, stream)` matches the query's WHERE + GROUP BY columns exactly,
 * `INCLUDE (emitted_at)` lets the MAX() aggregate read directly from the
 * index without a further heap lookup for that column. Verified directly
 * (production-representative selectivity: one connection at ~4.4% of a
 * 5.46M-row table, matching the real `cin_2de5ede05c8cc8d45935c414`/total
 * ratio, seeded and measured in a throwaway scratch database, never
 * production DDL): the SAME query plans a `Bitmap Heap Scan` off this
 * index post-VACUUM at 83.7ms, versus the 4.07s unindexed `Parallel Seq
 * Scan` measured on live production data -- and no change to
 * `canonicalResult`'s shape or `buildRepairedRow`'s consumption of it.
 *
 * SCOPE OF THAT MEASUREMENT, stated honestly: the 83.7ms figure is at ONE
 * connection holding ~4.4% of the table. This index helps in proportion to
 * how SELECTIVE the connection is, and a covering index stops being the
 * cheaper plan once a single connection owns a large fraction of `records`
 * -- past roughly a third, the planner correctly prefers a sequential scan
 * and this index will simply be ignored. That is not a defect in the index;
 * it is the point at which "read this one connection's rows" and "read the
 * whole table" converge. So this closes the gap for the fleet's normal
 * shape (many connections, each a small slice) and does NOT by itself
 * guarantee every future connection stays inside
 * `MIN_STATEMENT_TIMEOUT_MS`. A connection that grows to dominate the table
 * needs a bounded/resumable read, not a wider index or a bigger timeout.
 * Built `CONCURRENTLY` for the same reason as
 * `idx_pg_lexical_search_scope_document` above: `records` already holds
 * millions of rows in production, and a plain `CREATE INDEX` would hold a
 * table-wide write lock for the whole build.
 */
const RECORDS_CANONICAL_COUNT_INDEX_LOCK_ID = "8022352479012002";

async function ensurePostgresRecordsCanonicalCountIndex(
  client: PoolClient,
  log: StorageLog = NOOP_STORAGE_LOG
): Promise<void> {
  await withPostgresAdvisoryLock(client, RECORDS_CANONICAL_COUNT_INDEX_LOCK_ID, async () => {
    const existing = await client.query(
      `SELECT ix.indisvalid AS valid
         FROM pg_class idx
         JOIN pg_namespace ns ON ns.oid = idx.relnamespace
         JOIN pg_index ix ON ix.indexrelid = idx.oid
        WHERE ns.nspname = current_schema()
          AND idx.relname = 'idx_pg_records_canonical_count'
        LIMIT 1`
    );
    if ((existing.rowCount ?? 0) > 0 && existing.rows[0]?.valid === true) {
      return;
    }
    if ((existing.rowCount ?? 0) > 0) {
      log("[PDPP] Records migration: dropping invalid canonical-count index before rebuild");
      await client.query("DROP INDEX CONCURRENTLY IF EXISTS idx_pg_records_canonical_count");
    }

    // Existing deployments can have millions of records rows. Build
    // concurrently so startup does not hold a table-wide write lock while
    // the reference remains otherwise readable — same reasoning as
    // idx_pg_lexical_search_scope_document above.
    log("[PDPP] Records migration: building canonical-count index idx_pg_records_canonical_count");
    const startedAt = Date.now();
    await client.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pg_records_canonical_count
         ON records(connector_instance_id, deleted, stream)
         INCLUDE (emitted_at)`
    );
    log(`[PDPP] Records migration: canonical-count index ready in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  });
}

/**
 * Production incident, 2026-08-21: the owner's source-detail page took 44.5s
 * wall-clock while a Google Maps re-ingest ran concurrently. Two independent
 * defects compounded; this index closes the larger, and it closes it on BOTH
 * sides of that incident, which is the part worth stating plainly.
 *
 * The keyset-pagination shape `WHERE connector_instance_id = $1 AND stream =
 * $2 AND deleted = FALSE AND id > $3 ORDER BY id ASC LIMIT $4` had no index
 * that could serve it. `records`' seven existing indexes all lead with
 * `connector_instance_id` but none carries `id` as the column immediately
 * after the equality predicates, so none can satisfy the ORDER BY. The
 * closest, `idx_pg_records_stream_cursor`, is `(connector_instance_id,
 * stream, deleted, cursor_value, primary_key_text)` — its fourth column is
 * `cursor_value`, not `id`. The planner therefore fell back to `records_pkey`
 * (already `id`-ordered, so the sort is free) and filtered every
 * non-matching row away one at a time.
 *
 * Measured directly against production (READ-ONLY, `EXPLAIN (ANALYZE,
 * BUFFERS)`) for `cin_12407c1afb78d56848fe0b20`/`messages` — 140,689 live
 * rows in a 5.61M-row table: 27.4 SECONDS to return 50 rows, `Index Scan
 * using records_pkey`, `Rows Removed by Filter: 3,031,420`, reading 514,958
 * buffers from disk (~4 GB against a 512 MB `shared_buffers`). The row count
 * removed is the whole story: the scan must walk every row with a lower `id`
 * than the target connection's first row before it can return anything.
 *
 * This is NOT only a page-load defect. `postgresSemanticRecordsPage`
 * (postgres-search.ts) — the coverage-scan SELECT that feeds the semantic
 * backfill — issues the IDENTICAL query shape with `LIMIT 500`, and live
 * `pg_stat_activity` sampling during a real re-ingest caught it at 1.2s,
 * 1.6s, 1.9s, 7.0s, 12.2s, 17.2s, 22.3s and 27.4s on successive pages. So
 * the "bulk ingest freezes the console" symptom and the "source detail page
 * is slow" symptom were substantially the same missing index, hit from two
 * call sites — the bulk pager was not merely competing for resources, it was
 * itself running multi-second statements for the same reason. Fixing the
 * index bounds both.
 *
 * Verified in a throwaway scratch database (never production DDL), seeded to
 * production-representative shape — 3,031,420 rows belonging to other
 * connections occupying the low `id` range, then 140,689 target rows, which
 * reproduces the exact `Rows Removed by Filter: 3031420` from the live plan:
 * the `LIMIT 50` page query goes 558ms -> 0.089ms, and the `LIMIT 500` bulk
 * coverage page goes to 1.4ms, both switching to `Index Scan using
 * idx_pg_records_instance_stream_id` with all four predicates absorbed into
 * `Index Cond` and zero rows removed by filter.
 *
 * SCOPE, stated honestly: the scratch measurement's absolute numbers are
 * smaller than production's because the scratch table has narrow rows and a
 * warm cache; what transfers is the PLAN CHANGE and the elimination of
 * `Rows Removed by Filter`, not the millisecond figure. The improvement is
 * proportional to how deep the target connection's rows sit in the `id`
 * space — a connection whose rows start near `id = 0` was never slow and
 * gains little. Correspondingly, this index does not help any query that
 * cannot supply both `connector_instance_id` and `stream` as equalities.
 *
 * REDUNDANCY: none. All seven pre-existing `records` indexes show non-zero
 * `idx_scan` in `pg_stat_user_indexes` on production (lowest:
 * `idx_pg_records_semantic_time` at 2,208), so nothing is dropped here. This
 * index is additive — it does not prefix-subsume `idx_pg_records_stream_cursor`
 * (that one's `cursor_value`/`primary_key_text` tail serves a different
 * pagination) nor `idx_pg_records_canonical_count` (different column ORDER:
 * `(instance, deleted, stream)`, plus `INCLUDE (emitted_at)`).
 *
 * Built `CONCURRENTLY` for the same reason as
 * `idx_pg_records_canonical_count` above: `records` holds 5.6M rows / 4.6 GB
 * on production, and a plain `CREATE INDEX` would hold a table-wide write
 * lock for the entire build against the owner's live instance.
 */
const RECORDS_INSTANCE_STREAM_ID_INDEX_LOCK_ID = "8022352479012003";

async function ensurePostgresRecordsInstanceStreamIdIndex(
  client: PoolClient,
  log: StorageLog = NOOP_STORAGE_LOG
): Promise<void> {
  await withPostgresAdvisoryLock(client, RECORDS_INSTANCE_STREAM_ID_INDEX_LOCK_ID, async () => {
    const existing = await client.query(
      `SELECT ix.indisvalid AS valid
         FROM pg_class idx
         JOIN pg_namespace ns ON ns.oid = idx.relnamespace
         JOIN pg_index ix ON ix.indexrelid = idx.oid
        WHERE ns.nspname = current_schema()
          AND idx.relname = 'idx_pg_records_instance_stream_id'
        LIMIT 1`
    );
    if ((existing.rowCount ?? 0) > 0 && existing.rows[0]?.valid === true) {
      return;
    }
    if ((existing.rowCount ?? 0) > 0) {
      // A previous CONCURRENTLY build was interrupted. Postgres leaves the
      // index behind marked invalid, and `IF NOT EXISTS` will NOT rebuild it
      // — so the next boot would silently keep the slow plan forever. Drop
      // it (also concurrently, so this recovery path takes no write lock
      // either) and rebuild.
      log("[PDPP] Records migration: dropping invalid instance/stream/id index before rebuild");
      await client.query("DROP INDEX CONCURRENTLY IF EXISTS idx_pg_records_instance_stream_id");
    }

    log("[PDPP] Records migration: building keyset index idx_pg_records_instance_stream_id");
    const startedAt = Date.now();
    await client.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pg_records_instance_stream_id
         ON records(connector_instance_id, stream, deleted, id)`
    );
    log(`[PDPP] Records migration: keyset index ready in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  });
}

// The summary-evidence repair scans one connection across every stream. Its
// keyset predicate cannot use the stream-qualified index above because `stream`
// is not constrained, so keep the matching access path separate.
const RECORDS_INSTANCE_DELETED_ID_INDEX_LOCK_ID = "8022352479012004";

async function ensurePostgresRecordsInstanceDeletedIdIndex(
  client: PoolClient,
  log: StorageLog = NOOP_STORAGE_LOG
): Promise<void> {
  await withPostgresAdvisoryLock(client, RECORDS_INSTANCE_DELETED_ID_INDEX_LOCK_ID, async () => {
    const existing = await client.query(
      `SELECT ix.indisvalid AS valid
         FROM pg_class idx
         JOIN pg_namespace ns ON ns.oid = idx.relnamespace
         JOIN pg_index ix ON ix.indexrelid = idx.oid
        WHERE ns.nspname = current_schema()
          AND idx.relname = 'idx_pg_records_instance_deleted_id'
        LIMIT 1`
    );
    if ((existing.rowCount ?? 0) > 0 && existing.rows[0]?.valid === true) {
      return;
    }
    if ((existing.rowCount ?? 0) > 0) {
      log("[PDPP] Records migration: dropping invalid instance/deleted/id index before rebuild");
      await client.query("DROP INDEX CONCURRENTLY IF EXISTS idx_pg_records_instance_deleted_id");
    }

    log("[PDPP] Records migration: building keyset index idx_pg_records_instance_deleted_id");
    const startedAt = Date.now();
    await client.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pg_records_instance_deleted_id
         ON records(connector_instance_id, deleted, id)
         INCLUDE (stream, emitted_at)`
    );
    log(
      `[PDPP] Records migration: instance/deleted/id keyset index ready in ${Math.round((Date.now() - startedAt) / 1000)}s`
    );
  });
}

function localDeviceConnectorId(connectorId: string): string {
  return `local-device:${encodeURIComponent(connectorId)}`;
}

function legacyLocalDeviceConnectorId(connectorId: string, sourceInstanceId: string): string {
  return `${localDeviceConnectorId(connectorId)}:${encodeURIComponent(sourceInstanceId)}`;
}

async function mergeEquivalentPostgresConnectorInstances(
  client: PoolClient,
  legacyId: string,
  canonicalId: string,
  { skipDeviceSourceInstanceRewrite = false }: { skipDeviceSourceInstanceRewrite?: boolean } = {}
): Promise<void> {
  if (legacyId === canonicalId) {
    return;
  }

  const existingTables: string[] = [];
  await sequentially(PG_LEGACY_REWRITE_INSTANCE_REFERENCE_TABLES, async (table) => {
    if (skipDeviceSourceInstanceRewrite && table === "device_source_instances") {
      return;
    }
    if (await hasPostgresColumn(client, table, "connector_instance_id")) {
      existingTables.push(table);
    }
  });

  // A connector-instance id can be referenced by tables introduced after this
  // migration. Do not delete the legacy row unless every such reference is
  // either handled below or proven absent. This makes an unknown schema/data
  // combination fail closed instead of silently dropping an identity.
  const references = await client.query(
    `SELECT table_name
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND column_name = 'connector_instance_id'
        AND table_name <> 'connector_instances'`
  );
  await sequentially(references.rows, async ({ table_name: table }) => {
    if (existingTables.includes(table) || (skipDeviceSourceInstanceRewrite && table === "device_source_instances")) {
      return;
    }
    const present = await client.query(
      `SELECT 1 FROM ${pgIdentifier(table)} WHERE connector_instance_id = $1 LIMIT 1`,
      [legacyId]
    );
    if ((present.rowCount ?? 0) > 0) {
      throw new Error(
        `Cannot coalesce local-device connector instance ${legacyId} → ${canonicalId}: unhandled reference in ${table}; manual reconciliation required.`
      );
    }
  });

  await sequentially(existingTables, async (table) => {
    // These rows are derived from canonical records/manifests (or from the
    // canonical summary authorities), never an authority themselves. Keeping
    // the canonical row and dropping the legacy projection avoids a fake
    // uniqueness conflict while ensuring no stale legacy identity survives.
    // The normal index/evidence reconciliation rebuilds any omitted value.
    if (PG_REBUILDABLE_INSTANCE_REFERENCE_TABLES.has(table)) {
      await client.query(`DELETE FROM ${table} WHERE connector_instance_id = $1`, [legacyId]);
      return;
    }
    const uniqueCols = pgUniqueColumnsForLegacyRewrite(table);
    if (uniqueCols === null) {
      await client.query(`UPDATE ${table} SET connector_instance_id = $1 WHERE connector_instance_id = $2`, [
        canonicalId,
        legacyId,
      ]);
      return;
    }
    if (uniqueCols.length === 0) {
      const both = await client.query(
        `SELECT
           EXISTS(SELECT 1 FROM ${table} WHERE connector_instance_id = $1) AS legacy_present,
           EXISTS(SELECT 1 FROM ${table} WHERE connector_instance_id = $2) AS canonical_present`,
        [legacyId, canonicalId]
      );
      if (both.rows[0].legacy_present && both.rows[0].canonical_present) {
        throw new Error(
          `Cannot coalesce local-device connector instance ${legacyId} → ${canonicalId}: both ids hold a row in ${table}; manual reconciliation required.`
        );
      }
      if (both.rows[0].legacy_present) {
        await client.query(`UPDATE ${table} SET connector_instance_id = $1 WHERE connector_instance_id = $2`, [
          canonicalId,
          legacyId,
        ]);
      }
      return;
    }
    if (PG_ANY_TWO_OWNERS_TABLES.has(table)) {
      // connector_state and grant_connector_state fail closed on any
      // two-sided ownership, not only a same-stream collision: a legacy row
      // on one stream and a canonical row on a different stream are both
      // authoritative state that was never reconciled, and must not be
      // silently combined. This matches the class-level preflight above and
      // holds even if this function is ever called outside that preflight.
      const both = await client.query(
        `SELECT
           EXISTS(SELECT 1 FROM ${table} WHERE connector_instance_id = $1) AS legacy_present,
           EXISTS(SELECT 1 FROM ${table} WHERE connector_instance_id = $2) AS canonical_present`,
        [legacyId, canonicalId]
      );
      if (both.rows[0].legacy_present && both.rows[0].canonical_present) {
        throw new Error(
          `Cannot coalesce local-device connector instance ${legacyId} → ${canonicalId}: ${table} has colliding owned state; manual reconciliation required.`
        );
      }
      await client.query(`UPDATE ${table} SET connector_instance_id = $1 WHERE connector_instance_id = $2`, [
        canonicalId,
        legacyId,
      ]);
      return;
    }
    const keys = await client.query(`SELECT ${uniqueCols.join(", ")} FROM ${table} WHERE connector_instance_id = $1`, [
      legacyId,
    ]);
    await sequentially(keys.rows, async (key) => {
      const params = [canonicalId, ...uniqueCols.map((column) => key[column])];
      const where = uniqueCols.map((column, index) => `${column} IS NOT DISTINCT FROM $${index + 2}`).join(" AND ");
      const conflict = await client.query(
        `SELECT 1 FROM ${table} WHERE connector_instance_id = $1 AND ${where} LIMIT 1`,
        params
      );
      if ((conflict.rowCount ?? 0) > 0) {
        throw new Error(
          `Cannot coalesce local-device connector instance ${legacyId} → ${canonicalId}: ${table} has colliding owned state; manual reconciliation required.`
        );
      }
    });
    await client.query(`UPDATE ${table} SET connector_instance_id = $1 WHERE connector_instance_id = $2`, [
      canonicalId,
      legacyId,
    ]);
  });
  await client.query("DELETE FROM connector_instances WHERE connector_instance_id = $1", [legacyId]);
}

async function resolveLocalDeviceMigrationIdentity(
  client: PoolClient,
  row: LocalDeviceMigrationRow,
  connectorKey: string,
  oldConnectorId: string,
  sourceBinding: Record<string, string>,
  sourceBindingKey: string
): Promise<{ existingBindingInstanceId: string | null; legacyInstanceId: string | null } | null> {
  const legacyIds = await client.query<{ connector_instance_id: string }>(
    `SELECT DISTINCT connector_instance_id
       FROM (
         SELECT connector_instance_id FROM records WHERE connector_id = $1
         UNION SELECT connector_instance_id FROM connector_state WHERE connector_id = $1
         UNION SELECT connector_instance_id FROM connector_schedules WHERE connector_id = $1
         UNION SELECT connector_instance_id FROM controller_active_runs WHERE connector_id = $1
         UNION SELECT connector_instance_id FROM run_history WHERE connector_id = $1
         UNION SELECT connector_instance_id FROM scheduler_last_run_times WHERE connector_id = $1
       ) legacy_ids
      WHERE connector_instance_id IS NOT NULL
      ORDER BY connector_instance_id
      LIMIT 2`,
    [oldConnectorId]
  );
  if (legacyIds.rows.length > 1 && !row.connector_instance_id) {
    throw new Error(`Ambiguous local-device connector instance migration for ${oldConnectorId}`);
  }
  const existingBinding = await client.query<{ connector_instance_id: string }>(
    `SELECT connector_instance_id FROM connector_instances
      WHERE owner_subject_id = $1 AND connector_id = $2 AND source_kind = 'local_device'
        AND source_binding_key = $3 LIMIT 1`,
    [row.owner_subject_id, connectorKey, sourceBindingKey]
  );
  const legacyInstanceId = legacyIds.rows[0]?.connector_instance_id || null;
  const existingBindingInstanceId = existingBinding.rows[0]?.connector_instance_id || null;
  const legacyBinding = await client.query<{ connector_instance_id: string }>(
    `SELECT connector_instance_id FROM connector_instances
      WHERE owner_subject_id = $1 AND connector_id = $2 AND source_kind = 'local_device'
        AND source_binding_key <> $3 AND source_binding_json = $4::jsonb LIMIT 2`,
    [row.owner_subject_id, connectorKey, sourceBindingKey, JSON.stringify(sourceBinding)]
  );
  if (legacyBinding.rows.length > 1) {
    throw new Error(`Conflicting local-device connector instance migration for ${oldConnectorId}`);
  }
  const legacyBindingInstanceId = legacyBinding.rows[0]?.connector_instance_id || null;
  if (legacyBindingInstanceId && existingBindingInstanceId && legacyBindingInstanceId !== existingBindingInstanceId) {
    if (
      row.connector_instance_id &&
      row.connector_instance_id !== legacyBindingInstanceId &&
      row.connector_instance_id !== existingBindingInstanceId
    ) {
      throw new Error(`Conflicting local-device connector instance migration for ${oldConnectorId}`);
    }
    await mergeEquivalentPostgresConnectorInstances(client, legacyBindingInstanceId, existingBindingInstanceId);
    if (row.connector_instance_id === legacyBindingInstanceId) {
      row.connector_instance_id = existingBindingInstanceId;
    }
  }
  if (
    row.connector_instance_id &&
    existingBindingInstanceId &&
    existingBindingInstanceId !== row.connector_instance_id
  ) {
    throw new Error(`Conflicting local-device connector instance migration for ${oldConnectorId}`);
  }
  if (legacyInstanceId && existingBindingInstanceId && existingBindingInstanceId !== legacyInstanceId) {
    throw new Error(`Conflicting legacy local-device rows for ${oldConnectorId}`);
  }
  if (
    await localDeviceMigrationIsTombstoned(
      client,
      row,
      connectorKey,
      sourceBindingKey,
      existingBindingInstanceId,
      legacyInstanceId
    )
  ) {
    return null;
  }
  return { existingBindingInstanceId, legacyInstanceId };
}

async function localDeviceMigrationIsTombstoned(
  client: PoolClient,
  row: LocalDeviceMigrationRow,
  connectorKey: string,
  sourceBindingKey: string,
  existingBindingInstanceId: string | null,
  legacyInstanceId: string | null
): Promise<boolean> {
  if (row.connector_instance_id || existingBindingInstanceId || legacyInstanceId) {
    return false;
  }
  const tombstone = await client.query(
    `SELECT connector_instance_id FROM connector_instance_tombstones
      WHERE owner_subject_id = $1 AND connector_id = $2 AND source_kind = 'local_device'
        AND source_binding_key = $3 LIMIT 1`,
    [row.owner_subject_id, connectorKey, sourceBindingKey]
  );
  return tombstone.rows.length > 0;
}

/**
 * Authoritative connector-scoped tables the identity migration rewrites in
 * the SAME transaction as the identity change.
 *
 * These are not reconstructible from anything else: `record_changes` is the
 * retained change-history authority, `version_counter` is per-stream record
 * history state, `blobs`/`blob_bindings` carry payload bindings, and the
 * schedule/run tables are operator/audit state. A connector-id rewrite here
 * is safe only once the exact connector-instance identity and every
 * collision check has succeeded, so it stays inside the fail-closed
 * transaction and never becomes best-effort background work.
 */
const PG_LOCAL_DEVICE_AUTHORITATIVE_REWRITE_TABLES = [
  "connector_state",
  "grant_connector_state",
  "connector_detail_gaps",
  "records",
  "record_changes",
  "version_counter",
  "blobs",
  "blob_bindings",
  "connector_schedules",
  "controller_active_runs",
  "run_history",
  "scheduler_last_run_times",
] as const;

/**
 * Derived projection tables the identity migration deliberately does NOT
 * rewrite inline.
 *
 * Their source of truth is canonical `records` plus the registered manifest,
 * and the ordinary reconcile path already rebuilds them
 * (`search-index-reconcile.ts`). Rewriting them here was the incident: the
 * two largest tables on the deployment (24 GB `lexical_search_index`, 9.8 GB
 * `record_changes`) were both scanned before the server bound a listener,
 * because `connector_id` is only a residual filter on every instance-leading
 * index these tables have.
 *
 * A stale legacy `connector_id` here is not merely cosmetic: the semantic
 * reads in `postgres-search.ts` (`postgresListSemanticConnectorInstanceIds`,
 * `postgresListSemanticStreamsForConnector`) select BY `connector_id`, so a
 * legacy-keyed projection row is invisible to them. That is why these rows
 * are deleted rather than repointed — the same disposition
 * `mergeEquivalentPostgresConnectorInstances` already applies to
 * `PG_REBUILDABLE_INSTANCE_REFERENCE_TABLES` — and why the scope is marked
 * dirty in the identity transaction so the read surface reports the backlog
 * honestly until the rebuild lands.
 */
const PG_LOCAL_DEVICE_DERIVED_PROJECTION_TABLES = [
  "lexical_search_index",
  "lexical_search_meta",
  "semantic_search_blob",
  "semantic_search_meta",
  "semantic_search_backfill_progress",
] as const;

/**
 * Source rows committed per transaction. Small on purpose: the batch is the
 * crash-resume granularity, and each batch commits its identity writes, its
 * authoritative rewrites, its projection-repair marks, and its cursor
 * advance together. A larger batch buys nothing (the per-row work dominates)
 * and costs a longer lock hold plus more repeated work after a crash.
 */
const PG_LOCAL_DEVICE_MIGRATION_DEFAULT_BATCH_SIZE = 25;

/**
 * Batch size, overridable so a test can force observable batch boundaries.
 *
 * Batch boundaries ARE the crash-resume semantics, and at the default size a
 * small fixture fits in one batch — which would make a resume oracle assert
 * nothing. The override exists for that oracle, not as a tuning knob:
 * production leaves the variable unset and gets the default.
 */
function pgLocalDeviceMigrationBatchSize(): number {
  const raw = Number.parseInt(process.env.PDPP_LOCAL_DEVICE_MIGRATION_BATCH_SIZE ?? "", 10);
  return Number.isInteger(raw) && raw > 0 ? raw : PG_LOCAL_DEVICE_MIGRATION_DEFAULT_BATCH_SIZE;
}

const PG_LOCAL_DEVICE_MIGRATION_LEASE_MS = 15 * 60 * 1000;

export interface LocalDeviceCanonicalizationReceipt {
  /** Rows this run actually mutated, summed across authoritative tables. */
  readonly changedRows: number;
  /** Source rows this run committed. Zero on a boot that skipped the phase. */
  readonly processedSourceRows: number;
  /** Projection scopes this run enqueued for post-readiness repair. */
  readonly repairScopesEnqueued: number;
  /** `true` when a durable `complete` receipt made this boot skip the data phase. */
  readonly skippedByReceipt: boolean;
}

interface LocalDeviceRowOutcome {
  readonly changedRows: number;
  readonly repairScopes: number;
}

/**
 * Rewrite one authoritative table's legacy connector-id references for a
 * single connector instance, returning the rows actually changed.
 *
 * The `connector_id IS DISTINCT FROM $1` guard is a COST guard, not the
 * correctness mechanism — the ledger receipt is what makes the migration
 * exactly-once. It matters because the pre-guard statement issued a write
 * for every matching row on every boot even when the value was already
 * canonical, and because the returned count is the only honest way to say
 * "this run changed nothing" without inferring it from
 * `pg_stat_user_tables`.
 */
async function rewritePostgresAuthoritativeConnectorId(
  client: PoolClient,
  table: string,
  {
    connectorInstanceId,
    newConnectorId,
    oldConnectorId,
  }: {
    connectorInstanceId: string;
    newConnectorId: string;
    oldConnectorId: string;
  }
): Promise<number> {
  const result = await client.query(
    `UPDATE ${pgIdentifier(table)}
        SET connector_id = $1
      WHERE connector_id = $2
        AND connector_instance_id = $3
        AND connector_id IS DISTINCT FROM $1`,
    [newConnectorId, oldConnectorId, connectorInstanceId]
  );
  return result.rowCount ?? 0;
}

/**
 * Drop this instance's legacy-keyed projection rows and enqueue the affected
 * scopes for post-readiness rebuild.
 *
 * The streams are read from the projection tables themselves (not from
 * `records`) because a scope only needs repair if a legacy-keyed projection
 * row exists for it — enqueuing every stream the connector ever wrote would
 * hand the maintenance sweep work it does not need to do.
 *
 * Both the delete and the dirty mark run on the caller's transaction client,
 * so a rollback discards them together with the identity change. A dirty
 * mark that survived a rolled-back identity change would point the sweep at
 * a scope whose canonical identity does not exist yet.
 */
async function enqueuePostgresLocalDeviceProjectionRepair(
  client: PoolClient,
  {
    connectorInstanceId,
    newConnectorId,
    nowIso,
    oldConnectorId,
    repairConnectorInstanceId = connectorInstanceId,
  }: {
    connectorInstanceId: string;
    newConnectorId: string;
    nowIso: string;
    oldConnectorId: string;
    /** The canonical identity that owns the rebuilt projection. */
    repairConnectorInstanceId?: string;
  }
): Promise<number> {
  const scopes = new Set<string>();
  await sequentially(PG_LOCAL_DEVICE_DERIVED_PROJECTION_TABLES, async (table) => {
    if (!(await hasPostgresColumn(client, table, "connector_instance_id"))) {
      return;
    }
    // `semantic_search_blob` is keyed by scope_key, not stream. Its rows are
    // rebuilt from the same per-stream backfill as the rest, so it only
    // contributes the delete; the stream set comes from the stream-keyed
    // projections.
    if (await hasPostgresColumn(client, table, "stream")) {
      const streams = await client.query<{ stream: string }>(
        `SELECT DISTINCT stream FROM ${pgIdentifier(table)}
          WHERE connector_id = $1 AND connector_instance_id = $2`,
        [oldConnectorId, connectorInstanceId]
      );
      for (const { stream } of streams.rows) {
        scopes.add(stream);
      }
    }
    await client.query(`DELETE FROM ${pgIdentifier(table)} WHERE connector_id = $1 AND connector_instance_id = $2`, [
      oldConnectorId,
      connectorInstanceId,
    ]);
  });

  await sequentially([...scopes].sort(), async (stream) => {
    // Deliberately inlined rather than imported from
    // `stores/search-index-dirty-store.ts`: that module imports THIS one, and
    // `postgres-storage.ts` is a leaf on purpose so schema bootstrap cannot
    // be made to depend on store initialization order. The statement is a
    // verbatim copy of `markSearchIndexDirtyPostgres`, including the
    // in-statement `revision` increment that the reconcile clear CAS's on;
    // `postgres-boot-migration-resume.test.ts` asserts the two stay
    // equivalent, so a drift in either shows up as a test failure rather
    // than a silently un-reconciled scope.
    await client.query(
      `INSERT INTO search_index_dirty(connector_instance_id, connector_id, stream, dirty, marked_at, revision)
       VALUES ($1, $2, $3, 1, $4, 1)
       ON CONFLICT(connector_instance_id, stream) DO UPDATE SET
         connector_id = excluded.connector_id,
         dirty = 1,
         marked_at = excluded.marked_at,
         revision = search_index_dirty.revision + 1`,
      [repairConnectorInstanceId, newConnectorId, stream, nowIso]
    );
  });
  return scopes.size;
}

async function migratePostgresLocalDeviceConnectorRow(
  client: PoolClient,
  row: LocalDeviceMigrationRow & Record<string, unknown>
): Promise<LocalDeviceRowOutcome> {
  // The live enrollment path keys this binding by its stable collector
  // name. device_id/source_instance_id are per-enrollment facts, so using
  // them here makes a completed enrollment look like a conflicting second
  // connector instance on every later boot.
  const sourceBindingIdentity = {
    kind: "local_device",
    local_binding_name: row.local_binding_id,
  };
  const sourceBinding = {
    device_id: row.device_id,
    kind: "local_device",
    local_binding_name: row.local_binding_id,
    source_instance_id: row.source_instance_id,
  };
  const sourceBindingKey = makeConnectorInstanceSourceBindingKey(sourceBindingIdentity);
  // Relocate legacy `local-device:<id>:<source>` rows to the bare canonical
  // connector key, mirroring the SQLite migration and the live ingest/read
  // paths. Connection isolation is carried by connector_instance_id. See
  // canonicalize-connector-keys design Decision 7.
  const connectorKey = canonicalConnectorKey(row.connector_id) ?? row.connector_id;
  const newConnectorId = connectorKey;
  const oldConnectorId = legacyLocalDeviceConnectorId(row.connector_id, row.source_instance_id);

  const identity = await resolveLocalDeviceMigrationIdentity(
    client,
    row,
    connectorKey,
    oldConnectorId,
    sourceBinding,
    sourceBindingKey
  );
  if (!identity) {
    return { changedRows: 0, repairScopes: 0 };
  }
  const { existingBindingInstanceId, legacyInstanceId } = identity;

  const connectorInstanceId =
    row.connector_instance_id ||
    existingBindingInstanceId ||
    legacyInstanceId ||
    makeConnectorInstanceId(row.owner_subject_id, connectorKey, "local_device", sourceBindingKey);
  const now = new Date().toISOString();
  const manifest = {
    connector_id: connectorKey,
    display_name: (row.display_name as string) || connectorKey,
    streams: [],
  };

  await client.query(
    `INSERT INTO connectors(connector_id, manifest, created_at)
     VALUES($1, $2::jsonb, $3)
     ON CONFLICT(connector_id) DO NOTHING`,
    [connectorKey, JSON.stringify(manifest), row.created_at || now]
  );

  // Existing connector lifecycle is owner authority. The device row is
  // migration input only and may remain active after a zero-cascade revoke.
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
           source_kind = EXCLUDED.source_kind,
           source_binding_key = EXCLUDED.source_binding_key,
           source_binding_json = EXCLUDED.source_binding_json,
           updated_at = GREATEST(connector_instances.updated_at, EXCLUDED.updated_at)`,
    [
      connectorInstanceId,
      row.owner_subject_id,
      connectorKey,
      row.display_name,
      row.status === "revoked" ? "revoked" : "active",
      sourceBindingKey,
      JSON.stringify(sourceBinding),
      row.created_at,
      row.updated_at || now,
      row.status === "revoked" ? row.revoked_at || row.updated_at || now : null,
    ]
  );

  await client.query(
    `UPDATE device_source_instances
        SET connector_instance_id = $1,
            connector_id = $2,
            updated_at = CASE WHEN updated_at > $3 THEN updated_at ELSE $3 END
      WHERE device_id = $4 AND source_instance_id = $5`,
    [connectorInstanceId, connectorKey, now, row.device_id, row.source_instance_id]
  );

  let changedRows = 0;
  await sequentially(PG_LOCAL_DEVICE_AUTHORITATIVE_REWRITE_TABLES, async (table) => {
    changedRows += await rewritePostgresAuthoritativeConnectorId(client, table, {
      connectorInstanceId,
      newConnectorId,
      oldConnectorId,
    });
  });

  const repairScopes = await enqueuePostgresLocalDeviceProjectionRepair(client, {
    connectorInstanceId,
    newConnectorId,
    nowIso: now,
    oldConnectorId,
  });
  return { changedRows, repairScopes };
}

/**
 * Versioned, exactly-once, crash-resumable local-device canonicalization.
 *
 * WHAT CHANGED AND WHY (2026-08-29)
 *
 * This ran as an unconditional boot migration with no durable completion
 * marker. Every restart enumerated every `device_source_instances` row and
 * issued one `UPDATE` per row per table across 17 tables — including the
 * deployment's two largest, `lexical_search_index` (24 GB) and
 * `record_changes` (9.8 GB) — inside a single transaction that had to commit
 * before the server bound a listener. `EXPLAIN` on the production shape
 * confirmed the statements use the instance-leading primary keys with
 * `connector_id` as a residual FILTER, so an already-canonical instance still
 * walked millions of index entries to update zero rows. The whole operation
 * committed once at the end, so any later error rolled everything back and
 * the next boot repeated it from the beginning.
 *
 * The three separable defects, and the three separate fixes:
 *
 *  1. NO COMPLETION RECEIPT. The guard was table shape plus row presence, not
 *     "this migration completed." Fixed by the migration ledger
 *     (`postgres-migration-ledger.ts`): a `complete` row makes this function
 *     return without reading `device_source_instances` at all.
 *
 *  2. NO RESUME BOUNDARY. One transaction for the whole table meant a crash
 *     lost all progress. Fixed by committing per batch, with the cursor
 *     advance in the SAME transaction as the batch's writes — a cursor that
 *     committed separately would skip a batch after a crash between the two
 *     commits.
 *
 *  3. PROJECTION REWRITES ON THE READINESS PATH. Fixed by removing the
 *     derived tables from the identity transaction entirely; their stale
 *     legacy-keyed rows are dropped and the scope is enqueued to the
 *     EXISTING `search_index_dirty` queue that the post-listen maintenance
 *     sweep already drains, with the read surface already disclosing that
 *     backlog honestly (`routes/rs-read.ts`).
 *
 * Fail-closed behavior is unchanged and deliberately NOT relaxed: every
 * collision, ambiguity, and unknown-reference check in
 * `resolveLocalDeviceMigrationIdentity` /
 * `mergeEquivalentPostgresConnectorInstances` still throws, the batch rolls
 * back, and the ledger records `blocked` — never `complete`. A blocked
 * migration re-attempts on the next boot (an operator may have reconciled the
 * collision since) but can never be mistaken for a finished one.
 */
/**
 * Fail closed when two local-device `connector_instances` rows still describe
 * the same real binding and both hold owned state.
 *
 * WHY THIS SURVIVES THE COMPLETION RECEIPT
 *
 * The ledger retires the migration's ROW-REWRITING work — the multi-GB,
 * pre-listen index walks that were the incident. It must not retire the
 * safety property, and `device-enroll-postgres-admission-decoupling.test.ts`
 * ("D9: restart rejects colliding duplicate-owned state without changing
 * either identity") states that property as a per-RESTART contract, not a
 * one-time migration check. Gating the check behind the receipt regressed
 * that test, which is how the distinction surfaced.
 *
 * So the two are separated by cost, not by trust: this sentinel reads only
 * `connector_instances` (bounded by an owner's connection count, not by
 * record volume), joins it to itself on the binding identity carried in
 * `source_binding_json`, and confirms both claimants hold `connector_state`
 * before refusing. It issues no UPDATE, touches no projection, and never
 * looks at `records`, `record_changes`, or the search tables.
 *
 * The thrown message deliberately matches
 * `mergeEquivalentPostgresConnectorInstances`'s wording: an operator seeing
 * this on a converged deployment is looking at the same unresolved
 * condition, reached by a different route, and should not have to learn a
 * second vocabulary for it.
 */
async function assertNoUnresolvedPostgresLocalDeviceBindingCollision(client: PoolClient): Promise<void> {
  const collisions = await client.query<{ canonical_id: string; legacy_id: string }>(
    `SELECT canonical.connector_instance_id AS canonical_id,
            legacy.connector_instance_id    AS legacy_id
       FROM connector_instances canonical
        JOIN connector_instances legacy
         ON legacy.owner_subject_id = canonical.owner_subject_id
        AND legacy.connector_id     = canonical.connector_id
        AND legacy.source_kind      = 'local_device'
        AND legacy.source_binding_json = canonical.source_binding_json
        AND legacy.source_binding_key <> canonical.source_binding_key
        AND legacy.connector_instance_id > canonical.connector_instance_id
      WHERE canonical.source_kind = 'local_device'
        AND canonical.source_binding_json <> '{}'::jsonb
        AND EXISTS(SELECT 1 FROM connector_state WHERE connector_instance_id = canonical.connector_instance_id)
        AND EXISTS(SELECT 1 FROM connector_state WHERE connector_instance_id = legacy.connector_instance_id)
      ORDER BY canonical.connector_instance_id, legacy.connector_instance_id
      LIMIT 1`
  );
  const [collision] = collisions.rows;
  if (collision) {
    throw new Error(
      `Cannot coalesce local-device connector instance ${collision.legacy_id} → ${collision.canonical_id}: connector_state has colliding owned state; manual reconciliation required.`
    );
  }
}

interface ExactLocalDeviceBindingClass {
  readonly canonicalId: string;
  readonly connectorId: string;
  readonly connectorInstanceIds: readonly string[];
  readonly legacyIds: readonly string[];
}

interface LocalDeviceBindingCandidate {
  readonly connector_id: string;
  readonly connector_instance_id: string;
  readonly owner_subject_id: string;
  readonly source_binding_json: unknown;
  readonly source_binding_key: string;
}

/**
 * Returns the stable local-device key only for a complete enrolled binding.
 *
 * This is the same identity reduction the enrollment and migration paths use:
 * device and source ids identify an enrollment, while `local_binding_name`
 * identifies the enduring connection. Keeping it here lets the COMPLETE
 * receipt path recognize a stale full-binding key without reopening the
 * migration input table.
 */
function stablePostgresLocalDeviceBindingKey(sourceBinding: unknown): string | null {
  if (!sourceBinding || typeof sourceBinding !== "object" || Array.isArray(sourceBinding)) {
    return null;
  }
  const localBindingName = (sourceBinding as { local_binding_name?: unknown }).local_binding_name;
  if (typeof localBindingName !== "string" || localBindingName.length === 0) {
    return null;
  }
  return makeConnectorInstanceSourceBindingKey({ kind: "local_device", local_binding_name: localBindingName });
}

let postgresLocalDeviceDuplicateDiscoveryHookForTest:
  | ((bindingClass: ExactLocalDeviceBindingClass) => Promise<void> | void)
  | null = null;

/** Narrow test seam for a writer that commits after discovery but before the class locks. */
export function __setPostgresLocalDeviceDuplicateDiscoveryHookForTest(
  hook: ((bindingClass: ExactLocalDeviceBindingClass) => Promise<void> | void) | null
): void {
  postgresLocalDeviceDuplicateDiscoveryHookForTest = hook;
}

/**
 * Read the complete duplicate class rooted at one stable-key canonical id.
 *
 * A COMPLETE canonicalization receipt forbids reading
 * `device_source_instances`: it is the migration's unbounded input table.
 * The durable connector-instance binding already contains all identity facts
 * needed to recognize a post-enrollment stale full-binding key. Repeating
 * this query after the deterministic instance locks are held remains the
 * identity/source-binding revalidation boundary; it deliberately does not
 * trust a pre-transaction candidate.
 */
async function findExactPostgresLocalDeviceBindingClass(
  client: PoolClient,
  canonicalId?: string
): Promise<ExactLocalDeviceBindingClass | null> {
  const candidates = await client.query<LocalDeviceBindingCandidate>(
    `SELECT connector_instance_id, owner_subject_id, connector_id, source_binding_key, source_binding_json
       FROM connector_instances
      WHERE source_kind = 'local_device'
        AND source_binding_json <> '{}'::jsonb
        ${canonicalId ? "AND connector_instance_id = $1" : ""}
      ORDER BY connector_instance_id`,
    canonicalId ? [canonicalId] : []
  );
  for (const canonical of candidates.rows) {
    const stableKey = stablePostgresLocalDeviceBindingKey(canonical.source_binding_json);
    if (stableKey === null || canonical.source_binding_key !== stableKey) {
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: candidate iteration stops at the first stable duplicate class; serial queries keep its identity selection deterministic.
    const legacy = await client.query<{ connector_instance_id: string }>(
      `SELECT connector_instance_id
         FROM connector_instances
        WHERE owner_subject_id = $1
          AND connector_id = $2
          AND source_kind = 'local_device'
          AND source_binding_json = $3::jsonb
          AND source_binding_key <> $4
          AND connector_instance_id <> $5
        ORDER BY connector_instance_id`,
      [
        canonical.owner_subject_id,
        canonical.connector_id,
        stableJson(canonical.source_binding_json),
        canonical.source_binding_key,
        canonical.connector_instance_id,
      ]
    );
    if (legacy.rows.length > 0) {
      const legacyIds = legacy.rows.map((row) => row.connector_instance_id);
      return {
        canonicalId: canonical.connector_instance_id,
        connectorId: canonical.connector_id,
        connectorInstanceIds: [canonical.connector_instance_id, ...legacyIds].sort(),
        legacyIds,
      };
    }
  }
  return null;
}

async function assertPostgresConnectorInstanceClassCanMerge(
  client: PoolClient,
  bindingClass: ExactLocalDeviceBindingClass
): Promise<void> {
  const existingTables: string[] = [];
  await sequentially(PG_LEGACY_REWRITE_INSTANCE_REFERENCE_TABLES, async (table) => {
    if (await hasPostgresColumn(client, table, "connector_instance_id")) {
      existingTables.push(table);
    }
  });

  const references = await client.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND column_name = 'connector_instance_id'
        AND table_name <> 'connector_instances'`
  );
  await sequentially(references.rows, async ({ table_name: table }) => {
    if (existingTables.includes(table)) {
      return;
    }
    const present = await client.query(
      `SELECT 1 FROM ${pgIdentifier(table)} WHERE connector_instance_id = ANY($1::text[]) LIMIT 1`,
      [bindingClass.legacyIds]
    );
    if ((present.rowCount ?? 0) > 0) {
      throw new Error(
        `Cannot coalesce local-device connector instance class ${bindingClass.canonicalId}: unhandled reference in ${table}; manual reconciliation required.`
      );
    }
  });

  await sequentially(existingTables, async (table) => {
    if (PG_REBUILDABLE_INSTANCE_REFERENCE_TABLES.has(table)) {
      return;
    }
    const uniqueCols = pgUniqueColumnsForLegacyRewrite(table);
    if (uniqueCols === null) {
      return;
    }
    if (uniqueCols.length === 0 || PG_ANY_TWO_OWNERS_TABLES.has(table)) {
      // Some tables (singleton rows, or connector_state/grant_connector_state
      // by policy below) must never have two class members each own an
      // authoritative row, even when their per-key columns differ. A
      // same-stream-only collision check would let a legacy row on stream A
      // and a canonical row on stream B both survive the preflight, then
      // silently combine two independently owned state histories that were
      // never reconciled. Fail closed on any two-sided ownership instead.
      const owners = await client.query<{ count: string }>(
        `SELECT count(DISTINCT connector_instance_id)::text AS count
           FROM ${pgIdentifier(table)}
          WHERE connector_instance_id = ANY($1::text[])`,
        [bindingClass.connectorInstanceIds]
      );
      if (Number(owners.rows[0]?.count ?? 0) > 1) {
        throw new Error(
          `Cannot coalesce local-device connector instance ${bindingClass.legacyIds[0]} → ${bindingClass.canonicalId}: ${table} has colliding owned state; manual reconciliation required.`
        );
      }
      return;
    }
    const collision = await client.query(
      `SELECT 1
         FROM ${pgIdentifier(table)}
        WHERE connector_instance_id = ANY($1::text[])
        GROUP BY ${uniqueCols.join(", ")}
       HAVING count(DISTINCT connector_instance_id) > 1
        LIMIT 1`,
      [bindingClass.connectorInstanceIds]
    );
    if ((collision.rowCount ?? 0) > 0) {
      throw new Error(
        `Cannot coalesce local-device connector instance ${bindingClass.legacyIds[0]} → ${bindingClass.canonicalId}: ${table} has colliding owned state; manual reconciliation required.`
      );
    }
  });
}

/**
 * Coalesce an exact post-enrollment legacy/stable duplicate after the
 * canonicalization receipt is complete. A complete equivalence class is
 * locked, revalidated, preflighted, and merged in one transaction. If a
 * supported writer changes the class after discovery, this loop either sees
 * that newer shape before mutation or rolls back and retries from scratch.
 */
async function coalesceExactPostgresLocalDeviceBindingDuplicates(client: PoolClient): Promise<number> {
  let repairScopesEnqueued = 0;
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: each completed class changes the next class discovery and must commit independently.
    const discovered = await findExactPostgresLocalDeviceBindingClass(client);
    if (!discovered) {
      return repairScopesEnqueued;
    }
    await postgresLocalDeviceDuplicateDiscoveryHookForTest?.(discovered);

    await client.query("BEGIN");
    try {
      await acquireConnectorInstanceXactLocks(client, discovered.connectorInstanceIds);
      const revalidated = await findExactPostgresLocalDeviceBindingClass(client, discovered.canonicalId);
      if (
        !revalidated ||
        revalidated.connectorInstanceIds.length !== discovered.connectorInstanceIds.length ||
        revalidated.connectorInstanceIds.some((id, index) => id !== discovered.connectorInstanceIds[index])
      ) {
        await client.query("ROLLBACK");
        continue;
      }
      await assertPostgresConnectorInstanceClassCanMerge(client, revalidated);
      for (const legacyId of revalidated.legacyIds) {
        // biome-ignore lint/performance/noAwaitInLoops: each generic merger operates on the same locked class transaction.
        repairScopesEnqueued += await enqueuePostgresLocalDeviceProjectionRepair(client, {
          connectorInstanceId: legacyId,
          newConnectorId: revalidated.connectorId,
          nowIso: new Date().toISOString(),
          oldConnectorId: revalidated.connectorId,
          repairConnectorInstanceId: revalidated.canonicalId,
        });
        // A COMPLETE receipt is the authority that the source table already
        // points at the stable identity. This branch may not even inspect
        // that unbounded migration input; ordinary/blocked/resume claims use
        // the default path above and keep its source-row rewrite intact.
        await mergeEquivalentPostgresConnectorInstances(client, legacyId, revalidated.canonicalId, {
          skipDeviceSourceInstanceRewrite: true,
        });
      }
      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Rollback failure must not hide the coalescence failure.
      }
      throw err;
    }
  }
}

async function migratePostgresLocalDeviceConnectorInstances(
  client: PoolClient,
  { log = NOOP_STORAGE_LOG }: { log?: StorageLog } = {}
): Promise<LocalDeviceCanonicalizationReceipt> {
  const skipped: LocalDeviceCanonicalizationReceipt = {
    changedRows: 0,
    processedSourceRows: 0,
    repairScopesEnqueued: 0,
    skippedByReceipt: true,
  };

  const claim = await claimPostgresMigration(client, LOCAL_DEVICE_CANONICALIZATION_MIGRATION_ID, {
    leaseDurationMs: PG_LOCAL_DEVICE_MIGRATION_LEASE_MS,
    leaseOwner: `${process.pid}@${POSTGRES_MIGRATION_LEASE_OWNER_NONCE}`,
    nowIso: new Date().toISOString(),
  });
  if (!claim) {
    // The receipt retires the historical row scan, not exact identities
    // created after it completed. Reject conflicting state first, then merge
    // only exact one-sided duplicates through the existing fail-closed path.
    await assertNoUnresolvedPostgresLocalDeviceBindingCollision(client);
    return {
      ...skipped,
      repairScopesEnqueued: await coalesceExactPostgresLocalDeviceBindingDuplicates(client),
    };
  }

  let { cursor } = claim;
  let changedRows = 0;
  let processedSourceRows = 0;
  let repairScopesEnqueued = 0;

  for (;;) {
    // Keyset page over the SAME total order the cursor records, so a resumed
    // boot re-reads exactly the rows the previous boot did not commit. Read
    // outside the transaction: a page that turns out to be empty must not
    // leave an open transaction behind, and every row it returns is
    // re-validated by the fail-closed identity resolution inside the
    // transaction anyway.
    //
    // The ordering key changed from `(created_at, source_instance_id)` to
    // `source_instance_id` alone. A keyset cursor needs a UNIQUE, stable,
    // never-rewritten column, and `source_instance_id` is the table's
    // primary key while `created_at` is a mutable text timestamp that would
    // make the resume boundary ambiguous. The previous order carried no
    // semantics: each source row's canonicalization is independent, and
    // every cross-row interaction (coalescence, collision, tombstone) is
    // resolved by `resolveLocalDeviceMigrationIdentity` from the DATA, not
    // from the position a row happens to occupy in the scan.
    // biome-ignore lint/performance/noAwaitInLoops: Batches are sequential by contract — each page's cursor is only valid after the previous page committed, and concurrency here would defeat the resume boundary.
    const page = await client.query<LocalDeviceMigrationRow & Record<string, unknown>>(
      `SELECT
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
       WHERE $1::text IS NULL OR dsi.source_instance_id > $1::text
       ORDER BY dsi.source_instance_id
       LIMIT $2`,
      [cursor, pgLocalDeviceMigrationBatchSize()]
    );
    if (page.rows.length === 0) {
      break;
    }

    await client.query("BEGIN");
    try {
      let batchChangedRows = 0;
      let batchRepairScopes = 0;
      await sequentially(page.rows, async (row) => {
        const outcome = await migratePostgresLocalDeviceConnectorRow(client, row);
        batchChangedRows += outcome.changedRows;
        batchRepairScopes += outcome.repairScopes;
      });
      const batchCursor = String(page.rows.at(-1)?.source_instance_id);
      // Same transaction as the batch's writes. See the function doc: a
      // cursor that commits separately is not a resume boundary.
      await advancePostgresMigrationCursor(client, LOCAL_DEVICE_CANONICALIZATION_MIGRATION_ID, {
        changedRows: batchChangedRows,
        cursor: batchCursor,
        nowIso: new Date().toISOString(),
      });
      await client.query("COMMIT");
      cursor = batchCursor;
      changedRows += batchChangedRows;
      processedSourceRows += page.rows.length;
      repairScopesEnqueued += batchRepairScopes;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Rollback failure must not hide the original migration error.
      }
      // `blocked` is written on its own connection state AFTER the rollback,
      // so the receipt survives the discarded batch. It is never `complete`:
      // a fail-closed stop must not let a later boot skip the data phase.
      try {
        await blockPostgresMigration(client, LOCAL_DEVICE_CANONICALIZATION_MIGRATION_ID, {
          error: err instanceof Error ? err.message : String(err),
          nowIso: new Date().toISOString(),
        });
      } catch {
        // A ledger write failure must not hide the original migration error.
      }
      throw err;
    }
  }

  await completePostgresMigration(client, LOCAL_DEVICE_CANONICALIZATION_MIGRATION_ID, {
    nowIso: new Date().toISOString(),
  });
  if (processedSourceRows > 0) {
    log(
      `[PDPP] Local-device canonicalization: ${processedSourceRows} source rows, ${changedRows} authoritative rows changed, ${repairScopesEnqueued} projection scopes queued for post-readiness repair`
    );
  }
  return { changedRows, processedSourceRows, repairScopesEnqueued, skippedByReceipt: false };
}

/**
 * Read-only view of the local-device canonicalization receipt, for the boot
 * path and for tests that must assert a second boot skipped the data phase
 * without inferring it from timing.
 */
export async function readPostgresLocalDeviceCanonicalizationReceipt(): Promise<{
  attemptCount: number;
  changedRows: number;
  cursor: string | null;
  lastError: string | null;
  status: string;
} | null> {
  const client = await getPostgresPool().connect();
  try {
    const row = await readPostgresMigrationLedgerRow(client, LOCAL_DEVICE_CANONICALIZATION_MIGRATION_ID);
    return row
      ? {
          attemptCount: row.attemptCount,
          changedRows: row.changedRows,
          cursor: row.cursor,
          lastError: row.lastError,
          status: row.status,
        }
      : null;
  } finally {
    client.release();
  }
}

const PG_LEGACY_REWRITE_INSTANCE_REFERENCE_TABLES = [
  "connector_instance_credentials",
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
  "run_history",
  "scheduler_last_run_times",
  "device_source_instances",
];

// Derived projections are deliberately not merged value-by-value when both
// identities hold rows: their source-of-truth is canonical storage, and a
// value-level merge would preserve stale legacy indexes/evidence. All other
// tables remain authoritative or operator/audit state and fail closed on a
// uniqueness collision in mergeEquivalentPostgresConnectorInstances.
const PG_REBUILDABLE_INSTANCE_REFERENCE_TABLES = new Set([
  "lexical_search_index",
  "lexical_search_meta",
  "semantic_search_rowid",
  "semantic_search_blob",
  "semantic_search_meta",
  "semantic_search_backfill_progress",
  "connector_summary_evidence",
]);

// connector_state and grant_connector_state are keyed per-stream, but a
// same-stream-only collision check is not sufficient: a legacy identity can
// authoritatively own state for one stream while a live writer commits new
// state for a different stream on the canonical identity between discovery
// and lock acquisition. Both sides then own part of the class's state, on
// different streams, and a stream-keyed rewrite would silently combine two
// state histories that were never reconciled. Treat any two-sided ownership
// in these two tables as a fail-closed collision, exactly like the singleton
// tables above, regardless of which streams are involved.
const PG_ANY_TWO_OWNERS_TABLES = new Set(["connector_state", "grant_connector_state"]);

function pgUniqueColumnsForLegacyRewrite(table: string): readonly string[] | null {
  switch (table) {
    case "connector_instance_credentials":
      return [];
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

function pgIdentifier(identifier: string): string {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

async function migratePostgresLegacyConnectorInstancesToDefaultAccount(client: PoolClient): Promise<void> {
  await client.query("BEGIN");
  try {
    // Relax/replace the source_kind CHECK constraint inside the same
    // transaction as the rewrite. A failed rewrite must not leave schema
    // DDL advanced while data remains unmigrated.
    const checkInfo = await client.query(
      `SELECT conname
         FROM pg_constraint
        WHERE conrelid = 'connector_instances'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%source_kind%'`
    );
    await sequentially(checkInfo.rows, async (row) => {
      await client.query(`ALTER TABLE connector_instances DROP CONSTRAINT IF EXISTS ${pgIdentifier(row.conname)}`);
    });
    await client.query(
      `ALTER TABLE connector_instances
         ADD CONSTRAINT connector_instances_source_kind_check
         CHECK (source_kind IN ('account', 'local_device', 'browser_collector', 'manual'))
         NOT VALID`
    );

    const legacyRows = await client.query(
      `SELECT connector_instance_id, owner_subject_id, connector_id, display_name, status, created_at, updated_at, revoked_at
         FROM connector_instances
        WHERE source_kind = 'legacy'
        ORDER BY connector_instance_id`
    );

    // Determine which referencing tables actually have a connector_instance_id column.
    const existingTables: string[] = [];
    await sequentially(PG_LEGACY_REWRITE_INSTANCE_REFERENCE_TABLES, async (table) => {
      if (await hasPostgresColumn(client, table, "connector_instance_id")) {
        existingTables.push(table);
      }
    });

    await sequentially(legacyRows.rows, async (legacy) => {
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
        [legacy.owner_subject_id, legacy.connector_id]
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
            ['{"kind":"default_account"}', now, oldId]
          );
          return;
        }
        const conflict = await client.query(
          "SELECT 1 FROM connector_instances WHERE connector_instance_id = $1 LIMIT 1",
          [newId]
        );
        if ((conflict.rowCount ?? 0) > 0) {
          throw new Error(
            `Cannot migrate legacy connector_instance ${oldId} → ${newId}: destination id already exists for a non-default-account row.`
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
          [newId, '{"kind":"default_account"}', now, oldId]
        );
        await sequentially(existingTables, async (table) => {
          await client.query(`UPDATE ${table} SET connector_instance_id = $1 WHERE connector_instance_id = $2`, [
            newId,
            oldId,
          ]);
        });
        return;
      }

      const destId = dest.rows[0].connector_instance_id;
      await sequentially(existingTables, async (table) => {
        const uniqueCols = pgUniqueColumnsForLegacyRewrite(table);
        if (uniqueCols === null) {
          await client.query(`UPDATE ${table} SET connector_instance_id = $1 WHERE connector_instance_id = $2`, [
            destId,
            oldId,
          ]);
          return;
        }
        if (uniqueCols.length === 0) {
          const both = await client.query(
            `SELECT
               EXISTS(SELECT 1 FROM ${table} WHERE connector_instance_id = $1) AS legacy_present,
               EXISTS(SELECT 1 FROM ${table} WHERE connector_instance_id = $2) AS dest_present`,
            [oldId, destId]
          );
          if (both.rows[0].legacy_present && both.rows[0].dest_present) {
            throw new Error(
              `Cannot migrate legacy connector_instance ${oldId} → ${destId}: both ids hold a row in ${table} keyed solely on connector_instance_id; manual reconciliation required.`
            );
          }
          if (both.rows[0].legacy_present) {
            await client.query(`UPDATE ${table} SET connector_instance_id = $1 WHERE connector_instance_id = $2`, [
              destId,
              oldId,
            ]);
          }
          return;
        }
        const keys = await client.query(
          `SELECT ${uniqueCols.join(", ")} FROM ${table} WHERE connector_instance_id = $1`,
          [oldId]
        );
        await sequentially(keys.rows, async (k) => {
          const params = [destId, ...uniqueCols.map((c) => k[c])];
          const whereClause = uniqueCols.map((c, i) => `${c} IS NOT DISTINCT FROM $${i + 2}`).join(" AND ");
          const conflict = await client.query(
            `SELECT 1 FROM ${table}
              WHERE connector_instance_id = $1 AND ${whereClause}
              LIMIT 1`,
            params
          );
          if ((conflict.rowCount ?? 0) > 0) {
            throw new Error(
              `Cannot migrate legacy connector_instance ${oldId} → ${destId}: ${table} has a colliding row on (${uniqueCols.join(", ")}) = (${uniqueCols.map((c) => k[c]).join(", ")}); manual reconciliation required.`
            );
          }
        });
        await client.query(`UPDATE ${table} SET connector_instance_id = $1 WHERE connector_instance_id = $2`, [
          destId,
          oldId,
        ]);
      });
      await client.query("DELETE FROM connector_instances WHERE connector_instance_id = $1", [oldId]);
    });
    await client.query("ALTER TABLE connector_instances VALIDATE CONSTRAINT connector_instances_source_kind_check");
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

// Widen the source_kind CHECK to admit `browser_collector` alongside the
// existing account/local_device/manual kinds. Idempotent: no-op once the
// constraint already names `browser_collector`. A database created or last
// migrated before the browser-collector enrollment primitive carries the
// narrower CHECK; without this a `browser_collector` enrollment would be
// rejected by the constraint. See add-browser-collector-enrollment-primitive.
async function migratePostgresConnectorInstancesSourceKindBrowserCollector(client: PoolClient): Promise<void> {
  const checkInfo = await client.query(
    `SELECT conname, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conrelid = 'connector_instances'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) ILIKE '%source_kind%'`
  );
  const alreadyWidened = checkInfo.rows.some((row) => String(row.def).includes("browser_collector"));
  if (alreadyWidened) {
    return;
  }
  await client.query("BEGIN");
  try {
    await sequentially(checkInfo.rows, async (row) => {
      await client.query(`ALTER TABLE connector_instances DROP CONSTRAINT IF EXISTS ${pgIdentifier(row.conname)}`);
    });
    await client.query(
      `ALTER TABLE connector_instances
         ADD CONSTRAINT connector_instances_source_kind_check
         CHECK (source_kind IN ('account', 'local_device', 'browser_collector', 'manual'))`
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
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
async function migratePostgresSpineSourceColumns(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE spine_events
      ADD COLUMN IF NOT EXISTS source_kind TEXT,
      ADD COLUMN IF NOT EXISTS source_id TEXT
  `);

  if (await hasPostgresColumn(client, "spine_events", "provider_id")) {
    await client.query("ALTER TABLE spine_events DROP COLUMN provider_id");
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
async function migratePostgresBlobBindingsJsonPath(client: PoolClient): Promise<void> {
  const hasJsonPath = await hasPostgresColumn(client, "blob_bindings", "json_path");
  if (hasJsonPath) {
    // Even if the column exists, make sure the sha256 unique index is in
    // place (cheap idempotent step).
    await client.query("CREATE UNIQUE INDEX IF NOT EXISTS uniq_blobs_sha256 ON blobs(sha256)");
    return;
  }

  await client.query("BEGIN");
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
    await client.query("CREATE UNIQUE INDEX IF NOT EXISTS uniq_blobs_sha256 ON blobs(sha256)");

    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Optional cleanup is fail-open during additive migration.
    }
    throw err;
  }
}

async function migratePostgresManifestWriteViolations(client: PoolClient): Promise<void> {
  const column = await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'manifest_write_violations'
        AND column_name = 'manifest_fingerprint'`
  );
  if (column.rowCount === 0) {
    return;
  }
  await client.query("BEGIN");
  try {
    // A legacy NOT NULL `manifest_fingerprint` column cannot coexist with the
    // generation-keyed writer: keeping it would make every current write fail
    // even after adding the new primary-key column. Rebuild the small
    // provenance table so its schema, not merely its primary key, expresses
    // the durable-generation contract.
    await client.query("ALTER TABLE manifest_write_violations RENAME TO manifest_write_violations_legacy_generation");
    await client.query(`CREATE TABLE manifest_write_violations (
      connector_instance_id TEXT NOT NULL,
      stream TEXT NOT NULL,
      manifest_generation BIGINT NOT NULL,
      provenance TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      PRIMARY KEY(connector_instance_id, stream, manifest_generation)
    )`);
    await client.query(`INSERT INTO manifest_write_violations(
      connector_instance_id, stream, manifest_generation, provenance, observed_at
    )
    SELECT connector_instance_id, stream,
           -ROW_NUMBER() OVER (PARTITION BY connector_instance_id, stream ORDER BY observed_at, manifest_fingerprint),
           provenance, observed_at
      FROM manifest_write_violations_legacy_generation`);
    await client.query("DROP TABLE manifest_write_violations_legacy_generation");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function migratePostgresDeviceExporterColumns(client: PoolClient): Promise<void> {
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
      ADD COLUMN IF NOT EXISTS display_name TEXT,
      ADD COLUMN IF NOT EXISTS collection_scope_json JSONB
  `);
  await client.query(`
    ALTER TABLE device_source_instances
      ADD COLUMN IF NOT EXISTS connector_instance_id TEXT,
      ADD COLUMN IF NOT EXISTS source_kind TEXT,
      ADD COLUMN IF NOT EXISTS last_error_json JSONB,
      ADD COLUMN IF NOT EXISTS last_heartbeat_at TEXT,
      ADD COLUMN IF NOT EXISTS last_heartbeat_status TEXT,
      ADD COLUMN IF NOT EXISTS records_pending INTEGER,
      ADD COLUMN IF NOT EXISTS outbox_diagnostics_json JSONB,
      ADD COLUMN IF NOT EXISTS manifest_generation BIGINT
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
