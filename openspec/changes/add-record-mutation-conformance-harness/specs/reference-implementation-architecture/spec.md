## ADDED Requirements

### Requirement: Durable record mutation SHALL have a reusable conformance harness

The reference implementation SHALL provide a test-only conformance harness for durable record mutation semantics before extracting a production `RecordStore` or adding a second storage adapter for records.

#### Scenario: Current SQLite reference driver

- **WHEN** the record mutation conformance harness runs against the current SQLite-backed reference implementation
- **THEN** it SHALL prove changed writes, no-op writes, ingest deletes, direct deletes, rollback behavior, and version contiguity through the same reusable scenarios
- **AND** it SHALL NOT require production code to expose a generic repository, SQL handle, ORM builder, or `RecordStore` abstraction

#### Scenario: Harness falsifiability

- **WHEN** the conformance harness is exercised against a deliberately broken test fixture for at least one durable mutation invariant
- **THEN** the test suite SHALL prove that the harness detects the broken behavior
- **AND** the broken fixture SHALL NOT be used as a production adapter or environment profile

#### Scenario: Scope boundary

- **WHEN** the harness is introduced
- **THEN** it SHALL remain limited to durable record mutation semantics
- **AND** it SHALL NOT claim coverage for record read/list cursors, `changes_since`, range filters, `expand[]`, lexical retrieval, semantic retrieval, hybrid retrieval, or disclosure spine conformance
