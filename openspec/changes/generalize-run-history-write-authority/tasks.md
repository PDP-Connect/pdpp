## 1. Schema rename and column additions (both backends)

- [x] SQLite: rename `scheduler_run_history` to `run_history` in `SCHEMA`
      (fresh installs); add `migrateRunHistoryRename` for upgrades, guarded
      on legacy-table existence and running BEFORE `raw.exec(SCHEMA)` so
      `SCHEMA`'s own `CREATE TABLE IF NOT EXISTS run_history` cannot win
      the race and strand real data under the old name.
- [x] PostgreSQL: same rename + guard, `migratePostgresRunHistoryRename`,
      run before the schema-bootstrap `CREATE TABLE IF NOT EXISTS
      run_history` for the same reason.
- [x] Add `trigger_kind`, `facts_json`, `scheduler_managed` columns on
      both backends; nullable `completed_at`/`run_id`; `attempt` default.
- [x] Add a unique partial index on `run_id` (`WHERE run_id IS NOT
      NULL`) on both backends, created as a separate non-transactional
      step that fails open (logs, does not block the rename) if historical
      duplicate `run_id` rows exist.
- [x] Fix `migrateSchedulerInstanceColumns` (SQLite) and
      `migratePostgresSchedulerInstanceColumns` (both predate the
      generalization and hardcode the legacy table name) to no-op cleanly
      when `scheduler_run_history` no longer exists, instead of erroring
      against a table that was never created under that name.
- [x] Update `scripts/migrate-storage/schema.ts` and
      `scripts/migrate-storage/postgres-target.ts` table-name lists.

## 2. Kind-neutral idempotent writer

- [x] Add `server/stores/run-history-writer.ts`: `writeSqliteRunHistoryForSpineEvent`
      and `writePostgresRunHistoryForSpineEvent`, both keyed on
      `run.started` (create `running` row) vs. terminal event types
      (finalize, with an insert-already-terminal fallback).
- [x] Hook `emitSpineEvent` (`lib/spine.ts`) to call the SQLite writer on
      the same synchronous connection as the spine-event insert.
- [x] Hook `postgresEmitSpineEvent` (`lib/postgres-spine.ts`) to wrap the
      spine-event insert and the run_history write in one
      `withPostgresTransaction` call for run/terminal event types only
      (every other spine event type keeps its original single-statement
      write).
- [x] Reassemble `connector_error_json`/`terminal_reason` from the
      executor's flattened terminal-event fields
      (`connector_error_code`/`connector_error_message`/
      `connector_error_retryable`, `data.reason`) rather than a
      nonexistent nested `connectorError` object.
- [x] Fix SQLite/PostgreSQL `ON CONFLICT(run_id)` syntax to repeat the
      partial index's `WHERE run_id IS NOT NULL` clause verbatim — both
      backends require the conflict target to match the index exactly.

## 3. Scheduler write-path merge (no duplicate authority)

- [x] Change `insert-run-history.sql` (SQLite) and
      `scheduler-store.ts`'s PostgreSQL `appendRunHistory` from a plain
      insert to `ON CONFLICT(run_id) ... DO UPDATE`, merging
      scheduler-only enrichment fields (`attempt`,
      `checkpoint_summary_json`, `known_gaps_json`,
      `reported_records_emitted`) onto the row the spine hook already
      created/finalized for the same `run_id`, and setting
      `scheduler_managed = true`.

## 4. Reader audit — scheduler-only semantics fenced

- [x] Scope `getLatestRunHistoryForConnection`,
      `listLatestRunHistoryByConnectionIds`, and `listRunHistory` (both
      backends) to `status <> 'running' AND scheduler_managed`, so their
      visible output is unchanged from before this generalization —
      LIST's fallback and the scheduler's cadence/backoff hydration
      (`runtime/scheduler.ts` `hydratePersistence`,
      `runtime/controller.ts` `getLastRunTimeMs`/
      `loadScheduleHistoryIndex`, `dispatch-governor.ts`
      `evaluateBackoffDispatch`) all consume these three methods.
- [x] Verify `getLastSuccessfulRunAt` (the cross-path success probe)
      correctly reads from the spine directly and is unaffected — it
      deliberately sees every run kind, by design, unrelated to
      `run_history`.
- [x] Update stale comments referencing `scheduler_run_history` by the old
      name across `server/index.ts`, `server/scheduler-manager-factory.ts`,
      `runtime/controller.ts`, `runtime/scheduler/dispatch-governor.ts`.

## 5. Tests

- [x] `test/run-history-writer-authority.test.ts` (new): started->finalized
      transition for scheduled/manual/browser/cancelled run kinds;
      idempotency under retried `run.started`; idempotency under retried
      terminal events; fallback insert when no started row exists;
      scheduler `appendRunHistory` merges onto the spine-hook row instead
      of duplicating; `listRunHistory` stays scoped to `scheduler_managed`.
- [x] Fix pre-existing legacy-schema test fixtures
      (`test/scheduler-store-semantic-surface.test.ts`,
      `test/connector-instances-acceptance.test.ts`) that dropped/recreated
      `scheduler_run_history` after an `initDb` call that now creates
      `run_history` directly.
- [x] Fix `test/ref-connectors-connection-projection.test.ts`'s premise
      assertion (a manual run now legitimately creates a non-
      `scheduler_managed` `run_history` row; the test asserted zero rows
      of any kind).
- [x] Fix `test/ref-connectors-local-coverage-green.test.ts`'s direct
      table reference.
- [x] Run the full scheduler/cadence test surface
      (`test/scheduler.test.ts`, `test/scheduler-cooldown-recovery-
      eligibility.test.ts`, `test/scheduler-source-pressure-cooldown-
      suppression.test.ts`, `test/scheduler-durable-admission-
      boundary.test.ts`, `test/scheduler-managed-surface-routing.test.ts`,
      `test/scheduler-direct-run-liveness.test.ts`,
      `test/owner-connection-schedule.test.ts`,
      `test/controller-instance-runtime.test.ts`) and confirm unchanged
      pass/fail status.
- [x] `pnpm run typecheck` clean; `ultracite check` clean on all touched
      files.

## 6. Out of scope (deferred to later slices)

- [ ] Cut LIST over to reading `run_history` as primary (currently only
      the fallback path, unchanged by this slice).
- [ ] Bounded backfill of historical spine-only runs into `run_history`
      on the existing maintenance-sweep chassis (R7.3).
- [ ] Live active/in-progress overlay composition at read time (R7.2).

## 7. REVISE fix (2026-07-30 gate finding): legacy-migrated `completed_at` NOT NULL

- [x] Root cause: the legacy `scheduler_run_history` schema declared
      `completed_at TEXT NOT NULL` (every row was written post-terminal,
      in one shot). `migrateRunHistoryRename`/`migratePostgresRunHistoryRename`
      only renamed the table and added columns — they never relaxed that
      surviving `NOT NULL` constraint. The generalized writer's
      `run.started` INSERT deliberately leaves `completed_at` unset (the
      row sits in `running` state until the terminal event finalizes it),
      so on any already-deployed database (the majority case — every
      running instance already has `scheduler_run_history`; only a fresh
      install gets the nullable column for free) every `run.started` write
      of every run kind threw at the moment a run started.
- [x] SQLite fix: `migrateRunHistoryRename` now checks
      `pragma_table_info('run_history').completed_at.notnull` after the
      rename/`ADD COLUMN` steps and, if still `NOT NULL`, rebuilds the
      table (`run_history_new` with the fresh-install nullable-`completed_at`
      column defs, explicit-column-list `INSERT ... SELECT` preserving
      `id` values verbatim, `DROP TABLE`, `RENAME`) inside the same
      transaction as the rest of the migration. SQLite has no
      `ALTER COLUMN`; this is the standard rebuild pattern already used
      elsewhere in `server/db.ts` (e.g. `migrateBrowserSurfaceLeaseEnumChecks`).
- [x] PostgreSQL fix: `migratePostgresRunHistoryRename` adds
      `ALTER TABLE run_history ALTER COLUMN completed_at DROP NOT NULL`
      inside the existing migration transaction, alongside the other
      `ADD COLUMN` calls.
- [x] Regression tests added to `test/run-history-writer-authority.test.ts`
      (both backends): build a legacy-shaped fixture matching the real
      pre-migration production schema exactly, re-run the migration path
      (`initDb`/`initPostgresStorage`), assert `completed_at` is nullable
      post-migration, then assert a real `emitSpineEvent`/
      `postgresEmitSpineEvent` `run.started` call succeeds against the
      migrated table and the pre-existing legacy row's data survives
      intact. The PostgreSQL test runs live against the sanctioned
      disposable instance (`postgresql://postgres:pdpp_test@127.0.0.1:55447/pdpp_test`),
      skipped only when `PDPP_TEST_POSTGRES_URL` is unset.
- [x] Mutation-proved: reverting the fix (stashed both migration-function
      edits) reproduces the exact failure on both backends — SQLite fails
      the nullability assertion deterministically; PostgreSQL fails the
      same assertion live against the real disposable database. Fix
      restored, tests re-run green, confirmed idempotent across repeated
      runs (ran twice back-to-back with no state pollution).
- [x] Fresh-install behavior verified unaffected: a brand-new `initDb()`
      with no legacy table produces exactly one `run_history` table with
      `completed_at` nullable — the `legacyExists` guard at the top of
      `migrateRunHistoryRename` short-circuits the entire function
      (including the new rebuild step) when there is nothing to migrate.
- [x] `pnpm run typecheck` clean; `ultracite check` clean on
      `server/db.ts`, `server/postgres-storage.ts`,
      `test/run-history-writer-authority.test.ts`.
- [x] Broader regression sweep re-run clean after the fix: full
      `test/run-history-writer-authority.test.ts` (8/8, both backends),
      `test/scheduler-store-semantic-surface.test.ts` (13/13, both
      backends including the live Postgres page-batch test),
      `test/connector-instances-acceptance.test.ts`,
      `test/ref-connectors-connection-projection.test.ts`,
      `test/ref-connectors-local-coverage-green.test.ts`,
      `test/run-connection-identity-authority.test.ts`.
