## ADDED Requirements

### Requirement: First-party polyfill stream coverage SHALL be provenance-honest
The reference implementation SHALL distinguish verified owner-account connector data from seed, fixture, demo, scaffolded, or blocked connector data when using first-party polyfill connectors as evidence of reference behavior.

#### Scenario: A connector has local rows from a fixture path
- **WHEN** local records for a connector were produced by seed or demo data rather than verified owner-account ingestion
- **THEN** the reference SHALL NOT present those rows as owner-account evidence
- **AND** the connector status, documentation, or task tracking SHALL mark the data as untrusted until purged and re-ingested from a verified source

### Requirement: Layer 2 stream additions SHALL be connector-scoped and test-backed
Each Layer 2 stream addition for a first-party polyfill connector SHALL include manifest schema updates, connector extraction logic, and tests or live-smoke evidence appropriate to the data source.

#### Scenario: A new local-file stream is added
- **WHEN** a local-file connector gains a new stream
- **THEN** tests SHALL cover parsing, primary-key stability, incremental behavior, and manifest validation

#### Scenario: A browser-backed stream is added
- **WHEN** a browser-backed connector gains a new stream
- **THEN** the change SHALL record whether verification used real owner interaction, scrubbed fixtures, or synthetic fixtures
