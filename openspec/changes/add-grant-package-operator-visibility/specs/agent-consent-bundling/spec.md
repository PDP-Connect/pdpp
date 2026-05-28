## ADDED Requirements

### Requirement: Grant packages SHALL be visible to the operator

The reference implementation SHALL expose grant packages to the operator
console as a first-class artifact that the operator can list, inspect,
and revoke without per-child manual revocation.

#### Scenario: Operator opens the package list

- **WHEN** the operator visits the package list surface on the operator
  console
- **THEN** the surface SHALL render every grant package issued on the
  deployment, ordered by created-at descending
- **AND** each row SHALL surface the package id, the bound subject and
  client, the active status, the count of member child grants, and the
  created and revoked timestamps.

#### Scenario: Operator opens a package detail

- **WHEN** the operator opens a single package on the operator console
- **THEN** the detail surface SHALL render the package status, the
  bound subject and client, the created and revoked timestamps, and
  every member child grant with its source and current status
- **AND** the detail surface SHALL link to each member child grant's
  standalone detail surface and to the filtered event-subscription list
  for the package's children.

#### Scenario: Operator revokes a package

- **WHEN** the operator submits the revoke affordance on a package
  detail surface
- **THEN** the reference implementation SHALL revoke every active
  package membership
- **AND** SHALL flip the package row to `revoked`
- **AND** SHALL invalidate the package-bound MCP refresh token on the
  next exchange.

#### Scenario: Operator tries to revoke an already-revoked package

- **WHEN** the operator submits the revoke affordance on a package
  whose status is already `revoked`
- **THEN** the reference implementation SHALL return a typed
  `already_revoked` error envelope and SHALL NOT alter the existing
  child-grant statuses.

### Requirement: Child grants SHALL carry their package linkage on operator surfaces

The reference implementation SHALL surface a child grant's parent
package id on the operator console grant list and grant detail
surfaces whenever the grant is a member of a package.

#### Scenario: Operator views the grants list

- **WHEN** the operator opens the grants list on the operator console
- **THEN** every grant row whose grant id is present in
  `grant_package_members`
  SHALL carry the parent `grant_package_id`
- **AND** the row SHALL render a pivot affordance to the package
  detail surface.

#### Scenario: Operator views a child grant standalone

- **WHEN** the operator opens a child grant on the operator console
- **AND** the grant is bound to a package
- **THEN** the detail surface SHALL render a pivot affordance to the
  package detail surface.

### Requirement: Grant package visibility surfaces SHALL NOT leak secret material

The reference implementation SHALL NOT include grant-package secret
material (refresh-token hashes, opaque package secrets, raw bearer
strings) on any operator-visible package list, detail, or event-log
surface.

#### Scenario: Operator inspects a package

- **WHEN** the operator inspects a package detail
- **THEN** the rendered payload SHALL NOT contain any refresh-token
  hash, access-token string, or raw package secret
- **AND** the rendered payload SHALL only surface non-secret
  identifiers, statuses, and timestamps already exposed elsewhere in
  the operator console.
