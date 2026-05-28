## ADDED Requirements

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
