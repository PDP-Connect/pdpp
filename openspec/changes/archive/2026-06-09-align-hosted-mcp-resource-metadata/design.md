## Decision

The hosted MCP HTTP boundary uses the path-specific MCP endpoint as the OAuth resource identity. Anonymous `/mcp` requests SHALL challenge with the hosted MCP protected-resource metadata URL at `/.well-known/oauth-protected-resource/mcp`.

The provider-root metadata document remains served at `/.well-known/oauth-protected-resource` for non-MCP clients. Hosted MCP challenges do not use it because Claude live testing showed OAuth could complete but the client could still fail before attaching the connected server when the challenge pointed at provider-root metadata.

## Rationale

Claude's observed authorization request can use a provider-origin resource while the server itself is mounted at `/mcp`. The earlier provider-root challenge was intended to keep one resource identity, but live evidence after deployment showed Claude successfully created an active package grant and active `mcp_package` tokens, then failed before using the connected MCP server. That makes the path-specific MCP resource the safer interoperability default for the challenged `/mcp` surface.

Using path-specific metadata in the `/mcp` challenge matches the mounted MCP endpoint, keeps the well-known resource document self-consistent (`resource = <origin>/mcp`), and is the smallest reversible rollback from the failed Claude attempt.

## Alternatives

- Challenge with provider-root metadata. Rejected because Claude live testing completed OAuth but still failed to attach/use the server after that behavior shipped.
- Remove provider-root metadata. Rejected because non-MCP clients use the provider protected-resource metadata document.
- Accept both identities only server-side. Insufficient because the failing host may validate discovery and resource identity before sending authenticated MCP requests.

## Acceptance Checks

- Anonymous `/mcp` returns `401` with `WWW-Authenticate` pointing at `/.well-known/oauth-protected-resource/mcp`.
- The JSON error body reports the same metadata URL.
- `/.well-known/oauth-protected-resource/mcp` remains available and advertises hosted MCP token kinds.
- Hosted MCP still rejects owner bearers and accepts grant-scoped client/package bearers.
