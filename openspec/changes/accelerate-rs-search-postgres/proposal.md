## Why

The live reference instance exposes `/v1/search`, `/v1/search/semantic`, and `/v1/search/hybrid` over a broad owner-visible package. API benchmarks show search as the slowest read-surface path, and broad lexical queries can fail with Postgres `53100` shared-memory errors under Docker.

The current Postgres lexical index is global on `document`; owner search always has `connector_instance_id` and `stream` scope, so broad packages make Postgres combine or over-scan indexes instead of using a scope-shaped search index.

## What Changes

- Add a scoped Postgres GIN text-search index for `(connector_instance_id, stream, document)` using the built-in `btree_gin` extension when available.
- Run Postgres lexical search with transaction-local parallel query workers disabled so Docker `/dev/shm` limits do not turn search into `53100` failures.
- Bound per-source search fan-out concurrency for Postgres-backed lexical and semantic owner search without adding wall-clock sleeps or changing result shape.
- Preserve SQLite behavior and the public lexical/semantic/hybrid response contracts.

## Capabilities

Modified:
- `reference-implementation-architecture`

## Impact

- Runtime: `reference-implementation/server/postgres-search.js`, `reference-implementation/server/postgres-storage.js`, `reference-implementation/server/search.js`, `reference-implementation/server/search-semantic.js`
- Tests: Postgres lexical search and search fan-out regression tests
- Operations: existing Postgres deployments build one additional scoped GIN index; live deploy should run in a declared stack window.
