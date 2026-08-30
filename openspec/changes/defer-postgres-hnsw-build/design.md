## Decision

`bootstrapPostgresSchema` SHALL create the durable HNSW maintenance state row
as required schema, but SHALL NOT build an HNSW index. The pgvector column
conversion remains synchronous because it changes the stored representation and
must complete before the vector read path is selected.

After both protocol listeners bind, one post-listen maintenance attempt SHALL
acquire a dedicated PostgreSQL advisory lock, mark the durable job running, and
build the global and eligible hot-source HNSW indexes sequentially. The fixed
index names and advisory lock prevent duplicate builders. A statement timeout
bounds each attempt; an interrupted `CREATE INDEX CONCURRENTLY` leaves an
invalid catalog entry that the next attempt drops and rebuilds. Success,
unavailability, and failure are persisted in the job row. Failure is logged and
does not reject readiness.

Semantic vector reads continue to use the same SQL ordering when the HNSW index
is absent; PostgreSQL performs an exact scan. The index is an acceleration, not
the semantic correctness authority.

## Alternatives considered

- Keeping HNSW in bootstrap: rejected because the derived graph is the incident
  blocker and has no readiness dependency.
- Moving all semantic migration after listen: rejected because the column swap
  changes the storage representation and would make the active read mode
  ambiguous during startup.
- An in-memory promise or process-local mutex: rejected because crash recovery
  and multiple server processes require database-backed ownership and state.
- Reusing per-scope `search_index_dirty`: rejected because HNSW is one global
  catalog job, not record-derived scope maintenance; combining them would
  hide different retry and failure semantics.

## Acceptance checks

- A readiness test holds the optional builder open and proves AS/RS still bind.
- A Postgres test reads semantic results with no HNSW index.
- A Postgres test proves one durable builder, idempotent restart, invalid-index
  recovery, and durable advisory failure.
- Required bootstrap/migration errors still reject initialization.
- Focused Postgres tests, typecheck, Biome, readiness/restart mutants, and the
  five-part handoff checklist pass.
