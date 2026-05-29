## MODIFIED Requirements

### Requirement: Postgres runtime storage SHALL cover AS and control-plane durable state

The explicit Postgres runtime backend SHALL provide Postgres-backed storage for
durable authorization-server, resource-server, and operator-control state
needed to run the reference server without a local persistent SQLite database
acting as a second durable authority.

#### Scenario: Authorization state is durable in Postgres mode

- **WHEN** `PDPP_STORAGE_BACKEND=postgres` is configured
- **THEN** OAuth clients, grants, tokens, pending consent requests, and owner
  device-authorization requests SHALL be written to and read from Postgres
- **AND** token introspection, grant revocation, client deletion cascades,
  consent approval/denial, and owner-device polling SHALL preserve existing
  public response shapes and error codes.

#### Scenario: Connector and controller state is durable in Postgres mode

- **WHEN** `PDPP_STORAGE_BACKEND=postgres` is configured
- **THEN** connector manifests, connector sync state, schedules, active runs,
  search cursor snapshots, and reference read models SHALL be written to and
  read from Postgres
- **AND** reference routes that list connectors, approvals, schedules, active
  runs, search pages, or dashboard summaries SHALL not require durable rows in
  SQLite.

#### Scenario: Postgres runtime does not serve stale SQLite read models

- **WHEN** `PDPP_STORAGE_BACKEND=postgres` is configured
- **AND** local SQLite contains older or divergent derived read-model rows
- **THEN** reference routes SHALL NOT serve those SQLite rows as current
  Postgres runtime state
- **AND** derived read-model freshness metadata SHALL describe the active
  backend's projection state.

#### Scenario: Remaining SQLite use is explicitly classified

- **WHEN** runtime code can still initialize or touch SQLite while
  `PDPP_STORAGE_BACKEND=postgres` is configured
- **THEN** that use SHALL be classified as guarded SQLite-backend code,
  explicitly ephemeral/test-only compatibility, or a known violation tracked by
  the active Postgres-boundary change
- **AND** unclassified persistent SQLite reads SHALL fail validation before the
  implementation is considered complete.

#### Scenario: Postgres runtime names are storage-neutral

- **WHEN** runtime code constructs blob, consent, owner-device, connector-state,
  scheduler, dataset-summary, or other durable reference stores
- **THEN** production call sites SHALL use storage-neutral factory names
- **AND** SQLite-specific factory names MAY remain as compatibility aliases only
  for tests or older imports.
