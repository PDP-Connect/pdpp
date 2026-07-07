## MODIFIED Requirements

### Requirement: Connection summaries expose connection-scoped run evidence

The reference implementation SHALL project `last_run` and `last_successful_run` evidence for a configured connection from run summaries that belong to that connection. When run summaries carry a browser-surface profile key, the projection SHALL match that key to the connection's expected browser profile key. When a run summary does not carry a browser-surface profile key, the projection SHALL NOT assign it to a sibling connection unless the run summary carries explicit `connector_instance_id` or `connection_id` equal to that connection. When exact event-spine evidence is unavailable for a connection, the projection SHALL use exact scheduler run-history evidence keyed by that connection's `connector_instance_id` before considering any legacy connector-wide fallback.

#### Scenario: sibling browser connections do not share one run

**WHEN** two active connections for the same connector have browser-surface run summaries stamped with distinct browser-surface profile keys
**THEN** the owner connection-summary list projects each connection's `last_run` from its matching profile-keyed run only
**AND** it does not project one sibling's run as the other's `last_run`.

#### Scenario: browser-surface failure reason is visible

**WHEN** a connection's latest matching browser-surface run has status `surface_failed`
**AND** the run did not emit a terminal `run.failed` reason
**THEN** the owner connection-summary list uses the browser-surface wait/status evidence as `last_run.failure_reason`.

#### Scenario: multi-account scheduler history stays connection-scoped

**WHEN** two active connections for the same connector have terminal scheduler run-history rows keyed by distinct `connector_instance_id` values
**AND** the event spine has no exact run summary for either connection
**THEN** the owner connection-summary list SHALL project each connection's `last_run` from its own scheduler history
**AND** it SHALL NOT render the connection as lacking latest-run evidence solely because connector-wide spine evidence is ambiguous.
