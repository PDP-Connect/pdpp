# agent-consent-bundling Specification

## Purpose
Define reference-implementation semantics for agent consent ceremonies that bundle owner approval across multiple configured data connections without turning that bundle into a cross-source PDPP grant.
## Requirements
### Requirement: Hosted MCP broad approval SHALL issue source-bounded child grants

When the reference hosted MCP flow lets an owner approve multiple sources in one ceremony, the authorization server SHALL issue one independent source-bounded PDPP grant per approved source and SHALL NOT issue a single cross-source PDPP grant.

#### Scenario: Owner approves multiple sources

- **WHEN** an owner approves Gmail and Slack in one hosted MCP authorization ceremony
- **THEN** the authorization server SHALL create one Gmail-scoped grant and one Slack-scoped grant
- **AND** each grant SHALL remain independently auditable and revocable.

#### Scenario: Owner denies one source

- **WHEN** an owner selects Gmail but not Slack in a hosted MCP authorization ceremony
- **THEN** the authorization server SHALL issue no Slack child grant
- **AND** the MCP client SHALL NOT receive access to Slack records through the package.

### Requirement: Grant packages SHALL NOT be PDPP grants

A grant package SHALL be an authorization-server/reference grouping object for client token routing and audit, not a PDPP grant object carrying source or stream authority.

#### Scenario: Package token is introspected

- **WHEN** a package-bound hosted MCP token is introspected by the reference resource server
- **THEN** the token SHALL identify its grant package
- **AND** record access SHALL still be authorized only by active child grants.

### Requirement: Broad hosted MCP consent SHALL make cumulative risk legible

The hosted MCP consent ceremony for multiple sources SHALL show the owner cumulative breadth before approval.

#### Scenario: Multiple selected sources include maximal access

- **WHEN** the hosted MCP ceremony asks for all streams with continuous access across more than one source
- **THEN** the consent page SHALL show that the approval creates multiple source grants
- **AND** it SHALL show enough source/stream summary for the owner to understand the cumulative scope.

### Requirement: Hosted MCP consent SHALL distinguish configured connections

When a connector has more than one configured owner connection, the hosted MCP consent ceremony SHALL present the configured connection as the owner-facing selectable unit and SHALL preserve the selected connection binding on the issued child grant.

#### Scenario: Multiple Codex connections exist

- **WHEN** an owner has more than one active Codex connection
- **THEN** the hosted MCP consent page SHALL show owner-facing connection names and stable connection identifiers
- **AND** approving one Codex connection SHALL bind the child grant to that connection instance rather than an arbitrary Codex default.

#### Scenario: A package selector is ambiguous

- **WHEN** a package contains more than one child grant for the same connector type
- **THEN** connector-type selectors SHALL NOT silently choose one child grant
- **AND** the MCP read path SHALL require a source key, source token, or connection identifier that resolves to exactly one child grant.

### Requirement: Package revocation SHALL preserve child-grant control

The reference implementation SHALL support disabling a hosted MCP grant package without removing the ability to audit and revoke child grants individually.

#### Scenario: One child grant is revoked

- **WHEN** the owner revokes one child grant in a package
- **THEN** package reads for that source SHALL stop
- **AND** package reads for still-active child grants MAY continue.

#### Scenario: Package is revoked

- **WHEN** the owner revokes the package
- **THEN** package-bound access and refresh tokens SHALL stop working
- **AND** the implementation MAY offer a convenience action to revoke every still-active child grant.

### Requirement: Hosted MCP reads SHALL preserve REST read semantics

The hosted MCP adapter SHALL route read tools through the same scoped-token REST resource-server semantics rather than defining independent MCP-only query behavior.

#### Scenario: MCP search selects a REST search mode

- **WHEN** an MCP client calls `search` with `mode=hybrid`
- **THEN** the adapter SHALL route through the REST hybrid search endpoint
- **AND** it SHALL forward supported structured query parameters using the same nested REST query shape.

#### Scenario: A package token searches across children

- **WHEN** a package-bound MCP token searches across multiple child grants
- **THEN** each child read SHALL use the same REST endpoint selected by the MCP adapter
- **AND** each result SHALL remain source-qualified.

### Requirement: Hosted MCP connection presentation SHALL use shared connector identity

The hosted MCP consent picker SHALL use the reference implementation's shared connector identity equivalence helper when suppressing stale legacy local collector aliases or grouping equivalent connector ids.

#### Scenario: Legacy local collector alias has a canonical dataful connection

- **WHEN** both a legacy local collector connector id and its canonical connector id are registered
- **AND** the canonical connector has a dataful configured connection
- **THEN** the hosted MCP picker SHALL NOT show a stale zero-record legacy duplicate as a separate owner-facing source.

### Requirement: Grant packages SHALL be visible to the operator

The reference implementation SHALL expose grant packages to the operator console as a first-class artifact that the operator can list, inspect, and revoke without per-child manual revocation.

#### Scenario: Operator opens the package list

- **WHEN** the operator visits the package list surface on the operator console
- **THEN** the surface SHALL render every grant package issued on the deployment, ordered by created-at descending
- **AND** each row SHALL surface the package id, the bound subject and client, the active status, the count of member child grants, and the created and revoked timestamps.

#### Scenario: Operator opens a package detail

- **WHEN** the operator opens a single package on the operator console
- **THEN** the detail surface SHALL render the package status, the bound subject and client, the created and revoked timestamps, and every member child grant with its source and current status
- **AND** the detail surface SHALL link to each member child grant's standalone detail surface and to the filtered event-subscription list for the package's children.

#### Scenario: Operator revokes a package

- **WHEN** the operator submits the revoke affordance on a package detail surface
- **THEN** the reference implementation SHALL revoke every active package membership
- **AND** SHALL flip the package row to `revoked`
- **AND** SHALL invalidate the package-bound MCP refresh token on the next exchange.

#### Scenario: Operator tries to revoke an already-revoked package

- **WHEN** the operator submits the revoke affordance on a package whose status is already `revoked`
- **THEN** the reference implementation SHALL return a typed `already_revoked` error envelope and SHALL NOT alter the existing child-grant statuses.

### Requirement: Child grants SHALL carry their package linkage on operator surfaces

The reference implementation SHALL surface a child grant's parent package id on the operator console grant list and grant detail surfaces whenever the grant is a member of a package.

#### Scenario: Operator views the grants list

- **WHEN** the operator opens the grants list on the operator console
- **THEN** every grant row whose grant id is present in `grant_package_members` SHALL carry the parent `grant_package_id`
- **AND** the row SHALL render a pivot affordance to the package detail surface.

#### Scenario: Operator views a child grant standalone

- **WHEN** the operator opens a child grant on the operator console
- **AND** the grant is bound to a package
- **THEN** the detail surface SHALL render a pivot affordance to the package detail surface.

### Requirement: Grant package visibility surfaces SHALL NOT leak secret material

The reference implementation SHALL NOT include grant-package secret material (refresh-token hashes, opaque package secrets, raw bearer strings) on any operator-visible package list, detail, or event-log surface.

#### Scenario: Operator inspects a package

- **WHEN** the operator inspects a package detail
- **THEN** the rendered payload SHALL NOT contain any refresh-token hash, access-token string, or raw package secret
- **AND** the rendered payload SHALL only surface non-secret identifiers, statuses, and timestamps already exposed elsewhere in the operator console.

### Requirement: Hosted MCP adapter SHALL forward self-calls to a configured internal resource-server base

The hosted MCP adapter SHALL forward its grant-scoped self-calls to a configured internal resource-server base URL when one is present, and SHALL fall back to the advertised public resource when no internal base is configured. This applies to BOTH hosted MCP token paths: the **package** path (the per-member child `RsClient` fan-out for an `mcp_package` token) and the **standalone** path (the single-bearer `RsClient` for a `client` token). The advertised `resource`, the protected-resource discovery metadata, and the MCP server's advertised `providerUrl` SHALL continue to resolve to the public origin; the internal base SHALL be used only as the adapter's server-internal fetch base and SHALL NOT be advertised, written into issued-token audience/resource, or returned in discovery responses. The internal base SHALL be operator-configured to a trusted loopback or internal cluster/service-DNS address and SHALL NOT be derived from request headers. Each self-call SHALL still be authorized only by its active grant bearer (the child grant's bearer for a package token; the single grant's bearer for a `client` token) and SHALL remain subject to per-grant resource-server enforcement.

#### Scenario: Package-token update recovers from a public-edge method block

- **WHEN** a hosted MCP package token calls `update_event_subscription` (a `PATCH /v1/event-subscriptions/:id` self-call)
- **AND** the public edge fronting the advertised resource rejects the PATCH method with HTTP 405 while the configured internal resource-server base method-routes PATCH
- **THEN** the adapter SHALL forward the self-call to the internal base and the update SHALL succeed
- **AND** the call SHALL NOT return an `rs_error` with code `http_405`.

#### Scenario: Standalone client-token update also recovers from a public-edge method block

- **WHEN** a standalone hosted MCP `client` token (not a package token) calls `update_event_subscription` (a `PATCH /v1/event-subscriptions/:id` self-call)
- **AND** the public edge rejects PATCH with HTTP 405 while the configured internal base method-routes PATCH
- **THEN** the adapter SHALL build the single-bearer `RsClient` against the internal base and the update SHALL succeed
- **AND** the call SHALL NOT return an `rs_error` with code `http_405`
- **AND** the advertised `providerUrl` SHALL remain the public origin.

#### Scenario: Advertised metadata stays public

- **WHEN** a client discovers the hosted MCP resource and the adapter forwards a child self-call to the internal base
- **THEN** the advertised `resource`, the protected-resource discovery metadata, and the advertised `providerUrl` SHALL resolve to the public origin
- **AND** the internal resource-server base SHALL NOT appear in any advertised metadata, discovery response, or issued-token audience.

#### Scenario: No internal base configured falls back to the public resource

- **WHEN** no internal resource-server base is configured for the deployment
- **THEN** the adapter SHALL forward child self-calls to the advertised public resource
- **AND** the package adapter's child-locate, source-selection, ambiguity, fan-out, and per-child enforcement behavior SHALL be unchanged.

#### Scenario: Internal base does not widen authority

- **WHEN** the adapter forwards a child self-call to the configured internal resource-server base
- **THEN** the self-call SHALL carry the owning child grant's bearer
- **AND** record access SHALL still be authorized only by that active child grant under the resource server's per-grant enforcement.
