## Why

Claude's hosted MCP OAuth flow can authorize the provider resource origin while the reference `/mcp` 401 challenge advertises a path-specific protected resource. That split is avoidable friction at the OAuth/MCP boundary.

## What Changes

- Align hosted MCP 401 challenges with the canonical provider protected-resource metadata URL.
- Keep the hosted MCP metadata document available for clients that request the path-specific well-known URL directly.
- Add regression coverage for the challenge URL and hosted MCP token-kind advertisement.

## Capabilities

Modified:
- `mcp-adapter`

## Impact

- Hosted MCP clients receive a single canonical resource identity during the OAuth flow.
- Existing `/mcp` endpoint and package-token enforcement remain unchanged.
