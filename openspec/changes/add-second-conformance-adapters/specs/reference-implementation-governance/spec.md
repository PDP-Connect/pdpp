## MODIFIED Requirements

### Requirement: Storage and search abstractions SHALL be proven before promotion
Any proposal to abstract reference storage or search SHALL include a SQLite obligation inventory, semantic tests against the current SQLite implementation, and a feasibility mapping for at least one non-SQLite or fixture adapter before the abstraction is treated as approved architecture.

Before a test-only conformance-driver shape is promoted into a production storage/search interface, the relevant capability harness SHALL pass against the current SQLite implementation and at least one conforming second adapter. A deliberately broken adapter remains useful falsifiability evidence, but it SHALL NOT count as the conforming second adapter required for promotion.

#### Scenario: A production record-read storage interface is proposed
- **WHEN** a change proposes a production `RecordStore` read interface for record listing, record detail, cursor pagination, `changes_since`, projection, or declared filters
- **THEN** the record-read conformance harness SHALL already pass against SQLite and at least one conforming second adapter
- **AND** any Postgres compatibility claim SHALL remain provisional until the same harness passes against an env-gated Postgres driver

#### Scenario: A production record-mutation storage interface is proposed
- **WHEN** a change proposes a production record-mutation storage interface for ingest, delete, per-stream versions, or `record_changes`
- **THEN** the record-mutation conformance harness SHALL already pass against SQLite and at least one conforming second adapter

#### Scenario: A production disclosure-spine interface is proposed
- **WHEN** a change proposes a production `DisclosureSpineStore` interface for append/list/terminal event or summary behavior
- **THEN** the disclosure-spine conformance harness SHALL already pass against SQLite and at least one conforming second adapter
