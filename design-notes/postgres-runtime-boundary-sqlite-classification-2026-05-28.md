# Postgres Runtime Boundary — SQLite Classification

Date: 2026-05-28

Scope companion to `openspec/changes/complete-postgres-runtime-boundary/`
task 1.3. Captures the inventory + classification required before the
remaining boundary work proceeds.

## Inventory

Production runtime files (under `reference-implementation/server`,
`reference-implementation/lib`, `reference-implementation/operations`)
that import `getDb` or `better-sqlite3`, plus their Postgres-dispatch
status:

| File                                                                  | Imports `getDb` | Imports `better-sqlite3` | Dispatches on `isPostgresStorageBackend()` |
| --------------------------------------------------------------------- | --------------- | ------------------------ | ------------------------------------------ |
| `lib/controller-boot.ts`                                              | yes             | type-only                | yes                                        |
| `lib/db.ts`                                                           | yes (re-export) | yes (the wrapper)        | no — foundational                          |
| `lib/spine.ts`                                                        | yes             | type-only                | yes                                        |
| `server/auth.js`                                                      | no (uses `lib/db.ts`) | yes (typing only)  | yes                                        |
| `server/dataset-summary-read-model.js`                                | yes             | no                       | **NO**                                     |
| `server/db.js`                                                        | n/a — owner     | yes (the bootstrap)      | n/a                                        |
| `server/index.js`                                                     | yes (deployment diagnostics) | no          | yes                                        |
| `server/queries/index.ts`                                             | yes (registry boot) | no                   | no — SQLite-only artifact loader           |
| `server/record-version-stats.js`                                      | yes             | no                       | yes (line 95 guard)                        |
| `server/records.js`                                                   | yes             | no                       | yes (per-operation dispatch)               |
| `server/retained-size-read-model.js`                                  | yes             | no                       | yes (read + write helpers)                 |
| `server/search-semantic.js`                                           | yes             | no                       | yes                                        |
| `server/stores/browser-surface-lease-store.ts`                        | yes             | no                       | yes (SQLite & Postgres store classes)      |

## Classification

### A. Guarded SQLite-backend code (correct as-is)

These files use `getDb()` only inside SQLite branches of an
`isPostgresStorageBackend()` dispatch, or expose `_Sqlite` helpers whose
callers gate on the active backend:

- `lib/controller-boot.ts` — `nextSeqForController`, `reconcileSqlite`,
  `emitRunAbandonedSyncSqlite` all sit under the Postgres branch in their
  dispatchers (`reconcile`, `emitRunAbandoned`).
- `lib/spine.ts` — `getDb()` only reached after the Postgres branch returns.
- `server/auth.js`, `server/index.js`, `server/records.js`,
  `server/record-version-stats.js`, `server/retained-size-read-model.js`,
  `server/search-semantic.js`, `server/stores/*` — every `getDb()` call
  sits behind an `isPostgresStorageBackend()` dispatch, or is a `_Sqlite`
  helper called only from a SQLite branch.

### B. Explicitly ephemeral / test-only compatibility

- `lib/db.ts` — wrapper around `better-sqlite3` and the cached statement
  registry. In Postgres mode the wrapper still exists because:
  - the SQLite database file is the local default backend, kept ephemeral;
  - bounded SQL artifacts (`server/queries/index.ts`) load against the
    local SQLite handle at startup so their `prepare()` invariants hold
    regardless of active backend;
  - in Postgres mode the wrapper is not on any durable read path that
    serves operator answers — every caller dispatches first.
- `server/db.js`, `server/queries/index.ts` — bootstrap and registry only.
  They write/read against the local SQLite handle at startup; Postgres mode
  still calls `initDb()` because `bound-spine-and-record-read-paths`'s
  registry initialization happens against the SQLite handle for prepare-time
  invariants.

### C. Known violations (this change fixes)

- `server/dataset-summary-read-model.js` — entire module is SQLite-only.
  In Postgres mode the dashboard summary route avoids it (it now calls
  `getRetainedSizeDatasetSummaryProjection` instead), but:
  1. the route adapter is the single point of correctness — any other
     caller of `getDatasetSummaryProjection()` in Postgres mode would
     silently read the empty SQLite projection;
  2. `applyDatasetSummaryRecordDelta` and `applyDatasetSummaryBlobDelta`
     are no-ops on a never-rebuilt SQLite projection in Postgres mode;
     they swallow the error path that marks the projection failed.
  3. `dataset_summary_stream_projection` is the only natural place to
     read per-`(connector_id, stream)` ingest-time bounds and
     `consent_time_field` — the Postgres summary surfaces null for those
     in `executeRefDatasetSummaryStreams`.

  **Fix:** add an explicit guard that errors when
  `getDatasetSummaryProjection()` or its delta helpers are reached in
  Postgres mode, and stop wiring those helpers from the Postgres ingest
  path. The Postgres-mode retained-size projection already covers the
  dashboard's hot path; per-stream metadata that needs a Postgres home is
  out of scope for this slice.

### D. Owner-decision-required

None at this slice. `lib/db.ts` and `server/queries/index.ts` are
infrastructure for the SQLite default backend; making them lazy in
Postgres mode is a follow-on slice rather than a closeout item.

## Implications for this change

- Item 2.1–2.5 (Postgres dataset-summary projection) is **largely already
  done** at the read path: `/_ref/dataset/summary` and
  `/_ref/dataset/summary/streams` in Postgres mode read from
  `retained_size_*` tables via `getRetainedSizeDatasetSummaryProjection`
  and `listRetainedSizeStreams`. The remaining gap is **route-level
  correctness in the face of unguarded read-model callers** plus the
  divergence-regression test.
- Item 3.1 (guard) is the load-bearing piece this PR should land: a
  runtime guard that fails fast when SQLite dataset-summary helpers are
  reached in Postgres mode, plus a focused regression test that
  deliberately writes divergent SQLite projection rows and confirms the
  Postgres dashboard summary ignores them.
- Item 3.3 (deployment diagnostics) — the existing
  `/_ref/deployment` report already surfaces `storage_backend`. The
  classification table above is the documentation deliverable.

## Out of scope here

- Lazy/disabled SQLite initialization in Postgres mode.
- Migration tooling.
- Splitting `lib/db.ts` into a SQLite-only module.
- Promoting `record_json_bytes` and time bounds in the streams envelope
  to PDPP-stable wire semantics.
