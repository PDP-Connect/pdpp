## MODIFIED Requirements

### Requirement: Local collector startup recovers and drains durable work before scanning

The local collector runner SHALL recover expired leases and attempt to drain ready durable outbox work before scanning source data for additional work, subject to configured policy limits. Before that drain, the runner SHALL requeue dead-letter rows whose redacted error class is a transient local-device request failure, such as a local-device `408`, `429`, `5xx`, request timeout, or network transport failure. The runner SHALL NOT automatically requeue dead-letter rows whose class indicates malformed payloads, protocol mismatch, authentication or authorization rejection, invalid request, or another non-transient failure.

#### Scenario: Pending work exists before a scheduled run

- **WHEN** a local collector starts and finds ready pending work in the durable outbox
- **THEN** it SHALL attempt to deliver or advance that work before scanning the source for additional data
- **AND** it SHALL expose any inability to drain the work through diagnostics

#### Scenario: An expired lease exists

- **WHEN** a local collector starts and finds an outbox item whose lease has expired
- **THEN** it SHALL make that item eligible for recovery according to lease and fencing rules
- **AND** it SHALL NOT require manual queue-file editing to make later work progress

#### Scenario: A transient server failure was dead-lettered

- **WHEN** a local collector starts and finds a dead-letter row whose redacted error class is a transient local-device request failure
- **THEN** it SHALL requeue that row before the pre-scan drain
- **AND** it SHALL let the normal bounded drain and retry policy decide whether the row can now be acknowledged
- **AND** it SHALL NOT require the owner to run manual local recovery for that transient class

#### Scenario: A terminal dead letter exists

- **WHEN** a local collector starts and finds a dead-letter row whose redacted error class is non-transient
- **THEN** it SHALL leave that row dead-lettered
- **AND** it SHALL continue surfacing the dead-letter diagnostics and explicit recovery path
