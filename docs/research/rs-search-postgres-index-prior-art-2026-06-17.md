# RS Search Postgres Index Prior Art — 2026-06-17

Status: decided  
Owner: Codex RI-owner session  
Scope: reference implementation Postgres search performance and shared-memory safety

## Question

What is the least-incidental-complexity way to make the reference implementation's Postgres-backed `/v1/search` reliable and fast enough for broad owner-visible personal-data packages?

## Sources

- PostgreSQL documentation, "12.9. Preferred Index Types for Text Search": <https://www.postgresql.org/docs/current/textsearch-indexes.html>
- PostgreSQL documentation, "F.7. btree_gin — GIN operator classes with B-tree behavior": <https://www.postgresql.org/docs/current/btree-gin.html>
- PostgreSQL documentation, "65.4. GIN Indexes": <https://www.postgresql.org/docs/current/gin.html>
- Crunchy Data, "Postgres Troubleshooting: DiskFull ERROR: could not resize shared memory segment": <https://www.crunchydata.com/blog/postgres-troubleshooting-diskfull-error-could-not-resize-shared-memory-segment>

## Findings

Postgres's documented preferred index for full-text `tsvector` search is GIN. The reference already uses a generated `tsvector` column and a global `GIN(document)` index, which is directionally correct for small packages.

The live owner-search query is not just `document @@ query`; it is always scoped by `connector_instance_id` and `stream`. PostgreSQL's `btree_gin` extension exists for exactly the class of query that combines a GIN-indexable column with B-tree-style equality columns in a multicolumn GIN index. A scoped GIN index on `(connector_instance_id, stream, document)` therefore better matches the reference query than the global document index plus bitmap combination.

The live `53100` error is a dynamic shared-memory allocation failure during query execution. In a container, this can happen even when disk is not full. The reference already serializes HNSW index builds to avoid Docker `/dev/shm` failures; applying transaction-local `max_parallel_workers_per_gather = 0` to lexical search reads is the same narrow operational mitigation.

## Decision

Implement the Postgres reference search fix as:

- Ensure `btree_gin` when available.
- Add a scoped lexical GIN index on `(connector_instance_id, stream, document)`.
- Keep the existing global document GIN index for compatibility and rollback safety.
- Disable parallel workers only inside lexical search read transactions.
- Bound concurrent per-source fan-out for Postgres search work, with no fixed wall-clock sleeps.

## Non-goals

- Do not introduce Elasticsearch/OpenSearch in the reference.
- Do not change the public lexical result shape.
- Do not make search rely on a long-lived result cache as the primary correctness/performance mechanism.
