## MODIFIED Requirements

### Requirement: Local collector startup recovers and drains durable work before scanning

The local collector runner SHALL validate that the configured reference route accepts the enrolled device before it recovers expired leases, drains durable outbox work, or scans the source for additional work. After that precondition succeeds, the runner SHALL recover expired leases and attempt to drain ready durable outbox work before scanning source data for additional work, subject to configured policy limits. Before that drain, the runner SHALL requeue dead-letter rows whose redacted error class is a transient local-device request failure, such as a local-device `408`, `429`, `5xx`, request timeout, or network transport failure. The runner SHALL NOT automatically requeue dead-letter rows whose class indicates malformed payloads, protocol mismatch, authentication or authorization rejection, invalid request, or another non-transient failure.

#### Scenario: The configured reference route rejects startup

- **WHEN** a local collector starts with a configured reference route that rejects the enrolled device heartbeat
- **THEN** the runner SHALL fail before recovering leases, draining durable outbox work, or scanning the source
- **AND** it SHALL leave existing durable outbox rows in their prior pending, retrying, leased, or dead-letter state
- **AND** it SHALL surface the route failure as a bounded local-device request error without exposing device tokens or record payloads

#### Scenario: Pending work exists before a scheduled run

- **WHEN** a local collector starts and finds ready pending work in the durable outbox
- **AND** the configured reference route accepts the enrolled device
- **THEN** it SHALL attempt to deliver or advance that work before scanning the source for additional data
- **AND** it SHALL expose any inability to drain the work through diagnostics

#### Scenario: An expired lease exists

- **WHEN** a local collector starts and finds an outbox item whose lease has expired
- **AND** the configured reference route accepts the enrolled device
- **THEN** it SHALL make that item eligible for recovery according to lease and fencing rules
- **AND** it SHALL NOT require manual queue-file editing to make later work progress

#### Scenario: A transient server failure was dead-lettered

- **WHEN** a local collector starts and finds a dead-letter row whose redacted error class is a transient local-device request failure
- **AND** the configured reference route accepts the enrolled device
- **THEN** it SHALL requeue that row before the pre-scan drain
- **AND** it SHALL let the normal bounded drain and retry policy decide whether the row can now be acknowledged
- **AND** it SHALL NOT require the owner to run manual local recovery for that transient class

#### Scenario: A terminal dead letter exists

- **WHEN** a local collector starts and finds a dead-letter row whose redacted error class is non-transient
- **AND** the configured reference route accepts the enrolled device
- **THEN** it SHALL leave that row dead-lettered
- **AND** it SHALL continue surfacing the dead-letter diagnostics and explicit recovery path

### Requirement: Local collector health is connection-scoped and inspectable

The reference implementation SHALL expose local collector durable-work health for each configured connection or source instance. Health SHALL include queue depth, stale leases, retry/dead-letter counts, oldest pending work, backlog/gap counts, last acknowledgement, last committed checkpoint, package/protocol version, reference-route reachability where configured, and device/source-home identity where available. The health surface SHALL also name a single mutually-exclusive lifecycle state for the connection - one of healthy idle, actively draining, retryable backlog, dead-letter, stale lease, or coverage-diagnostics missing - derived from the durable outbox so a reader does not have to infer the situation from raw counts.

#### Scenario: An owner inspects a configured local collector route

- **WHEN** an owner or operator runs local collector diagnostics with device id, device token, source instance id, and reference base URL configured
- **THEN** the diagnostics SHALL perform a bounded non-mutating check of the device-scoped reference route
- **AND** it SHALL report whether that route is accepted, rejected, or unreachable
- **AND** it SHALL NOT expose device tokens, record payloads, cookies, or local source content

#### Scenario: Route diagnostics cannot be checked

- **WHEN** local collector diagnostics run without the device id, device token, or source instance id needed for a route check
- **THEN** the diagnostics SHALL report the reference-route check as unknown rather than guessing that the route is healthy
- **AND** it SHALL continue reporting local durable outbox state from the local database
