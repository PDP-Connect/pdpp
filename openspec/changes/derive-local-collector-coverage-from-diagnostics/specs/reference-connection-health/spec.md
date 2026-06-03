## ADDED Requirements

### Requirement: Local collector coverage SHALL derive from durable coverage diagnostics

When the connection-health rollup cannot derive a coverage verdict from run evidence (no terminal spine run, no pending detail gap, no degrading or accepted-coverage known gap, and no contradictory manifest), it SHALL derive the connection's coverage axis from the connection's durable `coverage_diagnostics` records. Local-device collectors push records from a device outbox and write no spine run history, so without this the coverage axis can only be `unknown` for them even after a successful host-local drain.

The derivation SHALL mirror the safe classification already used for the device-exporter completeness diagnostics: a store is accounted for when its coverage status is any recognized safe status other than `unaccounted`. When at least one coverage record is observed and no store is `unaccounted`, the coverage axis SHALL be `complete`. When at least one observed store is `unaccounted`, the axis SHALL be a degrading coverage gap that the `SourceCoverageComplete` condition surfaces with an actionable remediation. When no coverage records are observed, the axis SHALL remain `unknown`.

An empty, idle, or fully-drained local outbox SHALL NOT be treated as proof of complete coverage. Only durable coverage evidence SHALL promote the coverage axis off `unknown`; absence of coverage evidence SHALL read as absence, not as completeness.

Run-derived coverage SHALL stay authoritative. When run evidence yields any non-`unknown` coverage axis — `complete`, `partial`, `retryable_gap`, `terminal_gap`, an accepted-coverage label, or a required-but-accepted contradiction — the local coverage diagnostics SHALL NOT override it. The diagnostics SHALL apply only as a fallback when the run path is `unknown`. A failure to read the coverage diagnostics SHALL NOT fabricate a `complete` axis; it SHALL leave the run-derived axis unchanged.

#### Scenario: Drained local collector with full coverage diagnostics is no longer coverage_unknown

- **WHEN** a local-device connection has a trusted, healthy, fully-drained outbox and durable `coverage_diagnostics` records whose stores are all accounted for (collected, inventory-only, excluded, deferred, missing, or unsupported)
- **THEN** the connection projection SHALL report `axes.coverage = "complete"` and a `SourceCoverageComplete` condition with status `true`
- **AND** the coverage condition reason SHALL NOT be `coverage_unknown`

#### Scenario: Local collector with an unaccounted store reports a coverage gap

- **WHEN** a local-device connection's durable `coverage_diagnostics` records include at least one store classified `unaccounted`
- **THEN** the connection projection SHALL report a degrading coverage axis rather than `unknown` or `complete`
- **AND** the `SourceCoverageComplete` condition SHALL have status `false` with an actionable remediation, not a generic unknown

#### Scenario: Drained outbox without coverage diagnostics stays unknown

- **WHEN** a local-device connection has a trusted, healthy, fully-drained outbox but no `coverage_diagnostics` records
- **THEN** the connection projection SHALL leave `axes.coverage = "unknown"` and the `SourceCoverageComplete` condition reason `coverage_unknown`
- **AND** the empty/drained outbox SHALL NOT be projected as `complete`

#### Scenario: Run-derived coverage is not overridden by local coverage diagnostics

- **WHEN** a connection has a terminal spine run whose evidence yields a non-`unknown` coverage axis (for example a terminal known gap) and also has `coverage_diagnostics` records claiming completeness
- **THEN** the connection projection SHALL keep the run-derived coverage axis
- **AND** the local coverage diagnostics SHALL NOT promote the axis to `complete`
