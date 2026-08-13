## Purpose

Ensures a local collector's acknowledged source-instance cursor vector and
terminal per-stream evidence reach the reference as one durable, replayable run
commit rather than two independently failing network operations.

## ADDED Requirements

### Requirement: Terminal collection run commits SHALL be durable and idempotent

When a local collector has successful terminal facts for a source-instance run,
it SHALL persist one durable terminal run commit before any server can observe
the run's associated checkpoint vector. The commit SHALL be a versioned
canonical envelope whose server-recomputed SHA-256 binds its stable commit/run
identity, authenticated device, source instance, canonical connector, resolved
connection, supplied state delta, normalized terminal facts, and boundary. The
reference SHALL durably retain the envelope hash, binding, and exact successful
response. Same identity/hash SHALL replay that response without writes; any
different envelope or binding for that identity SHALL fail closed with a typed
non-retryable conflict and SHALL not disclose another receipt.

#### Scenario: Terminal request does not reach the reference

- **WHEN** a collector has persisted a terminal run commit and its request fails before the reference accepts it
- **THEN** the checkpoint vector and terminal facts SHALL remain retryable from durable local work
- **AND** a later collector execution SHALL be able to submit the same commit without re-scanning the source.

#### Scenario: Reference commits but the response is lost

- **WHEN** the reference durably commits a terminal run commit and the collector does not receive its response
- **THEN** a retry with the same idempotency identity SHALL succeed without producing another terminal event
- **AND** the reference SHALL retain the checkpoint vector and terminal facts from exactly one commit.

### Requirement: Terminal run commits SHALL be atomic at the reference boundary

The reference SHALL atomically persist a terminal run commit's source-instance
checkpoint delta and attributable terminal event and its run-history projection. It SHALL NOT expose the
checkpoint vector as committed if the matching terminal event did not commit,
and it SHALL NOT expose a terminal event whose matching checkpoint vector did
not commit.

#### Scenario: A multi-stream terminal run commits

- **WHEN** a valid terminal run commit contains cursors and terminal facts for multiple streams
- **THEN** the reference SHALL commit the full supplied cursor vector and exactly one attributable terminal event together
- **AND** a failure before that transaction commits SHALL leave neither newly committed.

#### Scenario: A fault occurs inside the commit transaction

- **WHEN** a fault is injected after a state write, terminal-event insert, or run-history write
- **THEN** the reference SHALL roll back the state delta, event, and run-history projection together.

### Requirement: Terminal commits SHALL preserve omitted state and empty terminal vectors

The reference SHALL atomically upsert supplied valid stream entries and preserve omitted existing entries. A valid terminal commit with an empty supplied state map SHALL still persist and retry its terminal facts.

#### Scenario: A terminal run omits a prior stream

- **WHEN** a terminal commit supplies one stream and an earlier state contains another stream
- **THEN** the earlier stream SHALL remain unchanged and the supplied stream plus terminal event SHALL commit atomically.

### Requirement: Terminal run-commit failures SHALL be accurately classified

The collector SHALL represent an unacknowledged terminal run commit as retryable
terminal-commit work or terminal-commit diagnostics. It SHALL NOT classify that
condition as a connector-child failure or state that the failure occurred before
an already committed checkpoint.

#### Scenario: Terminal delivery fails after records drain

- **WHEN** records and gaps have drained but a terminal run commit has not been acknowledged
- **THEN** the collector SHALL report the terminal run commit as pending or retrying
- **AND** it SHALL preserve its source-instance and stream-boundary identity without exposing payloads or credentials.
