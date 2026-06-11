## ADDED Requirements

### Requirement: Google Maps Data Portability connector SHALL collect only documented API-backed Maps resources

The first-party Google Maps Data Portability connector SHALL use Google's Data Portability API for Maps resource groups documented by Google, SHALL NOT scrape Google Maps browser or mobile UI, and SHALL NOT emit Google Maps Timeline point/segment streams unless Google documents equivalent Data Portability resources.

#### Scenario: Owner authorizes API-backed Maps resources

- **WHEN** the owner authorizes the Google Maps Data Portability connector through provider authorization
- **THEN** the connector SHALL collect only resource groups covered by the authorized Data Portability scopes
- **AND** each emitted stream SHALL correspond to a documented Google Data Portability Maps resource group or My Activity Maps resource group.

#### Scenario: Owner expects Timeline location history

- **WHEN** the owner asks for Google Maps Timeline points or segments
- **THEN** the connector SHALL NOT claim those records are available through Data Portability unless Google documents matching resources
- **AND** the reference SHALL direct the owner to the separate Google Maps Timeline Import source for owner-provided Timeline exports.

#### Scenario: Archive lifecycle runs

- **WHEN** a run starts for the Google Maps Data Portability connector
- **THEN** the runtime SHALL initiate or resume a Data Portability archive/export lifecycle
- **AND** it SHALL poll, download, parse, and checkpoint archive state without launching a browser.

#### Scenario: Archive contains multiple resource files

- **WHEN** a downloaded archive contains multiple Maps resource files
- **THEN** emitted records SHALL preserve resource-group and source-file provenance
- **AND** stream coverage SHALL distinguish authorized, denied, unavailable, empty, skipped, and failed resource groups.

#### Scenario: Time-based export is scheduled

- **WHEN** the connector uses time-based Data Portability export
- **THEN** its refresh policy SHALL respect Google's documented cadence, expiry, and refresh-token constraints
- **AND** the scheduler SHALL NOT request background exports more frequently than the provider allows.
