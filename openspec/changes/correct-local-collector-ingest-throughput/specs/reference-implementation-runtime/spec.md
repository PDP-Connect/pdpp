## ADDED Requirements

### Requirement: Ingest execution SHALL have process-wide bounded semantic work

Active batch execution and required index work SHALL use process-wide bounded
semaphores with bounded waiter queues; request-local `Promise.all(records)` is
forbidden. Duplicate logical keys contribute only final-state work. Failure
selection SHALL be lowest final input index after in-flight work drains.
Per-request state may retain its canonical input, compact O(batch) descriptors,
and one final-key map but not completed embedding tensors or duplicate payload
graphs. Aggregate multi-process capacity is replicas times the configured local
limit and must fit model/database capacity.

The semantic limit SHALL be selected from 1, 2, 4, or 8 by a representative
real local-transformer 100-record benchmark that records elapsed time, output
equality/cardinality, errors, high-water, and peak RSS. Eight is a ceiling,
not a default.

#### Scenario: Concurrent batches cannot multiply semantic work

- **WHEN** batches for multiple connector instances require semantic repair
- **THEN** global observed in-flight work and queued waiters SHALL remain within
configured bounds
- **AND** excess HTTP work SHALL receive safe retryable admission

### Requirement: Semantic and index admission plus device batch attempts SHALL have bounded time ownership

Semantic admission waiters SHALL have a configurable monotonic acquisition
deadline. A timed-out waiter SHALL remove only itself, preserve FIFO order for
remaining waiters, and return the stable retryable `semantic_work_busy` code;
it SHALL not consume or release another caller's permit. The child executor
SHALL bound parent-side outstanding work before spawning or writing a job to at
most its selected active work limit plus queue limit, returning a stable safe
retryable code when full.

Index admission waiters SHALL have the configurable acquisition deadline
`PDPP_INGEST_INDEX_WORK_ACQUIRE_DEADLINE_MS`. A timed-out waiter SHALL
remove only itself, preserve FIFO order for remaining waiters, and return the
stable retryable `record_index_busy` code without consuming or releasing a
permit. The active index limit and waiter queue SHALL remain bounded.

A device batch SHALL use one monotonic attempt deadline beginning before the
first durable record transaction and check it before and after each awaited
durable transaction, before and after authoritative final-key repair, and
before and after each final-key index operation. It SHALL drain every
already-started operation before selecting the lowest final input-index
failure, rather than using `Promise.race` to release the batch, semantic, index,
or connector fence around live work. Required semantic device streams SHALL
fail safely before a processing reservation unless the current backend both is
usable and explicitly confirms the required attempt-fencing contract. Empty
values in declared semantic fields remain a completed zero-row plan.

#### Scenario: A semantic waiter expires without corrupting permits

- **WHEN** one semantic operation holds the only permit and an earlier queued
  waiter reaches its acquisition deadline
- **THEN** that waiter SHALL return `semantic_work_busy` and be removed
- **AND** a later queued operation SHALL acquire exactly once when the holder
  releases, without any negative or leaked permit count

#### Scenario: An index waiter expires without corrupting permits

- **WHEN** one index operation holds the only permit and an earlier queued
  waiter reaches `PDPP_INGEST_INDEX_WORK_ACQUIRE_DEADLINE_MS`
- **THEN** that waiter SHALL return `record_index_busy` and be removed
- **AND** a later queued operation SHALL acquire exactly once when the holder
  releases, with active and queued index stats returning to zero

### Requirement: Local transformer execution SHALL be killable and fenced

Reserved local-transformer embedding SHALL execute compute-only in one bounded
OS child executor with no database/index handles or credentials. Every job
SHALL carry executor generation, job, attempt, and backend identities; only the
main process may write vectors after rechecking them. A deadline SHALL send
TERM, await a distinct monotonic grace, then send KILL and await a distinct
kill grace. Results from timed out, old, or mismatched generations SHALL be
discarded.

No batch, semantic, connector, or advisory capacity may be released and no
replacement may start before old child exit is confirmed. If exit remains
unconfirmed after KILL grace, the server SHALL stop accepting work and fail-stop
nonzero without releasing/reusing capacity. Production local semantic startup
SHALL fail unless a supervisor restart contract is configured. The synchronous
stub is bounded; any other reserved backend must provide an equivalent confirmed
cancellation executor or fail required work safely before reservation.

#### Scenario: An uncooperative compute child cannot become a zombie writer

- **WHEN** a child misses an attempt deadline and does not exit on TERM
- **THEN** the parent SHALL KILL, fence all generation jobs, and await exit
- **AND** if confirmation remains absent it SHALL fail-stop for supervised restart
- **AND** sticky reservations SHALL resume after restart without old results writing
