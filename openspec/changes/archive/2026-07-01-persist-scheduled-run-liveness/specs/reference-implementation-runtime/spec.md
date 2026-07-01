## MODIFIED Requirements

### Requirement: Scheduler SHALL preserve runtime results and avoid unsafe retries

The reference scheduler SHALL preserve runtime result metadata in history, stats, completion callbacks, and active-run liveness while preventing overlapping runs for the same connector and avoiding retries for deterministic failures. The reference attention read model SHALL NOT surface expired non-terminal owner-action rows as current unresolved attention.

#### Scenario: Direct scheduled run publishes active liveness

- **WHEN** the scheduler launches a direct `runConnector` attempt for a
  connector instance
- **AND** the runtime emits `run.started` with the run id and trace id
- **THEN** the scheduler SHALL persist an active-run liveness record for that
  connector instance using the same active-run registry read by run summary
  projection
- **AND** the liveness record SHALL remain present until the attempt settles
- **AND** the liveness record SHALL be removed after the attempt reaches a
  terminal success or failure

#### Scenario: Direct scheduled run remains active before terminal

- **WHEN** a direct scheduled run has emitted `run.started`
- **AND** it has not yet emitted `run.completed`, `run.failed`,
  `run.cancelled`, or `run.abandoned`
- **THEN** run summary projection SHALL classify it as in progress while its
  active-run liveness record is present
- **AND** it SHALL NOT classify the run as `orphaned_started_run`
