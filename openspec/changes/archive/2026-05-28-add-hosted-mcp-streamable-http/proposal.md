## Why

PDPP now has a local stdio MCP adapter for Claude/Codex-style clients, but ChatGPT and other modern hosted MCP clients need a public remote MCP endpoint plus an OAuth web authorization flow. The reference implementation should make already-authorized personal data available through MCP without bypassing grants, leaking owner credentials, or turning connector/runtime machinery into protocol semantics.

## What Changes

- Add a hosted Streamable HTTP MCP endpoint at `/mcp` that reuses the `@pdpp/mcp-server` tool surface.
- Keep the endpoint read-only and grant-scoped: every request uses a client bearer token that the RS already enforces.
- Add ChatGPT-compatible `search`/`fetch` behavior while preserving PDPP-native tools for schema, stream listing, record querying, and blob fetches.
- Add OAuth `authorization_code` + PKCE support for public remote MCP clients, reusing the existing pending-consent and grant issuance model.
- Advertise hosted MCP and OAuth code support in reference metadata using public-origin-safe URLs.
- Preserve local stdio MCP for Claude/Codex and keep owner/control-plane operations out of MCP.

## Capabilities

### Added Capabilities

- `mcp-adapter`: Hosted Streamable HTTP MCP endpoint and ChatGPT-compatible read-only search/fetch facade.

### Modified Capabilities

- `reference-implementation-architecture`: Adds OAuth authorization-code/PKCE support and metadata needed for hosted MCP clients.

## Impact

- Updates `packages/mcp-server` to support both stdio and hosted Streamable HTTP transport.
- Updates reference AS/RS routes and metadata for `/mcp`, `/oauth/authorize`, OAuth code exchange, and dynamic registration metadata.
- Adds a small OAuth authorization-code persistence surface for short-lived, single-use PKCE-bound codes.
- Adds package and reference tests for transport, authorization, metadata, and token-boundary behavior.
- Does not change PDPP Core record/query semantics, connector runs, local collectors, schedules, or owner-control APIs.
