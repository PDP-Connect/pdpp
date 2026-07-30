## Why

`scheduler_run_history` was scheduler-only: only `runtime/scheduler/run-executor.ts`
called `appendRunHistory`, so manual (`controller.runNow`), browser-triggered, and
owner-cancelled runs never produced a durable run-facts row. `terminal-read-architecture-
fable-0730.md` §7 (R7.1) ruled that the terminal owner of last-run/last-success facts
should be a run-grain durable projection written by the run executor itself, generalizing
`scheduler_run_history` to every run kind, rather than folding a second grain into
`connector_summary_evidence`.

This change is **Authority Slice A** of that ruling, scoped narrowly per direction
received mid-implementation: land the generalized write authority (schema rename +
idempotent started/finalize writer wired to every run kind) without touching LIST
readers or backfilling historical spine-only runs. Those are separate, later slices —
this slice's readers (`getLatestRunHistoryForConnection`, `listLatestRunHistoryByConnectionIds`,
`listRunHistory`) are scoped to stay byte-identical in visible output to before this
change landed.

## What Changes

- Rename `scheduler_run_history` to `run_history` on both SQLite and PostgreSQL,
  losslessly, with a migration on each backend guarded so it only fires when the
  legacy table still exists.
- Add `trigger_kind` (indexed scalar), `facts_json` (bounded remaining-facts payload),
  and `scheduler_managed` (provenance flag) columns; make `completed_at`/`run_id`/`attempt`
  accommodate a `running`-status row created at start. Critically, `completed_at`'s
  legacy `NOT NULL` constraint is explicitly relaxed by the migration (PostgreSQL:
  `ALTER COLUMN ... DROP NOT NULL`; SQLite: a table rebuild, since `ALTER COLUMN`
  isn't supported) — a 2026-07-30 gate found this initially missed, which made every
  `run.started` write throw on any already-deployed database (the majority deploy
  path; see "REVISE fix" in `tasks.md` §7).
- Add a unique partial index on `run_id` (`WHERE run_id IS NOT NULL`) for idempotency.
- Hook `emitSpineEvent` (`lib/spine.ts`, both the SQLite synchronous path and the
  PostgreSQL async path via `lib/postgres-spine.ts`) so every `run.started` event creates
  a `running`-status `run_history` row, and every terminal event
  (`run.completed`/`run.failed`/`run.cancelled`) finalizes it — for every run kind, not
  just scheduler-dispatched ones.
- Make the write idempotent under retried/duplicate emissions: `run.started` is
  `INSERT ... ON CONFLICT(run_id) DO NOTHING`; the terminal write is
  `UPDATE ... WHERE run_id = ? AND status = 'running'`, falling back to an
  `ON CONFLICT DO NOTHING` insert if no `running` row exists (a lost/raced start).
- Add a `scheduler_managed` provenance flag, set only by the scheduler's own
  `appendRunHistory` write path (now an upsert onto the same row instead of a
  duplicate insert), so scheduler cadence/backoff readers can stay scoped to
  exactly the rows they saw before this generalization — a manual/browser run's
  new `run_history` row does not silently start influencing scheduler backoff math.
- Rename the SQL query artifacts and registry keys from `*SchedulerRunHistory*` to
  `*RunHistory*`; add `start-run-history.sql`, `finalize-run-history.sql`,
  `insert-finalized-run-history.sql`.

## What Does NOT Change (explicitly out of scope for this slice)

- LIST output: `getLatestRunHistoryForConnection`/`listLatestRunHistoryByConnectionIds`
  (the `_ref/connectors` fallback readers) stay scoped to `status <> 'running' AND
  scheduler_managed`, matching their pre-change visible output exactly. Widening this
  fallback to every run kind is a deliberate follow-up slice.
- The read-time spine CTEs (`postgres-spine.ts:1350-1399`, `lib/spine.ts`) are untouched.
- No backfill of historical spine-only runs into `run_history`.
- No `openspec` capability spec changes to `reference-connection-health` or similar —
  this slice's effect is entirely in the write path and storage layer.

## Impact

- Affected capability: `reference-implementation-runtime` (run lifecycle, scheduler
  cadence/backoff).
- Affected code: `server/db.ts`, `server/postgres-storage.ts`, `lib/spine.ts`,
  `lib/postgres-spine.ts`, `server/stores/scheduler-store.ts`, new
  `server/stores/run-history-writer.ts`, `server/queries/controller/*.sql`,
  `scripts/migrate-storage/*.ts`.
- One named risk (R7.5, accepted and fenced): generalizing the write path makes
  manual/browser/cancelled runs visible to any future `run_history` reader that
  doesn't explicitly scope to `scheduler_managed`. This slice's own new readers all do;
  future readers must audit this column before consuming `run_history` for
  cadence/backoff purposes.
