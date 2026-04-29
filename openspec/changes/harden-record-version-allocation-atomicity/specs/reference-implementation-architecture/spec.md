## ADDED Requirements

### Requirement: Record version allocation SHALL be atomic with the durable mutation

The reference implementation SHALL allocate the next per-`(connector_id, stream)` record version with a single atomic store operation, executed inside the durable record mutation transaction, that simultaneously advances version state and returns the freshly-allocated version. The reference SHALL NOT compute the next version from a separately-observable read of `version_counter` followed by a later write.

This requirement strengthens, but does not weaken, the existing durable record ingest and direct delete atomicity requirements. Lexical, semantic, and disclosure-spine maintenance SHALL remain outside the durable record mutation transaction.

#### Scenario: Atomic allocation on first write

- **WHEN** the reference performs the first changed write for a `(connector_id, stream)` pair
- **THEN** the atomic allocator SHALL create the `version_counter` row at `max_version = 1` and return `1` in the same statement
- **AND** the appended `record_changes.version` SHALL equal the returned value

#### Scenario: Atomic allocation on subsequent writes

- **WHEN** the reference performs a subsequent changed write for an existing `(connector_id, stream)` pair
- **THEN** the atomic allocator SHALL advance `version_counter.max_version` by exactly one and return the advanced value in the same statement
- **AND** successive changed writes for the same `(connector_id, stream)` SHALL receive distinct, monotonically increasing versions

#### Scenario: No-op writes do not allocate

- **WHEN** the reference processes a no-op re-ingest, an absent-record delete, or a repeated delete
- **THEN** it SHALL NOT invoke the atomic allocator
- **AND** `version_counter` SHALL NOT advance
- **AND** `record_changes` SHALL NOT gain a row

#### Scenario: Contiguous change-log sequence

- **WHEN** consumers read `record_changes` for a `(connector_id, stream)` after a sequence of changed and no-op writes
- **THEN** the observed `version` sequence SHALL be contiguous and strictly increasing
- **AND** `changes_since` SHALL observe no gaps and no duplicates relative to `version_counter.max_version`

#### Scenario: Allocation failure rolls back the durable mutation

- **WHEN** the atomic allocation or any subsequent step inside the durable mutation transaction fails
- **THEN** the reference SHALL NOT leave `version_counter` advanced relative to `records` and `record_changes`
- **AND** a later changed write for the same `(connector_id, stream)` SHALL NOT collide with or skip around a partially allocated version
