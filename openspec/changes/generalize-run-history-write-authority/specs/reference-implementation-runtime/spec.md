## ADDED Requirements

### Requirement: `run_history` SHALL be a kind-neutral, run-grain durable projection written at run.started and finalized at the terminal event

The reference runtime SHALL maintain one `run_history` row per `run_id`, created when
`run.started` is emitted (status `running`) and finalized when the run's terminal spine
event (`run.completed`/`run.failed`/`run.cancelled`) is emitted — for every run kind
(scheduled, manual, browser-triggered, owner-cancelled), not only scheduler-dispatched
runs. The write SHALL be idempotent under retried or duplicate emission of either the
started or the terminal event for the same `run_id`.

#### Scenario: A scheduled run's started and terminal events produce exactly one finalized row

- **GIVEN** the scheduler dispatches a run for a connector instance
- **WHEN** `run.started` is emitted, followed by `run.completed`
- **THEN** `run_history` SHALL contain exactly one row for that `run_id`
- **AND** the row's `status` SHALL be `running` after `run.started` and the terminal
  status after the terminal event
- **AND** the row's `completed_at` SHALL be null until the terminal event finalizes it

#### Scenario: A manual run invoked directly (not through the scheduler) still produces a row

- **GIVEN** a run is started via `runtime/controller.ts`'s `runNow`, bypassing the
  scheduler's own run-executor entirely
- **WHEN** its `run.started` and terminal spine events are emitted
- **THEN** `run_history` SHALL contain exactly one row for that `run_id`, with
  `trigger_kind` carrying whatever value the run supplied (e.g. `manual`, `webhook`)
- **AND** the row's `scheduler_managed` flag SHALL be false, since the scheduler's own
  write path never touched it

#### Scenario: A retried `run.started` for the same run_id is a no-op

- **GIVEN** a `run_history` row already exists for a `run_id` (created by a prior
  `run.started` emission)
- **WHEN** `run.started` is emitted again for the same `run_id` (a retry or duplicate
  delivery)
- **THEN** no second row SHALL be created and the existing row SHALL be unchanged

#### Scenario: A retried terminal event for an already-finalized run_id is a no-op

- **GIVEN** a `run_history` row has already been finalized to a terminal status for a
  `run_id`
- **WHEN** a terminal event is emitted again for the same `run_id` (a retry or duplicate
  delivery, possibly with a different terminal event type)
- **THEN** the row's status SHALL remain the first-finalized terminal status
- **AND** no second row SHALL be created

#### Scenario: A terminal event with no prior started row still produces a finalized row

- **GIVEN** no `run.started` was ever recorded for a `run_id` (the started write raced,
  was lost, or predates this writer)
- **WHEN** a terminal event is emitted for that `run_id`
- **THEN** `run_history` SHALL contain exactly one row for that `run_id`, already in its
  terminal state

### Requirement: The scheduler's own run-history write SHALL merge onto the same row rather than create a duplicate

The scheduler's `appendRunHistory` call (its own richer terminal record, carrying
`attempt`, `checkpoint_summary_json`, `known_gaps_json`, `reported_records_emitted`)
SHALL upsert onto the `run_history` row the run.started/terminal spine-event writer
already created or finalized for the same `run_id`, marking it `scheduler_managed`,
rather than creating a second row for the same run.

#### Scenario: A scheduled run produces one row enriched by both write paths

- **GIVEN** a scheduled run's `run.started`/terminal spine events have already created
  and finalized a `run_history` row for its `run_id`
- **WHEN** the scheduler's own `appendRunHistory` call runs afterward for the same
  `run_id`
- **THEN** `run_history` SHALL still contain exactly one row for that `run_id`
- **AND** that row SHALL carry the scheduler's enrichment fields (`attempt`,
  `checkpoint_summary_json`, etc.) and `scheduler_managed` SHALL be true

### Requirement: Scheduler cadence/backoff readers SHALL stay scoped to `scheduler_managed` rows

Any reader of `run_history` used for scheduler cadence, backoff, or in-memory history
hydration purposes SHALL filter to `scheduler_managed` rows only, so a run that never
passed through the scheduler's own dispatch path does not silently begin influencing
scheduler backoff or cadence decisions as a side effect of this generalization.

#### Scenario: A direct/manual run's new row does not affect scheduler backoff hydration

- **GIVEN** a manual run invoked via `runtime/controller.ts`'s `runNow` has produced a
  `run_history` row that is not `scheduler_managed`
- **AND** a separate scheduled run for a different connector instance has produced a
  `scheduler_managed` row
- **WHEN** the scheduler hydrates its in-memory run-history projection from
  `run_history` on boot
- **THEN** the hydrated history SHALL include the scheduled run's row
- **AND** SHALL NOT include the manual run's row

### Requirement: Existing LIST readers SHALL remain unchanged in visible output by this generalization

The connector-summary LIST fallback readers (`getLatestRunHistoryForConnection`,
`listLatestRunHistoryByConnectionIds`) SHALL continue to produce byte-identical output
to their pre-generalization behavior: scoped to `scheduler_managed`, terminal
(`status <> 'running'`) rows only. Widening these readers to surface every run kind is
explicitly out of scope for this change and reserved for a later, deliberate slice.

#### Scenario: A manual run's new row does not change LIST's last-run-facts fallback

- **GIVEN** a connection has no prior scheduler-dispatched run, but a manual run has
  produced a non-`scheduler_managed` `run_history` row for it
- **WHEN** the connector-summary LIST projection reads the last-run-facts fallback for
  that connection
- **THEN** the fallback SHALL return the same result as before this change (no row),
  not the manual run's new row

### Requirement: A database migrated from the legacy `scheduler_run_history` schema SHALL accept the generalized writer's `run.started` insert

The legacy `scheduler_run_history` schema declared `completed_at NOT NULL` (every row
was written post-terminal, in one shot). The generalized `run.started` write
deliberately leaves `completed_at` unset until the terminal event finalizes the row.
The `scheduler_run_history` → `run_history` migration, on both SQLite and PostgreSQL,
SHALL relax `completed_at` to nullable as part of the migration, so that a database
migrated from the legacy schema accepts a `run.started` insert the same way a
fresh-install database already does. This applies to every already-deployed instance,
since a fresh install never has `scheduler_run_history` to trigger the migration at all.

#### Scenario: `run.started` succeeds against a database migrated from legacy `scheduler_run_history`

- **GIVEN** a database with a legacy-shaped `scheduler_run_history` table
  (`completed_at TEXT NOT NULL`, no `trigger_kind`/`facts_json`/`scheduler_managed`
  columns) and at least one pre-existing terminal row
- **WHEN** the migration runs (rename to `run_history`, add the new columns)
- **THEN** `run_history.completed_at` SHALL be nullable
- **AND** a `run.started` spine event for a new `run_id` SHALL successfully create a
  `run_history` row with `status = 'running'` and `completed_at = NULL`
- **AND** the pre-existing legacy row's data (including its own non-null
  `completed_at`) SHALL be unchanged, and it SHALL be marked `scheduler_managed`

#### Scenario: A fresh install is unaffected by the migrated-database fix

- **GIVEN** a database with no pre-existing `scheduler_run_history` table
- **WHEN** the database is initialized
- **THEN** exactly one `run_history` table SHALL exist, with `completed_at` nullable
  from the `CREATE TABLE` statement — the legacy-migration path (including its
  `completed_at` nullability fix) SHALL NOT run at all
