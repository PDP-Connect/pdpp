## ADDED Requirements

### Requirement: Sandbox stream list SHALL mount `rs.streams.list`

The website-hosted sandbox SHALL serve `GET /sandbox/v1/streams` by mounting the canonical `rs.streams.list` operation through a sandbox fixture environment profile. It SHALL NOT construct the public stream-list response through an independent website-local AS/RS builder.

#### Scenario: Sandbox stream list route

- **WHEN** `/sandbox/v1/streams` is requested
- **THEN** the route SHALL execute the same `rs.streams.list` operation implementation used by the native reference host
- **AND** sandbox-specific code SHALL be limited to request adaptation, fixture dependency selection, response adaptation, and sandbox demo headers

#### Scenario: Parallel builder removal

- **WHEN** `/sandbox/v1/streams` is migrated to `rs.streams.list`
- **THEN** the website-local public builder that previously constructed the live-shaped stream-list response SHALL be deleted or demoted so it cannot be imported by the public route
- **AND** the migration SHALL include a regression test proving the route still returns a live-shaped list of stream summaries from the sandbox fixture profile
