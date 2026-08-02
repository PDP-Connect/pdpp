# Change: Owner-only detail-gap observability

## ADDED Requirements

### Requirement: Owner detail-gap pages are bounded and exact-connection scoped

The reference implementation SHALL expose an owner-bearer
`GET /v1/owner/connections/{connectionId}/diagnostics/detail-gaps` read that
resolves one active connection owned by the token subject and never widens the
read to a connector type or sibling connection.

#### Scenario: The owner reads a bounded page

- **WHEN** an owner bearer requests the route with no `limit`
- **THEN** the reference SHALL use the documented safe default
- **AND** SHALL return at most the hard maximum of rows per page
- **AND** SHALL return deterministic `created_at ASC, gap_id ASC` keyset
  traversal with an opaque `next_cursor` only when another row exists

#### Scenario: The owner reads the next page

- **WHEN** the owner supplies a cursor returned for the same connection
- **THEN** the reference SHALL continue strictly after that cursor boundary
- **AND** SHALL reject malformed or cross-connection cursors as typed 400
  errors

#### Scenario: The projection is diagnostic-only

- **WHEN** a page is returned
- **THEN** each row SHALL include only gap id, stream, record key, status,
  reason, `last_error.class`, attempt/timing fields, modeled lease state and
  expiry, and terminal/policy disposition
- **AND** SHALL omit record payloads, locators, filenames, email/provider
  metadata, grant/run/lease identifiers, tokens, and arbitrary diagnostics

#### Scenario: Non-owner credentials are rejected

- **WHEN** a client or MCP-package bearer, missing bearer, foreign owner, or
  unknown connection requests the page
- **THEN** the owner route SHALL reject the request using the existing owner
  authentication and exact namespace-resolution behavior

### Requirement: The existing detail-gap store is the authority

The SQLite and PostgreSQL implementations SHALL provide the same bounded,
connection-scoped all-status listing semantics without introducing a new store,
materialized view, or provider-specific endpoint.

#### Scenario: Backends agree

- **WHEN** equivalent rows and a cursor boundary are read from SQLite and
  PostgreSQL
- **THEN** both stores SHALL return the same ordered gap ids, statuses, and
  projection inputs
- **AND** the query SHALL remain bounded by `limit + 1`
