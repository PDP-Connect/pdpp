## Context

Real API benchmarking on the live Postgres reference instance showed `/v1/search` as a P0 read-surface bottleneck:

- lexical search p50 roughly 13.6s for `q=error`
- semantic search p50 roughly 7.3s for `q=deployment failure`
- hybrid search p50 roughly 6.7s for `q=deployment failure`
- broad lexical terms can fail with SQLSTATE `53100`, `could not resize shared memory segment`

The live index has roughly 7.2M lexical rows. The largest owner-visible connector instances have millions of searchable rows. The current lexical Postgres index is `GIN(document)`, while every owner search query also filters by `connector_instance_id` and `stream`.

Official Postgres documentation describes GIN as the preferred index type for full-text search, and `btree_gin` as useful when queries test both a GIN-indexable column and B-tree-indexable columns in one multicolumn GIN index. This matches the reference query shape.

## Decisions

### 1. Use a scope-shaped GIN index

The Postgres reference shall create `btree_gin` when available and ensure an index on `(connector_instance_id, stream, document)`. This lets the planner satisfy the equality scope and text match from one GIN index instead of combining a global text index with a separate key index.

The existing global document index remains in place for compatibility and rollback safety.

### 2. Disable parallel workers only for lexical search queries

The live failure is a Docker shared-memory failure during query execution, not a full-disk condition. The reference already serializes HNSW index builds because parallel Postgres work can exhaust Docker shared memory. Lexical read queries get the same narrow treatment: transaction-local `max_parallel_workers_per_gather = 0`.

This is scoped to the lexical query transaction. It does not globally change Postgres and does not add artificial sleeps.

### 3. Bound concurrent per-source fan-out on Postgres

The current owner search path starts every per-connection/per-plan query at once. That is correct for small packages but unsafe for a personal server with broad local-agent logs and many connections.

The reference shall execute Postgres per-source fan-out through a bounded work queue. The default bound is high enough to keep the normal Postgres pool saturated without launching every owner-visible source at once, and remains configurable. This is resource governance, not a wall-clock cap: work starts as soon as a slot is available, and no eligible work is delayed by timers.

SQLite remains unchanged because the live bottleneck and shared-memory failure are Postgres-specific.

### 4. Bound the Postgres lexical ranking candidate window

The scoped GIN index fixes the authorization-scope shape, but exact relevance ranking over every match in a multi-million-row source still makes broad/common terms too slow. The reference shall first collect a bounded candidate window through the scoped text-search predicate, then compute rank and snippets over that window.

This preserves the public contract: v1 lexical search is relevance-oriented and does not promise portable numeric BM25 scores or exhaustive global ranking. Requests narrowed by explicit record keys keep the exact path because the caller already supplied a bounded candidate set.

### 5. Cache repeated semantic query vectors

Semantic database retrieval is fast once a query vector exists; the local Transformers.js query embedding is the expensive step. The reference shall keep a small, backend-identity-keyed in-process query-vector cache with single-flight semantics so repeated semantic/hybrid requests during one navigation do not recompute the same embedding.

The cache is intentionally short-lived and clears when the semantic backend changes. It does not change semantic result semantics; it reuses the same vector the backend would have produced.

## Alternatives

- Increase Docker shared memory only: helpful, but insufficient. A forkable reference should not require operators to discover a container memory footgun before `/v1/search` works.
- Replace Postgres search with an external engine now: too much operational complexity for the reference. Postgres FTS remains the lowest-incidental-complexity substrate until evidence proves it cannot meet the reference bar.
- Long-lived search-result caches: useful later, but they hide the bad query path rather than making first reads reliable.
- Global fixed sleeps or wall-clock caps: rejected. They contradict the control-system ideal; the fix should govern concurrent work and database plan shape, not make collection/search wait arbitrarily.
- Exact ranking over every match for broad terms: rejected for the reference default. It is accurate in a narrow scoring sense but failed the owner experience by producing 10-40 second searches on live personal-data volumes.
- Caching full semantic search result pages first: rejected for this tranche. The measured bottleneck is query embedding generation, so caching the query vector removes duplicate CPU work while preserving fresh index reads and cursor semantics.

## Acceptance Checks

- A broad owner lexical search on Postgres returns `200`, not SQLSTATE `53100`.
- A broad owner semantic search still returns semantic results and does not run all per-source KNN queries unbounded.
- SQLite lexical and semantic search tests remain unchanged.
- Postgres bootstrap is idempotent on empty and existing databases.
- Live proof after deploy includes before/after `/v1/search`, `/v1/search/semantic`, and `/v1/search/hybrid` timings.
