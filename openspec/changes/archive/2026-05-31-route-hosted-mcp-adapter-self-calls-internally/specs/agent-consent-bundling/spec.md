## ADDED Requirements

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
