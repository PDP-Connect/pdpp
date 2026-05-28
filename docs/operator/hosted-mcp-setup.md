# Hosted MCP Setup

This runbook connects a self-hosted PDPP reference deployment to MCP clients
that support remote Streamable HTTP MCP servers.

If you do not yet have a reachable self-hosted deployment, start with the
[self-host quickstart](selfhost-quickstart.md). Come back here once
`/dashboard/deployment` reports healthy.

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

Use this URL in every MCP client setup step below — not `pdpp.vivid.fish/mcp`,
which is the Vana development deployment and only serves data collected there.

## ChatGPT

1. Open ChatGPT connector creation.
2. Choose a custom MCP connector.
3. Set the MCP server URL to `<PDPP_REFERENCE_ORIGIN>/mcp`.
4. Choose OAuth authentication.
5. Complete connector registration and sign in to the PDPP owner dashboard when redirected.
6. Select the PDPP source the connector should read and approve the grant.
7. Return to ChatGPT and finish connecting the connector.

The reference authorization server supports dynamic client registration for
public OAuth clients using `authorization_code` with PKCE and `refresh_token`.
The refresh token is bound to the approved PDPP grant; it does not expose owner
dashboard credentials or operator/admin control.

## Claude

Claude products expose remote MCP configuration in different places depending
on product and account tier. Use your server URL:

```text
<PDPP_REFERENCE_ORIGIN>/mcp
```

When the client offers authentication, choose OAuth and complete the PDPP owner
approval flow in the browser. The approved grant scopes the MCP server to the
selected PDPP source and read-only MCP tools.

Claude Code can also connect to remote MCP servers from a local terminal when
remote MCP OAuth is available in the installed version. Prefer the product's
current MCP setup command or settings UI and use the same URL above.

## Security Model

- `/mcp` accepts only PDPP client bearer tokens tied to an approved grant.
- Owner dashboard/session tokens are rejected by `/mcp`.
- Refresh tokens are accepted only at `/oauth/token`.
- Revoking the PDPP grant invalidates its access tokens and refresh tokens.
- The hosted MCP surface is read-only and does not run connectors, schedules,
  browser sessions, or operator-console actions.

## Trusted local agents (operator-side)

The owner-token path is a separate surface for the operator and for trusted
local agents that run on the operator's behalf — a CLI tool you wrote, a
backup script you run from your laptop, an agent like a personal assistant
that lives on a machine you control. It is not the route for ordinary MCP
clients.

Provision one from `/dashboard/deployment/tokens`:

1. Sign in to the operator dashboard at `/owner/login`.
2. Open the **Deployment → Tokens** page in the operator console
   (`/dashboard/deployment/tokens`).
3. Enter a token name that identifies the bearer (for example `local-cli`,
   `backup-script`, or the local agent's name).
4. Click **Issue token**. The dashboard registers a fresh OAuth client
   (RFC 7591), drives the device authorization flow under your signed-in
   owner session, and renders the bearer once. Copy it now — the dashboard
   does not store it.
5. The bearer is bound to that named client. Revoking the client (RFC 7592)
   from the same page cascade-revokes the bearer.

Use the bearer as `Authorization: Bearer …` against `/v1/*`. The owner
bearer is an explicitly broader credential than a PDPP grant; treat it as
operator-grade material, not something to paste into a third-party agent
session.

Ordinary MCP clients (Claude, ChatGPT, third-party agents) should keep
using the OAuth scoped-grant flow at `/mcp` described above. `/mcp` rejects
owner bearers on purpose.

## Troubleshooting

- `Unsupported grant_types metadata values: refresh_token`: the deployment is
  running an old reference image. Update the reference service to a revision
  that advertises `refresh_token` in authorization-server metadata.
- `No streaming target registered for this run`: that belongs to connector
  browser streaming, not hosted MCP. Hosted MCP reads already-collected records.
- `401` from `/mcp`: reconnect the MCP client or re-run OAuth approval.
- `403` from `/mcp`: the bearer is valid but not a PDPP client bearer for this
  MCP resource.

## Event subscriptions

The MCP adapter exposes tools for subscribing to record changes:
`create_event_subscription`, `list_event_subscriptions`,
`get_event_subscription`, `update_event_subscription`, `send_test_event`,
`delete_event_subscription`. The client retains lifecycle authority. The
operator console surfaces every subscription on the deployment at
`/dashboard/event-subscriptions` with a read-only list, a peek pane, and
one safety-valve disable.

See [`docs/operator/event-subscriptions.md`](event-subscriptions.md) for the
operator console walkthrough and the local test receiver that completes the
Standard Webhooks handshake without a real client.
