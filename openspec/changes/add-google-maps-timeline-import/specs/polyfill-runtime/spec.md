## ADDED Requirements

### Requirement: Google Maps Timeline import SHALL be file-based and provenance-preserving

The first-party Google Maps Timeline import connector SHALL collect from owner-provided export files rather than scraping Google Maps or using a Google account credential, SHALL require filesystem access and no network or browser binding, SHALL emit validated normalized Timeline records, and SHALL preserve source-format provenance on each emitted record. It SHALL NOT be advertised as an API-backed Google Maps connection.

#### Scenario: Owner imports a Google Maps Timeline export

- **WHEN** the owner provides a supported Google Maps Timeline export file and requests Google Maps streams
- **THEN** the connector SHALL parse the file without authenticating to Google or launching a browser
- **AND** emitted records SHALL be validated before they are written to the runtime protocol
- **AND** emitted records SHALL identify their source format.

#### Scenario: Export contains raw location points

- **WHEN** the export contains timestamped latitude/longitude observations
- **THEN** the connector SHALL emit them to `timeline_points`
- **AND** `timeline_points` SHALL have a stable primary key and a timestamp cursor.

#### Scenario: Export contains semantic visits or activities

- **WHEN** the export contains visit, activity, or movement segment entries
- **THEN** the connector SHALL emit normalized segment records to `timeline_segments`
- **AND** any point path contained by those segments SHALL be emitted to `timeline_points` with a segment reference.

#### Scenario: Export file is absent

- **WHEN** the configured import directory does not contain a supported Timeline file
- **THEN** the connector SHALL emit a skip result for the requested stream
- **AND** the skip result and progress messages SHALL NOT expose absolute local paths.

#### Scenario: Import progresses through a large export

- **WHEN** the connector parses and emits a large Timeline export
- **THEN** it SHALL emit bounded progress messages with connector phase, stream, and item counts
- **AND** progress messages SHALL NOT include raw place names, addresses, or absolute local file paths.
