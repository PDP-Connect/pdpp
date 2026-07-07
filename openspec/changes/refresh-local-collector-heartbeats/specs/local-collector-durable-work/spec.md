## MODIFIED Requirements

### Requirement: Local collector startup recovers and drains durable work before scanning

The local collector runner SHALL recover expired leases and attempt to drain ready durable outbox work before scanning source data for additional work, subject to configured policy limits.

When a collector run skips source scanning because durable outbox work remains, the runner SHALL still report a terminal source-instance heartbeat that includes current outbox diagnostics and records-pending counts. If that heartbeat cannot be accepted by the reference server, the run SHALL surface the failure rather than returning as a clean successful local pass.

#### Scenario: Pending work exists before a scheduled run

- **WHEN** a local collector starts and finds ready pending work in the durable outbox
- **THEN** it SHALL attempt to deliver or advance that work before scanning the source for additional data
- **AND** it SHALL expose any inability to drain the work through diagnostics

#### Scenario: Backlog-only pass reports current device health

- **WHEN** a local collector pass drains some durable work but leaves pending work that blocks source scanning
- **THEN** it SHALL send a source-instance heartbeat with current pending, retrying, leased, dead-letter, and oldest-pending diagnostics
- **AND** it SHALL NOT return a clean successful result if the reference server rejects that heartbeat

#### Scenario: An expired lease exists

- **WHEN** a local collector starts and finds an outbox item whose lease has expired
- **THEN** it SHALL make that item eligible for recovery according to lease and fencing rules
- **AND** it SHALL NOT require manual queue-file editing to make later work progress

### Requirement: Local collector backlog and gaps are first-class diagnostics

The reference implementation SHALL preserve known uncollected, deferred, failed, or policy-limited local work as machine-readable backlog or gap units. Backlog and gap units SHALL include enough information to support retry, operator display, and honest run coverage reporting without exposing secrets.

State-read failures SHALL report a current blocked source-instance heartbeat with safe outbox diagnostics and a redacted stable error kind. The heartbeat SHALL be part of the failure path so owner surfaces can distinguish a state-read block from a dead-letter backlog or a missing local host.

#### Scenario: A local work unit cannot complete but has a known reason

- **WHEN** a local collector cannot complete a bounded work unit because of a retryable error, policy budget, privacy classification, missing file, unsupported store, or terminal parse failure
- **THEN** the reference implementation SHALL record a backlog or gap unit with stream or boundary identity, reason, retryability, and last-attempt metadata
- **AND** it SHALL NOT reduce the condition to unstructured run failure text only

#### Scenario: State read is blocked before scanning

- **WHEN** a local collector cannot read prior source-instance state before scanning
- **THEN** it SHALL send a blocked source-instance heartbeat with a redacted `state_read_failed` error kind and current outbox diagnostics
- **AND** it SHALL fail the local run rather than silently reporting success

#### Scenario: A run has useful data and known gaps

- **WHEN** a local collector run durably delivers some records but leaves known backlog or gaps
- **THEN** the reference implementation SHALL report partial coverage honestly
- **AND** it SHALL distinguish clean completion from completion with gaps, retryable backlog, or terminal dead-letter work
