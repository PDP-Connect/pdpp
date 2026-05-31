# @pdpp/mcp-server

Local stdio and hosted Streamable HTTP [Model Context Protocol](https://modelcontextprotocol.io/)
adapter for grant-scoped access to a [PDPP](https://pdpp.vivid.fish) resource server.

The adapter is a thin client of the PDPP resource server (RS). It does not run connectors,
issue grants, or replicate any RS authorization logic. Every data-bearing tool call is a
forwarded request to an existing `/v1/*` endpoint, authenticated with the scoped client
access token already cached by `pdpp connect`. Side-effectful tools (the event-subscription
management surface) are honestly annotated with `readOnlyHint: false` so MCP harnesses can
prompt the user before invoking them.

## What this is not

- **Not a grant-issuance surface.** If the cache is empty or the token is invalid, the
  adapter exits / surfaces an error directing the operator at `pdpp connect`.
- **Not an owner-mode bypass.** `PDPP_OWNER_TOKEN` and other owner credentials are
  refused by default.
- **Not a proxy.** Per-client consent and confused-deputy mitigations would be required
  before this package accepted unvalidated MCP-client tokens. Hosted callers must
  validate the bearer before passing it to this package.

## Publication status

This package is a private workspace package (`"private": true`). It is consumed
in-repo by the agent skill and integration tests. Promoting it to a published
`@pdpp/mcp-server@beta` on npm requires a follow-up OpenSpec change under the
[package release policy](../../docs/package-release-policy.md) (manifest opt-in,
release-train wiring, and npm trusted-publisher bootstrap), matching the
precedent established for `@pdpp/cli` and `@pdpp/local-collector`.

## Install (local agent harness)

```jsonc
// claude_desktop_config.json (or equivalent)
{
  "mcpServers": {
    "pdpp": {
      "command": "npx",
      "args": ["-y", "@pdpp/mcp-server@beta", "--provider-url", "https://pdpp.example.com"]
    }
  }
}
```

Run `pdpp connect https://pdpp.example.com` first so a scoped client token is cached at
`.pdpp/clients/<host>.json`.

## CLI

```
pdpp-mcp-server --provider-url <url> [--cache-root <dir>] [--server-name <name>]
```

Flags can also come from environment variables: `PDPP_PROVIDER_URL`,
`PDPP_CACHE_ROOT`, `PDPP_MCP_SERVER_NAME`.

The adapter writes only MCP protocol messages to stdout. Diagnostics go to stderr.

## Tools

All tools forward to existing RS endpoints under the scoped client token.

### Read tools (read-only, idempotent)

| Tool | RS endpoint |
| --- | --- |
| `schema` | `GET /v1/schema` |
| `list_streams` | `GET /v1/streams` |
| `query_records` | `GET /v1/streams/{stream}/records` |
| `search` | `GET /v1/search` |
| `fetch` | `GET /v1/streams/{stream}/records/{record_id}` |
| `fetch_blob` | `GET /v1/blobs/{blob_id}` |
| `list_event_subscriptions` | `GET /v1/event-subscriptions` |
| `get_event_subscription` | `GET /v1/event-subscriptions/{id}` |
| `discover_event_subscription_capabilities` | `GET /.well-known/oauth-protected-resource` |

Plus one resource template: `pdpp://stream/{name}` → `GET /v1/streams/{name}`.

`search` preserves the RS envelope in `structuredContent.data` and also returns
ChatGPT-compatible `structuredContent.results[]` entries with `id`, `title`, and `url`.
`fetch` accepts result ids in `stream:record_id` form and returns `id`, `title`, `text`,
`url`, and `metadata`.

Discovery tools (`schema`, `list_streams`) preserve the full RS body in
`structuredContent.data` and also include concise parseable text with stream names,
`connection_id`, `connector_key`, display labels, and schema field-capability essentials
so MCP clients whose models read only `content[]` can still choose streams, fields, and
connection scopes.

`query_records` also preserves the full RS envelope in `structuredContent.data`, and its
text content includes a bounded preview of returned records. This keeps agents that can
only reason over MCP `content[]` from seeing only a count summary while preserving
`structuredContent` as the canonical machine-readable result.

### Side-effectful tools (event-subscription management)

These tools manage outbound event subscriptions on the configured PDPP instance via the
existing `/v1/event-subscriptions[...]` REST surface. They use the same scoped client bearer
the read tools use — no new credential path. Each tool is annotated honestly so an MCP
harness can prompt before invoking:

| Tool | RS endpoint | `destructiveHint` | `idempotentHint` |
| --- | --- | --- | --- |
| `create_event_subscription` | `POST /v1/event-subscriptions` | false | false |
| `update_event_subscription` | `PATCH /v1/event-subscriptions/{id}` | false | false |
| `send_test_event` | `POST /v1/event-subscriptions/{id}/test-event` | false | false |
| `delete_event_subscription` | `DELETE /v1/event-subscriptions/{id}` | **true** | true |

Receiver constraints:

- The callback URL must be an HTTPS endpoint reachable from the configured PDPP instance
  (`http://localhost` is accepted only for development; max 2048 bytes).
- Deliveries are signed per [Standard Webhooks](https://www.standardwebhooks.com): headers
  `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64>`. The per-subscription
  secret is returned exactly once on create (and again on `rotate_secret`).
- Envelope is [CloudEvents 1.0](https://cloudevents.io/) JSON structured mode
  (`application/cloudevents+json; charset=utf-8`). Record bodies are **never** pushed —
  clients pull changes by passing `data.changes_since` to `query_records`.
- Authoritative wire shape (event types, signing profile, retry schedule, verification
  handshake) is advertised at `capabilities.client_event_subscriptions` on the RS
  protected-resource metadata: `GET /.well-known/oauth-protected-resource`. The
  read-only `discover_event_subscription_capabilities` tool fetches that
  advertisement so an MCP client never has to leave the adapter to plan a
  subscription call.
- Use event subscriptions when a long-lived receiver needs low-latency change
  notifications; prefer polling via `query_records` with `changes_since` for
  one-shot reads, short-lived clients, or environments where a reachable HTTPS
  callback is impractical.

The MCP adapter does not host a callback receiver. Your application is responsible for
running a reachable HTTPS endpoint that handles `pdpp.subscription.verify` (echo the
challenge), `pdpp.subscription.test`, `pdpp.records.changed`, and `pdpp.grant.revoked`
envelopes.

For operators verifying delivery against a fresh deployment, the repository ships a
local test receiver at `scripts/event-subscription-test-receiver.mjs` that completes
the verification handshake and prints incoming envelopes. The companion operator
guide at [`docs/operator/event-subscriptions.md`](../../docs/operator/event-subscriptions.md)
covers the receiver, the operator console surface at `/dashboard/event-subscriptions`,
and the operator disable affordance.

Owner credentials are still refused. The event-subscription tools do not widen the
adapter's credential surface; they reuse the existing scoped client bearer, and every
authorization check happens server-side on the RS as before.

## Hosted Streamable HTTP helper

Reference servers can mount hosted MCP by authenticating the incoming bearer themselves,
then passing a Web `Request` plus scoped token to `handleStreamableHttpRequest()`:

```js
import { handleStreamableHttpRequest } from '@pdpp/mcp-server';

const response = await handleStreamableHttpRequest(request, {
  providerUrl: 'https://pdpp.example.com',
  accessToken: scopedClientBearer,
});
```

The helper creates a fresh server and Streamable HTTP transport per request with MCP
session ids disabled.

## Errors

Resource-server error responses (4xx/5xx including `invalid_token`, `insufficient_scope`,
`needs_broader_grant`, `invalid_cursor`) are surfaced as MCP `isError: true` results with
the original envelope preserved in `structuredContent.error`. The adapter does not retry
with broader credentials.
