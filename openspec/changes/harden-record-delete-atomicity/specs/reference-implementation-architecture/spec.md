## ADDED Requirements

### Requirement: Direct record delete SHALL be atomic

The reference implementation SHALL treat direct owner-authenticated record delete as one atomic mutation of live record state, per-stream version state, and record change history. Search-index maintenance and disclosure-spine observability SHALL remain outside this durable record mutation unit unless a later OpenSpec change explicitly widens the boundary.

#### Scenario: Successful direct delete

- **WHEN** the reference directly deletes an existing live record
- **THEN** the live `records` row delete marker, appended deleted `record_changes` row, and `version_counter` advance SHALL commit as one atomic unit
- **AND** the appended `record_changes.version` SHALL be the version recorded by `version_counter` for that `(connector_id, stream)` after the commit

#### Scenario: No-op direct delete

- **WHEN** the reference directly deletes a record that is absent or already deleted
- **THEN** it SHALL NOT append a `record_changes` row
- **AND** it SHALL NOT advance `version_counter`

#### Scenario: Direct delete mutation failure

- **WHEN** an error occurs before the durable direct-delete mutation commits
- **THEN** the reference SHALL NOT leave `records`, `record_changes`, and `version_counter` in a partially advanced state
- **AND** a later mutation for the same `(connector_id, stream)` SHALL NOT collide with or skip around a partially written version

#### Scenario: Derived index delete maintenance

- **WHEN** durable direct record delete commits successfully
- **THEN** lexical and semantic index delete maintenance MAY run after the commit as derived maintenance
- **AND** failure in derived index delete maintenance SHALL NOT retroactively partially commit or roll back the durable direct delete mutation
