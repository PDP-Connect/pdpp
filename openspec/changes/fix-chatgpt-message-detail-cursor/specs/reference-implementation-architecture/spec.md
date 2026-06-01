## ADDED Requirements

### Requirement: Connector detail cursors are stream-specific
When a reference connector derives a child stream by fetching details for records discovered through a parent stream, the reference implementation SHALL track child-detail progress separately from the parent-list cursor. A parent stream cursor SHALL NOT cause a later child-stream collection to skip parent records whose child detail has not yet been collected.

#### Scenario: Child stream enabled after parent-only run
- **WHEN** a parent stream has advanced its cursor during a parent-only collection run
- **THEN** a later collection run that requests the child stream SHALL still fetch detail for parent records not yet covered by the child stream cursor

#### Scenario: Detail cursor advances after coverage
- **WHEN** child detail collection completes or records recoverable detail gaps for a batch of parent records
- **THEN** the child stream cursor SHALL advance only after the corresponding detail coverage is emitted
