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

## Troubleshooting

- `Unsupported grant_types metadata values: refresh_token`: the deployment is
  running an old reference image. Update the reference service to a revision
  that advertises `refresh_token` in authorization-server metadata.
- `No streaming target registered for this run`: that belongs to connector
  browser streaming, not hosted MCP. Hosted MCP reads already-collected records.
- `401` from `/mcp`: reconnect the MCP client or re-run OAuth approval.
- `403` from `/mcp`: the bearer is valid but not a grant-scoped PDPP client
  bearer for this MCP resource. Trusted owner-agent bearers are REST
  credentials and are rejected by `/mcp` on purpose.

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
