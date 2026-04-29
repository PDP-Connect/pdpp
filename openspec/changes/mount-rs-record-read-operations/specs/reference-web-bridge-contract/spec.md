## ADDED Requirements

### Requirement: Sandbox record list SHALL mount `rs.records.list`

The website-hosted sandbox SHALL serve `GET /sandbox/v1/streams/:stream/records` by mounting the canonical `rs.records.list` operation through a sandbox fixture environment profile. It SHALL NOT construct the public record-list response through an independent website-local AS/RS builder.

#### Scenario: Sandbox record list route

- **WHEN** `/sandbox/v1/streams/:stream/records` is requested
- **THEN** the route SHALL execute the same `rs.records.list` operation implementation used by the native reference host
- **AND** sandbox-specific code SHALL be limited to request adaptation, fixture dependency selection, response adaptation, and sandbox demo headers

#### Scenario: Parallel records-list builder removal

- **WHEN** `/sandbox/v1/streams/:stream/records` is migrated to `rs.records.list`
- **THEN** the website-local public builder that previously constructed the live-shaped record-list response SHALL be deleted so it cannot be imported by the public route
- **AND** the migration SHALL include a regression test proving the route still returns a live-shaped list of record envelopes from the sandbox fixture profile

### Requirement: Sandbox record detail SHALL mount `rs.records.get`

The website-hosted sandbox SHALL serve `GET /sandbox/v1/streams/:stream/records/:recordId` by mounting the canonical `rs.records.get` operation through a sandbox fixture environment profile. It SHALL NOT construct the public record-detail response through an independent website-local AS/RS builder.

#### Scenario: Sandbox record detail route

- **WHEN** `/sandbox/v1/streams/:stream/records/:recordId` is requested
- **THEN** the route SHALL execute the same `rs.records.get` operation implementation used by the native reference host
- **AND** sandbox-specific code SHALL be limited to request adaptation, fixture dependency selection, response adaptation, and sandbox demo headers

#### Scenario: Parallel record-detail builder removal

- **WHEN** `/sandbox/v1/streams/:stream/records/:recordId` is migrated to `rs.records.get`
- **THEN** the website-local public builder that previously constructed the live-shaped record-detail response SHALL be deleted so it cannot be imported by the public route
- **AND** the migration SHALL include a regression test proving the route still returns a live-shaped record envelope from the sandbox fixture profile
