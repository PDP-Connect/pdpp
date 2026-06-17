## MODIFIED Requirements

### Requirement: Connection summaries expose connection-scoped run evidence

The reference implementation SHALL project `last_run` and `last_successful_run` evidence for a configured connection from run summaries that belong to that connection. When run summaries carry a browser-surface profile key, the projection SHALL match that key to the connection's expected browser profile key. When a run summary does not carry a browser-surface profile key, the projection SHALL NOT assign it to a sibling connection unless the run summary carries explicit `connector_instance_id` or `connection_id` equal to that connection.

#### Scenario: sibling browser connections do not share one run

**WHEN** two active connections for the same connector have browser-surface run summaries stamped with distinct browser-surface profile keys
**THEN** the owner connection-summary list projects each connection's `last_run` from its matching profile-keyed run only
**AND** it does not project one sibling's run as the other's `last_run`.

#### Scenario: browser-surface failure reason is visible

**WHEN** a connection's latest matching browser-surface run has status `surface_failed`
**AND** the run did not emit a terminal `run.failed` reason
**THEN** the owner connection-summary list uses the browser-surface wait/status evidence as `last_run.failure_reason`.

### Requirement: Connection summary list coalesces repeated full-list reads

The reference implementation SHALL coalesce duplicate full connection-summary list reads with a short-lived implementation cache when an equivalent Postgres projection is already in flight, provided scoped connection reads and diagnostic test hooks still execute the underlying projection path.

#### Scenario: duplicate full-list reads reuse one in-flight projection

**WHEN** multiple full connection-summary list reads arrive in the same process while an equivalent Postgres projection is already in flight
**THEN** the reference implementation may serve those reads from the same in-flight projection
**AND** it SHALL NOT use that optimization for explicit scoped connection reads.

### Requirement: Connection summary list avoids repeated retained-size reads

The reference implementation SHALL compute the full owner connection-summary list without issuing retained-size stream and retained-size connection reads once per configured connection when the retained-size read model can provide the same projection rows in one bounded read. Scoped single-connection summary reads SHALL remain scoped and SHALL NOT require the all-connection retained-size snapshot.

#### Scenario: full list reuses one retained-size snapshot

**WHEN** the owner reads the full connection-summary list
**THEN** the reference implementation reads the retained-size stream and connection projections as shared request-local inputs
**AND** projects each connection from the same per-connection summary function.

#### Scenario: scoped read stays scoped

**WHEN** the owner reads a single connection summary by route id
**THEN** the reference implementation projects only that resolved connection
**AND** it does not require the all-connection retained-size snapshot.
