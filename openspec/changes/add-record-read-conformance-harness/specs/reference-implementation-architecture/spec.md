## ADDED Requirements

### Requirement: Durable record reads SHALL have a reusable conformance harness

The reference implementation SHALL provide a test-only conformance harness for durable record read semantics before extracting production `RecordStore` read contracts or claiming alternate storage adapter compatibility for record reads.

#### Scenario: Current SQLite reference driver

- **WHEN** the record-read conformance harness runs against the current SQLite-backed reference implementation
- **THEN** it SHALL prove stable record-list pagination, cursor round trips, `changes_since` bootstrap/cursor behavior, field projection, and declared filter behavior through reusable scenarios
- **AND** it SHALL NOT require production code to expose a generic repository, raw SQL handle, route handler, ORM builder, or `RecordStore` abstraction

#### Scenario: Harness falsifiability

- **WHEN** the conformance harness is exercised against a deliberately broken test fixture for at least one record-read invariant
- **THEN** the test suite SHALL prove that the harness detects the broken behavior
- **AND** the broken fixture SHALL NOT be used as a production adapter or environment profile

#### Scenario: Scope boundary

- **WHEN** the harness is introduced
- **THEN** it SHALL remain limited to durable record read/list semantics
- **AND** it SHALL NOT claim coverage for record mutation atomicity, disclosure spine conformance, lexical retrieval, semantic retrieval, hybrid retrieval, blob content, or connector runtime behavior
