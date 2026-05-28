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
