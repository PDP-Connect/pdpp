## ADDED Requirements

### Requirement: Sandbox lexical search SHALL mount `rs.search.lexical`

The website-hosted sandbox SHALL serve `GET /sandbox/v1/search` by mounting the canonical `rs.search.lexical` operation through a sandbox fixture environment profile. It SHALL NOT construct the public lexical-search response through an independent website-local AS/RS builder.

#### Scenario: Sandbox lexical search route

- **WHEN** `/sandbox/v1/search` is requested with a valid query
- **THEN** the route SHALL execute the same `rs.search.lexical` operation implementation used by the native reference host
- **AND** sandbox-specific code SHALL be limited to request adaptation, fixture dependency selection, response adaptation, error mapping, and sandbox demo headers

#### Scenario: Parallel lexical-search builder removal

- **WHEN** `/sandbox/v1/search` is migrated to `rs.search.lexical`
- **THEN** the public sandbox route SHALL NOT statically import the previous website-local public builder that constructed the live-shaped lexical-search response
- **AND** the migration SHALL include a regression test proving the route still returns the canonical lexical-search list envelope from the sandbox fixture profile

#### Scenario: Sandbox API obeys the canonical request contract

- **WHEN** `/sandbox/v1/search` is requested with empty or missing `q`
- **THEN** the route SHALL return the canonical `invalid_request` error envelope produced by the operation
- **AND** the route SHALL NOT short-circuit to an empty list envelope as a host-level demo policy

#### Scenario: Sandbox API rejects unsupported query parameters

- **WHEN** `/sandbox/v1/search` is requested with a query parameter outside the v1 allowlist (`q`, `limit`, `cursor`, `streams`, `streams[]`, `filter`)
- **THEN** the route SHALL return the canonical `invalid_request` error envelope produced by the operation, identifying the rejected parameter

#### Scenario: Sandbox fixture evaluates supported filters and rejects unsupported filters

- **WHEN** `/sandbox/v1/search` is requested with `filter[field]=value` for a top-level scalar field declared in the demo stream's manifest
- **THEN** the route SHALL evaluate the filter against record data and return only matching records (or an empty list when no record matches)
- **WHEN** `/sandbox/v1/search` is requested with `filter[field][op]=value` (a range filter) on any demo field
- **THEN** the route SHALL return the canonical `invalid_request` error envelope because the sandbox manifest advertises no `query.range_filters` for any stream
- **WHEN** `/sandbox/v1/search` is requested with `filter[unknown_field]=value`
- **THEN** the route SHALL return the canonical `invalid_request` error envelope identifying the rejected filter
- **AND** the sandbox SHALL NOT silently accept filter shapes that are not evaluated
