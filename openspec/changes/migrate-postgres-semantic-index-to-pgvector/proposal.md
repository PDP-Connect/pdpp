# Proposal: migrate-postgres-semantic-index-to-pgvector

## Why

The Postgres semantic-search path stores embeddings in
`semantic_search_blob.embedding` as **JSONB** (384-dim float arrays, roughly
4.8 KB/row versus roughly 1.5 KB as a pgvector `vector`) and answers queries by
SELECTing candidate rows and brute-force cosine-scoring them in JavaScript
(`postgres-search.js` `postgresSemanticSearch`). The live deployment already
runs the `pgvector/pgvector:pg16` image, so the `vector` extension is available
but unused. At the live table size (~1.85M rows / ~10 GB) the JSONB
representation wastes roughly 3× the storage and the brute-force read path
ships every candidate embedding over the wire to score it in JS — worse, the
candidate SELECT carries a bare `LIMIT` with no ordering, so on scopes larger
than the per-connector overscan the JS pass scores an **arbitrary** candidate
subset rather than the true nearest neighbors.

The SQLite path (`search-semantic.js`: sqlite-vec preferred, BLOB flat
fallback) is healthy and is explicitly out of scope.

## What Changes

- Add a `reference-implementation-architecture` requirement: on a
  Postgres backend with the `vector` extension available, the reference SHALL
  persist semantic embeddings as pgvector `vector` values and answer semantic
  index queries with the database's cosine-distance operator (`<=>`) plus an
  HNSW index, instead of fetching candidate embeddings and scoring them in
  process. Retrieval contract semantics (result shape, ranking order semantics,
  distance values, grant scoping) SHALL NOT change.
- Boot migration in `postgres-storage.js`, following the existing
  boot-migration style: detect the legacy JSONB `embedding` column, add a
  `vector` column, backfill in bounded batches (default 50k rows per
  statement, `jsonb → text → vector` cast), swap the columns atomically, then
  build a partial expression HNSW index
  (`(embedding::vector(384)) vector_cosine_ops WHERE vector_dims(embedding) = 384`).
  The migration is idempotent and resume-safe: every batch is its own
  statement, the column swap is a single transaction, and a re-run after an
  interruption picks up where it left off. Progress is logged through the
  startup logger.
- The `embedding` column is the **dimension-untyped** `vector` type with a
  partial expression HNSW index pinned at the production profile's 384
  dimensions. This is pgvector's documented pattern for tables that may hold
  vectors of more than one dimension, and it preserves today's
  dimension-agnostic table semantics (test stub backends use 8/64-dim vectors
  against the same table; the backend-identity drift machinery, not the column
  type, owns rebuild-on-dimension-change).
- Write path: `postgresSemanticIndexUpsertMany` inserts vector literals
  (`$n::vector`) instead of `$n::jsonb`.
- Read path: `postgresSemanticSearch` becomes
  `ORDER BY embedding::vector(d) <=> $q::vector(d) LIMIT k` with the existing
  `connector_instance_id` / `scope_key` / `record_key` scoping plus a
  `vector_dims(embedding) = d` guard, wrapped in a transaction that sets
  `hnsw.ef_search` to cover the requested limit and (when pgvector ≥ 0.8)
  `hnsw.iterative_scan = strict_order` so filtered scans do not under-return.
  Returned hits keep the exact shape and score semantics of the JS path:
  `distance` is the cosine distance (`1 − cosine similarity`), ties re-sorted
  in process under the same total order as before.
- When the `vector` extension is unavailable the existing JSONB representation
  and JS brute-force scoring remain as the fallback, unchanged — pgvector stays
  optional for the Postgres backend, as the bootstrap comment already promises.

## Capabilities

Modified:
- `reference-implementation-architecture`

Added:
- None

Removed:
- None

## Impact

- Reference implementation Postgres storage/search plumbing only
  (`postgres-storage.js`, `postgres-search.js`, logger threading in
  `index.js`). The public `GET /v1/search/semantic` surface, the
  semantic-retrieval spec, SQLite-path behavior, connector manifests, and the
  Collection Profile are unchanged.
- `semantic_search_blob` is a **derived** table for the migrate-storage tool
  (rebuilt by the runtime, never copied), so the column type change does not
  affect SQLite→Postgres migration tooling.
- Live migration (~1.85M rows): batched backfill (~37 statements at 50k) plus
  one HNSW index build at boot. Expected single-digit-minutes for the backfill
  and tens of minutes for the index build at default `maintenance_work_mem`;
  the migration session raises `maintenance_work_mem` (default 256MB,
  overridable via `PDPP_PG_SEMANTIC_INDEX_MAINTENANCE_WORK_MEM`) to keep the
  build in memory. The server does not serve until the boot migration
  completes; an interrupted boot resumes safely.
- Storage effect: the JSONB column (~10 GB at the live size) is dropped after
  the swap; space is reclaimed by routine vacuuming. The vector representation
  plus HNSW index is expected to net out several GB smaller.
