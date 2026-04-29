## ADDED Requirements

### Requirement: Sandbox schema SHALL mount `rs.schema.get`

The website-hosted sandbox SHALL serve `GET /sandbox/v1/schema` by mounting the canonical `rs.schema.get` operation through a sandbox fixture environment profile. It SHALL NOT construct the public schema-discovery response through an independent website-local AS/RS builder.

#### Scenario: Sandbox schema route

- **WHEN** `/sandbox/v1/schema` is requested
- **THEN** the route SHALL execute the same `rs.schema.get` operation implementation used by the native reference host
- **AND** sandbox-specific code SHALL be limited to request adaptation, fixture dependency selection, response adaptation, and sandbox demo headers

#### Scenario: Parallel builder removal

- **WHEN** `/sandbox/v1/schema` is migrated to `rs.schema.get`
- **THEN** the website-local public builder that previously constructed the live-shaped schema response SHALL be deleted or demoted so it cannot be imported by the public route
- **AND** the migration SHALL include a regression test proving the route still returns a live-shaped schema graph from the sandbox fixture profile
