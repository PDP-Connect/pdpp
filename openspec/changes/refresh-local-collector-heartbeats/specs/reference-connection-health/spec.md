## MODIFIED Requirements

### Requirement: Coverage, Work, And Attention SHALL Remain Decomplected

The reference implementation SHALL keep source coverage, local-device backlog, dead letters, retryable detail gaps, and owner attention as separate condition families.

#### Scenario: Successful run with partial coverage

**WHEN** a run succeeds but leaves terminal or retryable source gaps
**THEN** the projection MAY be degraded, but the underlying coverage condition SHALL identify the affected streams and recovery class.

#### Scenario: Local exporter has pending work

**WHEN** a local collector reports pending outbox records on a recent source-instance heartbeat
**THEN** the connection projection SHALL expose the condition as active local-device work without labeling the connection as a scheduler failure or owner-repair task.

#### Scenario: Local exporter pending work stops reporting

**WHEN** a local collector reports pending outbox records but the source-instance heartbeat is older than the configured stale threshold
**THEN** the connection projection SHALL expose the condition as stalled local-device work with operator remediation.

#### Scenario: Owner action blocks progress

**WHEN** a connector is waiting for current owner input
**THEN** `AttentionClear=false` or equivalent attention evidence SHALL dominate the projection until the request is satisfied, expires, or is canceled.
