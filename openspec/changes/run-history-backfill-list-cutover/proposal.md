## Why

`generalize-run-history-write-authority` (Authority Slice A) landed the write path but
explicitly deferred three items: cutting LIST over to `run_history` as primary, bounded
backfill of historical spine-only runs, and the live active/in-progress overlay
composition. `terminal-read-architecture-fable-0730.md` §9 (fourth-pass ruling)
reviewed a scout's implementation packet for those three items and struck three
proposals as needless machinery: a dedicated `run_history_backfill_state` table (the
existing `connector_maintenance_cursor` fenced-lease store already supports name-keyed
resumable cursors), a schema `origin` column (provenance is audit-only — `facts_json`
carries it), and a synchronous startup-blocking backfill loop (the scout's own
arithmetic showed ~27 min worst-case at 10k runs; G4 honesty — "not yet observed
(backfilling)" — is the correct cutover mechanism, not a traffic gate).

This change is that struck-down, minimal packet: one new bounded/resumable stage on
the existing maintenance-sweep chassis, plus the LIST/detail reader cutover away from
the R7-transitional `scheduler_managed`-scoped fallback and the spine-CTE fold.

A second gate pass (2026-07-30) found two systemic gaps in the first landing
(`a0487c89b`): (1) a G1 violation — a spine-read fallback still fired on every
connector-summary route for a connection with a currently-running run — reproduced
live against the sanctioned Postgres instance; (2) a fleet-migration reachability gap
in `e44bf3391`'s `completed_at` nullable repair, which never reaches a database whose
`scheduler_run_history` → `run_history` rename already executed under an earlier
deployment predating that fix. Both are closed in this revision — see "G1 closure" and
"Fleet-migration reachability" below.

## What Changes

- **Backfill stage** (`server/stores/run-history-backfill-stage.ts`, new): a bounded,
  resumable fold over run-lifecycle `spine_events`, keyed by `event_seq > cursor`,
  seq-ascending. Reuses the unmodified `summarizeEvents` (SQLite) /
  `postgresFoldRunSummariesByIds` (Postgres) fold — the same fold `listRunSummariesByConnectorIds`
  already used for the pre-cutover LIST path. Legacy connector-wide runs (no
  `connector_instance_id` anywhere in their event window) get the singleton-attribution
  rule applied once, using the connector's current active-instance count; unattributable
  runs are skipped (never inserted — `run_history.connector_instance_id` is `NOT NULL`,
  so there is no schema slot for "unattributed, audit-only").
- **Cursor reuse, not a new table**: `connector-maintenance-cursor-store.ts` is
  generalized to accept a `name` parameter (`ConnectorMaintenanceCursorName`); the
  backfill stage registers `name = 'run_history_backfill'` as a second row on the
  existing `connector_maintenance_cursor` table (both backends' `CHECK` constraint is
  widened via migration to admit the new name). Two independent sweep owners fence
  through the store's existing generation/lease-token compare-and-set.
- **Chassis wiring, not a new engine**: one more independently-best-effort branch on
  `runConnectorMaintenanceSweep`'s `Promise.all` (60s periodic tick), plus a
  fire-and-forget startup accelerator (`runStartupRunHistoryBackfillToCompletion`,
  mirrors the existing `runStartupSummaryEvidenceSweepToCompletion` pattern) — never
  awaited before the HTTP listener opens.
- **Provenance in `facts_json`, not a column**: backfilled rows carry
  `{"origin":"backfill", ...}` inside the existing `facts_json` JSON column, extracted
  from the terminal event's own raw data (mirroring `run-history-writer.ts`'s
  `factsJsonFromTerminalData`) — not from the fold summary object, which does not carry
  those fields.
- **LIST/detail cutover**: `ConnectorSummaryProjectionDeps` drops
  `getLatestRunHistoryForConnection`/`listRunSummariesForConnector` (the R7-transitional
  `scheduler_managed`-scoped-then-spine-fallback composition) in favor of
  `getLatestRunSummaryForConnectionId`, backed by a new unscoped product reader
  (`listLatestRunHistoryForProductByConnectionIds` / `getLatestRunHistoryForProductByConnectionId`
  on `SchedulerStore`) that reads `run_history` for every run kind, no
  `scheduler_managed` filter. Composed with the page-scoped active-run/lease overlay
  using the **existing** `summarizeEvents` status vocabulary — `running` + live lease
  → `in_progress`; `running` + no lease → `failed` (orphaned); terminal row → stored
  status unchanged. No new status enum.
- **G1 closure on the touched routes, no exceptions (REVISE, second gate pass,
  2026-07-30)**: the per-run `readRunTerminalEventData` spine read
  `toConnectorRunSummary`/`schedulerRunHistoryToConnectorRunSummary` used to build
  `collection_facts`/`known_gaps`/`recovery_only` is gone — `run_history.facts_json` now
  carries those fields (writer + backfill both capture them). The first gate pass shipped
  `readLatestCollectionRateForRun` with a spine-read fallback for `collection_rate` on a
  still-running run and declared it "out of section 9's scope" — the second gate pass
  reproduced that spine read live against the sanctioned Postgres instance on all five
  routes and rejected the carve-out: §3 G1 and R9.3 oracle 5 state the zero-spine bar
  with no route- or feature-specific exception, so the maker cannot grant itself one.
  Closed for real: `run.progress_reported`'s `collection_rate` is now merged directly
  into the running row's `facts_json` at write time
  (`run-history-writer.ts`'s `RUN_PROGRESS_EVENT_TYPE` branch, both backends), atomically
  and fenced by `WHERE run_id = ? AND status = 'running'` so a concurrent/later terminal
  write always wins and a stale in-flight progress merge can never resurrect or overwrite
  a finalized row. `readLatestCollectionRateForRun`'s spine fallback and its backing SQL
  (`spineGetRunLatestCollectionRateEvent` / the inline Postgres query) are deleted
  entirely — the function now only reads `facts_json`, unconditionally, for both a
  terminal and a still-running row. Zero spine touches remain anywhere on the five
  connector-summary routes' call graph, proven on both SQLite and real sanctioned
  PostgreSQL for the in-progress, terminal, and no-run cases
  (`test/active-run-summary-zero-spine.test.ts`).
- **Fleet-migration reachability fix (REVISE, second gate pass, 2026-07-30)**:
  `e44bf3391`'s `completed_at` nullable repair lived inside
  `migrateRunHistoryRename`/`migratePostgresRunHistoryRename`'s `legacyExists`-gated
  branch, which returns immediately once `scheduler_run_history` no longer exists. A
  database whose rename already executed under an earlier deployment of this migration
  (i.e. before `e44bf3391` shipped) never reaches the repair — the guard that would let
  it run is false by the time the fix ships, and every `run.started` write throws
  forever on that database. Closed by extracting the repair into its own standalone
  function (`migrateRunHistoryCompletedAtNullable` / `migratePostgresRunHistoryCompletedAtNullable`)
  that checks `run_history`'s own existence and nullability directly, independent of
  `scheduler_run_history`, and runs unconditionally right after the rename migration on
  both backends. Idempotent; preserves row data, `id` values, and both indexes across
  the SQLite rebuild; no-op on a fresh install.
  `getLatestRunSummaryForConnection` (the R7-transitional three-tier composition),
  `createConnectorRunSummariesReader`, `listPageRunSummaries`, `readRunTerminalEventData`
  — all now unreachable from any route handler. `listRunSummariesByConnectorIds` /
  `postgresListRunSummariesByConnectorIds` / `listSpineCorrelations` are kept (used by
  the backfill fold itself, by an unrelated Family-A-adjacent freshness helper in
  `server/index.ts`, and as the dual-backend equivalence oracle in tests) —
  per R9.2's "the old fold survives only as the test oracle."

## What Does NOT Change (explicitly out of scope for this slice)

- `listActiveRuns()` stays an unscoped (O(fleet)) read — R3's page-scoping of that call
  is a separate, already-identified gate item, not touched here.
- No `openspec` spec changes to Family-A record-read surfaces (`_ref/records`,
  `executeRecordsList`) — unrelated to this slice.
- Scheduler cadence/backoff readers (`listLatestRunHistoryByConnectionIds`,
  `getLatestRunHistoryForConnection`, `listRunHistory`) keep their `scheduler_managed`
  fence exactly as Authority Slice A established (§7/R7.5) — unchanged by this slice.

## Impact

- Affected capability: `reference-implementation-runtime` (run-history backfill,
  connector-summary LIST/detail read composition).
- Affected code: `server/stores/run-history-backfill-stage.ts` (new),
  `server/stores/connector-maintenance-cursor-store.ts`,
  `server/connector-maintenance-sweep.ts`, `server/index.ts`,
  `server/stores/scheduler-store.ts`, `server/stores/run-history-writer.ts`,
  `server/ref-control.ts`, `server/db.ts`, `server/postgres-storage.ts`,
  `server/queries/index.ts`, `server/queries/controller/merge-run-history-collection-rate.sql`
  (new; `server/queries/spine/get-run-latest-collection-rate-event.sql` deleted),
  `lib/spine.ts`, `lib/postgres-spine.ts`.
- One named risk (unchanged from §7/R7.5, not newly introduced): every current
  `run_history` reader that must stay scheduler-only already fences on
  `scheduler_managed`; a future reader must audit this before consuming `run_history`
  for cadence/backoff purposes.
