## ADDED Requirements

### Requirement: The MCP adapter SHALL expose client event subscription management tools

The reference MCP adapter (`packages/mcp-server`) SHALL register tools that forward the client-facing `/v1/event-subscriptions[...]` REST surface verbatim. Each tool SHALL use the same scoped client bearer the adapter already caches via `pdpp connect`. The adapter SHALL NOT introduce a new authorization mode and SHALL NOT accept owner credentials for these tools — the existing owner-credential refusal in `packages/mcp-server/src/index.js` SHALL still gate startup.

Each subscription tool SHALL forward to exactly one REST endpoint, MUST NOT silently drop or rename a forwarded field, and SHALL surface the RS response (or typed error envelope) under the standard `structuredContent` shape the existing read tools use.

#### Scenario: An MCP client lists the registered tools

- **WHEN** an MCP client connected to the adapter calls `tools/list`
- **THEN** the response SHALL include `create_event_subscription`, `list_event_subscriptions`, `get_event_subscription`, `update_event_subscription`, `delete_event_subscription`, and `send_test_event` in addition to the existing read tools

#### Scenario: A client creates a subscription through MCP

- **WHEN** an MCP client calls `create_event_subscription` with an HTTPS `callback_url`
- **THEN** the adapter SHALL issue `POST /v1/event-subscriptions` to the configured provider with `Authorization: Bearer <scoped-client-token>` and a JSON body containing `callback_url` (and `filters` when supplied)
- **AND** the tool result's `structuredContent.data` SHALL include the RS response body verbatim, including the `whsec_`-prefixed delivery secret returned exactly once

#### Scenario: A client deletes a subscription through MCP

- **WHEN** an MCP client calls `delete_event_subscription` with a `subscription_id`
- **THEN** the adapter SHALL issue `DELETE /v1/event-subscriptions/<id>` with the scoped bearer attached
- **AND** the tool SHALL surface `status: 204` in the structured content without echoing a synthetic body

#### Scenario: The RS rejects a non-HTTPS callback URL

- **WHEN** an MCP client calls `create_event_subscription` with a `callback_url` the RS rejects with a typed `invalid_request` envelope
- **THEN** the tool result SHALL set `isError: true`
- **AND** the structured content SHALL preserve the RS error envelope's `type`, `code`, and `message` rather than masking them

#### Scenario: An owner credential is present in the environment

- **WHEN** the adapter is started with `PDPP_OWNER_TOKEN` or `PDPP_OWNER_SESSION_COOKIE` in the environment
- **THEN** the adapter SHALL refuse to start with the existing exit code, regardless of which tools (read or write) are registered

### Requirement: Subscription tools SHALL annotate their side effects honestly

Each subscription tool SHALL set MCP tool annotations that reflect the underlying REST endpoint's side effect. Read-only tools (`list_event_subscriptions`, `get_event_subscription`) SHALL advertise `readOnlyHint: true` and `idempotentHint: true`. Write tools SHALL advertise `readOnlyHint: false`. `delete_event_subscription` SHALL advertise `destructiveHint: true`. `update_event_subscription` and `send_test_event` SHALL advertise `idempotentHint: false` because they affect server state on each call (secret rotation mints a new secret; test-event enqueue mints a new event id).

All subscription tools SHALL advertise `openWorldHint: false` because their side effects are bounded to the configured PDPP resource server.

#### Scenario: A client harness inspects tool annotations

- **WHEN** an MCP client reads the `annotations` block for `delete_event_subscription`
- **THEN** the annotations SHALL include `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`, and `openWorldHint: false`

#### Scenario: A client harness inspects update tool annotations

- **WHEN** an MCP client reads the `annotations` block for `update_event_subscription` or `send_test_event`
- **THEN** the annotations SHALL include `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`, and `openWorldHint: false`

### Requirement: The MCP adapter SHALL expose an event-subscription discovery tool

The adapter SHALL register a read-only `discover_event_subscription_capabilities` tool that fetches the resource server's protected-resource metadata at `/.well-known/oauth-protected-resource` and surfaces `capabilities.client_event_subscriptions`. The tool SHALL set `readOnlyHint: true`, `idempotentHint: true`, and `openWorldHint: false`. The endpoint is unauthenticated per RFC 9728; the adapter MAY include the configured bearer in the request but SHALL NOT require authentication for this discovery tool to succeed.

The tool's `structuredContent` SHALL include `supported` (boolean derived from `capability.supported === true`), `capability` (the advertised block verbatim, or `null` when absent), `data` (the full protected-resource metadata body), and the standard `provider_url`, `request_id`, and `http_status` fields.

When the advertisement omits `capabilities.client_event_subscriptions`, the tool SHALL surface `supported: false` and `capability: null` and SHALL NOT set `isError`. RS errors (e.g. untrusted-host envelopes) SHALL propagate as `isError: true` with the typed envelope preserved.

#### Scenario: A client discovers supported event types before subscribing

- **WHEN** an MCP client calls `discover_event_subscription_capabilities` against a reference instance that advertises `client_event_subscriptions`
- **THEN** the adapter SHALL issue `GET /.well-known/oauth-protected-resource` to the configured provider
- **AND** `structuredContent.supported` SHALL be `true`
- **AND** `structuredContent.capability` SHALL contain the `endpoint`, `event_types`, `signing`, `envelope`, and `retry` fields advertised by the RS

#### Scenario: A deployment does not advertise event subscriptions

- **WHEN** the protected-resource metadata omits `capabilities.client_event_subscriptions`
- **THEN** the tool SHALL return `structuredContent.supported: false` and `structuredContent.capability: null`
- **AND** the tool result SHALL NOT set `isError`
- **AND** the prose `content[0].text` SHALL guide the caller toward `query_records` with `changes_since` as the polling alternative

### Requirement: Subscription tool descriptions SHALL explain when to use events versus polling

Every write tool description (`create_event_subscription`, `update_event_subscription`, `send_test_event`) and every read tool description that touches the subscription substrate SHALL state when event subscriptions are appropriate (long-lived receiver, low-latency change notification) and when polling via `query_records` with `changes_since` is the better choice (one-shot reads, short-lived clients, environments without a reachable HTTPS callback). Descriptions SHALL also reference `discover_event_subscription_capabilities` as the authoritative source for supported event types, signing profile, and retry schedule.

#### Scenario: An LLM agent reads a write-tool description

- **WHEN** an MCP client inspects the description of `create_event_subscription`, `update_event_subscription`, or `send_test_event`
- **THEN** the description SHALL mention both event subscriptions and the polling alternative
- **AND** the description SHALL name `discover_event_subscription_capabilities` (directly or via the protected-resource metadata path) as the way to learn supported event types and wire shape
