## Why

PDPP already defines scoped disclosure through grants and the resource-server query API, but agent developers increasingly expect MCP as the local tool/resource surface. A PDPP MCP adapter lets agents consume already-authorized personal data without adding a new data plane, bypassing grants, or turning collection/runtime mechanics into protocol semantics.

## What Changes

- Add a new `@pdpp/mcp-server` package that runs a stdio MCP server for local agent clients.
- The adapter reads an existing scoped PDPP client token from the local `pdpp connect` credential cache and calls the existing resource-server endpoints.
- Expose a small read-only MCP surface: schema/tool discovery, stream listing, record queries, search, blob fetch, and a stream resource template.
- Refuse owner-token/default-admin access unless a future explicit owner-mode design is approved.
- Defer hosted Streamable HTTP MCP, grant issuance, connector execution, sampling, prompts, roots, subscriptions, and elicitation.

## Capabilities

### New Capabilities

- `mcp-adapter`: Local stdio MCP adapter for read-only, grant-scoped PDPP resource-server access.

### Modified Capabilities

- `reference-implementation-architecture`: Documents the package boundary and confirms the MCP adapter is an external client of the RS, not a new reference-server control plane.

## Impact

- Adds `packages/mcp-server` and workspace/package metadata.
- May reuse credential-cache helpers from `@pdpp/cli` or extract a small shared cache helper if needed.
- Adds MCP SDK dependency for the adapter package only.
- Adds package tests and an integration test proving MCP tool output matches direct RS responses under the same token.
- Does not change PDPP Core, Collection Profile, connector runtime, grants, AS routes, or RS wire semantics.
