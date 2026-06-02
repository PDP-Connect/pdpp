# reference-implementation-runtime — Owner Run Cancellation Control

## MODIFIED Requirements

### Requirement: Controller SHALL expose safe owner run controls

The reference runtime controller SHALL provide owner-only run control behavior for manual runs, pending interactions, active-run conflict detection, single-run cancellation, schedule management, and abandoned controller-managed run reconciliation.

#### Scenario: Manual run starts
- **WHEN** the owner starts a connector run through the reference control plane
- **THEN** the controller SHALL resolve a runnable connector path
- **AND** it SHALL persist an active controller-managed run record
- **AND** it SHALL return the run id and trace id

#### Scenario: Connector is already active
- **WHEN** the owner starts a manual run for a connector that already has an active controller-managed run
- **THEN** the controller SHALL reject the request with `run_already_active`
- **AND** it SHALL include the active run id

#### Scenario: Interaction response targets the current pending interaction
- **WHEN** the owner submits an interaction response for an active run with the current `interaction_id`
- **THEN** the controller SHALL deliver the response to the waiting runtime interaction
- **AND** it SHALL acknowledge the accepted status

#### Scenario: Interaction response is stale or absent
- **WHEN** the owner submits an interaction response for an unknown run, a finished run, a run with no pending interaction, or an interaction id that is not current
- **THEN** the controller SHALL reject the response
- **AND** it SHALL NOT deliver response data to a connector

#### Scenario: Owner requests cancellation of an active run
- **WHEN** the owner requests cancellation of an active controller-managed run by its `run_id`
- **THEN** the controller SHALL signal cancellation to only that run's in-flight runtime task
- **AND** it SHALL acknowledge a `cancel_requested` result with the run id
- **AND** it SHALL NOT signal, terminate, or clear any other active run

#### Scenario: Cancellation targets a missing or finished run
- **WHEN** the owner requests cancellation for a `run_id` that has no active controller-managed run, or for a run that already has a terminal event
- **THEN** the controller SHALL return a typed `no_active_run` or `already_terminal` result
- **AND** it SHALL NOT alter any run, record, schedule, grant, or connection

#### Scenario: Cancelled run clears only its active-run lock
- **WHEN** an owner-cancelled run reaches its terminal state
- **THEN** the controller SHALL clear the `controller_active_runs` row for only the cancelled run
- **AND** a later manual run for the same connector SHALL be admitted
- **AND** any sibling connector's active-run row SHALL remain unchanged

#### Scenario: Controller restarts with abandoned active runs
- **WHEN** the controller starts and finds persisted active controller-managed runs without a live in-memory owner
- **THEN** it SHALL reconcile those runs as abandoned
- **AND** it SHALL clear stale active-run locks so later manual runs for the same connector can start

#### Scenario: Schedule is managed
- **WHEN** the owner creates, lists, pauses, resumes, or deletes a connector schedule
- **THEN** the controller SHALL persist the schedule mutation
- **AND** connector list projections SHALL include configured schedule state

#### Scenario: Schedule projection includes policy context
- **WHEN** the owner lists connectors or schedules
- **THEN** schedule projections SHALL include the connector's recommended refresh policy when one is declared
- **AND** they SHALL expose enough current state to explain active run, last attempt, last success, next due time, paused/manual mode, and human-attention requirements

### Requirement: Runtime SHALL maintain checkpointed streaming integrity
The reference runtime SHALL stream records to the resource server in batches, flush a stream before staging that stream's `STATE`, and commit staged state only after terminal validation succeeds and state persistence is enabled. The reference runtime SHALL NOT commit staged state when a run is cancelled.

#### Scenario: Successful persistent run
- **WHEN** a connector emits scoped records, scoped state, and `DONE status="succeeded"` with a matching `records_emitted` count and compatible exit code
- **THEN** the reference runtime SHALL flush buffered records
- **AND** it SHALL persist staged state for each staged stream
- **AND** it SHALL report a checkpoint summary with `commit_status: "committed"`

#### Scenario: State persistence is disabled
- **WHEN** a connector run starts with `persistState` disabled
- **THEN** the reference runtime SHALL send `START.state` as null
- **AND** it SHALL NOT persist staged state
- **AND** it SHALL report a checkpoint summary with `commit_status: "disabled"`

#### Scenario: Checkpoint commit partially fails
- **WHEN** record ingest succeeds but committing one or more staged stream states fails after terminal success
- **THEN** the reference runtime SHALL fail the run as a runtime error
- **AND** it SHALL report how many state streams were staged and committed
- **AND** it SHALL include a known gap for the partial or missing checkpoint commit

#### Scenario: Terminal validation fails
- **WHEN** terminal exit code or `DONE.records_emitted` validation fails
- **THEN** the reference runtime SHALL fail the run as a connector protocol violation
- **AND** it SHALL report observed and reported record counts when they differ
- **AND** it SHALL NOT commit staged state

#### Scenario: Run is cancelled before terminal success
- **WHEN** a run is cancelled and its connector child exits without emitting `DONE status="succeeded"`
- **THEN** the reference runtime SHALL preserve records already flushed to the resource server
- **AND** it SHALL NOT commit staged cursor state for that run

### Requirement: Runtime SHALL persist safe run timeline events
The reference runtime SHALL emit durable spine events for runtime-observable run lifecycle milestones without storing connector secret responses in those events. When an owner cancels a run, the reference runtime SHALL record the cancellation request and a terminal event that preserves the owner-cancel intent.

#### Scenario: Run starts
- **WHEN** the reference runtime sends `START`
- **THEN** it SHALL record a `run.started` event with run source, collection mode, grant id when supplied, state commit intent, advertised bindings, and scoped stream names

#### Scenario: State is staged
- **WHEN** the reference runtime accepts a scoped `STATE` checkpoint
- **THEN** it SHALL record `run.state_staged` with the stream id, cursor, checkpoint mode, staged-state count, and state commit intent

#### Scenario: Progress is reported
- **WHEN** the connector emits valid `PROGRESS`
- **THEN** the reference runtime SHALL record `run.progress_reported`
- **AND** it SHALL include stream, message, count, and total only when supplied and valid

#### Scenario: Stream is skipped
- **WHEN** the connector emits valid `SKIP_RESULT`
- **THEN** the reference runtime SHALL record `run.stream_skipped`
- **AND** it SHALL include a bounded known-gap projection with reason, message, scope, and recovery hint when available

#### Scenario: Owner cancellation is requested
- **WHEN** the reference runtime observes an owner cancellation signal for an in-flight run that has no terminal event yet
- **THEN** it SHALL record a non-terminal `run.cancel_requested` event for that run
- **AND** it SHALL begin terminating the connector child process for only that run

#### Scenario: Run reaches a terminal state
- **WHEN** the run completes, fails, or is cancelled
- **THEN** the reference runtime SHALL record `run.completed`, `run.failed`, or `run.cancelled`
- **AND** the terminal event SHALL include record counts, checkpoint status, staged and committed state counts, terminal reason when applicable, connector error summary when applicable, and bounded known gaps

#### Scenario: Owner-cancelled run reaches its terminal state
- **WHEN** a run whose cancellation was requested by the owner exits without `DONE status="succeeded"`
- **THEN** the reference runtime SHALL record a terminal `run.cancelled` event rather than a generic connector-exit failure
- **AND** the terminal reason SHALL distinguish a graceful owner cancellation from one that required force-terminating the connector child
