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

For the live Vana development deployment, the MCP server URL is:

```text
https://pdpp.vivid.fish/mcp
```

## ChatGPT

1. Open ChatGPT connector creation.
2. Choose a custom MCP connector.
3. Set the MCP server URL to `https://pdpp.vivid.fish/mcp`.
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
on product and account tier. Use the same server URL:

```text
https://pdpp.vivid.fish/mcp
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

## Troubleshooting

- `Unsupported grant_types metadata values: refresh_token`: the deployment is
  running an old reference image. Update the reference service to a revision
  that advertises `refresh_token` in authorization-server metadata.
- `No streaming target registered for this run`: that belongs to connector
  browser streaming, not hosted MCP. Hosted MCP reads already-collected records.
- `401` from `/mcp`: reconnect the MCP client or re-run OAuth approval.
- `403` from `/mcp`: the bearer is valid but not a PDPP client bearer for this
  MCP resource.
