## Why

Claude Code's MCP OAuth client metadata publishes loopback redirect URIs without
a port, then uses a runtime-selected localhost port during authorization. The
reference currently requires literal redirect URI equality at authorization time,
which rejects this standards-shaped native client flow.

## What Changes

- Treat RFC 8252 native loopback redirect matching as exact except for the port.
- Keep exact matching for all non-loopback redirects.
- Keep path and query matching strict for loopback redirects.
- Keep token exchange bound to the exact redirect URI used in the authorization
  request.

## Capabilities

Modified:
- `reference-agent-access-workflow`

## Impact

- Affects hosted MCP OAuth authorization-code setup for native clients whose
  metadata uses portless loopback callbacks.
- Does not widen web-client redirect matching.
- Does not add Claude-specific client-id handling.
