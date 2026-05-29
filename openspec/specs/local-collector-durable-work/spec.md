# local-collector-durable-work Specification

## Purpose
TBD - created by archiving change add-local-collector-durable-work-substrate. Update Purpose after archive.
## Requirements
### Requirement: Local collector work is stored in a durable outbox

The reference implementation SHALL store local collector outbound work in a durable local outbox before treating that work as pending delivery. The outbox SHALL support record batches, checkpoint/state commits, gap/backlog reports, and artifact/blob upload work.

#### Scenario: A collector prepares records for upload

- **WHEN** a local collector prepares records that have not yet been acknowledged by the server
- **THEN** the collector SHALL write those records or their upload batch into the durable outbox
- **AND** it SHALL NOT treat the records as delivered until the server acknowledgement is recorded

#### Scenario: The collector process crashes after enqueue

- **WHEN** a local collector process crashes after writing work to the durable outbox and before server acknowledgement
- **THEN** the next local collector execution SHALL recover the pending work from the durable outbox
- **AND** it SHALL be able to retry delivery without re-scanning the source first

### Requirement: Local collector work units are bounded and replayable

The reference implementation SHALL model local source progress as bounded work units rather than as one monolithic run. A work unit MAY represent a stream partition, source-home scan window, file batch, page/export result, date range, or equivalent source-specific boundary.

#### Scenario: A first backfill exceeds one execution budget

- **WHEN** a local source contains more data than one collector execution can process within configured policy limits
- **THEN** the collector SHALL preserve the remaining source work as bounded replayable work units or backlog units
- **AND** a later execution SHALL resume from those units rather than restarting the entire first backfill as one opaque run

#### Scenario: A work unit completes

- **WHEN** all records, blobs, state commits, and known gaps for a work unit are acknowledged by the server
- **THEN** the reference implementation SHALL be able to mark that work unit complete without requiring all other work units in the run to complete

### Requirement: Local collector startup recovers and drains durable work before scanning

The local collector runner SHALL recover expired leases and attempt to drain ready durable outbox work before scanning source data for additional work, subject to configured policy limits.

#### Scenario: Pending work exists before a scheduled run

- **WHEN** a local collector starts and finds ready pending work in the durable outbox
- **THEN** it SHALL attempt to deliver or advance that work before scanning the source for additional data
- **AND** it SHALL expose any inability to drain the work through diagnostics

#### Scenario: An expired lease exists

- **WHEN** a local collector starts and finds an outbox item whose lease has expired
- **THEN** it SHALL make that item eligible for recovery according to lease and fencing rules
- **AND** it SHALL NOT require manual queue-file editing to make later work progress

### Requirement: Local collector checkpoints are destination-confirmed

The reference implementation SHALL advance local collector checkpoints only after the server durably accepts the records and gap metadata that justify the checkpoint. Source-observed cursors and connector-emitted `STATE` messages SHALL be treated as staged progress until destination acknowledgement completes.

#### Scenario: Records are accepted and checkpoint state is pending

- **WHEN** a local collector emits records and a checkpoint for the same stream boundary
- **AND** the server acknowledges the records and any gap metadata for that boundary
- **THEN** the reference implementation MAY commit the checkpoint for that boundary

#### Scenario: Records are not accepted

- **WHEN** a local collector emits records and checkpoint state but the server does not acknowledge the records or gap metadata that justify that checkpoint
- **THEN** the reference implementation SHALL NOT advance the committed checkpoint past those unacknowledged effects
- **AND** a later execution SHALL be able to replay or repair that boundary

### Requirement: Local collector backlog and gaps are first-class diagnostics

The reference implementation SHALL preserve known uncollected, deferred, failed, or policy-limited local work as machine-readable backlog or gap units. Backlog and gap units SHALL include enough information to support retry, operator display, and honest run coverage reporting without exposing secrets.

#### Scenario: A local work unit cannot complete but has a known reason

- **WHEN** a local collector cannot complete a bounded work unit because of a retryable error, policy budget, privacy classification, missing file, unsupported store, or terminal parse failure
- **THEN** the reference implementation SHALL record a backlog or gap unit with stream or boundary identity, reason, retryability, and last-attempt metadata
- **AND** it SHALL NOT reduce the condition to unstructured run failure text only

#### Scenario: A run has useful data and known gaps

- **WHEN** a local collector run durably delivers some records but leaves known backlog or gaps
- **THEN** the reference implementation SHALL report partial coverage honestly
- **AND** it SHALL distinguish clean completion from completion with gaps, retryable backlog, or terminal dead-letter work

### Requirement: Local outbox claiming uses recoverable leases

The reference implementation SHALL claim local outbox work using leases with holder identity, lease epoch, and lease deadline. Expired leases SHALL be recoverable, and stale holders SHALL NOT be able to acknowledge work after losing a lease.

#### Scenario: A worker dies while holding a lease

- **WHEN** a local collector process dies while holding a lease on outbox work
- **THEN** a later execution SHALL be able to identify the expired lease and make the work claimable again
- **AND** the work SHALL NOT remain permanently blocked in an `in_flight` state

#### Scenario: A stale worker resumes after lease expiration

- **WHEN** a stale worker resumes after its lease has expired or after another holder has claimed the work with a newer epoch
- **THEN** the stale worker SHALL NOT be able to mark that work acknowledged without passing the current lease/fencing check

### Requirement: Local collector health is connection-scoped and inspectable

The reference implementation SHALL expose local collector durable-work health for each configured connection or source instance. Health SHALL include queue depth, stale leases, retry/dead-letter counts, oldest pending work, backlog/gap counts, last acknowledgement, last committed checkpoint, package/protocol version, and device/source-home identity where available.

#### Scenario: An owner inspects a local collector connection

- **WHEN** an owner or operator inspects a local collector connection through CLI, logs, dashboard, or reference diagnostics
- **THEN** the reference implementation SHALL show whether durable work is pending, retrying, leased, stale, dead-lettered, or fully drained
- **AND** it SHALL scope that health to the configured connection or source instance rather than only to connector type

#### Scenario: Diagnostics are displayed remotely

- **WHEN** durable-work diagnostics are displayed outside the local device
- **THEN** the reference implementation SHALL avoid leaking raw local secrets, auth files, browser cookies, or unredacted absolute local paths
