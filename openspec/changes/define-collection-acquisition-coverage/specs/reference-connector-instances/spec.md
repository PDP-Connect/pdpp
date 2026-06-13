## ADDED Requirements

### Requirement: Connector instances MAY aggregate multiple acquisition paths under one logical connection

The reference implementation SHALL allow one owner-facing connection to receive
records for the same logical source through multiple acquisition paths when each
path is represented by acquisition-batch provenance and records remain
instance-scoped.

Adding a second acquisition path SHALL NOT require a second owner-facing
connection when the owner is strengthening coverage for the same logical source.

#### Scenario: Historical and current acquisitions belong to one source

- **WHEN** an owner uses an owner artifact to hydrate historical data for a
  source
- **AND** later authorizes a browser-polyfill, provider API, or device-sync path
  for current data for the same source
- **THEN** the reference MAY keep both acquisition paths under one connection
- **AND** each accepted batch SHALL retain acquisition method and provenance
- **AND** records from one acquisition path SHALL NOT overwrite sibling records
  unless explicit identity rules say they are the same logical record.

#### Scenario: Acquisition path targets a different account or device

- **WHEN** an acquisition path refers to a different account, device, local
  binding, or source identity
- **THEN** the reference SHALL create or require a distinct connection or
  source-instance identity rather than merging it into an existing connection by
  connector type alone.

### Requirement: Same-stream writes from multiple acquisition paths SHALL be explicit and non-destructive

When multiple acquisition paths write to the same stream for one connection, the reference SHALL preserve record identity, acquisition provenance, and coverage claim attribution.

A later acquisition path SHALL NOT erase, tombstone, or hide records from an
earlier path merely because the later path did not observe them.

#### Scenario: Daily current-data path does not erase historical archive data

- **WHEN** a historical owner-artifact batch populated records for a stream
- **AND** a later daily provider API or browser-polyfill batch observes only a
  current window for the same stream
- **THEN** the current-data batch SHALL NOT tombstone or hide historical records
  outside its declared coverage window
- **AND** the reference SHALL keep the historical batch's coverage claim visible.

#### Scenario: Full-refresh path has explicit coverage authority

- **WHEN** a connector claims full-refresh coverage for a stream and acquisition
  method
- **THEN** any destructive reconciliation SHALL be limited to that declared
  coverage authority
- **AND** it SHALL NOT apply to records whose only evidence came from a distinct
  acquisition method unless an explicit cross-method identity rule authorizes
  that reconciliation.
