## MODIFIED Requirements

### Requirement: Runtime SHALL persist safe run timeline events
The reference runtime SHALL emit durable spine events for runtime-observable run lifecycle milestones without storing connector secret responses in those events. When an owner cancels a run, the reference runtime SHALL record the cancellation request and a terminal event that preserves the owner-cancel intent. When a connector fails before authenticated collection progress, the reference runtime SHALL preserve bounded, non-secret terminal known-gap metadata when the connector supplies safe diagnostic error text.

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

#### Scenario: Pre-progress connector failure includes safe known-gap metadata
- **WHEN** a connector fails before authenticated collection progress and supplies bounded terminal error text for invalid credentials, visible login/challenge, or parser/runtime failure
- **THEN** the reference runtime SHALL persist a terminal `run_failed` known gap with that bounded message
- **AND** the run SHALL NOT be represented only by `connector_reported_failed` with an empty known-gap list

#### Scenario: Owner-cancelled run reaches its terminal state
- **WHEN** a run whose cancellation was requested by the owner exits without `DONE status="succeeded"`
- **THEN** the reference runtime SHALL record a terminal `run.cancelled` event rather than a generic connector-exit failure
- **AND** the terminal reason SHALL distinguish a graceful owner cancellation from one that required force-terminating the connector child
