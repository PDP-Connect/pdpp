## ADDED Requirements

### Requirement: Browser detail hydration SHALL be bounded and recoverable

First-party browser-backed connectors that perform optional per-record detail hydration SHALL bound that detail lane independently from the controller watchdog. When detail hydration is skipped, deferred, or fails after the connector-local budget, the connector SHALL emit durable retryable `DETAIL_GAP` records for the affected detail stream and SHALL preserve any list-derived records it can emit safely.

#### Scenario: Detail budget defers enrichment

- **WHEN** a browser-backed connector has enumerated a list item whose detail enrichment is owed
- **AND** the connector-local detail budget has been reached
- **THEN** the connector SHALL emit any safe list-derived records for that item
- **AND** it SHALL emit a retryable reference-only `DETAIL_GAP` for the detail-enriched stream
- **AND** it SHALL NOT rely on the controller watchdog to terminate the run.

#### Scenario: Recovery-only detail run

- **WHEN** the runtime starts a connector with `recovery_only: true` and pending detail gaps
- **THEN** the connector SHALL restrict work to retrying the provided detail locators
- **AND** it SHALL NOT re-walk the forward list boundary for ordinary collection.

#### Scenario: Attempted detail failure diagnostics are bounded

- **WHEN** fixture capture is enabled and attempted detail hydration fails
- **THEN** the connector SHALL capture at most a bounded diagnostic detail checkpoint for that failure class
- **AND** the emitted `DETAIL_GAP` SHALL remain redacted and reference-only.

#### Scenario: Source-pressure cooldown is not armed for local detail budget

- **WHEN** detail hydration is deferred because the connector-local detail budget was reached
- **THEN** the connector SHALL use a non-source-pressure retryable gap classification
- **AND** it SHALL include redacted structured gap evidence for the local budget class
- **AND** the scheduler SHALL be able to run work-conserving recovery without treating the source as rate-limited.
