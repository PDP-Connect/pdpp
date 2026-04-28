## ADDED Requirements

### Requirement: Storage abstraction proposals SHALL be evidence-backed before approval

Any proposal to abstract reference storage or search SHALL include a SQLite obligation inventory, semantic tests against the current SQLite implementation, and a feasibility mapping for at least one non-SQLite or fixture adapter before the abstraction is treated as approved architecture.

#### Scenario: Abstraction proposed from interface design alone

- **WHEN** a change proposes `RecordStore`, `GrantStore`, `LexicalIndex`, `SemanticIndex`, or similar contracts without first identifying the current semantic obligations they must preserve
- **THEN** the change SHALL remain exploratory
- **AND** implementation work SHALL NOT migrate production operations behind those contracts

#### Scenario: Postgres compatibility is claimed

- **WHEN** a change claims the reference architecture can support Postgres
- **THEN** the change SHALL document mappings for JSON field filters, cursor ordering, `changes_since`, transactions, lexical retrieval, semantic retrieval, and vector index identity
- **AND** the claim SHALL remain provisional until at least one operation family passes the same semantic tests through SQLite and a second adapter

### Requirement: Operation migration SHALL include conformance evidence

Each operation migrated into the operation-owned runtime architecture SHALL include conformance or equivalence evidence proving the operation's behavior did not drift across supported hosts or profiles.

#### Scenario: Operation mounted in sandbox and local server

- **WHEN** an operation is mounted through both the local server host and the sandbox host
- **THEN** the same conformance scenarios SHALL pass against both hosts
- **AND** any profile-specific limitation SHALL be disclosed in the environment capability matrix
