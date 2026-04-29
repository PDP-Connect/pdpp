## ADDED Requirements

### Requirement: Connector state and scheduler persistence semantics SHALL be conformance-tested before storage extraction

Before introducing production `ConnectorStateStore` or `SchedulerStore` abstractions, the reference implementation SHALL define reusable test-only conformance scenarios that pin the current connector-state, schedule, and active-run persistence obligations.

#### Scenario: Connector state conformance

- **WHEN** a candidate connector-state persistence driver is evaluated
- **THEN** it SHALL pass conformance scenarios for owner-scoped state upsert/list, overwrite behavior, grant-scoped state isolation, and allowed-stream enforcement where feasible
- **AND** any behavior left to route/runtime tests SHALL be explicitly documented as deferred from the storage conformance harness

#### Scenario: Schedule conformance

- **WHEN** a candidate scheduler persistence driver is evaluated
- **THEN** it SHALL pass conformance scenarios for schedule create, update, list, pause, resume, and delete behavior where feasible
- **AND** schedule policy warnings that are not storage behavior SHALL remain covered by controller tests unless a narrow persistence seam already exists

#### Scenario: Active-run conformance

- **WHEN** a candidate active-run persistence driver is evaluated
- **THEN** it SHALL pass conformance scenarios for one-active-run-per-connector, unique run id, lookup, delete, and abandoned-run cleanup behavior where feasible
- **AND** any controller-only behavior SHALL remain covered by existing route/controller tests

#### Scenario: Harness boundary

- **WHEN** the conformance harness is implemented
- **THEN** it SHALL live under `reference-implementation/test/**`
- **AND** it SHALL expose semantic lifecycle operations rather than raw SQL, table names, generic repositories, or production store interfaces
- **AND** it SHALL include a falsifiability proof that fails on at least one deliberately broken state, schedule, or active-run invariant
