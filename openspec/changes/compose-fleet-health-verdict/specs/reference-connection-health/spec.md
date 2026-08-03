## ADDED Requirements

### Requirement: Owner fleet health SHALL compose existing typed evidence

The reference implementation SHALL expose one owner-only, read-only fleet
health composition over current configured-connection inventory, current
connection summaries and rendered verdicts, runtime-envelope evidence, and the
existing stream-coverage audit. The composition SHALL return fleet `state`, a
strict `fully_healthy` boolean, explicit scope reconciliation, and typed
dimensions. It SHALL NOT persist a fleet state, replace the connection-health
projection, or infer its result by parsing UI copy or untyped run text.

#### Scenario: Owner action prevents full health

- **WHEN** an assessed connection has a current owner-satisfiable required
  action or blocking attention evidence
- **THEN** the fleet state SHALL be `unhealthy`
- **AND** `fully_healthy` SHALL be false
- **AND** the connection SHALL appear in a typed owner-action dimension.

#### Scenario: Connector and recovery trouble prevent full health

- **WHEN** an assessed connection is connector-broken, degraded, cooling off,
  has a maintainer `code_fix` action, retryable or terminal recovery trouble,
  or stalled work
- **THEN** the fleet state SHALL be `unhealthy`
- **AND** each cause SHALL remain in its applicable typed dimension.

#### Scenario: Runtime or coverage-audit failure prevents full health

- **WHEN** runtime evidence is unavailable or unhealthy, or the existing
  stream-coverage audit reports failure
- **THEN** the fleet state SHALL be `unhealthy`
- **AND** the runtime and coverage-audit results SHALL remain distinct
  dimensions.

#### Scenario: Healthy bounded work remains progress context

- **WHEN** an assessed connection has fresh retained data, settled coverage,
  and active bounded collection work with no failure, stale, or unknown
  evidence
- **THEN** the fleet state SHALL be `healthy`
- **AND** `fully_healthy` SHALL be true
- **AND** the connection SHALL remain in the typed active-work dimension.

#### Scenario: Genuine unsettled evidence prevents a health claim

- **WHEN** no unhealthy condition exists but unknown health or coverage
  evidence, an inconclusive stream-coverage audit, or an unassessed configured
  connection remains
- **THEN** the fleet state SHALL be `indeterminate`
- **AND** `fully_healthy` SHALL be false.

#### Scenario: Intentional manual or paused policy is not a fault

- **WHEN** an otherwise healthy assessed connection is manual or paused by
  current policy
- **THEN** it SHALL appear in an intentional-policy dimension
- **AND** it SHALL NOT alone make the fleet unhealthy or indeterminate.

#### Scenario: Stale manual or paused data is advisory

- **WHEN** a manual or paused connection has current typed stale-freshness
  evidence and no unhealthy or indeterminate evidence exists
- **THEN** the fleet state SHALL be `healthy_with_advisories`
- **AND** `fully_healthy` SHALL be false
- **AND** the connection SHALL appear in a freshness-advisory dimension.

#### Scenario: Fully healthy is strict

- **WHEN** every operational configured connection is assessed and has no
  unhealthy, unknown, coverage-audit, or freshness-advisory cause
- **THEN** the fleet state SHALL be `healthy`
- **AND** `fully_healthy` SHALL be true.

### Requirement: Fleet health SHALL reconcile configured scope explicitly

The fleet-health composition SHALL report the configured population, assessed
connections, intentional exclusions, setup-pending connections, and
unassessed connections. A revoked connection SHALL be an intentional exclusion.
A draft or setup-in-progress connection SHALL be visible as setup-pending and
shall not be silently counted as assessed healthy.

#### Scenario: Configured connection has no assessable summary

- **WHEN** a configured operational connection lacks an assessable current
  summary projection
- **THEN** the composition SHALL report its identity in unassessed scope
- **AND** the fleet state SHALL be `indeterminate`.

#### Scenario: Summary and inventory disagree in either direction

- **WHEN** an independently-read summary names a connection absent from the
  configured inventory snapshot
- **THEN** the composition SHALL report that summary identity in unassessed
  scope
- **AND** the fleet state SHALL be `indeterminate`.

#### Scenario: Draft and revoked inventory stay explicit

- **WHEN** configured inventory contains draft, setup-in-progress, and revoked
  connections
- **THEN** draft and setup-in-progress connections SHALL be reported as
  setup-pending
- **AND** revoked connections SHALL be reported as intentional exclusions
- **AND** neither class SHALL be silently counted as assessed healthy.

### Requirement: Stream coverage audit SHALL remain coverage evidence

The existing stream-health audit SHALL remain a narrow required-stream coverage
evidence check. Its name and description SHALL NOT present a passing result as
a fleet-health verdict. The fleet composer MAY consume its typed result as one
dimension but SHALL NOT change its settled-connection or coverage predicates.

#### Scenario: Coverage passes while fleet is unhealthy

- **WHEN** the stream-health audit passes but a connection has owner action,
  connector repair trouble, or other fleet-health blocking evidence
- **THEN** the stream-health audit SHALL remain a passing coverage result
- **AND** the fleet composition SHALL return `unhealthy`.
