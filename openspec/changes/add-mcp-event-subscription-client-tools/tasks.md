## 1. OpenSpec

- [x] 1.1 Draft proposal, design, tasks, and spec delta for `add-mcp-event-subscription-client-tools`.
- [x] 1.2 `openspec validate add-mcp-event-subscription-client-tools --strict`.

## 2. RS client extensions

- [x] 2.1 Add `postJson`, `patchJson`, `deleteJson` to `packages/mcp-server/src/rs-client.js`. Reuse `parseRsResponse` for consistent error envelope and `request_id` handling. `deleteJson` SHALL accept a 204 (No Content) as success and surface `body: null`.

## 3. MCP tools

- [x] 3.1 Add `create_event_subscription` to `packages/mcp-server/src/tools.js`. Input: `callback_url` (required, https only — accept the RS's verdict), optional `filters.streams[]`. Output: `{subscription_id, secret, status, callback_url, created_at}` plus the standard `provider_url`/`request_id` envelope.
- [x] 3.2 Add `list_event_subscriptions`. No input. Output: RS list envelope under `data`.
- [x] 3.3 Add `get_event_subscription`. Input: `subscription_id`. Output: projected subscription row.
- [x] 3.4 Add `update_event_subscription`. Input: `subscription_id`, optional `enabled` (boolean), optional `rotate_secret` (boolean). Output: updated subscription row plus optional fresh `secret`.
- [x] 3.5 Add `delete_event_subscription`. Input: `subscription_id`. Output: empty body, `status: 204` surfaced in summary text. Annotate `destructiveHint: true`.
- [x] 3.6 Add `send_test_event`. Input: `subscription_id`. Output: `{event_id}`. Annotate `idempotentHint: false`.
- [x] 3.7 Every write tool description SHALL state: REST endpoint forwarded to, the side effect, the scoped-client-bearer requirement, the receiver constraint (HTTPS reachable, Standard Webhooks signed, CloudEvents structured-mode JSON, no record bodies, `data.changes_since` for pull-based reads), and a pointer to `capabilities.client_event_subscriptions` for the authoritative wire-shape spec.

## 4. Tests

- [x] 4.1 Add `packages/mcp-server/test/event-subscription-tools.test.js` covering tool list registration, forwarding HTTP method/path/body, error-envelope passthrough, structuredContent envelope shape, and annotation honesty.
- [x] 4.2 Confirm existing `packages/mcp-server/test/canonical-mirror.test.js`, `server.integration.test.js`, and other tests still pass.

## 5. Docs

- [x] 5.1 Update `packages/mcp-server/README.md` Tools table with the six new tools and add a "Side-effectful tools" section that names the scoped-bearer requirement and the receiver constraints.

## 6. CLI decision

- [x] 6.1 Document in `design.md` why a client-side `pdpp event-subscriptions` CLI is deliberately omitted. No code change in `packages/cli/`.

## 7. Validation

- [x] 7.1 `node --test packages/mcp-server/test/` passes.
- [x] 7.2 `openspec validate add-mcp-event-subscription-client-tools --strict` passes.
- [x] 7.3 `openspec validate --all --strict` passes.

## Acceptance checks

- `tools/list` over the in-memory MCP transport returns the six new tool names alongside the existing read tools.
- A tool call to `create_event_subscription` with a valid HTTPS `callback_url` issues `POST /v1/event-subscriptions` with `Authorization: Bearer <scoped-token>` and the JSON body `{callback_url}` (plus `filters` if supplied), and the tool result's `structuredContent.data.secret` carries the `whsec_` prefix exactly once.
- A tool call to `delete_event_subscription` issues `DELETE /v1/event-subscriptions/<id>` and surfaces `status: 204` without echoing a synthetic body.
- A tool call to `create_event_subscription` with `callback_url: "http://example.com/hook"` propagates the RS's typed `invalid_request` error envelope back to the tool result with `isError: true`.
- Owner-token MCP rejection still applies — the new tools do not create a code path that would accept owner credentials.
