## ADDED Requirements

### Requirement: The reference implementation SHALL expose owner-session-gated `_ref/grant-packages*` endpoints

The reference implementation SHALL mount owner-session-gated routes that
let the operator console list grant packages, fetch one package detail,
and revoke a package. The endpoints SHALL be read-mostly and SHALL NOT
support package creation or membership editing — packages remain a
hosted-MCP authorization-flow artifact.

#### Scenario: Owner lists grant packages

- **WHEN** an owner-authenticated request hits the package list endpoint
- **THEN** the response SHALL be a paginated envelope ordered by
  created-at descending
- **AND** each row SHALL include the package id, subject, client,
  status, member count, created and revoked timestamps.

#### Scenario: Owner fetches a package detail

- **WHEN** an owner-authenticated request hits the package detail
  endpoint for an existing package id
- **THEN** the response SHALL include the package metadata, every
  member child grant with its source and current status, and the bound
  subject and client identifiers
- **AND** the response SHALL NOT include token hashes, refresh secrets,
  or any other secret material.

#### Scenario: Owner fetches a missing package

- **WHEN** an owner-authenticated request hits the package detail
  endpoint with an unknown id
- **THEN** the reference implementation SHALL return a typed `not_found`
  error envelope with HTTP 404.

#### Scenario: Owner revokes an active package

- **WHEN** an owner-authenticated request hits the package revoke
  endpoint for an active package
- **THEN** every active package membership SHALL be revoked
- **AND** the package row SHALL flip to `revoked`
- **AND** the package's MCP refresh-token exchange SHALL be rejected
  on the next attempt.

#### Scenario: Owner revokes an already-revoked package

- **WHEN** an owner-authenticated request hits the package revoke
  endpoint for a package that is not in `active` status
- **THEN** the reference implementation SHALL return a typed
  `already_revoked` error envelope with HTTP 409 and SHALL NOT alter
  child-grant statuses.

#### Scenario: Unauthenticated request hits a package endpoint

- **WHEN** a request without an owner session hits any
  `/_ref/grant-packages*` route
- **THEN** the reference implementation SHALL reject the request with
  the same owner-session-required envelope used by other `/_ref/*`
  routes.

### Requirement: The operator console SHALL mount package list, package detail, and child-grant pivot surfaces

The operator console SHALL surface grant packages as routable pages
under the existing `/dashboard/grants/*` subtree, mirroring the
`ListWithPeekView` shape used by `/dashboard/grants` so the operator
does not have to learn a new layout.

#### Scenario: Operator opens the package list page

- **WHEN** the operator opens `/dashboard/grants/packages`
- **THEN** the page SHALL render the list returned by the package list
  endpoint
- **AND** every row SHALL link to the package detail route.

#### Scenario: Operator opens a package detail page

- **WHEN** the operator opens `/dashboard/grants/packages/<id>`
- **THEN** the page SHALL render the detail returned by the package
  detail endpoint
- **AND** the page SHALL render a server-rendered revoke form that
  requires an explicit `confirm_revoke=yes` field and the existing
  owner session.

#### Scenario: Operator opens a child grant page

- **WHEN** the operator opens `/dashboard/grants/<grantId>` for a
  grant whose grant id is present in `grant_package_members`
- **THEN** the page SHALL render a pivot link to the package detail
  page.

### Requirement: The `_ref/grants` spine envelope SHALL carry `grant_package_id`

The `executeRefSpineCorrelationsList` operation (kind=`grant`) SHALL
include `grant_package_id` on every row whose grant id is a member of a
grant package. The field SHALL be omitted otherwise. Existing consumers
SHALL continue to function because they ignore unknown fields by
contract.

#### Scenario: Owner lists grants and one row is package-bound

- **WHEN** the spine correlations list operation runs for grants
- **AND** at least one returned grant id is present in
  `grant_package_members`
- **THEN** the envelope SHALL surface `grant_package_id` for that row
- **AND** the envelope SHALL omit `grant_package_id` for rows whose
  grant id is not a package member.
