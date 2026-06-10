## ADDED Requirements

### Requirement: Durable record ingest SHALL be atomic

The reference implementation SHALL treat durable record ingest as one atomic mutation of live record state, per-stream version state, and record change history. Search-index maintenance and disclosure-spine observability SHALL remain outside this durable record mutation unit unless a later OpenSpec change explicitly widens the boundary.

#### Scenario: Successful record mutation

- **WHEN** the reference ingests a record whose payload changes durable state
- **THEN** the live `records` row, appended `record_changes` row, and `version_counter` advance SHALL commit as one atomic unit
- **AND** the appended `record_changes.version` SHALL be the version recorded by `version_counter` for that `(connector_id, stream)` after the commit

#### Scenario: No-op re-ingest

- **WHEN** the reference ingests a record whose durable payload is identical to the current live state
- **THEN** it SHALL NOT append a `record_changes` row
- **AND** it SHALL NOT advance `version_counter`

#### Scenario: Repeated delete

- **WHEN** the reference receives a delete for a record that is already deleted or absent
- **THEN** it SHALL NOT append a duplicate delete change
- **AND** it SHALL NOT advance `version_counter`

#### Scenario: Durable mutation failure

- **WHEN** an error occurs before the durable ingest mutation commits
- **THEN** the reference SHALL NOT leave `records`, `record_changes`, and `version_counter` in a partially advanced state
- **AND** a later ingest for the same `(connector_id, stream)` SHALL NOT collide with or skip around a partially written version

#### Scenario: Derived index maintenance

- **WHEN** durable record ingest commits successfully
- **THEN** lexical and semantic index maintenance MAY run after the commit as derived maintenance
- **AND** failure in derived index maintenance SHALL NOT retroactively partially commit or roll back the durable record mutation
