## MODIFIED Requirements

### Requirement: Coverage, Work, And Attention SHALL Remain Decomplected

The reference implementation SHALL keep source coverage, local-device backlog, dead letters, retryable detail gaps, and owner attention as separate condition families.

For local-device-backed connections, trusted local-device progress SHALL be eligible to establish freshness even when stale historical scheduler history exists. A stale scheduler run SHALL NOT override a fresh trusted local-device heartbeat for a push-mode connection. Active local-device outbox progress SHALL carry as work-in-progress evidence rather than as a scheduler/freshness failure. The projection SHALL still treat stalled outbox evidence, dead letters, incomplete coverage, current owner attention, and failed current run evidence as separate load-bearing conditions.

#### Scenario: Successful run with partial coverage

**WHEN** a run succeeds but leaves terminal or retryable source gaps
**THEN** the projection MAY be degraded, but the underlying coverage condition SHALL identify the affected streams and recovery class.

#### Scenario: Local exporter has pending work

**WHEN** a local collector reports pending outbox records
**THEN** the connection projection SHALL expose pending device work without labeling the connection as a scheduler failure.

#### Scenario: Owner action blocks progress

**WHEN** a connector is waiting for current owner input
**THEN** `AttentionClear=false` or equivalent attention evidence SHALL dominate the projection until the request is satisfied, expires, or is canceled.

#### Scenario: Local-device freshness is not blocked by stale historical scheduler history

**WHEN** a local-device-backed connection has trusted healthy local-device heartbeat evidence inside the declared freshness window
**AND** the same connection has stale historical scheduler run history
**THEN** the freshness axis SHALL be derived from the trusted local-device heartbeat
**AND** the stale historical scheduler run SHALL NOT cause the connection to project degraded solely because of freshness.

#### Scenario: Local-device heartbeat does not hide device backlog

**WHEN** a local-device-backed connection has pending or stalled outbox evidence
**THEN** the outbox condition SHALL remain visible and load-bearing
**AND** local-device heartbeat evidence SHALL NOT make the connection healthy by itself.
