## Decision

The hosted MCP HTTP boundary uses the provider origin as the canonical OAuth resource identity. Anonymous `/mcp` requests SHALL challenge with the provider protected-resource metadata URL, not a `/mcp`-derived metadata URL.

The path-specific metadata document remains served at `/.well-known/oauth-protected-resource/mcp` because MCP clients may request a path-derived well-known URI. It advertises the hosted MCP endpoint and accepted token kinds, but the 401 challenge avoids switching resource identities mid-flow.

## Rationale

Claude's observed authorization request used `resource=https://pdpp.vivid.fish/` while the `/mcp` challenge returned metadata for `resource=https://pdpp.vivid.fish/mcp`. MCP authorization requires the `resource` parameter to identify the MCP server the client intends to use. A host that binds tokens strictly can treat the later `/mcp` challenge as a different resource and fail before retrying with the token.

Using one provider-origin resource identity is the smallest interoperable fix for the reference's composed AS/RS deployment. It avoids requiring chat hosts to discover and preserve a second resource identity for the same operator instance.

## Alternatives

- Require users to connect `https://host/mcp` instead of `https://host`: rejected for poor operator UX and because Claude already derived `/mcp` after authorizing the root resource.
- Accept both identities only server-side: insufficient because Claude failed before sending an authenticated MCP request.
- Remove the path-specific metadata document: rejected because MCP clients may construct that well-known URL for path-mounted servers.

## Acceptance Checks

- Anonymous `/mcp` returns `401` with `WWW-Authenticate` pointing at `/.well-known/oauth-protected-resource`.
- The JSON error body reports the same metadata URL.
- `/.well-known/oauth-protected-resource/mcp` remains available and advertises hosted MCP token kinds.
- Hosted MCP still rejects owner bearers and accepts grant-scoped client/package bearers.
