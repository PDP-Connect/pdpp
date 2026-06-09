# Design — migrate-postgres-semantic-index-to-pgvector

## Context

`semantic_search_blob` on the Postgres backend stores one embedding per
`(connector_instance_id, scope_key, record_key)` as a JSONB float array.
`postgresSemanticSearch` SELECTs candidate rows (bare `LIMIT`, no ordering),
parses each JSONB array, and computes cosine distance in JS, then sorts and
slices. The live deployment runs `pgvector/pgvector:pg16` (extension available,
unused) with ~1.85M rows / ~10 GB in this table.

Constraints discovered in the codebase:

- **Mixed dimensions are load-bearing in tests.** `makeStubBackend` defaults to
  64 dims; `postgres-runtime-storage.test.js` uses 8; the production profiles
  use 384. Test files run with file-level parallelism against one shared
  `PDPP_TEST_POSTGRES_URL` database, so a hard `vector(384)` column (or any
  global retype-on-write) would let one suite break another.
- **pgvector is documented as optional** in `bootstrapPostgresSchema` (the
  `CREATE EXTENSION` attempt is already wrapped in try/catch). Plain-postgres
  dev databases must keep working.
- **`distance` is the score contract.** `search-semantic.js` consumes
  `hit.distance` (cosine distance, `1 − similarity`) for merging, collapsing,
  and total-order comparison (`compareHits`: distance, connector_id,
  connector_instance_id, scope_key, record_key). No public numeric score is
  exposed (semantic-retrieval spec forbids one), so equivalence is internal.
- **`semantic_search_blob` is derived** for `scripts/migrate-storage` (never
  copied, rebuilt by the runtime), so the column type is free to change.

## Decision 1: dimension-untyped `vector` column + partial expression HNSW index

The column becomes `embedding vector` (no typmod). The ANN index is pgvector's
documented pattern for that shape:

```sql
CREATE INDEX idx_pg_semantic_search_embedding_hnsw
  ON semantic_search_blob
  USING hnsw ((embedding::vector(384)) vector_cosine_ops)
  WHERE (vector_dims(embedding) = 384);
```

- 384 is the production embedding profile dimension (`search-semantic.js`
  profiles); rows of other dimensions (test stubs) simply fall outside the
  partial index and are scanned exactly.
- Mixed-dimension rows coexist without global DDL churn, preserving today's
  parallel-test safety and leaving rebuild-on-model-change to the existing
  backend-identity drift machinery (`semantic_search_meta` /
  `semantic_search_backfill_progress`), exactly as on SQLite.
- Verified against `pgvector/pgvector:pg16` (0.8.2): mixed-dims inserts into an
  untyped column, the partial expression HNSW build, and post-index
  mixed-dims inserts all work.

Rejected alternatives:
- `vector(384)` typed column: breaks every non-384 stub-backend test and turns
  the column type into cross-test shared mutable state.
- Dynamic retype-on-write (mirroring sqlite-vec's drop-and-recreate): racy
  under file-parallel tests sharing one database.

## Decision 2: query shape and score equivalence

```sql
SELECT connector_id, connector_instance_id, scope_key, record_key,
       (embedding::vector(d) <=> $q::vector(d))::float8 AS distance
  FROM semantic_search_blob
 WHERE connector_instance_id = $1
   AND scope_key = ANY($2::text[])
   AND vector_dims(embedding) = d
   [AND record_key = ANY($n::text[])]
 ORDER BY embedding::vector(d) <=> $q::vector(d)
 LIMIT k
```

- `d` is the query vector's length, validated as a small positive integer
  before interpolation (typmods cannot be bound parameters). When `d = 384`
  the expression matches the partial index; otherwise the plan is an exact
  filtered scan.
- `<=>` is cosine distance — numerically the same quantity the JS
  `cosineDistance` returned (`1 − dot/(|a||b|)`), so downstream
  thresholds/merging see equivalent values (float32 vs float64 rounding noise
  of ~1e-7 aside, which tests bound at 1e-5).
- Secondary tie-break keys stay **out** of the SQL `ORDER BY` (they would
  disqualify the ANN index); the ≤k returned rows are re-sorted in JS under the
  same total order as before.
- Zero-magnitude embeddings: pgvector yields `NaN` where JS yielded
  `Infinity`; the row mapper normalizes `NaN → Infinity` for parity.
- The transaction wrapper issues `SET LOCAL hnsw.ef_search =
  clamp(limit, 40, 1000)` (default 40 would silently cap a 200-row overscan)
  and, when supported (pgvector ≥ 0.8, probed once at bootstrap),
  `SET LOCAL hnsw.iterative_scan = strict_order` so scope/record-key filtered
  index scans keep exact distance order and do not under-return.
- Note: this is strictly *more* correct than the previous Postgres path, whose
  candidate SELECT applied `LIMIT` before any ordering.

## Decision 3: boot migration, resume-safe and idempotent

State machine keyed on the `embedding` column's `udt_name`:

1. No `vector` extension → leave JSONB, mode = `jsonb` (fallback path
   unchanged).
2. `udt_name = 'vector'` → ensure the HNSW index exists, mode = `vector`.
3. `udt_name = 'jsonb'` → migrate:
   - delete non-castable garbage rows (`jsonb_typeof <> 'array'` or arrays
     containing `null`) — derived data, rebuilt by the existing backfill
     machinery; count logged;
   - `ADD COLUMN IF NOT EXISTS embedding_vec vector`;
   - loop: `UPDATE … SET embedding_vec = (embedding::text)::vector WHERE ctid
     IN (SELECT ctid … WHERE embedding_vec IS NULL LIMIT batch)` — each batch
     its own statement (50k default, `PDPP_PG_SEMANTIC_MIGRATION_BATCH_SIZE`
     override for tests), progress logged;
   - one transaction: `DROP COLUMN embedding; RENAME embedding_vec TO
     embedding; SET NOT NULL`;
   - build the HNSW index (`CREATE INDEX IF NOT EXISTS`), with
     `maintenance_work_mem` raised for the session (default 256MB,
     `PDPP_PG_SEMANTIC_INDEX_MAINTENANCE_WORK_MEM` override) and reset after.

Interruption at any point re-enters the correct state on the next boot: an
unfinished backfill resumes at the remaining `embedding_vec IS NULL` rows; the
column swap is atomic; an interrupted index build re-runs `CREATE INDEX IF NOT
EXISTS`. Fresh databases bootstrap with the JSONB column and immediately pass
through step 3 with zero rows, landing on the vector shape — one code path.

The index build is **serial** (`max_parallel_maintenance_workers = 0`).
Parallel HNSW builds allocate dynamic shared memory proportional to
`maintenance_work_mem`, and containerized Postgres commonly runs with the
64MB `/dev/shm` default — the parallel build dies with `could not resize
shared memory segment` (reproduced against `pgvector/pgvector:pg16`). Serial
builds use no DSM and work in any container.

Measured on a synthetic 200k-row, 384-dim fixture (pgvector 0.8.2, defaults):
backfill ~12s (4 × 50k batches ≈ 3s each), serial HNSW build 262s, JSONB heap
407MB → ~320MB live vector heap + 391MB HNSW index. Extrapolated to the live
~1.85M rows: backfill a few minutes, serial index build roughly 40–75 minutes
(random vectors are a pessimistic build case; clustered real embeddings build
faster), total boot-blocking time of roughly an hour, interruption-safe
throughout. Post-migration the dropped JSONB column's space (~10 GB) returns
via routine vacuuming.

The detected mode (`jsonb` | `vector`) and the iterative-scan capability are
cached module-level in `postgres-storage.js`, reset on init/close, and exposed
to `postgres-search.js`, whose read/write functions branch once on mode.

## Decision 4: logging

`bootstrapPostgresSchema`/`initPostgresStorage` gain an optional `{ log }`
parameter (no-op default, same convention as
`semanticIndexBackfillForManifest`); `startServer` threads `logger.info`. No
existing caller changes required.

## Open questions (owner)

- The boot migration blocks server start for the full backfill + index build
  (measured extrapolation: roughly an hour at live size, dominated by the
  serial HNSW build). Acceptable for the reference deployment, or schedule a
  maintenance window? If the live container gets `--shm-size` ≥
  `maintenance_work_mem`, the owner may re-enable parallel build workers to
  cut this substantially.
- After the migration, a manual `VACUUM (FULL)`/`pg_repack` (or routine
  autovacuum over time) reclaims the dropped JSONB column's ~10 GB. Note
  `VACUUM FULL` itself wants `/dev/shm` headroom in a constrained container.
