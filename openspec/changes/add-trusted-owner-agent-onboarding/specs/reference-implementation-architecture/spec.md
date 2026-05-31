## MODIFIED Requirements

### Requirement: Client event subscriptions are a discoverable RI extension with explicit authority scoping

The reference implementation SHALL expose outbound event subscriptions at the canonical resource-server path `/v1/event-subscriptions`. It SHALL advertise the surface in the resource server's protected-resource metadata document under `capabilities.client_event_subscriptions`, with `supported: true`, `stability: "reference_extension"`, `scope: "reference_implementation"`, and `authority_kinds_supported` containing `client_grant` and `trusted_owner_agent`. The advertisement SHALL document the endpoint, supported event types, the signing profile and header names, delivery semantics (at-least-once, after-commit, retry schedule, max attempts), verification handshake, hint cursor field, callback-URL HTTPS requirement, and client-visible byte limits.

Ordinary client subscription create, read, list, update, delete, and test-event operations SHALL require a client bearer whose grant is currently active. The persisted subscription SHALL record authority kind `client_grant`, the bearer's `(grant_id, client_id, subject_id)`, and SHALL refuse any subsequent operation by a bearer whose `(client_id, grant_id)` does not match.

Trusted owner-agent subscription create, read, list, update, delete, and test-event operations SHALL require an owner bearer issued to a registered client. The persisted subscription SHALL record authority kind `trusted_owner_agent`, the bearer's `(client_id, subject_id)`, and SHALL refuse any subsequent operation by a bearer whose `(client_id, subject_id)` does not match. Owner-agent subscriptions SHALL be owner-visible current/future data subscriptions; they SHALL NOT expose record bodies in pushed events; record-change events SHALL carry enough source identity (`connector_id`, stream, `connection_id` where known, and `changes_since`) for the owner agent to pull changed records through the owner REST read path; and they SHALL be disabled when the registered client is deleted.

#### Scenario: A client creates a subscription with a valid bearer
- **WHEN** an authorized client posts a subscription create request to `POST /v1/event-subscriptions` with a client bearer token whose grant is active
- **THEN** the reference SHALL persist the subscription with authority kind `client_grant` and the bearer's `(grant_id, client_id, subject_id)` snapshotted
- **AND** the response SHALL include the freshly generated delivery secret exactly once
- **AND** the secret SHALL carry the Standard Webhooks `whsec_` prefix

#### Scenario: A trusted owner agent creates a subscription with a registered owner bearer
- **WHEN** a trusted owner agent posts a subscription create request to `POST /v1/event-subscriptions` with an owner bearer issued to a registered client
- **THEN** the reference SHALL persist the subscription with authority kind `trusted_owner_agent`
- **AND** the subscription SHALL be scoped to the bearer's `(client_id, subject_id)` rather than to a grant id
- **AND** the response SHALL include the freshly generated delivery secret exactly once

#### Scenario: A different authority attempts to read a subscription
- **WHEN** a bearer requests `GET /v1/event-subscriptions/:id` for a subscription whose stored authority does not match the bearer's authority
- **THEN** the reference SHALL return a not-found response without disclosing the subscription's existence

#### Scenario: An unregistered owner bearer attempts to use subscriptions
- **WHEN** an owner bearer token with no registered `client_id` is presented to any `/v1/event-subscriptions[...]` endpoint
- **THEN** the reference SHALL reject the request with HTTP 403

#### Scenario: A registered owner-agent client is deleted
- **WHEN** the owner deletes the registered client that issued an owner-agent subscription's bearer
- **THEN** the reference SHALL revoke the owner-agent token
- **AND** it SHALL disable that client's pending or active event subscriptions and drop pending queue rows

#### Scenario: A client reads the protected-resource metadata
- **WHEN** a client or owner agent reads `/.well-known/oauth-protected-resource` on the resource server
- **THEN** the response SHALL include `capabilities.client_event_subscriptions` with `supported: true`, `stability: "reference_extension"`, an `endpoint` of `/v1/event-subscriptions`, and `authority_kinds_supported` containing `client_grant` and `trusted_owner_agent`
- **AND** the advertisement SHALL declare the envelope as `format: "cloudevents+json"`, `specversion: "1.0"`, `pdppversion: "1"`, `content_type: "application/cloudevents+json; charset=utf-8"`, and `subscription_id_location: "data.subscription_id"`
- **AND** the advertisement SHALL declare the signing profile as `standard-webhooks` with `algorithm: "HMAC-SHA256"`, `id_header: "webhook-id"`, `timestamp_header: "webhook-timestamp"`, `signature_header: "webhook-signature"`, `signed_payload: "{webhook-id}.{webhook-timestamp}.{body}"`, `signature_encoding: "v1,<base64>"`, and `secret_prefix: "whsec_"`
- **AND** the advertisement SHALL include the set of supported event types (`pdpp.subscription.verify`, `pdpp.subscription.test`, `pdpp.records.changed`, `pdpp.grant.revoked`), the delivery semantics (at-least-once, after-commit, max-attempts), the verification handshake shape, and the hint cursor location

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
- **THEN** it MAY create event subscriptions for low-latency update notification where the reference advertises trusted owner-agent support
- **AND** when it lacks such a receiver it SHALL use cursor polling instead of attempting callback delivery to an unreachable local endpoint
