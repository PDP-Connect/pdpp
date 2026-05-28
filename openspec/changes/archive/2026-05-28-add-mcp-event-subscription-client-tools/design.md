# Design — MCP event-subscription client tools

## 1. Posture

The MCP adapter is, and remains, a thin client of the PDPP resource server. Every data-bearing tool call is a forwarded HTTP request authenticated with the scoped client bearer cached by `pdpp connect`. This change does not change that posture; it just stops cutting the client-facing surface in half at the adapter boundary.

The archived `add-client-event-subscription-management` change deferred MCP tools with a paragraph about owner-bearer leakage and the "read-only" posture of the adapter. That argument applied to *operator* oversight (`/_ref/event-subscriptions*`), which would have required an owner credential path the adapter does not support. The client-facing surface at `/v1/event-subscriptions[...]` already uses the scoped client bearer the adapter already holds, so the deferral does not apply to it. We are not widening the adapter's credential surface or its enforcement responsibilities; we are mirroring an existing REST contract.

## 2. Tool shape

Six tools, mirroring the six REST endpoints one-to-one. Each tool's input schema mirrors the REST body or query exactly — the MCP layer does not invent fields, rename them, or silently drop unsupported ones. This is the same mirror invariant `canonicalize-public-read-contract` already established for the read tools.

| Tool                          | REST                                          | Annotations                                                  |
| ----------------------------- | --------------------------------------------- | ------------------------------------------------------------ |
| `create_event_subscription`   | `POST /v1/event-subscriptions`                | readOnlyHint=false, destructiveHint=false, idempotentHint=false |
| `list_event_subscriptions`    | `GET /v1/event-subscriptions`                 | readOnlyHint=true, destructiveHint=false, idempotentHint=true |
| `get_event_subscription`      | `GET /v1/event-subscriptions/:id`             | readOnlyHint=true, destructiveHint=false, idempotentHint=true |
| `update_event_subscription`   | `PATCH /v1/event-subscriptions/:id`           | readOnlyHint=false, destructiveHint=false, idempotentHint=false (because `rotate_secret` mints a new secret each call) |
| `delete_event_subscription`   | `DELETE /v1/event-subscriptions/:id`          | readOnlyHint=false, destructiveHint=true, idempotentHint=true |
| `send_test_event`             | `POST /v1/event-subscriptions/:id/test-event` | readOnlyHint=false, destructiveHint=false, idempotentHint=false |

Annotations follow the MCP `ToolAnnotations` semantics defined by the SDK. They are advisory — the RS still enforces every constraint — but they let MCP clients render correct confirmations to users (and let agent harnesses choose whether to auto-approve).

`openWorldHint` is `false` for all subscription tools because the side effect is bounded to the configured PDPP RS, not the open web.

## 3. CLI decision

We deliberately do **not** add `pdpp event-subscriptions ...` as a user-facing CLI command in this change. Reasons:

1. **Subscriptions are not a human-typed workflow.** Creating a subscription requires a callback URL that the user's *application* hosts. Typing `pdpp event-subscriptions create --callback-url https://my-app.example/webhook` from a terminal mints a Standard Webhooks secret that the human has to immediately ferry into the same app's config. That is a worse ergonomic than just calling the REST endpoint from the app's own startup code.
2. **MCP and REST already cover the two real use cases.** Agents create/manage subscriptions via MCP tools; applications create/manage them via the REST endpoint (or a generated client). A third surface that no real workflow needs is over-construction.
3. **Operator oversight already has a CLI.** `pdpp ref event-subscriptions list|show|disable` covers the operator side. Reusing the same noun for a client-side command would invite confusion about whose creds are in play.

This decision is recorded here so a future change does not re-litigate it without context. The bar for adding a client-side CLI later is: a real workflow exists where a human (not their app, not their agent) needs to manage a subscription from a terminal.

## 4. RS client extensions

`rs-client.js` gains three helpers that match the existing `getJson` shape:

- `postJson(path, { body, headers })`
- `patchJson(path, { body, headers })`
- `deleteJson(path, { headers })` (no body)

They share the same `parseRsResponse` flow as `getJson`, so error envelopes (including the typed `grant_invalid`, `invalid_request`, `invalid_state`, `not_found`, and 403 `grant_invalid` returned by the RS) come back in the same shape MCP tools already render. `request_id` is preserved.

`deleteJson` returns `{ ok: true, status: 204, body: null, requestId }` on success because the RS returns 204 for delete. The MCP tool's `toToolResult` summarizes that as "subscription deleted" without echoing a null body to the model.

## 5. Tool descriptions (LLM-efficient)

Tool descriptions are constant, not interpolated from RS responses. Each carries:

- The REST endpoint forwarded to (one line).
- The credential requirement (one line: scoped client bearer).
- The side effect (one line: persisted on the RS).
- The receiver constraint (HTTPS reachable, Standard Webhooks signed, CloudEvents structured-mode JSON, body carries `changes_since` not record bodies).
- A pointer to `/.well-known/oauth-protected-resource` `capabilities.client_event_subscriptions` for the authoritative wire-shape spec.

This keeps the descriptions short while giving an MCP client enough hint to construct a valid call without round-tripping to docs.

## 6. Discovery

No new discovery surface. The protected-resource metadata document already advertises `capabilities.client_event_subscriptions` with `endpoint`, `signing`, `envelope`, `event_types`, `delivery`, `verification`, and `hint_cursor`. MCP clients SHOULD consult that block before constructing a subscription.

The MCP server's tool list itself is also discovery: an MCP client that asks for `tools/list` will see the six new tools alongside the existing read tools. There is no separate "advertise that subscription tools exist" surface, because the SDK-driven tool list already is one.

## 7. Tests

New file `packages/mcp-server/test/event-subscription-tools.test.js` covers:

- Tool list registration: all six tool names appear in `tools/list`.
- Input-schema mirror: each tool's required/optional inputs match the REST body/query.
- Output-schema validation: structuredContent envelope (`data`, `provider_url`, `request_id`) matches the read-tool envelope.
- Forwarding behavior: each tool issues the right HTTP method + path with the bearer attached.
- Error passthrough: a typed `invalid_request` (HTTPS-only callback) error from the RS arrives in the tool result with `isError: true` and the original `code` / `message`.
- Side-effect annotation honesty: write tools advertise `readOnlyHint: false`; `delete_event_subscription` advertises `destructiveHint: true`; `send_test_event` and `update_event_subscription` advertise `idempotentHint: false`.

The existing `canonical-mirror.test.js` invariants apply to the new tools too: input schemas are not silently widened or narrowed, outputs flow through structuredContent.

## 8. What this does NOT do

- It does not introduce a new auth mode for the MCP adapter.
- It does not expose operator-side oversight through MCP. The owner-bearer rejection in `parseOptions` remains.
- It does not change the RS wire shape, delivery worker, signing, or storage.
- It does not host a callback receiver — that remains the client application's responsibility.

## 9. Acceptance

- `node --test packages/mcp-server/test/event-subscription-tools.test.js` passes.
- `node --test packages/mcp-server/test/` passes (no regression in read tools, canonical mirror, or server integration).
- `openspec validate add-mcp-event-subscription-client-tools --strict` passes.
- An MCP client calling `tools/list` sees six new tool names; calling `create_event_subscription` with a valid `callback_url` posts to `/v1/event-subscriptions` with the cached scoped bearer and surfaces the freshly minted `whsec_`-prefixed secret in the tool's structured content exactly once.
