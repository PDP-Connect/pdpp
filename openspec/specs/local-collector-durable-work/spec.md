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

### Requirement: Local collector deployment posture is mechanically visible

The reference implementation SHALL expose, on the local collector health
surface, whether the running collector resolves to a published package install
or to a repository `dist/` development override, so an operator or agent can
tell published operator-host evidence from local development evidence without a
manual path-resolution ritual. The posture signal SHALL include the package
version, a mutually-exclusive classification — published package, repository
`dist/` override, or unknown — and a flag for the placeholder `0.0.0` version
that disqualifies a build from being treated as a real published version.

#### Scenario: A published install is inspected

- **WHEN** the running `pdpp-local-collector` resolves to a package installed
  under `node_modules/@pdpp/local-collector`
- **THEN** the health surface SHALL classify the deployment posture as a
  published package
- **AND** it SHALL report the installed package version alongside the
  classification

#### Scenario: A repository dist override is inspected

- **WHEN** the running `pdpp-local-collector` resolves to a monorepo checkout's
  `packages/local-collector` tree rather than a `node_modules` install — for
  example via `npm link`, a `file:` install, or running the source entrypoint
  directly
- **THEN** the health surface SHALL classify the deployment posture as a
  repository `dist/` override rather than as a published package
- **AND** `doctor` SHALL treat that posture as a warning that disqualifies the
  output as published operator-host evidence, not as a hard failure
- **AND** `doctor` SHALL NOT escalate that posture to its critical severity

#### Scenario: Posture cannot be determined conclusively

- **WHEN** the health surface cannot conclusively determine whether the running
  collector is a published install or a repository override
- **THEN** it SHALL report the posture as unknown rather than guessing a
  published-package classification

#### Scenario: The placeholder version is reported

- **WHEN** the running collector reports the placeholder `0.0.0` version
- **THEN** the health surface SHALL flag that the version is a placeholder that
  must not be treated as a real published version
- **AND** `doctor` SHALL surface that as a warning

#### Scenario: Posture is displayed without leaking local paths

- **WHEN** the deployment posture is displayed, including outside the local
  device
- **THEN** the posture signal SHALL convey the module-location classification
  without emitting an unredacted absolute local path such as a home directory

### Requirement: Local collector bounds retained acknowledged outbox work automatically

The local collector runner SHALL bound the number of acknowledged
(server-confirmed `succeeded`) rows retained in the durable local outbox, as an
intrinsic part of a normal run, without requiring a separate timer, schedule, or
operator command for correctness. After a drain attempt completes, the runner
SHALL prune acknowledged rows that exceed a most-recent-count cap for the run's
source instance, removing every acknowledged row outside the most-recent
retained set REGARDLESS of how recently it was acknowledged, so that the
retained acknowledged row count can never exceed the configured cap. The prune
SHALL operate only on acknowledged rows and SHALL NOT remove pending/ready,
leased, retryable, or dead-letter work. The automatic prune SHALL NOT create a
database backup file on each run. The runner SHALL expose how many acknowledged
rows the prune reclaimed on its run result, and the outbox counts it reports on
its run result and heartbeat after a run SHALL reflect the post-prune state. An
operator SHALL be able to disable or retune the cap through run configuration or
environment without rebuilding the collector, and a malformed override SHALL NOT
prevent the run from completing.

#### Scenario: A clean run accumulates acknowledged rows beyond the cap

- **WHEN** a local collector completes a drain and the durable outbox retains
  more acknowledged rows than the most-recent-count cap for the run's source
  instance
- **THEN** the runner SHALL remove the acknowledged rows outside the most-recent
  retained set
- **AND** it SHALL retain exactly the most-recent rows up to the cap
- **AND** it SHALL report the number of acknowledged rows reclaimed on the run
  result

#### Scenario: A large acknowledged tail was all acknowledged recently

- **WHEN** a local collector completes a drain and the durable outbox retains
  far more acknowledged rows than the cap, all of which were acknowledged within
  a short recent window
- **THEN** the runner SHALL still remove every acknowledged row outside the
  most-recent retained set, so the recency of acknowledgement does not protect
  rows beyond the cap
- **AND** the retained acknowledged row count SHALL be reduced to the cap on
  that run

#### Scenario: A run leaves undelivered work behind

- **WHEN** a local collector completes a drain attempt that leaves
  pending/ready, leased, retryable, or dead-letter rows in the durable outbox
- **THEN** the automatic prune SHALL NOT remove any of those rows
- **AND** it SHALL remove only acknowledged rows that exceed the cap

#### Scenario: Acknowledged rows are within the cap

- **WHEN** a local collector completes a drain and the retained acknowledged
  rows are within the most-recent-count cap
- **THEN** the runner SHALL retain those acknowledged rows
- **AND** it SHALL report that no acknowledged rows were reclaimed

#### Scenario: An operator disables or retunes the automatic prune

- **WHEN** an operator disables the automatic prune, or retunes its
  most-recent-count cap, through run configuration or environment on a deployed
  collector
- **THEN** the runner SHALL honor the override without requiring a rebuild
- **AND** when disabled it SHALL retain all acknowledged rows and report that
  the automatic prune did not run
- **AND** a malformed override value SHALL fall back to the lower-precedence
  setting rather than fail the run

#### Scenario: The automatic prune runs without a per-run backup

- **WHEN** the automatic prune removes acknowledged rows during a normal run
- **THEN** it SHALL NOT write a database backup file for that prune
- **AND** the removal SHALL be bounded by the most-recent-count cap so it can
  never remove all acknowledged rows in one pass
