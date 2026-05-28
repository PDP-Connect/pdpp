## ADDED Requirements

### Requirement: Disclosure spine SHALL have a reusable conformance harness

The reference implementation SHALL provide a test-only conformance harness for disclosure-spine semantics before extracting production `DisclosureSpineStore` contracts or claiming alternate storage adapter compatibility for spine behavior.

#### Scenario: Current SQLite reference driver

- **WHEN** the disclosure-spine conformance harness runs against the current SQLite-backed reference implementation
- **THEN** it SHALL prove append order, correlation timeline ordering, pagination cursor behavior where supported, terminal event lookup, and correlation summary aggregate extent through reusable scenarios
- **AND** it SHALL NOT require production code to expose a generic repository, raw SQL handle, route handler, ORM builder, or `DisclosureSpineStore` abstraction

#### Scenario: Harness falsifiability

- **WHEN** the conformance harness is exercised against a deliberately broken test fixture for at least one spine invariant
- **THEN** the test suite SHALL prove that the harness detects the broken behavior
- **AND** the broken fixture SHALL NOT be used as a production adapter or environment profile

#### Scenario: Scope boundary

- **WHEN** the harness is introduced
- **THEN** it SHALL remain limited to disclosure-spine semantics
- **AND** it SHALL NOT claim coverage for record storage, lexical retrieval, semantic retrieval, hybrid retrieval, blob content, or connector runtime behavior
