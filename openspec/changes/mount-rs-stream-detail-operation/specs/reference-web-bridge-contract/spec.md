## ADDED Requirements

### Requirement: Sandbox stream detail SHALL mount `rs.streams.detail`

The website-hosted sandbox SHALL serve `GET /sandbox/v1/streams/:stream` by mounting the canonical `rs.streams.detail` operation through a sandbox fixture environment profile. It SHALL NOT construct the public stream-metadata response through an independent website-local AS/RS builder.

#### Scenario: Sandbox stream detail route

- **WHEN** `/sandbox/v1/streams/:stream` is requested
- **THEN** the route SHALL execute the same `rs.streams.detail` operation implementation used by the native reference host
- **AND** sandbox-specific code SHALL be limited to path adaptation, fixture dependency selection, response adaptation, and sandbox demo headers

#### Scenario: Parallel builder removal

- **WHEN** `/sandbox/v1/streams/:stream` is migrated to `rs.streams.detail`
- **THEN** the website-local public builder that previously constructed the live-shaped stream-metadata response SHALL be deleted or demoted so it cannot be imported by the public route
- **AND** the migration SHALL include a regression test proving the route still returns a live-shaped `stream_metadata` envelope from the sandbox fixture profile
