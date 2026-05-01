## ADDED Requirements

### Requirement: Reference freshness SHALL be derived from run evidence when available

Reference RS and `_ref` surfaces that emit `freshness` SHALL derive the field from connector run evidence and connector refresh policy when those inputs are available. The reference SHALL NOT report a fabricated `last_attempted_at` from record timestamps.

#### Scenario: Recent successful run is current

- **WHEN** a connector has a latest successful run with `finished_at` inside `capabilities.refresh_policy.maximum_staleness_seconds`
- **THEN** RS and `_ref` freshness for that connector's streams SHALL include `captured_at` equal to the latest successful run time
- **AND** `status` SHALL be `current`.

#### Scenario: Latest failed attempt marks data stale

- **WHEN** a connector has a latest failed or cancelled run attempt after the latest successful run
- **THEN** freshness SHALL include `last_attempted_at` equal to the failed or cancelled attempt time
- **AND** `status` SHALL be `stale`.

#### Scenario: Record timestamp fallback remains unknown without policy

- **WHEN** the reference has record `last_updated` evidence but no connector run evidence or maximum staleness policy
- **THEN** freshness MAY include `captured_at` from the record timestamp
- **AND** it SHALL keep `status` equal to `unknown`
- **AND** it SHALL NOT emit `last_attempted_at`.

#### Scenario: Missing maximum staleness does not invent freshness guarantees

- **WHEN** a connector has a successful run but no `maximum_staleness_seconds` declaration
- **THEN** freshness SHALL NOT report `current` solely because a run exists
- **AND** it SHALL keep `status` equal to `unknown` unless the latest attempt failed after the latest success.
