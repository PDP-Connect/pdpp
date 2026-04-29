## MODIFIED Requirements

### Requirement: Record Mutation Atomicity

The reference implementation SHALL commit durable record payload, record-change, and stream-version state as one atomic mutation. Version allocation for a changed record mutation SHALL be atomic with respect to the mutation and SHALL NOT be implemented as a separately observable read-then-write sequence.

#### Scenario: Changed writes allocate unique versions

**WHEN** two changed writes are committed for the same connector stream
**THEN** each write receives a distinct monotonically increasing stream version
**AND** `changes_since` observes the committed changes as a contiguous version sequence.

#### Scenario: No-op writes do not allocate

**WHEN** an identical record payload is re-ingested or an already-deleted record is deleted again
**THEN** the reference implementation SHALL NOT append a record-change row
**AND** SHALL NOT advance the stream version counter.
