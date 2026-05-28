## Why

`/v1/event-subscriptions` is the client-facing surface for outbound event subscriptions on a reference deployment. Today it is reachable only via REST. The MCP adapter (`packages/mcp-server`) exposes the rest of the client-facing PDPP surface (`schema`, `list_streams`, `query_records`, `search`, `fetch`, `fetch_blob`) so an MCP-only client (Claude, ChatGPT) can read records but cannot subscribe to changes, list its own subscriptions, rotate a delivery secret, send a test event, or delete a subscription. The SLVP construction target is one capability with adapter parity, not adapter-shaped feature gaps.

The previous change (`add-client-event-subscription-management`, archived 2026-05-28) explicitly deferred MCP tools for subscription management, citing concerns about owner-bearer code paths and operator state leakage. That archive note was about *operator* oversight, not client self-service. The client surface at `/v1/event-subscriptions` already authenticates with a scoped client bearer — the exact credential the MCP adapter already holds. There is no new auth path; this change brings the existing scoped-client surface into adapter parity.

## What Changes

- Add six MCP tools that forward to the existing `/v1/event-subscriptions[...]` REST endpoints using the same scoped client bearer the adapter already uses for read tools:
  - `create_event_subscription` (forwards `POST /v1/event-subscriptions`)
  - `list_event_subscriptions` (forwards `GET /v1/event-subscriptions`)
  - `get_event_subscription` (forwards `GET /v1/event-subscriptions/:id`)
  - `update_event_subscription` (forwards `PATCH /v1/event-subscriptions/:id`)
  - `delete_event_subscription` (forwards `DELETE /v1/event-subscriptions/:id`)
  - `send_test_event` (forwards `POST /v1/event-subscriptions/:id/test-event`)
- Honestly annotate each non-read tool: `readOnlyHint: false`, `destructiveHint` only on `delete_event_subscription`, `idempotentHint: false` on writes that mint or affect server state.
- Extend the RS client (`packages/mcp-server/src/rs-client.js`) with `postJson`, `patchJson`, `deleteJson` so non-GET forwarding is uniform with the existing GET helpers.
- Keep tool descriptions LLM-efficient: each description states the REST endpoint forwarded to, the side effect, the credential requirement, and the receiver constraints (HTTPS reachable callback, Standard Webhooks signing, CloudEvents 1.0 envelope, no record bodies in events, `data.changes_since` cursor for pull-based reads).
- Add OAuth protected-resource metadata advertisement note: clients discover subscription support via the existing `capabilities.client_event_subscriptions` block on `/.well-known/oauth-protected-resource`. No new discovery surface is added.
- Update `packages/mcp-server/README.md` Tools table and add a "Side-effectful tools" section.
- Decide not to add a user-facing `pdpp event-subscriptions` CLI in this change. Rationale captured in `design.md`: subscription management is naturally driven from the agent (MCP) or from the client application code that owns the callback receiver, not from a human-typed terminal. The existing `pdpp ref event-subscriptions list|show|disable` operator CLI stays untouched. We document this decision so a future change does not relitigate it without context.

## Capabilities

Modified:

- `reference-implementation-architecture`

Added:

- None (no new capability folders).

Removed:

- None.

## Impact

- Affected code:
  - `packages/mcp-server/src/tools.js` — six new tool definitions, side-effect annotations, output schemas.
  - `packages/mcp-server/src/rs-client.js` — add `postJson`, `patchJson`, `deleteJson` helpers; preserve request-id and error-envelope normalization.
  - `packages/mcp-server/test/event-subscription-tools.test.js` — new test file covering tool list registration, schema mirror, forwarding behavior, error-envelope passthrough, and owner-bearer rejection passthrough.
  - `packages/mcp-server/README.md` — Tools table extended, side-effectful tools section.
- Affected behavior:
  - MCP clients can now manage their own grant-scoped event subscriptions through the adapter.
  - No new REST surface, no new auth path, no change to RS storage, no change to delivery worker, no new wire shape.
- Protocol impact: none. The MCP layer remains an adapter over the existing REST contract.

## Out of scope (and why)

- **Owner-token MCP mode.** The adapter refuses owner credentials by design (see `parseOptions` in `packages/mcp-server/src/index.js`). This change does not relax that posture.
- **Always-on Claude/ChatGPT webhook receiver.** Out of scope. The MCP tools assume the caller has an HTTPS receiver reachable from the reference deployment. Hosting a generic receiver is a separate product question.
- **Pushing record bodies in webhook events.** Already prohibited by the existing spec (events carry a `changes_since` cursor, not record bodies). This change does not relax that.
- **Owner-side operator MCP surface.** Out of scope. The archived `add-client-event-subscription-management` change shipped operator oversight via `/_ref/event-subscriptions*`, dashboard, and `pdpp ref event-subscriptions` CLI. That surface stays where it is.
- **User-facing CLI command.** Deliberately omitted. See `design.md` §3.
