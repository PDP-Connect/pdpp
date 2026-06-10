# Design — fix-semantic-index-state-postgres-routing

## Problem

`reference-implementation/server/search-semantic.js::computeIndexState()`
reads SQLite `semantic_search_backfill_progress` and `semantic_search_meta`
unconditionally. In Postgres storage mode every other meta/progress read in
`semanticIndexBackfillForManifest` is correctly branched on
`isPostgresStorageBackend()`, so the writer side has migrated and the SQLite
rows are now frozen orphans. `computeIndexState()` therefore returns
`"stale"` indefinitely on Postgres deployments, and that value is published
on `/.well-known/oauth-protected-resource` (`capabilities.semantic_retrieval`)
and the reference `/_ref/deployment` report.

See the diagnosis evidence in
`tmp/workstreams/semantic-index-stale-diagnosis-report.md`.

## Decision

Branch `computeIndexState()` on `isPostgresStorageBackend()`, the same as
every other semantic meta/progress read in the same file. Convert the
function to `async` and propagate the change through its two callers and
the `rs.protected-resource-metadata` operation. The SQLite path is preserved
verbatim for SQLite-mode deployments.

State machine (unchanged shape):

1. `!backend` → `"stale"`.
2. `isSemanticIndexBackfillActive()` → `"building"`.
3. Active backend reports any progress row → `"stale"` (rebuild in flight or
   interrupted).
4. Active backend reports zero meta rows → `"built"` (boot path always
   backfills before advertising; same comment as the SQLite-only version).
5. Any meta row whose `(model_id, dimensions, distance_metric)` does not
   match the live backend → `"stale"`.
6. Otherwise → `"built"`.

The active backend is the authority. Orphaned rows in the inactive backend
are ignored. Honesty is preserved: Postgres-mode `built` still requires the
Postgres meta identity to match the live backend.

## Alternatives Considered

1. **Keep `computeIndexState()` sync; cache the value behind module-local
   state updated on backfill events.** Rejected: it adds a second source of
   truth for the index state, complicates startup ordering (the cache has
   to be populated before the first advertisement), and silently diverges
   from storage if the cache is missed.
2. **One-shot delete of orphan SQLite semantic rows on Postgres startup.**
   Rejected for this change: the reader stops looking at those rows once
   it branches on the active backend; deletion is unnecessary for the fix
   and introduces a live data mutation that the diagnosis report explicitly
   advises against without a regression test that proves it necessary. Can
   be revisited as a separate, optional cleanup.
3. **Branch every caller instead of `computeIndexState()`.** Rejected: the
   bug lives in a shared helper; fixing it once is smaller, matches the
   existing branch pattern in the same file, and means no caller can
   forget the branch.

## Async Propagation

`postgresQuery` is async in the pg driver. Making `computeIndexState()`
async forces:

- `resolveSemanticCapability()` in `reference-implementation/server/index.js`
  to become async.
- `executeRsProtectedResourceMetadata()` to become async.
- The `/.well-known/oauth-protected-resource` route handler (already a
  framework-async handler shape) to `await` the operation.
- `DeploymentDiagnosticsRuntimeDeps.computeIndexState` to declare
  `() => Promise<SemanticIndexState>`; `collectDeploymentDiagnostics` is
  already async and only needs an added `await`.

Test ripple:

- `reference-implementation/test/rs-protected-resource-metadata-operation.test.js`
  — every `executeRsProtectedResourceMetadata` call wraps in `await`.
- `reference-implementation/test/semantic-retrieval.test.js` already drives
  the advertisement through HTTP, so it does not need to change shape for
  the async migration; we add one new regression scenario.
- `reference-implementation/test/deployment-diagnostics.test.js` calls
  `buildDeploymentDiagnostics` (sync inner), not the async outer wrapper —
  no change required.

## In Scope

- `reference-implementation/server/search-semantic.js::computeIndexState()`
  becomes async and branches on storage backend.
- Two new Postgres helpers in
  `reference-implementation/server/postgres-search.js`.
- Async propagation through `resolveSemanticCapability` and the
  `rs.protected-resource-metadata` operation.
- One regression test in `reference-implementation/test/semantic-retrieval.test.js`
  asserting Postgres-mode `computeIndexState()` ignores orphaned SQLite
  progress/meta rows.
- Updated test wraps for `executeRsProtectedResourceMetadata`.

## Out Of Scope

- Mutating live SQLite rows in Postgres mode.
- Changing the spec semantics of `index_state` (still `built | building |
  stale`).
- Changing semantic ranking, request validation, or any other semantic
  wire surface.
- The orphan-cleanup follow-up.

## Acceptance Checks

1. `computeIndexState()` returns `"built"` in Postgres mode when Postgres
   meta rows match the live backend and the Postgres progress table is
   empty — even if SQLite contains a frozen progress row.
2. `computeIndexState()` returns `"stale"` in Postgres mode when any
   Postgres meta row's identity diverges from the live backend.
3. `computeIndexState()` returns `"building"` whenever the in-process
   backfill counter is non-zero, regardless of backend.
4. SQLite-mode behavior is unchanged (regression coverage already exists
   in `semantic-retrieval.test.js`).
5. `openspec validate fix-semantic-index-state-postgres-routing --strict`
   passes.
6. `node --test reference-implementation/test/semantic-retrieval.test.js`
   passes.
7. `pnpm --dir reference-implementation typecheck` passes.
