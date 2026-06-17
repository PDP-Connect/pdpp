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

Live common-term measurement showed the default must also avoid Postgres contention, not only bound total work. Simulating the production connector-level fan-out over all indexed live streams for `q=the` showed concurrency 8 was consistently fastest and stable, while concurrency 16 had wider outliers and concurrency 2 under-utilized the store. The reference therefore defaults Postgres search fan-out to 8 while preserving the environment override for operators with different hardware.

### 4. Bound the Postgres lexical ranking candidate window

The scoped GIN index fixes the authorization-scope shape, but exact relevance ranking over every match in a multi-million-row source still makes broad/common terms too slow. The reference shall first collect a bounded candidate window through the scoped text-search predicate, then compute rank and snippets over that window.

This preserves the public contract: v1 lexical search is relevance-oriented and does not promise portable numeric BM25 scores or exhaustive global ranking. Requests narrowed by explicit record keys keep the exact path because the caller already supplied a bounded candidate set.

Live tuning after the semantic tranche showed the default lexical candidate window was still too wide for extremely common terms on multi-million-row sources: a `claude-code/messages` scoped search for `the` took about 5.6s with a 1000-row candidate window and about 85ms with a 200-row candidate window, while a 100-row window produced an unrelated 1.8s outlier on `codex/messages`. The reference default is therefore 200: enough overscan for the public first page while avoiding unnecessary common-term work.

### 5. Cache repeated semantic query vectors

Semantic database retrieval is fast once a query vector exists; the local Transformers.js query embedding is the expensive step. The reference shall keep a small, backend-identity-keyed in-process query-vector cache with single-flight semantics so repeated semantic/hybrid requests during one navigation do not recompute the same embedding.

The cache is intentionally short-lived and clears when the semantic backend changes. It does not change semantic result semantics; it reuses the same vector the backend would have produced.

### 6. Align semantic overscan with the public page maximum

The semantic route previously requested 200 hits per connector even though the public maximum page size is 100. For broad owner searches this doubled KNN and candidate-merging work without improving the first page. The reference shall cap per-connector semantic overscan at the public maximum until a later change introduces a measured adaptive overscan policy.

### 7. Adapt semantic overscan to the requested page and coalesce unfiltered scopes

Live Postgres evidence after the first search tranche showed semantic and hybrid search still at about 7s p50. The bottleneck was no longer query-vector generation; warm benchmark runs still paid for multiple filtered HNSW KNN reads per connector, each asking for the public maximum of 100 hits even when the caller requested the default 25-hit page.

The reference shall size per-connector semantic overscan from the requested page size, with a small duplicate-collapse cushion and a hard cap at the public maximum. For unfiltered Postgres semantic plans, the reference shall coalesce all same-connection semantic scope keys into one KNN read. Entries narrowed by record-key candidates or query filters SHALL remain separate so the filtered semantics are unchanged.

### 8. Keep broad semantic retrieval on the ANN-compatible filter boundary

Live Postgres `EXPLAIN ANALYZE` after decision 7 showed the residual semantic bottleneck was planner shape, not embedding generation or fan-out. The unfiltered HNSW path returned in tens of milliseconds, and connector-only HNSW remained fast. But when `connector_instance_id` and `scope_key = ANY(...)` were both present on the HNSW scan, PostgreSQL chose the `(connector_instance_id, scope_key)` btree index, exact-scanned tens of thousands of vectors for large Gmail/ChatGPT sources, and top-N sorted them. That produced about 3-4s pinned-source searches and kept broad semantic/hybrid search around 5-6s.

The reference shall keep large broad 384-dimension Postgres semantic retrieval on the ANN-compatible boundary by first asking HNSW for a bounded same-connection candidate window, then applying the grant/planner scope-key filter to that materialized candidate set before results leave the database. Record-key-narrowed requests and non-production-dimension test embeddings keep the exact path so candidate narrowing and historical parity tests remain exact.

A second live/test finding matters: connector-filtered HNSW is a poor plan for tiny or rare connectors because the global ANN graph may walk a large index to find enough same-connection candidates. The reference shall therefore use the retained-size stream projection as a cheap cardinality estimate. Small or unknown estimates stay on the exact scoped path; large clean estimates use the ANN candidate window. The default exact threshold is intentionally high enough for 15k-20k-row local-device sources to avoid the global graph, while large dominant sources use a modest candidate window instead of a 1000-row overscan.

This is a query-shape and derived-index fix, not a new search engine. It preserves the authorization scope filter, avoids unbounded per-connector partial-index proliferation, and stays within pgvector/Postgres until measured evidence shows the reference needs a different retrieval substrate.

Live partial-index proof changed the final construction. The existing btree exact path is already present but remains too slow for medium-large filtered vector slices (Gmail/ChatGPT at roughly 80k-90k semantic rows). The global HNSW graph is fast for dominant connectors and unfiltered search, but medium-selectivity connector filters still either under-return without a large candidate window or cold-scan too much of the graph. Official pgvector guidance calls out partial HNSW indexes for a small number of filtered values; PDPP applies that as a bounded reference read-model optimization, not as unbounded per-instance DDL.

The reference shall therefore manage hot-source partial HNSW indexes for clean retained-size projections in the medium-large band: above a minimum row threshold, below a maximum table-share threshold, and capped to a small number of connections. This creates filtered graphs for the Gmail/ChatGPT/large-upload class while avoiding indexes for tiny sources (exact is cheaper) and dominant local-agent sources (a 700k+ row partial HNSW graph is expensive to build and not the right default). The managed indexes are derived from retained-size projections and can be rebuilt; they are not protocol state.

## Alternatives

- Increase Docker shared memory only: helpful, but insufficient. A forkable reference should not require operators to discover a container memory footgun before `/v1/search` works.
- Replace Postgres search with an external engine now: too much operational complexity for the reference. Postgres FTS remains the lowest-incidental-complexity substrate until evidence proves it cannot meet the reference bar.
- Long-lived search-result caches: useful later, but they hide the bad query path rather than making first reads reliable.
- Global fixed sleeps or wall-clock caps: rejected. They contradict the control-system ideal; the fix should govern concurrent work and database plan shape, not make collection/search wait arbitrarily.
- Exact ranking over every match for broad terms: rejected for the reference default. It is accurate in a narrow scoring sense but failed the owner experience by producing 10-40 second searches on live personal-data volumes.
- Caching full semantic search result pages first: rejected for this tranche. The measured bottleneck is query embedding generation, so caching the query vector removes duplicate CPU work while preserving fresh index reads and cursor semantics.
- Unbounded per-connection partial HNSW indexes or table partitioning immediately: rejected. Official pgvector guidance treats partial indexes and partitioning as valid filtered-ANN options, but unbounded per-instance DDL and table partitioning add operational and migration complexity. The measured live issue is solved by a capped hot-source partial-index set plus query-shape fallback; full partitioning can be revisited only with evidence that the bounded construction fails.

## Acceptance Checks

- A broad owner lexical search on Postgres returns `200`, not SQLSTATE `53100`.
- A broad owner semantic search still returns semantic results and does not run all per-source KNN queries unbounded.
- SQLite lexical and semantic search tests remain unchanged.
- Postgres bootstrap is idempotent on empty and existing databases.
- Live proof after deploy includes before/after `/v1/search`, `/v1/search/semantic`, and `/v1/search/hybrid` timings.
