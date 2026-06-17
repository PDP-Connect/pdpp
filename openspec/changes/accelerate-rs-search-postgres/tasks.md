## 1. Postgres Search Indexing

- [x] Create `btree_gin` during Postgres bootstrap when available.
- [x] Ensure a scoped lexical GIN index for `(connector_instance_id, stream, document)`.
- [x] Keep the existing global document index for compatibility.

## 2. Runtime Query Safety

- [x] Run Postgres lexical queries with transaction-local `max_parallel_workers_per_gather = 0`.
- [x] Add a shared bounded fan-out helper for Postgres search work.
- [x] Apply bounded fan-out to lexical owner search snapshot building.
- [x] Apply bounded fan-out to semantic owner search snapshot building.
- [x] Add a bounded Postgres lexical candidate window before rank/snippet computation for broad searches.
- [x] Add short-lived single-flight caching for repeated semantic query vectors.
- [x] Reduce semantic per-connector overscan to the public maximum page size.
- [x] Adapt semantic per-connector overscan to the requested page size.
- [x] Coalesce unfiltered Postgres semantic scope reads per connection.
- [x] Use retained-size estimates to keep small/unknown semantic scopes on exact scans and large scopes on bounded ANN candidate windows.
- [x] Manage bounded hot-source partial HNSW indexes for medium-selectivity semantic sources.

## 3. Tests

- [x] Add unit coverage for fan-out concurrency and ordering.
- [x] Add/extend Postgres lexical tests to cover scoped index bootstrap and candidate-window lexical query success.
- [x] Add semantic query-vector cache coverage.
- [x] Add semantic overscan and Postgres plan coalescing coverage.
- [x] Add production-dimension Postgres semantic coverage proving ANN candidate retrieval still enforces requested semantic scopes.
- [x] Prove hot-source partial HNSW indexes on the live slow semantic sources before deploy.
- [x] Run targeted search tests.
- [x] Run reference TypeScript.
- [x] Validate OpenSpec strict/all.

## 4. Live Verification

- [x] Build/deploy in a live-stack window.
- [x] Verify `/v1/search?q=the&limit=5` no longer fails with shared-memory errors.
- [x] Verify API benchmark deltas for lexical, semantic, and hybrid search.
- [x] Record residual performance gaps for the next loop.
- [x] Verify API benchmark deltas after broad Postgres semantic retrieval uses ANN candidate windows instead of exact scoped vector scans.
