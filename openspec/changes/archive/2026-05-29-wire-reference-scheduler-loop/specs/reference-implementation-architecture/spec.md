## MODIFIED Requirements

### Requirement: The Collection boundary stays explicit

The reference implementation SHALL keep the Collection boundary explicit across
core semantics, Collection Profile semantics, and runtime-only behavior.

#### Scenario: Shared collection semantics are classified
- **WHEN** behavior concerns RECORD envelopes, streams, scope, tombstones, or
  state/checkpoint semantics shared across collection and disclosure paths
- **THEN** those semantics SHALL be treated as core/shared semantics rather than
  as ad hoc runtime details

#### Scenario: Bounded-run collection behavior is classified
- **WHEN** behavior concerns START, INTERACTION, RECORD, STATE, DONE, binding
  matching, or run-scoped lifecycle rules for collected/polyfill sources
- **THEN** that behavior SHALL be treated as Collection Profile behavior rather
  than as native-provider contract surface

#### Scenario: Orchestrator behavior is classified
- **WHEN** behavior concerns scheduling, retry, credential storage, webhook
  adaptation, batch import, or multi-connector coordination
- **THEN** it SHALL be treated as runtime/orchestrator behavior unless and until
  a concrete interoperability need justifies a new profile

#### Scenario: Persisted schedules are active runtime instructions
- **WHEN** the long-lived reference server starts with enabled persisted
  connector schedules
- **THEN** the reference SHALL treat those schedules as runtime/orchestrator
  instructions for automatic connector refresh
- **AND** it SHALL NOT present enabled schedules as automatic if no scheduler
  loop is active for that server process

#### Scenario: The reference makes an optimistic collection choice before the spec is fully frozen
- **WHEN** the reference implementation enforces a strong Collection Profile
  behavior before the PDPP spec is fully settled
- **THEN** that behavior SHALL be labeled as either an interoperability
  requirement to be pushed into the Collection Profile spec or as a
  reference-only choice that does not yet claim normative status

### Requirement: Reference scheduler lifecycle is explicit

The reference server SHALL own the lifecycle for automatic scheduled connector
runs in long-lived local and Docker deployments.

#### Scenario: Scheduler starts after internal origins are known
- **WHEN** the reference server starts automatic scheduling
- **THEN** it SHALL start the scheduler only after AS and RS listeners have
  populated server-side loopback origins for connector children
- **AND** automatic scheduled runs SHALL use the same internal AS/RS origins as
  controller-managed manual runs

#### Scenario: Scheduler uses persisted schedule state
- **WHEN** a connector schedule is enabled
- **THEN** the scheduler SHALL derive automatic run cadence from the persisted
  schedule row
- **AND** disabled or deleted schedule rows SHALL NOT launch automatic runs

#### Scenario: Scheduler shares controller state
- **WHEN** an automatic scheduled run starts
- **THEN** it SHALL share controller/runtime state for connector path
  resolution, owner token issuance, active-run conflict prevention, connector
  state, needs-human state, and run-history persistence

#### Scenario: Scheduler shuts down safely
- **WHEN** the reference server begins graceful shutdown
- **THEN** it SHALL stop the scheduler before waiting for connector drain
- **AND** stopped scheduler retry/backoff timers SHALL NOT launch new connector
  attempts

#### Scenario: Docker runs the same scheduler lifecycle
- **WHEN** the Docker reference service runs the standard
  `reference-implementation/server/index.js` entrypoint
- **THEN** enabled persisted schedules SHALL execute through the same server-owned
  scheduler lifecycle as non-Docker long-lived startup

#### Scenario: Schedule projection reflects durable history after restart
- **WHEN** an operator-facing schedule projection is built for a persisted
  connector schedule (e.g. via `controller.listSchedules` or
  `controller.getSchedule`)
- **AND** no in-memory active-run row currently exists for that connector
- **THEN** the projection's `last_started_at`, `last_finished_at`,
  `last_successful_at`, and `last_error_code` fields SHALL reflect the
  durable `scheduler_run_history` (and `scheduler_last_run_times`) records
  for that connector when they exist
- **AND** the projection's `next_due_at` field SHALL be the projected next
  dispatch instant computed from the persisted last-run timestamp plus the
  configured interval whenever the persisted last-run anchor exists and the
  schedule is enabled
- **AND** a persisted schedule with neither an active run nor any persisted
  history SHALL retain null last-run/next-due fields so consumers can still
  identify genuinely never-fired schedules
