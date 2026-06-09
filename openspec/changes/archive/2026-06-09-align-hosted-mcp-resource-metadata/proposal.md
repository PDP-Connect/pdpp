## Why

Claude's hosted MCP OAuth flow can fail after token issuance when the reference `/mcp` 401 challenge advertises provider-root protected resource metadata instead of the path-specific MCP protected resource metadata. That split is avoidable friction at the OAuth/MCP boundary.

## What Changes

- Align hosted MCP 401 challenges with the path-specific hosted MCP protected-resource metadata URL.
- Keep the provider-root protected resource metadata document available for non-MCP clients.
- Add regression coverage for the challenge URL and hosted MCP token-kind advertisement.

## Capabilities

Modified:
- `mcp-adapter`

## Impact

- Hosted MCP clients receive a resource identity that matches the mounted MCP endpoint.
- Existing `/mcp` endpoint and package-token enforcement remain unchanged.
