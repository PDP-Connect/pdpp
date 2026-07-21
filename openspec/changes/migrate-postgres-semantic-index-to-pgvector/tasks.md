# Tasks — migrate-postgres-semantic-index-to-pgvector

## 1. Spec delta

- [x] Add the `reference-implementation-architecture` requirement for
  pgvector-backed semantic embedding storage on the Postgres backend
  (vector representation, database-side cosine distance, boot migration,
  unchanged retrieval semantics, JSONB fallback when the extension is absent).
- [x] `openspec validate migrate-postgres-semantic-index-to-pgvector --strict`.

## 2. Schema + boot migration (`postgres-storage.js`)

- [x] Probe the `vector` extension at bootstrap (existing `CREATE EXTENSION IF
  NOT EXISTS vector` attempt, then `pg_extension` check) and cache the
  semantic embedding mode (`jsonb` | `vector`) plus the
  `hnsw.iterative_scan` capability, reset on init/close.
- [x] Add `migratePostgresSemanticEmbeddingToVector` in the existing
  boot-migration style: detect the JSONB `embedding` column, drop
  non-castable rows (logged), add `embedding_vec vector`, backfill in bounded
  batches (default 50k, `PDPP_PG_SEMANTIC_MIGRATION_BATCH_SIZE` override) with
  progress logging, swap columns in one transaction, set NOT NULL.
- [x] Build the partial expression HNSW index
  (`(embedding::vector(384)) vector_cosine_ops WHERE vector_dims(embedding) = 384`)
  with `CREATE INDEX IF NOT EXISTS`, raising `maintenance_work_mem` for the
  session (default 256MB, `PDPP_PG_SEMANTIC_INDEX_MAINTENANCE_WORK_MEM`
  override) and resetting it after. Build serially
  (`max_parallel_maintenance_workers = 0`): parallel HNSW builds need
  `/dev/shm` ≥ `maintenance_work_mem` and die in default containers
  (`could not resize shared memory segment`, reproduced on
  pgvector/pgvector:pg16).
- [x] Thread an optional `{ log }` through
  `initPostgresStorage`/`bootstrapPostgresSchema` (no-op default) and pass the
  startup logger from `server/index.js`.

## 3. Read/write path (`postgres-search.js`)

- [x] `postgresSemanticIndexUpsertMany`: insert `$n::vector` literals in vector
  mode (`$n::jsonb` unchanged in fallback mode); skip empty vectors in vector
  mode.
- [x] `postgresSemanticSearch` (vector mode): `ORDER BY embedding::vector(d)
  <=> $q::vector(d) LIMIT k` with the existing
  `connector_instance_id`/`scope_key`/`record_key` scoping plus
  `vector_dims(embedding) = d`; transaction-scoped `SET LOCAL hnsw.ef_search`
  and `hnsw.iterative_scan = strict_order` (when supported); map `NaN →
  Infinity`; re-sort ties in JS under the existing total order. JSONB
  brute-force path retained verbatim for fallback mode.

## 4. Tests (`test/postgres-semantic-pgvector.test.js`, gated on `PDPP_TEST_POSTGRES_URL`)

- [x] Boot migration on a seeded legacy-JSONB-shape table (scratch schema):
  column becomes `vector`, row count and values preserved, batched backfill
  exercised (batch override), HNSW index present, NOT NULL restored.
- [x] Resume safety: a manufactured half-migrated state (partial
  `embedding_vec` backfill) completes on the next bootstrap.
- [x] Query parity: ordering and `distance` values from the pgvector path match
  a JS brute-force replica on a small fixture (within 1e-5), including
  scope-key scoping and `recordKeys` filtering.
- [x] Mixed-dimension coexistence: rows of different dimensions in the shared
  table do not interfere (each query sees only its own dimension).
- [x] Existing Postgres suites stay green: `postgres-runtime-storage`,
  `semantic-index-state-postgres-routing`, `connector-instances-acceptance`,
  `postgres-records-ingest-noop`, plus SQLite `semantic-retrieval`,
  `hybrid-retrieval`, `lexical-retrieval` suites.

## 5. Quality gates

- [x] Biome/ultracite clean on touched files.
- [x] `openspec validate migrate-postgres-semantic-index-to-pgvector --strict`.

## 6. Live rollout (owner)

- [ ] Schedule the boot migration for the live deployment (~1.85M rows:
  batched backfill minutes, HNSW build tens of minutes; server does not serve
  until complete; interruption-safe).
- [ ] After migration, confirm semantic search results and reclaim the dropped
  JSONB column's space via routine vacuum (or `pg_repack`/`VACUUM FULL` in a
  window).
