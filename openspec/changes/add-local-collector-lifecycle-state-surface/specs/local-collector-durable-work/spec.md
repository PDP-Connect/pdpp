## MODIFIED Requirements

### Requirement: Local collector health is connection-scoped and inspectable

The reference implementation SHALL expose local collector durable-work health for each configured connection or source instance. Health SHALL include queue depth, stale leases, retry/dead-letter counts, oldest pending work, backlog/gap counts, last acknowledgement, last committed checkpoint, package/protocol version, and device/source-home identity where available. The health surface SHALL also name a single mutually-exclusive lifecycle state for the connection — one of healthy idle, actively draining, retryable backlog, dead-letter, stale lease, or coverage-diagnostics missing — derived from the durable outbox so a reader does not have to infer the situation from raw counts.

#### Scenario: An owner inspects a local collector connection

- **WHEN** an owner or operator inspects a local collector connection through CLI, logs, dashboard, or reference diagnostics
- **THEN** the reference implementation SHALL show whether durable work is pending, retrying, leased, stale, dead-lettered, or fully drained
- **AND** it SHALL scope that health to the configured connection or source instance rather than only to connector type
- **AND** it SHALL report a single lifecycle state for the connection alongside the raw counts

#### Scenario: A drained connection has never carried a coverage diagnostic

- **WHEN** a local collector connection has durably delivered record work but has never carried a coverage-diagnostics record, and no durable work remains pending, retrying, leased, or dead-lettered
- **THEN** the health surface SHALL report the connection as coverage-diagnostics missing rather than as healthy idle
- **AND** it SHALL distinguish that case from a connection that has collected nothing yet
- **AND** it SHALL point the operator at re-running the collector with its default stream set to emit the coverage diagnostic

#### Scenario: Coverage observation stays bounded on a large or legacy outbox

- **WHEN** the health surface determines whether a connection has carried a coverage-diagnostics record
- **THEN** it SHALL answer from a payload-light index rather than reparsing retained record payloads, so the determination is bounded regardless of how much retained record data the outbox holds
- **AND** when the determination cannot be made within a bounded budget — because the outbox predates the index and its unindexed backlog exceeds that budget — it SHALL report coverage observation as unknown rather than perform an unbounded scan
- **AND** it SHALL NOT report a connection with unknown coverage observation as coverage-diagnostics missing

#### Scenario: Diagnostics are displayed remotely

- **WHEN** durable-work diagnostics are displayed outside the local device
- **THEN** the reference implementation SHALL avoid leaking raw local secrets, auth files, browser cookies, or unredacted absolute local paths
