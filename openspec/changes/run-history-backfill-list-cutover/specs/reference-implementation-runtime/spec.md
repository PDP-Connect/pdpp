## MODIFIED Requirements

### Requirement: Existing LIST readers SHALL remain unchanged in visible output by this generalization

The connector-summary LIST/detail composition (`getConnectorSummaryForRoute`,
`getConnectorDetail`, `listConnectorSummaries`, `listConnectorSummaryPage`,
`getOwnerConnectionDiagnostics`) SHALL read `run_history` for every run kind — no
`scheduler_managed` scope — composed with the page-scoped active-run/lease overlay,
superseding the prior byte-identical-output constraint for this read path
specifically. Scheduler cadence/backoff readers (`getLatestRunHistoryForConnection`,
`listLatestRunHistoryByConnectionIds`, `listRunHistory`) SHALL remain unaffected and
scoped to `scheduler_managed` rows exactly as established.

#### Scenario: A manual run's row is now visible to the product LIST/detail composition

- **GIVEN** a connection has no prior scheduler-dispatched run, but a manual run has
  produced a non-`scheduler_managed` `run_history` row for it
- **WHEN** the connector-summary LIST/detail projection reads run facts for that
  connection
- **THEN** the projection SHALL return the manual run's facts (status, timestamps,
  `collection_facts`/`known_gaps`/`recovery_only` from `facts_json`), not an empty
  result

#### Scenario: Scheduler cadence hydration is unaffected by the product LIST cutover

- **GIVEN** the same manual run's non-`scheduler_managed` row exists
- **WHEN** the scheduler hydrates its in-memory run-history projection from
  `run_history` on boot (`listRunHistory`/`getLatestRunHistoryForConnection`/
  `listLatestRunHistoryByConnectionIds`)
- **THEN** the hydrated history SHALL NOT include the manual run's row — unchanged from
  before this slice

## ADDED Requirements

### Requirement: Historical spine-only runs SHALL be backfilled into `run_history` via a bounded, resumable maintenance-sweep stage

Every run whose lifecycle predates or bypassed the generalized run-grain writer SHALL
be discovered and folded into `run_history` by a bounded, resumable stage running on
the existing connector-maintenance-sweep chassis (periodic tick plus a fire-and-forget
startup accelerator) — never a synchronous startup-blocking loop, never a new table.
The stage SHALL reuse the existing, unmodified event-fold logic
(`summarizeEvents`/`postgresFoldRunSummariesByIds`) rather than re-deriving run status.
A concurrent live terminal write for the same `run_id` SHALL always win over a backfill
insert for that run_id.

#### Scenario: A historical spine-only run is backfilled with the fold-derived status

- **GIVEN** a run's `run.started`/terminal spine events exist but it has no
  `run_history` row (predates the generalized writer)
- **WHEN** the backfill stage's bounded round processes the batch containing this run
- **THEN** `run_history` SHALL contain exactly one row for that `run_id`, with `status`
  equal to the terminal status the existing fold derives from the run's event window
- **AND** `facts_json` SHALL carry `origin: "backfill"` plus the same
  `collection_facts`/`known_gaps`/`recovery_only`/browser-surface fields the live
  writer captures, extracted from the terminal event's raw data

#### Scenario: A legacy connector-wide run is attributed once, at backfill time, only when unambiguous

- **GIVEN** a run's event window never resolves a `connector_instance_id` or
  `connection_id` (a legacy connector-wide run predating connection identity on the
  spine)
- **AND** the connector currently has exactly one active, owner-visible instance
- **WHEN** the backfill stage processes this run
- **THEN** `run_history` SHALL contain one row for this run_id, attributed to that sole
  active instance

#### Scenario: An unattributable legacy connector-wide run is never inserted

- **GIVEN** the same legacy connector-wide run window, but the connector currently has
  zero or more than one active instance
- **WHEN** the backfill stage processes this run
- **THEN** no `run_history` row SHALL be created for this run_id (never surfaced — the
  column is `NOT NULL`, so there is no schema slot for an unattributed audit row)

#### Scenario: Backfill is idempotent under repeated or concurrent execution

- **GIVEN** a run has already been backfilled into `run_history`
- **WHEN** a subsequent backfill round (or a second concurrent sweep owner) processes
  a batch that would otherwise rediscover this run
- **THEN** the run SHALL be excluded from candidate discovery (already has a row) or,
  if concurrently discovered, its insert SHALL be a no-op via `ON CONFLICT(run_id) DO
  NOTHING`
- **AND** exactly one row SHALL exist for the run_id, with terminal facts unchanged
  from whichever write landed first

#### Scenario: The backfill cursor commits only after its batch lands, surviving a crash mid-batch

- **GIVEN** a backfill round processes a bounded batch of candidate runs
- **WHEN** the round completes and commits its cursor
- **THEN** the committed cursor position SHALL reflect only runs actually processed in
  that round
- **AND** a subsequent round (including one started by a freshly-constructed stage
  instance after a simulated crash) SHALL resume from that committed position without
  re-processing already-backfilled runs or skipping any candidate run

#### Scenario: A still-active run is never backfilled as a terminal row

- **GIVEN** a candidate run's event window shows `run.started` with no terminal event
  and an active lease
- **WHEN** the backfill stage encounters this run
- **THEN** no `run_history` row SHALL be inserted for it, and the cursor SHALL NOT
  advance past this run's `event_seq` — its own live writer (once it terminates) or a
  later backfill pass (once it is discovered orphaned) owns this row

### Requirement: The product LIST/detail active-run overlay SHALL use only the existing status vocabulary

The read-time composition of a `running` `run_history` row with the page-scoped
active-run/lease overlay SHALL produce only status values `summarizeEvents` already
produces (`in_progress`, `failed`, or the row's own stored terminal status) — never a
new status enum value.

#### Scenario: A running row with a live lease renders in_progress

- **GIVEN** a `run_history` row with `status = 'running'`
- **AND** a live entry in the active-run/lease registry for the same `run_id`
- **WHEN** the product LIST/detail composition reads this connection's run facts
- **THEN** the composed status SHALL be `in_progress`

#### Scenario: A running row with no lease renders failed (orphaned)

- **GIVEN** a `run_history` row with `status = 'running'`
- **AND** no entry in the active-run/lease registry for this `run_id` (e.g. a crashed
  process left the row running)
- **WHEN** the product LIST/detail composition reads this connection's run facts
- **THEN** the composed status SHALL be `failed` — matching what the pre-cutover
  spine fold rendered for the same orphaned-run shape

### Requirement: Authenticated GET on the connector-summary LIST/detail routes SHALL perform zero `spine_events` statements

`listConnectorSummaries`, `listConnectorSummaryPage`, `getConnectorSummaryForRoute`,
`getConnectorDetail`, and `getOwnerConnectionDiagnostics` SHALL read run facts
exclusively from `run_history` and the page-scoped active-run/lease overlay — never
`spine_events`, and never a write, on the request path. This bar admits no
route-specific or feature-specific exception: every fact the projection synthesizes,
including the adaptive-rate-controller's `collection_rate` snapshot for a currently-running
run, SHALL be sourced from `run_history.facts_json` alone.

#### Scenario: A GET on the connector-summary route touches no spine_events statement for a terminal run

- **GIVEN** a connection with a backfilled or live-written terminal `run_history` row
- **WHEN** `getConnectorSummaryForRoute` (or any of the other four routes) is invoked
- **THEN** the set of SQL statements executed during that call SHALL contain zero
  statements referencing `spine_events`

#### Scenario: A GET on the connector-summary route touches no spine_events statement for a currently-running run

- **GIVEN** a connection with a `run_history` row still `status = 'running'`, whose
  `run.progress_reported` event has merged a `collection_rate` snapshot into its
  `facts_json`
- **WHEN** `getConnectorSummaryForRoute` (or any of the other four routes) is invoked
- **THEN** the set of SQL statements executed during that call SHALL contain zero
  statements referencing `spine_events`
- **AND** the synthesized summary's adaptive-rate-controller snapshot SHALL reflect the
  merged `collection_rate` value
- **AND** this SHALL hold on both the SQLite and PostgreSQL backends

#### Scenario: A GET on the connector-summary route touches no spine_events statement for a connection with no run at all

- **GIVEN** a connection with no `run_history` row
- **WHEN** `getConnectorSummaryForRoute` (or any of the other four routes) is invoked
- **THEN** the set of SQL statements executed during that call SHALL contain zero
  statements referencing `spine_events`

### Requirement: `run.progress_reported`'s `collection_rate` SHALL be merged into a still-running run's `facts_json` atomically, never overwriting a concurrent terminal write

The run-history writer SHALL merge `collection_rate` into the `running` row's
`facts_json` at each `run.progress_reported` event, using a single atomic
statement scoped by `WHERE run_id = ? AND status = 'running'`. A concurrent or
later terminal write SHALL always win: once a row has been finalized, a
progress-event merge for the same `run_id` SHALL be a silent no-op.

#### Scenario: A progress event's collection_rate is merged into the running row

- **GIVEN** a `run_history` row exists with `status = 'running'`
- **WHEN** a `run.progress_reported` event carrying `collection_rate` is emitted for
  that `run_id`
- **THEN** the row's `facts_json` SHALL contain the merged `collection_rate` value
- **AND** the row's `status` SHALL remain `running`

#### Scenario: A stale progress event after finalization does not resurrect or overwrite the terminal row

- **GIVEN** a `run_history` row has already been finalized to a terminal status
- **WHEN** a `run.progress_reported` event carrying a different `collection_rate` is
  emitted for the same `run_id` (a stale/delayed delivery)
- **THEN** the row SHALL remain unchanged — its `facts_json` SHALL NOT be overwritten
  by the stale progress event's payload

### Requirement: The `completed_at` nullable repair SHALL reach a database whose `scheduler_run_history` → `run_history` rename already executed under an earlier deployment

The repair that relaxes `run_history.completed_at` from the legacy `NOT NULL`
constraint SHALL run based on `run_history`'s own existence and column state,
independent of whether `scheduler_run_history` still exists — so a database migrated
under any deployment ordering converges to the nullable column, not only a database
migrated for the first time after the repair shipped.

#### Scenario: A database whose rename predates the completed_at fix is repaired on its next boot

- **GIVEN** a database where `run_history` already exists (renamed from
  `scheduler_run_history` by an earlier deployment) with `completed_at` still `NOT
  NULL`, and no `scheduler_run_history` table remains
- **WHEN** the database is initialized
- **THEN** `run_history.completed_at` SHALL become nullable
- **AND** a subsequent `run.started` write (with `completed_at` unset) SHALL succeed
- **AND** every pre-existing row's data, `id` value, and both of `run_history`'s
  indexes SHALL be preserved exactly
- **AND** this SHALL hold on both the SQLite and PostgreSQL backends

#### Scenario: The repair is idempotent

- **GIVEN** a database has already been repaired by a prior boot (completed_at is
  nullable)
- **WHEN** the database is initialized again
- **THEN** the repair SHALL no-op, and existing row data SHALL remain unchanged

#### Scenario: A fresh install is unaffected by the repair

- **GIVEN** a database with no pre-existing `run_history` artifacts of any kind
- **WHEN** the database is initialized
- **THEN** `run_history` SHALL be created with `completed_at` nullable from its
  `CREATE TABLE` statement, and the repair SHALL no-op immediately

### Requirement: `run_history`'s uniqueness, conflict, and identity key SHALL be `(run_id, connector_instance_id)`, never `run_id` alone

`run_id` is minted independently by multiple call sites with no connection-scoped
entropy and is NOT globally unique — two different connections CAN legitimately
produce the identical `run_id` string. Every unique index, `ON CONFLICT` target, and
identity-fencing predicate on `run_history` SHALL therefore key on the pair `(run_id,
connector_instance_id)`, never on `run_id` alone. No compatibility read path, and no
swallowed/fail-open index-creation error, SHALL exist for this key.

#### Scenario: Two different connections independently producing the same run_id each get their own row

- **GIVEN** two distinct connections whose independently-minted `run_id` values are
  identical (a genuine collision, not a retry)
- **WHEN** both connections' `run.started` events are written
- **THEN** `run_history` SHALL contain two separate rows, one per connection, neither
  overwriting nor blocking the other
- **AND** this SHALL hold on both the SQLite and PostgreSQL backends

#### Scenario: A progress or terminal write for one connection never affects another connection's row sharing the same run_id

- **GIVEN** two `run_history` rows sharing a `run_id` but belonging to different
  connections, one still `status = 'running'`
- **WHEN** a `run.progress_reported` or terminal spine event for ONE of those
  connections is written
- **THEN** only that connection's row SHALL be modified
- **AND** the other connection's row SHALL remain completely unchanged, regardless of
  its own status

#### Scenario: The unique index builds successfully over historical data containing duplicate run_ids across distinct connections

- **GIVEN** a database whose `run_history` table already contains two or more rows
  sharing a `run_id` value, each belonging to a distinct `connector_instance_id`
- **WHEN** the database is initialized (fresh install, post-rename migration, or
  post-`completed_at`-repair index recreation)
- **THEN** the composite `(run_id, connector_instance_id)` unique index SHALL be
  created successfully, with no error and no fail-open/swallowed-exception path
- **AND** every pre-existing row SHALL be preserved exactly — none deleted, collapsed,
  or relabeled

#### Scenario: The backfill stage discovers and folds each connection's run separately, never blending their event windows

- **GIVEN** `spine_events` contains lifecycle events for two distinct connections that
  independently used the same `run_id`, and neither has a `run_history` row yet
- **WHEN** the backfill stage's candidate discovery and fold run
- **THEN** the two connections SHALL be discovered as two separate candidates (keyed
  on the pair, not bare `run_id`)
- **AND** each candidate SHALL be folded using ONLY its own connection's events —
  never a window blended with the other connection's events
- **AND** two separate `run_history` rows SHALL result, each with status/facts
  reflecting only its own connection's actual event history

### Requirement: An interrupted `scheduler_run_history` -> `run_history` rename migration SHALL reconcile losslessly, never refuse or delete data

If a database's rename migration is interrupted after `run_history` has already been
populated (via a completed rename plus live/backfill writes) but before
`scheduler_run_history` was dropped — leaving both tables present with real data, for
example because a candidate deployment carrying the migration was rolled back to a
revision that predates `run_history` entirely and resumed writing to a
freshly-recreated `scheduler_run_history` — the migration SHALL reconcile
`scheduler_run_history`'s rows into `run_history` rather than throw. The merge, its
completeness verification, and the eventual `DROP TABLE scheduler_run_history` SHALL
execute as one all-or-nothing transaction. No `scheduler_run_history` row's numeric
`id` SHALL ever be reused as a `run_history` id.

#### Scenario: A composite-identity row present in both tables merges via the established upsert contract

- **GIVEN** a `run_history` row and a `scheduler_run_history` row share the same
  `(run_id, connector_instance_id)` pair, with divergent field values
- **WHEN** the interrupted-migration reconciliation runs
- **THEN** the `scheduler_run_history` row's fields SHALL win on every field the
  scheduler's own `appendRunHistory` upsert contract already updates (`status`,
  `attempt`, `completed_at`, `records_emitted`, etc.)
- **AND** fields `scheduler_run_history` never carried (`facts_json`, `trigger_kind`)
  SHALL be left exactly as they were in the pre-existing `run_history` row
- **AND** exactly one row SHALL exist afterward for this identity — never two

#### Scenario: Rows present in only one table are preserved exactly

- **GIVEN** a `scheduler_run_history` row whose `(run_id, connector_instance_id)` has
  no matching `run_history` row (a write that landed only after the interrupted
  candidate's rename completed), and a `run_history` row with no matching
  `scheduler_run_history` row (e.g. a backfilled historical run)
- **WHEN** the interrupted-migration reconciliation runs
- **THEN** both rows SHALL be preserved in `run_history` afterward, unmodified
  (the `scheduler_run_history`-only row landing under a freshly-assigned `run_history`
  id, never its own legacy numeric id)

#### Scenario: A duplicate run_id across two different connections, split across the two tables, never collapses

- **GIVEN** `run_history` holds a row for `(run_id, connector_instance_id_A)` and
  `scheduler_run_history` holds a row for the SAME `run_id` but
  `connector_instance_id_B` (a genuine cross-connection collision, not a duplicate
  write)
- **WHEN** the interrupted-migration reconciliation runs
- **THEN** both rows SHALL exist afterward in `run_history`, each under its own
  connection's identity — neither overwriting nor merging with the other

#### Scenario: A run_id-IS-NULL scheduler_run_history row is preserved without collision

- **GIVEN** a `scheduler_run_history` row has no `run_id` (e.g. a skipped run)
- **WHEN** the interrupted-migration reconciliation runs
- **THEN** this row SHALL be inserted into `run_history` exactly once, under a fresh
  `run_history` id

#### Scenario: The reconciliation is idempotent across a crash before commit

- **GIVEN** a reconciliation transaction inserts rows into `run_history` but crashes
  (or is otherwise interrupted) before it commits
- **WHEN** the process restarts and the transaction is never committed
- **THEN** `scheduler_run_history` SHALL remain completely unmodified (no partial
  merge state), `run_history` SHALL contain none of the crashed attempt's inserted
  rows, and a subsequent clean boot SHALL reconcile successfully from the untouched
  pre-crash state
- **AND** this SHALL hold on both the SQLite and PostgreSQL backends

#### Scenario: A legacy-only migration (no interruption) is unaffected

- **GIVEN** `scheduler_run_history` exists and `run_history` does not exist, or exists
  but is empty
- **WHEN** the rename migration runs
- **THEN** the existing pure-rename behavior SHALL apply unchanged — this requirement
  adds a new branch for the both-non-empty case only, and does not alter the
  already-established fresh-install or legacy-only-migration paths
