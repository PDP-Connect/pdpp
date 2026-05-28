## ADDED Requirements

### Requirement: Hosted MCP package tokens SHALL enforce through child grants

The reference resource server SHALL resolve hosted MCP package tokens to active child grants and SHALL enforce each read through the selected child grant before returning records, blobs, stream metadata, schema, or search results.

#### Scenario: Package search fans out

- **WHEN** a hosted MCP package token searches across approved sources
- **THEN** the resource server SHALL execute source-local searches under each active child grant
- **AND** returned results SHALL include source identity.

#### Scenario: Package record query names a source

- **WHEN** a hosted MCP package token queries records for a source and stream
- **THEN** the resource server SHALL route the read to the child grant for that source
- **AND** the existing stream, field, time-range, resource, and manifest checks SHALL apply.

#### Scenario: Package record query omits source

- **WHEN** a hosted MCP package token has more than one active child grant and the client calls a source-specific read without a source selector
- **THEN** the resource server SHALL reject the request with an explicit source-disambiguation error.

### Requirement: Hosted MCP package tokens SHALL remain read-only client tokens

Hosted MCP package tokens SHALL be client tokens accepted only by grant-scoped read surfaces and SHALL NOT be treated as owner/admin tokens.

#### Scenario: Package token calls owner route

- **WHEN** a hosted MCP package token calls an owner-only reference route
- **THEN** the server SHALL reject the request as lacking owner authority.

### Requirement: Hosted MCP package adapter SHALL route every read under exactly one child grant

The hosted MCP `/mcp` handler SHALL substitute a package-aware adapter (`PackageRsClient`) for the default single-bearer RS client whenever the inbound token is `pdpp_token_kind=mcp_package`. The adapter SHALL NOT forward a "first active member" token, SHALL NOT widen a single child grant's authority to cover other approved sources, and SHALL run every record/blob/event-subscription read under exactly one child grant's scoped client bearer.

#### Scenario: Schema and list_streams fan out per source

- **WHEN** a package token calls `schema` or `list_streams`
- **THEN** the adapter SHALL fan out across each active child grant and SHALL merge the responses with `source` identity (`grant_id`, `connector_id`, `connection_id`) attached to every stream and granted connection row
- **AND** the merged envelope SHALL include `meta.package.member_count` so the client can tell it is operating under a package token.

#### Scenario: Search fans out across children and preserves the selected REST search mode

- **WHEN** a package token calls `search` with `mode=lexical`, `mode=semantic`, or `mode=hybrid`
- **THEN** the adapter SHALL forward the call through `/v1/search`, `/v1/search/semantic`, or `/v1/search/hybrid` respectively
- **AND** SHALL execute one source-local search per active child grant under that child's bearer
- **AND** SHALL merge the hits into one envelope, with each hit carrying source identity.

#### Scenario: Source-specific reads without a selector return typed ambiguous_connection

- **WHEN** a package token with more than one active child grant calls `query_records`, `fetch`, or `fetch_blob` without `connection_id`
- **THEN** the adapter SHALL return a typed `ambiguous_connection` (409) error envelope including `available_connections` (one entry per active member with `grant_id`, `connector_id`, `connection_id`, optional `display_name`) and `retry_with: "connection_id"`
- **AND** SHALL NOT call any child grant's RS bearer.

#### Scenario: Unknown selector returns typed not_found

- **WHEN** a package token passes a `connection_id` that does not match any active member
- **THEN** the adapter SHALL return a typed `not_found` (404) error envelope including the candidate list
- **AND** SHALL NOT fan out to any member.

### Requirement: Hosted MCP package event subscriptions SHALL bind to one child grant

Hosted MCP package tokens SHALL NOT create cross-source event subscriptions. Each persisted event subscription row SHALL belong to exactly one child grant's `grant_id`.

#### Scenario: Create requires a child selector when the package is multi-source

- **WHEN** a package token with more than one active child grant calls `create_event_subscription` without `connection_id`
- **THEN** the adapter SHALL return a typed `ambiguous_connection` (409)
- **AND** SHALL NOT issue any RS write call.

#### Scenario: Create with a single-source package infers the child

- **WHEN** a package token with exactly one active child grant calls `create_event_subscription`
- **THEN** the adapter SHALL forward the request under that one child's bearer
- **AND** the persisted subscription SHALL belong to that child's `grant_id`.

#### Scenario: List and lookups stay package-narrowed

- **WHEN** a package token calls `list_event_subscriptions`
- **THEN** the adapter SHALL fan out across each active child grant under that child's bearer
- **AND** SHALL merge the rows into one envelope with source identity attached
- **AND** SHALL NOT return subscriptions whose `grant_id` is not an active member of the package.

#### Scenario: Get / update / delete / send_test_event locate the owning child

- **WHEN** a package token calls `get_event_subscription`, `update_event_subscription`, `delete_event_subscription`, or `send_test_event` with a `subscription_id`
- **THEN** the adapter SHALL probe each active child's `/v1/event-subscriptions/:id` under that child's bearer
- **AND** SHALL forward the call only under the child whose probe returned 200
- **AND** SHALL return a typed `not_found` (404) when no active member owns the subscription.

### Requirement: Hosted MCP refresh tokens SHALL support package-bound access

The reference OAuth token endpoint SHALL support refresh-token exchange for hosted MCP package-bound access without exposing child-grant bearer tokens to the client.

#### Scenario: Client refreshes package access

- **WHEN** a hosted MCP client exchanges a valid package refresh token
- **THEN** the authorization server SHALL issue a new package-bound access token for the same package
- **AND** SHALL NOT return child-grant tokens.

#### Scenario: Package is revoked before refresh

- **WHEN** a hosted MCP client exchanges a refresh token for a revoked package
- **THEN** the authorization server SHALL reject the exchange.
