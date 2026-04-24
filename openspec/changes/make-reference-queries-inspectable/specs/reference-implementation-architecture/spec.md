## ADDED Requirements

### Requirement: Static reference SQL SHALL be inspectable by name
The reference implementation SHALL keep static SQLite statements that define durable reference behavior in named query artifacts or an equivalent named registry. Query identifiers SHALL be stable enough for reviewers, tests, and future operator tooling to refer to them directly.

#### Scenario: A reviewer audits record-list SQL
- **WHEN** a reviewer needs to inspect the SQL used by a durable reference route
- **THEN** the query SHALL be discoverable by a stable name rather than only by grepping unrelated application code
- **AND** the call site SHALL make the selected query name clear

### Requirement: Query extraction SHALL NOT hide dynamic behavior
The reference implementation SHALL keep genuinely dynamic SQL construction explicit when extracting it would obscure authorization, filter, pagination, or variable-list semantics.

#### Scenario: A query has optional filters
- **WHEN** SQL shape changes based on request filters, grant constraints, cursor predicates, or a variable number of candidate keys
- **THEN** the reference MAY keep that query assembly in code
- **AND** the dynamic branch SHALL remain auditable and covered by tests

### Requirement: Extracted SQL SHALL be validated against the reference schema
The reference implementation SHALL provide a validation path that prepares or analyzes extracted static SQL against the current reference schema so missing tables, missing columns, and malformed statements fail before runtime use.

#### Scenario: A query references a removed column
- **WHEN** an extracted SQL artifact references a column that no longer exists in the current schema
- **THEN** the reference verification path SHALL fail with a diagnostic identifying the query artifact
