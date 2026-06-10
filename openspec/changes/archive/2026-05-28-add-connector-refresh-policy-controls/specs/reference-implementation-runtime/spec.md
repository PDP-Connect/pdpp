## MODIFIED Requirements

### Requirement: Controller SHALL expose safe owner run controls

The reference runtime controller SHALL provide owner-only run control behavior for manual runs, pending interactions, active-run conflict detection, schedule management, and abandoned controller-managed run reconciliation.

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

### Requirement: Scheduler SHALL preserve runtime results and avoid unsafe retries

The reference scheduler SHALL preserve runtime result metadata in history, stats, and completion callbacks while preventing overlapping runs for the same connector and avoiding retries for deterministic failures.

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

#### Scenario: Policy delays or skips a run
- **WHEN** refresh policy, backoff, overlap prevention, or human-attention state prevents a scheduled run from starting
- **THEN** the reference SHALL preserve an inspectable skip or delay reason in schedule/run history
- **AND** manual `run now` SHALL remain available unless the connector is already active
