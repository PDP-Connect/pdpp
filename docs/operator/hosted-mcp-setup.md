# Hosted MCP Setup

This runbook connects a self-hosted PDPP reference deployment to MCP clients
that support remote Streamable HTTP MCP servers.

If you do not yet have a reachable self-hosted deployment, start with the
[self-host quickstart](selfhost-quickstart.md). Come back here once
`/dashboard/deployment` reports healthy.

The dashboard setup page is `/dashboard/connect`. Use that page for the normal
copy-paste path; this runbook is the expanded reference.

## Prerequisites

- The reference deployment is reachable over HTTPS.
- Owner login works for the deployment dashboard.
- Public metadata resolves from the same origin:
  - `/.well-known/oauth-authorization-server`
  - `/.well-known/oauth-protected-resource/mcp`
  - `/mcp`

## Your MCP server URL

Your MCP server URL is always:

```text
<PDPP_REFERENCE_ORIGIN>/mcp
```

Substitute `<PDPP_REFERENCE_ORIGIN>` with the value you set in `.env.docker`.
For a RunPod CPU Pod this is `https://<podid>-3002.proxy.runpod.net/mcp`.
For a local Docker host this is typically `http://localhost:3002/mcp`.

Use this URL in every MCP client setup step below — not some other operator's
deployment (for example `pdpp.example.com/mcp`), which only serves data
collected there.

## ChatGPT

1. Open ChatGPT connector creation.
2. Choose a custom MCP connector.
3. Set the MCP server URL to `<PDPP_REFERENCE_ORIGIN>/mcp`.
4. Choose OAuth authentication.
5. Complete connector registration and sign in to the PDPP owner dashboard when redirected.
6. Select the PDPP source the connector should read and approve the grant.
7. Return to ChatGPT and finish connecting the connector.

The reference authorization server supports dynamic client registration for
public OAuth clients using `authorization_code` with PKCE, `refresh_token`, and
RFC 8628 device authorization for headless clients. The issued tokens are bound
to the approved PDPP grant; they do not expose owner dashboard credentials or
operator/admin control.

## Claude Code

Use one HTTP MCP server entry:

```sh
claude mcp add --transport http pdpp <PDPP_REFERENCE_ORIGIN>/mcp
```

When Claude Code opens the OAuth flow, approve the PDPP source in the browser.
The approved grant scopes `/mcp` to the selected source and read-only tools.

## Codex

Use one streamable HTTP MCP server entry:

```sh
codex mcp add pdpp --url <PDPP_REFERENCE_ORIGIN>/mcp
```

When Codex starts OAuth, approve the PDPP source in the browser. Do not add a
bearer-token environment variable for normal MCP setup.

## Headless or sandboxed MCP clients

Browser-capable MCP clients should use the authorization-code + PKCE flow above.
If an MCP client runs in a sandbox, SSH session, container, or other environment
where its loopback callback cannot be reached, use the grant-scoped device-code
path instead. This is still normal MCP setup: it issues a scoped client token for
`/mcp`, not an owner bearer.

The client starts `POST /oauth/device_authorization` with:

- `client_id`: a pre-registered, CIMD-backed, or dynamically registered public
  client id.
- `resource`: `<PDPP_REFERENCE_ORIGIN>/mcp`.
- `authorization_details`: the same PDPP data-access request shape used by the
  hosted MCP authorization-code flow.

The response includes `device_code`, `user_code`, `verification_uri`,
`verification_uri_complete`, `expires_in`, and `interval`. Show the owner the
verification URL/code, show the expiry, poll `/oauth/token` no faster than the
advertised interval, and handle `authorization_pending`, `slow_down`,
`access_denied`, `expired_token`, `invalid_grant`, and `invalid_client` as
retryable or terminal OAuth outcomes. If approval expires or is denied, show a
fresh retry command instead of asking for an owner bearer. Do not wait forever
on a loopback callback that cannot arrive.

## Security Model

- `/mcp` accepts only PDPP client bearer tokens tied to an approved grant.
- Owner dashboard/session tokens are rejected by `/mcp`.
- Owner-agent device authorization creates owner-level REST/control-plane
  credentials, not normal MCP credentials.
- Refresh tokens are accepted only at `/oauth/token`.
- Revoking the PDPP grant invalidates its access tokens and refresh tokens.
- The hosted MCP surface is read-only and does not run connectors, schedules,
  browser sessions, or operator-console actions.

## Trusted local agents (operator-side)

Trusted local owner agents are a separate REST/control-plane surface for the
operator — a CLI tool you wrote, a backup script you run from your laptop, or a
personal assistant that lives on a machine you control. This is not the route
for ordinary MCP clients and it is not grant-scoped MCP access.

For the happy path, onboard the trusted owner agent with browser-mediated owner
approval and a local credential file:

```sh
pdpp owner-agent onboard <PDPP_REFERENCE_ORIGIN> \
  --credential-file ~/applications/daisy/.pi/agent/pdpp-owner-agent.json

pdpp owner-agent status \
  --credential-file ~/applications/daisy/.pi/agent/pdpp-owner-agent.json
```

The CLI discovers the owner-agent onboarding profile, opens the approval flow,
and writes the issued credential with restrictive permissions. It prints only
non-secret status; the bearer is not displayed and should not be pasted into a
chat transcript. A trusted local owner agent reads the credential file at call
time and uses the bearer only against owner-bearer-supported `/v1/*` REST
routes.

The dashboard token page at `/dashboard/deployment/tokens` may still be useful
as a low-level self-export/debug tool for operators who need to inspect the raw
REST bearer flow. Keep that path secondary: the bearer is broader than a PDPP
grant, should not be used with `/mcp`, and should not be copied into a
third-party agent session.

Ordinary MCP clients (Claude, ChatGPT, third-party agents) should keep
using the OAuth scoped-grant flow at `/mcp` described above. `/mcp` rejects
owner bearers on purpose.

## Verifying hosted schema token efficiency (parity check)

The `schema` tool defaults to a compact, token-efficient projection so an agent's
discovery path (`schema -> schema(stream) -> schema(stream, connection_id) ->
query_records`) stays cheap.
A real owner grant's full `GET /v1/schema` body can exceed 2 MB once every
connector advertises per-field JSON Schema, which is too large as a default
agent-facing payload. The hosted `/mcp` Streamable HTTP surface and the local
stdio adapter run the **same** in-repo tool code (`createPdppMcpServer` ->
`buildTools` -> `toSchemaToolResult`), so the compact default is structurally the
same on both. The in-repo regression guards that prove this are:

- `packages/mcp-server/test/schema-token-budget.test.js` — compact default over
  the in-memory (stdio/local) transport.
- `packages/mcp-server/test/hosted-schema-token-budget.test.js` — compact default
  **over a real `handleStreamableHttpRequest` `tools/call`**, i.e. the hosted
  `/mcp` wire path. Both assert `structuredContent < 60 KB` for a ~1.4 MB
  verbatim fixture and that global `detail: "full"` is rejected.

Those tests prove the serialization. The steps below are the **owner-only live
parity check** against a real ChatGPT/Claude registration — run them when you
want end-to-end confidence that the hosted gateway forwards the compact bytes,
without pasting large payloads into a chat transcript.

> Do not paste full `schema` responses into chat. Capture them to a file and
> measure the file size; only the byte count needs to leave the loop.

1. **Clear stale registrations.** In ChatGPT/Claude, delete any existing PDPP
   connector that was registered against an older reference image, then re-add it
   against `<PDPP_REFERENCE_ORIGIN>/mcp` and complete the OAuth grant. A stale
   registration can pin an old tool surface; a fresh add guarantees the gateway
   advertises the current `schema` tool (with `detail` and `stream` inputs).
2. **Confirm the tool surface.** Ask the agent to list its PDPP tools, or inspect
   the connector's tool list. Confirm the exact tools are `schema`,
   `query_records`, `aggregate`, `search`, `fetch`, and `read_record_field`;
   confirm `schema` exposes `detail` (`compact|full`), `stream`, and
   `connection_id`. `read_record_field` is the model-callable bounded-read path
   when a search preview is not enough; generic resource reads are optional. If
   the list differs, the gateway or client registration is stale — return to
   step 1 after updating the reference service.
3. **Call the compact default and record its size.** Have the agent call `schema`
   with no arguments and write the raw structured result to a file rather than
   echoing it. For a direct owner-side check against the same RS endpoint the tool
   forwards to (bytes, not contents):

   ```sh
   # Owner-side, against the same grant-scoped client bearer the gateway uses.
   # Do not print $PDPP_CLIENT_BEARER; only the byte count is surfaced.
   curl -fsS -H "Authorization: Bearer $PDPP_CLIENT_BEARER" \
     "<PDPP_REFERENCE_ORIGIN>/v1/schema" | wc -c
   ```

   This `wc -c` is the **verbatim** RS body — the number the compact default must
   stay far below. Expect it to be large (hundreds of KB to multiple MB) for a
   real multi-connector grant. The compact `schema` default the agent receives
   should be roughly an order of magnitude smaller and well under ~60 KB for a
   typical grant.
4. **Spot-check the compact shape.** In the captured compact result, each
   `field_capabilities.<field>` is a terse flag string (e.g.
   `type=string,granted=true,exact,...`), not a nested JSON Schema object, and
   `data.detail` is `"compact"`. Connection identity (`connection_id`,
   `display_name`) is preserved.
5. **Confirm the escape hatch is scoped.** Have the agent call
   `schema(detail: "full")` without a `stream` and confirm it is rejected. Then
   call `schema(stream: "<one stream>", connection_id: "<one connection>",
   detail: "full")` and capture it to a file. This proves exhaustive JSON Schema
   is reachable for a chosen source but never returned for the whole grant.
6. **Confirm per-stream and per-connection scope.** `schema(stream: "<one stream>")`
   may return multiple rows because stream names are not globally unique.
   `schema(stream: "<one stream>", connection_id: "<one connection>")` should
   return only that configured source, compact, as the cheap middle step of the
   discovery path.

If steps 3-6 hold, the hosted gateway has schema token-efficiency parity with the
in-repo reference server. If the compact default comes back verbatim-sized, the
gateway is re-serializing the RS body instead of forwarding the tool result —
capture the byte counts (not contents) and file a reference issue; do not work
around it by weakening the compact default.

## Troubleshooting

- **Stale tool surface (wrong tool list or missing `detail`/`stream`
  inputs):** External MCP hosts (ChatGPT,
  Claude, and similar) cache the tool surface at registration time and do not
  poll PDPP for changes. This is an external host cache reality — PDPP cannot
  force the client to refresh a cached registration. The reference server
  publishes the current tool surface version via the MCP `initialize`
  `serverVersion` field on every connection, but the client may not act on it.
  **Fix:** delete the PDPP connector from the MCP client and re-add it pointing
  at the same `<PDPP_REFERENCE_ORIGIN>/mcp` URL, then complete the OAuth grant.
  The client fetches the current tool surface on re-add. Do not conclude the
  server is broken just because a client shows an old tool list.
- `Unsupported grant_types metadata values: refresh_token`: the deployment is
  running an old reference image. Update the reference service to a revision
  that advertises `refresh_token` in authorization-server metadata.
- `No streaming target registered for this run`: that belongs to connector
  browser streaming, not hosted MCP. Hosted MCP reads already-collected records.
- `401` from `/mcp`: fetch the advertised resource metadata, reconnect the MCP
  client, and redo OAuth or device authorization for `<origin>/mcp`. If the
  client cached an old registration, delete and re-add the connector. Do not use
  an owner bearer.
- `403` from `/mcp`: the bearer is valid but not a grant-scoped PDPP client
  bearer for this MCP resource. Trusted owner-agent bearers are REST
  credentials and are rejected by `/mcp` on purpose.

## Event subscriptions

Event-subscription management is not part of the normal `/mcp` tool surface.
The operator console surfaces every subscription on the deployment at
`/dashboard/event-subscriptions` with a read-only list, a peek pane, and one
safety-valve disable.

See [`docs/operator/event-subscriptions.md`](event-subscriptions.md) for the
operator console walkthrough and the local test receiver that completes the
Standard Webhooks handshake without a real client.
