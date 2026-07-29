## ADDED Requirements

### Requirement: Reference connector-summary enumeration SHALL be a bounded read path

The reference implementation SHALL treat unscoped `GET /_ref/connectors` as a
bounded identity-page read path. It SHALL apply owner scope, deterministic
identity ordering, keyset continuation, and page limit in storage before
summary synthesis. It SHALL batch page evidence through semantic store
interfaces and keep fleet-level composition separate from page item synthesis.

#### Scenario: A page does not pay for unrelated connections

- **GIVEN** a requested owner page contains connection ids `A` through `Z`
- **WHEN** the summary gatherer reads repairable evidence, schedules, run
  history, product projections, or runtime snapshots
- **THEN** connection-grain storage reads SHALL be scoped to `A` through `Z`
- **AND** the gatherer SHALL NOT enumerate unrelated owner connections merely
  to render that page.

#### Scenario: Fleet composition remains independent

- **WHEN** the console needs fleet counts, attention rollups, or fleet health
- **THEN** the reference SHALL obtain those values through their own bounded
  aggregate/composition read
- **AND** SHALL NOT describe a partial connector-summary page as fleet truth.
