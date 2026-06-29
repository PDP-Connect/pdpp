# reference-implementation-runtime Specification

## Purpose
TBD - created by archiving change add-reference-runtime-spec. Update Purpose after archive.
## Requirements
### Requirement: Runtime SHALL construct a bounded START envelope
The reference runtime SHALL send each connector a `START` envelope containing a concrete `run_id`, `collection_mode`, normalized `scope`, validated stream-keyed `state` when state persistence is enabled, and the runtime bindings available to that run.

#### Scenario: No explicit scope is supplied
- **WHEN** the reference runtime starts a connector without an explicit scope
- **THEN** it SHALL derive `START.scope.streams` from the connector manifest stream names
- **AND** it SHALL reject manifests that leave the derived scope empty

#### Scenario: Explicit scope is supplied
- **WHEN** the reference runtime starts a connector with an explicit scope
- **THEN** it SHALL require at least one named stream
- **AND** it SHALL reject wildcard stream names, streams not declared in the manifest, unresolved `view` names, and issuance-time `necessity` values
- **AND** it SHALL validate optional `resources`, `fields`, and `time_range` members before sending `START`

#### Scenario: Field-scoped stream is normalized
- **WHEN** a stream scope supplies an explicit `fields` array
- **THEN** the reference runtime SHALL add manifest-required fields, primary-key fields, and any consent-time field needed for a requested time range
- **AND** it SHALL preserve caller-requested fields without duplicating additions

#### Scenario: Runtime bindings are advertised
- **WHEN** a connector run starts
- **THEN** the reference runtime SHALL advertise `network` and `filesystem` bindings
- **AND** it SHALL advertise `interactive` only when an interaction handler is available

### Requirement: Runtime SHALL enforce scoped connector output
The reference runtime SHALL validate connector output against the active scope, manifest, and run phase before ingesting records, staging state, reporting progress, recording known gaps, or completing the run.

#### Scenario: Record is outside the active scope
- **WHEN** a connector emits a `RECORD` for an undeclared stream, outside the stream's declared `resources`, outside requested `fields`, or outside the stream `time_range` when a manifest consent-time field is available
- **THEN** the reference runtime SHALL fail the run as a connector protocol violation
- **AND** it SHALL NOT ingest the offending record

#### Scenario: State checkpoint is outside the active scope
- **WHEN** a connector emits a `STATE` checkpoint for an undeclared stream or with a cursor that is neither an object nor null
- **THEN** the reference runtime SHALL fail the run as a connector protocol violation
- **AND** it SHALL NOT persist that checkpoint

#### Scenario: Progress or skip result names an undeclared stream
- **WHEN** a connector emits `PROGRESS` or `SKIP_RESULT` with a stream not present in `START.scope.streams`
- **THEN** the reference runtime SHALL fail the run as a connector protocol violation
- **AND** for `PROGRESS` it SHALL expose a runtime-authored violation subtype of `progress_for_undeclared_stream`

#### Scenario: Connector emits after terminal DONE
- **WHEN** a connector emits any message after a terminal `DONE`
- **THEN** the reference runtime SHALL fail the run as a connector protocol violation
- **AND** it SHALL NOT commit staged state for that run

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

### Requirement: Runtime SHALL broker interactions as in-process pauses
The reference runtime SHALL treat connector `INTERACTION` messages as blocking in-process pauses that are completed by a matching `INTERACTION_RESPONSE` while the connector child process remains alive. The reference runtime SHALL additionally monitor the browser surface during a `manual_action` or browser-surface-backed `otp` interaction wait and SHALL fail closed by cancelling the open interaction if the surface becomes unavailable before the owner responds.

#### Scenario: Interaction is accepted
- **WHEN** a connector emits a valid `INTERACTION` and the run advertised `interactive`
- **THEN** the reference runtime SHALL record `run.interaction_required`
- **AND** it SHALL wait for a matching response or timeout before sending `INTERACTION_RESPONSE` to the connector

#### Scenario: Interaction completes
- **WHEN** the interaction handler returns `success`, `cancelled`, or `timeout` for the current interaction request id
- **THEN** the reference runtime SHALL record `run.interaction_completed` with status, kind, and stream
- **AND** it SHALL NOT record submitted credential, OTP, or manual-action response data in the durable run timeline

#### Scenario: Interaction is unavailable
- **WHEN** a connector emits `INTERACTION` but `START.bindings` omitted `interactive`
- **THEN** the reference runtime SHALL fail the run as a connector protocol violation
- **AND** it SHALL NOT record interaction-required or interaction-completed events for that invalid interaction

#### Scenario: Connector emits output while waiting
- **WHEN** a connector emits another message or invalid JSONL while the runtime is waiting for the current interaction response
- **THEN** the reference runtime SHALL fail the run as a connector protocol violation
- **AND** it SHALL terminate the connector child process

#### Scenario: Browser surface is lost during interaction wait
- **WHEN** a connector emits a `manual_action` or `otp` INTERACTION with an active browser surface
- **AND** the browser surface becomes unreachable (CDP HTTP probe fails) before the owner responds
- **THEN** the reference runtime SHALL detect the surface loss via periodic mid-wait polling
- **AND** it SHALL emit `run.browser_surface_lost` with `interaction_id`, `kind`, and a `browser_surface_probe` envelope carrying the typed failure code and detail
- **AND** it SHALL cancel the pending interaction and record `run.interaction_completed { status: "cancelled" }`
- **AND** it SHALL clear the pending interaction entry so any subsequent owner response is rejected as stale

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

### Requirement: Controller SHALL disambiguate local connector implementations
The reference runtime controller SHALL resolve local connector paths deterministically when reference fixture manifests and polyfill connector manifests share a connector id.

#### Scenario: Active manifest matches a polyfill connector
- **WHEN** a connector id exists in both reference fixture manifests and polyfill manifests
- **AND** the active manifest fingerprint matches the polyfill manifest fingerprint
- **THEN** the controller SHALL resolve the runnable polyfill connector implementation

#### Scenario: No active manifest is supplied
- **WHEN** the controller resolves a connector id without an active manifest
- **AND** a runnable polyfill implementation exists for that connector id
- **THEN** it SHALL prefer the runnable polyfill implementation

#### Scenario: Polyfill-only connector is requested
- **WHEN** a connector id exists only in the polyfill connector registry and has a runnable implementation
- **THEN** the controller SHALL resolve the polyfill connector path

### Requirement: Scheduler SHALL preserve runtime results and avoid unsafe retries

The reference scheduler SHALL preserve runtime result metadata in history, stats, and completion callbacks while preventing overlapping runs for the same connector and avoiding retries for deterministic failures. The reference attention read model SHALL NOT surface expired non-terminal owner-action rows as current unresolved attention.

#### Scenario: Run succeeds

- **WHEN** a scheduled connector run succeeds
- **THEN** the scheduler SHALL record status, source, run id, trace id, record count, checkpoint summary, known gaps, and connector state returned by the runtime
- **AND** scheduler stats SHALL expose the same last-run projection

#### Scenario: Failure is retryable

- **WHEN** a connector-declared failure is retryable or the runtime failure is a retryable rate-limit or transient server failure
- **THEN** the scheduler SHALL retry up to the configured retry limit
- **AND** it SHALL use bounded exponential backoff between attempts
- **AND** it SHALL record the succeeding or terminal attempt number

#### Scenario: Failure is deterministic

- **WHEN** the runtime reports a connector protocol violation, authentication error, permission error, deterministic grant lifecycle error, deterministic connector-invalid error, or the connector declares `retryable: false`
- **THEN** the scheduler SHALL NOT retry that run
- **AND** it SHALL preserve the failure reason, terminal reason, connector error summary, checkpoint summary, and known gaps

#### Scenario: Connector already has an active scheduled run

- **WHEN** a schedule tick fires while the same connector has an active scheduled run
- **THEN** the scheduler SHALL NOT start an overlapping connector process

#### Scenario: Scheduler stops during retry backoff

- **WHEN** the scheduler is stopped while a retryable failure is waiting for backoff
- **THEN** it SHALL NOT launch the next retry attempt

#### Scenario: Scheduled run requires human attention

- **WHEN** an automatic scheduled run reaches a pending interaction that requires credentials, OTP, or manual browser action
- **THEN** the scheduler SHALL avoid repeatedly launching new automatic attempts for the same unresolved condition
- **AND** schedule state SHALL explain that human attention is needed

#### Scenario: Expired manual action is stale after later success

- **WHEN** an older failed run leaves an open `manual_action_required` attention row whose `expires_at` is at or before the attention read clock
- **AND** a later run for the same connector instance succeeds
- **THEN** the reference attention read model SHALL NOT return the expired row as open unresolved attention
- **AND** the later successful run SHALL NOT be projected as needing current owner attention solely because of that expired row

#### Scenario: Policy delays or skips a run

- **WHEN** refresh policy, backoff, overlap prevention, or human-attention state prevents a scheduled run from starting
- **THEN** the reference SHALL preserve an inspectable skip or delay reason in schedule/run history
- **AND** manual `run now` SHALL remain available unless the connector is already active

### Requirement: Scheduler SHALL handle single-use and disabled grants conservatively
The reference scheduler SHALL treat `single_use` grants and deterministic grant lifecycle failures as reference orchestration concerns rather than connector wire-protocol extensions.

#### Scenario: Single-use run succeeds
- **WHEN** a scheduled connector with `grantAccessMode: "single_use"` completes successfully
- **THEN** the scheduler SHALL mark the connector grant exhausted
- **AND** later ticks SHALL emit skipped run records instead of starting another connector process
- **AND** state persistence SHALL be disabled for the single-use run

#### Scenario: Single-use run fails before success
- **WHEN** a scheduled connector with `grantAccessMode: "single_use"` fails before any successful run consumes the grant
- **THEN** the scheduler SHALL keep the grant reusable for a later scheduled attempt
- **AND** state persistence SHALL remain disabled for those single-use attempts

#### Scenario: Deterministic grant lifecycle failure occurs
- **WHEN** a scheduled run fails with `grant_consumed`, `grant_expired`, `grant_invalid`, or `grant_revoked`
- **THEN** the scheduler SHALL disable future connector attempts for that grant
- **AND** it SHALL emit one skipped run record explaining that the grant is no longer usable
- **AND** later intervals SHALL remain quiet until the schedule is restarted with usable grant state

### Requirement: Browser-backed runtime helpers SHALL use local operator profiles
Reference polyfill browser helpers SHALL use local persistent browser profile directories and operator-controlled interaction hooks for browser-backed connectors.

#### Scenario: Browser connector uses default profile binding
- **WHEN** a browser-backed connector does not supply a profile name
- **THEN** the helper runtime SHALL use the connector name as the profile name
- **AND** it SHALL acquire a persistent browser context under the local `.pdpp` profile directory

#### Scenario: Browser profile name is invalid
- **WHEN** a browser-backed connector requests a profile name outside `[A-Za-z0-9_-]+`
- **THEN** browser acquisition SHALL fail before launching the browser context

#### Scenario: Session probe fails
- **WHEN** a browser-backed connector supplies a session probe and the probe reports that the session is not live
- **THEN** the helper runtime SHALL request `manual_action` interaction with a bounded timeout
- **AND** it SHALL fail the connector run if the session still is not live after the interaction completes

#### Scenario: Browser tracing is enabled
- **WHEN** `PDPP_TRACE=1` is set for a browser-backed connector helper run
- **THEN** the helper runtime SHALL attempt to produce a replayable Playwright trace
- **AND** it SHALL emit progress messages naming trace start and final trace output or trace-write failure

### Requirement: Run handles SHALL remain resolvable until and after terminal state

Every run identifier returned by a control surface SHALL remain resolvable
to a status until and after the run reaches a terminal state — this covers
the run-now 202 acknowledgement, scheduler projections, and cancellation
acknowledgements. The reference implementation SHALL expose an owner-session route
`GET /_ref/runs/{run_id}` that resolves a run handle to its current status:
`active` while the controller's run bookkeeping owns the run or while a
`run.started` event exists without a terminal event, and the terminal status
(`completed` | `failed` | `cancelled` | `abandoned`) once a terminal spine
event exists — independent of the flight-state `controller_active_runs`
table, whose rows are deleted when a run settles. Failure information served
by the route SHALL be the typed, bounded fields already persisted on the
run's terminal spine event (terminal reason, failure origin, bounded
messages); the route SHALL NOT expose connector secrets or bearer tokens.

#### Scenario: Active run resolves

- **WHEN** an owner requests `GET /_ref/runs/{run_id}` for a run that has
  been acknowledged with 202 and has not yet reached a terminal state
- **THEN** the route SHALL respond 200 with status `active`
- **AND** it SHALL include the run id, trace id, connector identity, and
  started timestamp from the controller's active-run bookkeeping
- **AND** it SHALL link to the run's timeline route

#### Scenario: Terminal run resolves

- **WHEN** an owner requests `GET /_ref/runs/{run_id}` for a run whose
  terminal spine event has been recorded, regardless of how long ago the run
  settled
- **THEN** the route SHALL respond 200 with the terminal status derived from
  the run's most-recent terminal spine event
- **AND** it SHALL include the terminal reason when the terminal event
  carries one, started and completed timestamps, and — for failed or
  abandoned runs — a typed failure summary bounded to the fields persisted
  on the terminal event

#### Scenario: Unknown run id gets a typed 404

- **WHEN** an owner requests `GET /_ref/runs/{run_id}` for an identifier
  with no active-run bookkeeping and no spine events
- **THEN** the route SHALL respond with the reference error envelope and a
  typed `not_found` code naming the `run_id` parameter
- **AND** it SHALL NOT fall through to the transport's default unknown-route
  response

#### Scenario: Launch crash leaves the handle resolvable

- **WHEN** a run acknowledged with 202 crashes before the runtime records
  `run.started` (a throw in the launch path before the connector child
  spawns)
- **THEN** the controller SHALL record a typed terminal `run.failed` event
  with reason `launch_failed`, a bounded failure message, and zero records
- **AND** it SHALL log the failure with the run id and trace id
- **AND** `GET /_ref/runs/{run_id}` SHALL subsequently resolve the handle to
  status `failed`

#### Scenario: Post-spawn failures are not double-terminated

- **WHEN** a run's in-flight task rejects after the runtime has already
  recorded a terminal spine event for that run
- **THEN** the controller SHALL NOT emit a second terminal event for the run

