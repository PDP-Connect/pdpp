## ADDED Requirements

### Requirement: Stalled local-device outbox SHALL name its cause class

When the connection-health projection reports a stalled local-device outbox, it SHALL classify the cause from the heartbeat evidence the server already holds and render a cause-specific message, reason, and remediation in the `LocalExporterAvailable` and `BacklogClear` conditions instead of one generic stalled/blocked message. The cause SHALL be one of `state_read_failed`, `dead_letter_backlog`, or `stale_pending`.

A `blocked` heartbeat with no rolled-up dead letters SHALL classify as `state_read_failed`; a `blocked` heartbeat with one or more rolled-up dead letters SHALL classify as `dead_letter_backlog`; pending work whose heartbeat has gone stale past the freshness threshold SHALL classify as `stale_pending`. When a connection's trusted sources report different causes, the projection SHALL surface the most actionable cause, ordered `dead_letter_backlog` over `state_read_failed` over `stale_pending`.

The cause classification SHALL NOT widen or rename the outbox axis: the axis stays `idle | active | stalled | unknown`, and a non-stalled axis SHALL NOT carry a stalled cause. When a stalled axis carries no cause, the projection SHALL fall back to the generic stalled message rather than inventing a cause. The classification SHALL NOT introduce new device telemetry, change the heartbeat wire contract, or read a device's local outbox directly; it SHALL be derived only from the already-persisted heartbeat status and outbox-diagnostic counts.

#### Scenario: Blocked heartbeat with no dead letters names a state-read stall

- **WHEN** a trusted local-device heartbeat reports `blocked` status with no dead-lettered records
- **THEN** the projection SHALL classify the stalled cause as `state_read_failed`
- **AND** the `LocalExporterAvailable` condition SHALL state that the exporter is blocked reading prior state, that there is nothing to requeue, and that re-running the collector on the host clears it

#### Scenario: Blocked heartbeat with dead letters names a dead-letter backlog

- **WHEN** a trusted local-device heartbeat reports `blocked` status with one or more dead-lettered records
- **THEN** the projection SHALL classify the stalled cause as `dead_letter_backlog`
- **AND** the `LocalExporterAvailable` condition SHALL state that dead-lettered records must be retried and then drained by re-running the collector on the host

#### Scenario: Pending work with a stale heartbeat names a stalled drain

- **WHEN** a trusted local-device heartbeat reports pending work but has not been seen within the stale-heartbeat threshold
- **THEN** the projection SHALL classify the stalled cause as `stale_pending`
- **AND** the `LocalExporterAvailable` condition SHALL state that pending work stopped draining and that re-running the collector on the host resumes it

#### Scenario: A cause never leaks onto a non-stalled axis

- **WHEN** a connection's outbox axis is `idle`, `active`, or `unknown`
- **THEN** the projection SHALL NOT render a stalled cause message or remediation for that connection
- **AND** an `active` outbox SHALL read as queued work draining normally, not as a danger signal
