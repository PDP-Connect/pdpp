## ADDED Requirements

### Requirement: Deployment diagnostics SHALL surface lexical backfill progress
The reference deployment diagnostics surface SHALL report active lexical index
backfill progress when the reference server is rebuilding lexical search
indexes.

#### Scenario: Lexical backfill is active
- **WHEN** a lexical index backfill is actively scanning or rebuilding records
- **THEN** `/_ref/deployment` SHALL include the current lexical backfill job
- **AND** the report SHALL include enough progress data for the dashboard to
  show the connector, stream, phase, scanned records, total records when known,
  written index rows, and updated timestamp
- **AND** the report SHALL include a warning that lexical search results may be
  partial while the rebuild is active

#### Scenario: Lexical backfill is inactive
- **WHEN** no lexical index backfill is active
- **THEN** `/_ref/deployment` SHALL report no active lexical backfill progress
- **AND** it SHALL NOT emit a lexical rebuilding warning

#### Scenario: Dashboard renders lexical progress
- **WHEN** `/dashboard/deployment` receives lexical backfill progress
- **THEN** it SHALL render browser-visible progress without requiring operators
  to inspect container logs
