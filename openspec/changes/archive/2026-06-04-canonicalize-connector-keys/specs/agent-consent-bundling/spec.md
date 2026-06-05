## MODIFIED Requirements

### Requirement: Hosted MCP connection presentation SHALL use shared connector identity

The hosted MCP consent picker SHALL use canonical connector keys and configured connections as its selectable units. It SHALL suppress stale alias rows, SHALL NOT show URL-shaped manifest identifiers as connector choices, and SHALL preserve selected connection bindings on issued child grants.

#### Scenario: Legacy local collector alias has a canonical dataful connection

- **WHEN** both a stale local collector alias and its canonical connector key are present in storage
- **AND** the canonical connector has a dataful configured connection
- **THEN** the hosted MCP picker SHALL NOT show the stale alias as a separate owner-facing source.

#### Scenario: Connector manifest has a registry URI

- **WHEN** the hosted MCP picker renders a connector-backed source
- **THEN** the selectable item SHALL identify the connector type by canonical connector key and display name
- **AND** any registry URI SHALL be shown only as provenance metadata, not as the value submitted by the form.

#### Scenario: Owner approves multiple connections

- **WHEN** an owner approves multiple configured connections in one hosted MCP authorization ceremony
- **THEN** each child grant SHALL bind to the selected canonical connector key and selected connection id
- **AND** the grant package SHALL NOT infer child grants from connector-type URLs or stale aliases.

### Requirement: Hosted MCP package adapter SHALL route every read under exactly one child grant

The hosted MCP `/mcp` handler SHALL substitute a package-aware adapter (`PackageRsClient`) for the default single-bearer RS client whenever the inbound token is `pdpp_token_kind=mcp_package`. The adapter SHALL NOT forward a "first active member" token, SHALL NOT widen a single child grant's authority to cover other approved sources, and SHALL run every record/blob/event-subscription read under exactly one child grant's scoped client bearer.

#### Scenario: Schema and list_streams fan out per source

- **WHEN** a package token calls `schema` or `list_streams`
- **THEN** the adapter SHALL fan out across each active child grant and SHALL merge the responses with source identity (`grant_id`, `connector_key`, `connection_id`) attached to every stream and granted connection row
- **AND** the merged envelope SHALL include `meta.package.member_count` so the client can tell it is operating under a package token.

#### Scenario: Search fans out across children and preserves the selected REST search mode

- **WHEN** a package token calls `search` with `mode=lexical`, `mode=semantic`, or `mode=hybrid`
- **THEN** the adapter SHALL forward the call through `/v1/search`, `/v1/search/semantic`, or `/v1/search/hybrid` respectively
- **AND** it SHALL execute one source-local search per active child grant under that child's bearer
- **AND** every merged hit SHALL carry canonical connector key and connection identity.

#### Scenario: Source-specific reads without a selector return typed ambiguous_connection

- **WHEN** a package token with more than one active child grant calls `query_records`, `fetch`, `fetch_blob`, or an event-subscription create operation without `connection_id`
- **THEN** the adapter SHALL return a typed `ambiguous_connection` (409) error envelope including `available_connections` (one entry per active member with `grant_id`, `connector_key`, `connection_id`, optional `display_name`) and `retry_with: "connection_id"`
- **AND** it SHALL NOT call any child grant's RS bearer.

#### Scenario: Unknown selector returns typed not_found

- **WHEN** a package token passes a `connection_id` that does not match any active member
- **THEN** the adapter SHALL return a typed `not_found` (404) error envelope including the candidate list
- **AND** it SHALL NOT fan out to any member.
