## ADDED Requirements

### Requirement: Lexical Retrieval Conformance Harness

The reference implementation SHALL maintain a test-only lexical retrieval conformance harness before promoting lexical indexing into a production storage interface.

#### Scenario: Multiple drivers prove the lexical contract

**WHEN** the lexical conformance suite runs
**THEN** it SHALL exercise at least the production SQLite-backed driver and one non-SQLite memory driver
**AND** both drivers SHALL satisfy the same semantic retrieval invariants while advertising their backend identity and score semantics.

#### Scenario: Broken driver proves falsifiability

**WHEN** a deliberately broken lexical driver drops indexed content or violates deterministic result ordering
**THEN** the conformance suite SHALL fail.

#### Scenario: Harness remains test-only

**WHEN** the harness is introduced
**THEN** it SHALL NOT create a production `LexicalIndex` interface
**AND** SHALL NOT change public `/v1/search` behavior.
