## ADDED Requirements

### Requirement: Scheduler SHALL apply a cross-run cooldown for pending source-pressure gaps

When a connection still has pending retryable detail gaps caused by upstream/source pressure (for example a gap with reason `upstream_pressure` or `rate_limited`), the reference scheduler SHALL NOT treat the connection as immediately due on its normal interval merely because the prior run terminated `succeeded`. The scheduler SHALL defer the next automatic dispatch by a cooldown derived from the pending source-pressure gaps. This cooldown is independent of, and additional to, the scheduler's failure-class back-off; whichever defers the next attempt further SHALL govern eligibility.

#### Scenario: Scheduled run succeeded but deferred work under source pressure

- **WHEN** a scheduled connection's most recent run terminated `succeeded` but left one or more pending detail gaps whose reason is source pressure
- **THEN** the scheduler SHALL consider the connection cooling off rather than immediately due on the base interval
- **AND** the scheduler SHALL NOT launch another automatic run for that connection until the cooldown window has elapsed

#### Scenario: Manual run-now during cooldown

- **WHEN** an owner triggers a manual run for a connection that is in source-pressure cooldown
- **THEN** the cooldown SHALL NOT block the manual run

### Requirement: Source-pressure cooldown SHALL decay and SHALL relax on recovery

The source-pressure cooldown SHALL grow as pressure persists across runs and SHALL be bounded by a configured upper cap. The cooldown SHALL relax once the pending source-pressure gaps are recovered, so a connection is never held in cooldown indefinitely after pressure clears.

#### Scenario: Pressure persists across runs

- **WHEN** repeated automatic attempts continue to leave the same connection with pending source-pressure gaps
- **THEN** the deferred next-attempt time SHALL grow relative to the base interval
- **AND** the deferred next-attempt time SHALL NOT grow beyond the configured cooldown cap

#### Scenario: A run recovers the pending pressure gaps

- **WHEN** a later run recovers the connection's pending source-pressure gaps so that none remain
- **THEN** the scheduler SHALL no longer apply a source-pressure cooldown to that connection
- **AND** the connection SHALL return to its normal scheduled cadence

### Requirement: Source-pressure cooldown SHALL be reason-scoped and not throttle unrelated connectors

The source-pressure cooldown SHALL be driven only by detail gaps whose reason represents account/source pressure. Detail gaps with other reasons, and connections with no pending source-pressure gaps, SHALL NOT be throttled by this policy. A failure to read the durable pending-gap evidence SHALL be treated as no pressure, so an unreadable store cannot silently pause a schedule.

#### Scenario: Connection has only non-pressure gaps

- **WHEN** a connection's pending detail gaps are all non-source-pressure reasons (or it has no pending gaps)
- **THEN** the scheduler SHALL NOT apply a source-pressure cooldown to that connection

#### Scenario: Pending-gap evidence cannot be read

- **WHEN** the durable pending-gap evidence cannot be read for a connection
- **THEN** the scheduler SHALL treat the connection as having no source-pressure cooldown
- **AND** the scheduler SHALL NOT silently suppress the connection's scheduled runs on that basis

### Requirement: Schedule projection SHALL surface source-pressure cooldown honestly

While a connection is governed by the source-pressure cooldown, the schedule/health projection SHALL surface a cooling-off health state and a deferred next-run time rather than presenting the connection as healthy with no qualification. The projection SHALL NOT downgrade a stronger blocked failure state to cooling off.

#### Scenario: Connection cooling off is projected

- **WHEN** the schedule projection is computed for a connection with pending source-pressure gaps that defer its next run
- **THEN** the projection SHALL report a cooling-off health state
- **AND** the projection SHALL report a next-run time no earlier than the cooldown's deferred attempt time

#### Scenario: Connection has no pending source pressure

- **WHEN** the schedule projection is computed for a connection with no pending source-pressure gaps and no failure back-off
- **THEN** the projection SHALL NOT report a cooling-off health state on the basis of source pressure
