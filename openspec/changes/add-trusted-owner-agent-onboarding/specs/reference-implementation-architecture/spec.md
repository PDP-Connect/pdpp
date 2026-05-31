## ADDED Requirements

### Requirement: Trusted owner-agent metadata SHALL advertise the REST owner-agent profile

When trusted owner-agent onboarding is enabled, the reference Resource Server SHALL advertise a machine-readable advisory block that identifies owner-level REST automation as a separate profile from grant-scoped MCP/client access. The advisory block SHALL be non-normative reference metadata and SHALL NOT present owner-agent onboarding as a PDPP Core requirement.

#### Scenario: Metadata includes owner-agent onboarding
- **WHEN** a caller fetches `GET /` or `GET /.well-known/oauth-protected-resource` from a deployment that supports trusted owner-agent onboarding
- **THEN** the response SHALL include an advisory trusted-owner-agent block with the profile name, AS issuer, RS resource origin, owner approval surface, schema endpoint, stream discovery endpoint, query base, token introspection endpoint, revocation path, and event-subscription discovery link
- **AND** the block SHALL state that `/mcp` is not the owner-agent transport

#### Scenario: Metadata remains safe on unsupported deployments
- **WHEN** owner-agent onboarding is disabled, misconfigured, or not safely available
- **THEN** the reference SHALL omit the trusted-owner-agent advisory block
- **AND** protected-resource metadata SHALL remain valid for ordinary grant-scoped clients

### Requirement: Trusted owner-agent approval SHALL avoid bearer-token paste flows

The reference implementation SHALL provide a browser-mediated owner approval path for trusted owner-agent credentials. The happy path SHALL avoid printing bearer material into chat, terminal transcripts, dashboard status tables, or logs.

#### Scenario: Owner approves a local agent
- **WHEN** a local owner agent initiates or follows the trusted owner-agent onboarding flow
- **THEN** the owner SHALL approve the request through an owner-authenticated browser or dashboard-mediated flow
- **AND** the flow SHALL write or hand off bearer material only through an owner-controlled local credential target
- **AND** user-visible transcripts SHALL print non-secret metadata such as token kind, client id, expiry, and revocation handle rather than the bearer itself

#### Scenario: Owner denies or revokes the local agent
- **WHEN** the owner denies the onboarding request or revokes the issued credential
- **THEN** the agent SHALL receive a non-secret failure or revocation status
- **AND** subsequent owner-agent REST calls with that bearer SHALL fail as revoked or inactive

### Requirement: Owner-agent bearers SHALL remain REST/control-plane credentials

The reference implementation SHALL preserve the route-auth boundary for owner-agent credentials. Owner-agent bearers SHALL authorize only the owner-level REST/control-plane routes that explicitly accept owner bearers, and `/mcp` SHALL reject owner bearers.

#### Scenario: Owner-agent bearer reads owner REST data
- **WHEN** a trusted local owner agent calls an owner-bearer-supported `/v1/**` REST route with a valid owner-agent bearer
- **THEN** the reference SHALL authorize the request according to owner-token semantics
- **AND** the response SHALL expose owner-visible streams, records, schemas, blobs, and metadata subject to the route's existing owner behavior

#### Scenario: Owner-agent bearer calls MCP
- **WHEN** a caller sends a trusted owner-agent bearer to `/mcp`
- **THEN** the reference SHALL reject the request
- **AND** the error SHALL direct ordinary MCP clients toward grant-scoped MCP setup rather than owner-bearer use

### Requirement: Owner-agent read guidance SHALL support current and future data efficiently

The reference implementation SHALL provide a testable owner-agent access pattern that lets a local owner agent maintain an incremental view of current and future owner data without broad repeated scans.

#### Scenario: Owner-agent performs initial sync
- **WHEN** a trusted local owner agent starts with a valid owner-agent bearer
- **THEN** it SHALL discover `/v1/schema` and `/v1/streams` before record reads
- **AND** it SHALL use `connection_id` to attribute and disambiguate records in multi-connection deployments
- **AND** it SHALL store local sync state per stream and connection

#### Scenario: Owner-agent performs incremental sync
- **WHEN** the trusted local owner agent refreshes its local view after initial sync
- **THEN** it SHALL prefer `changes_since`, pagination cursors, declared filters, and schema-advertised capabilities over rescanning all records
- **AND** it SHALL refresh schema and stream metadata periodically so newly visible streams and connections can be discovered
- **AND** it SHALL fetch blobs by reference only when needed

#### Scenario: Owner-agent chooses between callbacks and polling
- **WHEN** the trusted local owner agent has a durable valid-TLS HTTPS callback receiver
- **THEN** it MAY create client event subscriptions for low-latency update notification where the reference advertises support
- **AND** when it lacks such a receiver it SHALL use cursor polling instead of attempting callback delivery to an unreachable local endpoint
