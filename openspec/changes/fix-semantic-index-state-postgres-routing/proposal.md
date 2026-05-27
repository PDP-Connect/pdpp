## Why

The advertised `capabilities.semantic_retrieval.index_state` is computed by
`computeIndexState()` against SQLite even when
`PDPP_STORAGE_BACKEND=postgres`. Postgres-mode semantic writers correctly
target Postgres, leaving the SQLite `semantic_search_backfill_progress` row
frozen from earlier SQLite-era runs. The reader therefore observes a stale
SQLite progress row and advertises `"stale"` indefinitely, even though every
restart cleanly rebuilds the Postgres semantic index.

`index_state` is a protocol-observable field on
`/.well-known/oauth-protected-resource` and the reference `/_ref/deployment`
report. The bug is a construction gap: the writer-side Postgres migration
(commit `7bc34e23`, 2026-05-24) did not update the reader.

## What Changes

- Branch `computeIndexState()` on the active storage backend so semantic
  meta/progress are read from Postgres in Postgres mode and from SQLite in
  SQLite mode.
- Add Postgres helpers `postgresAnySemanticProgressRow()` and
  `postgresListAllSemanticMetaIdentities()` that mirror the existing SQLite
  queries.
- Convert `computeIndexState()` to async and update its callers
  (`resolveSemanticCapability`, `/_ref/deployment` diagnostics) and the
  `rs.protected-resource-metadata` operation to await it.
- Preserve `building` while in-process backfill is active.
- Preserve honest `stale` reporting when meta identity disagrees with the
  current backend identity.

## Capabilities

Modified:

- `semantic-retrieval`

## Impact

- Affects the advertised `index_state` in resource-server protected-resource
  metadata and the reference `/_ref/deployment` report.
- Does not change PDPP Core, Collection Profile messages, grant semantics,
  request validation, ranking, or the `/v1/search/semantic` wire shape.
- Does not introduce a new semantic indexing mechanism, mutate stored data,
  or perform one-off cleanup.
