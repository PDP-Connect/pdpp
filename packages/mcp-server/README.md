# @pdpp/mcp-server

Local stdio [Model Context Protocol](https://modelcontextprotocol.io/) adapter for read-only,
grant-scoped access to a [PDPP](https://pdpp.vivid.fish) resource server.

The adapter is a thin client of the PDPP resource server (RS). It does not run connectors,
issue grants, or replicate any RS authorization logic. Every data-bearing tool call is a
forwarded request to an existing `/v1/*` endpoint, authenticated with the scoped client
access token already cached by `pdpp connect`.

## What this is not

- **Not a hosted MCP server.** stdio only. A Streamable HTTP variant requires a separate
  OpenSpec change.
- **Not a grant-issuance surface.** If the cache is empty or the token is invalid, the
  adapter exits / surfaces an error directing the operator at `pdpp connect`.
- **Not an owner-mode bypass.** `PDPP_OWNER_TOKEN` and other owner credentials are
  refused by default.
- **Not a proxy.** Per-client consent and confused-deputy mitigations would be required
  before this package ever accepted MCP-client tokens; that is out of scope.

## Publication status

This package is a private workspace package (`"private": true`). It is consumed
in-repo by the agent skill and integration tests. Promoting it to a published
`@pdpp/mcp-server@beta` on npm requires a follow-up OpenSpec change under the
[package release policy](../../docs/package-release-policy.md) (manifest opt-in,
release-train wiring, and npm trusted-publisher bootstrap), matching the
precedent established for `@pdpp/cli` and `@pdpp/local-collector`.

## Install (local agent harness)

```jsonc
// claude_desktop_config.json (or equivalent)
{
  "mcpServers": {
    "pdpp": {
      "command": "npx",
      "args": ["-y", "@pdpp/mcp-server@beta", "--provider-url", "https://pdpp.example.com"]
    }
  }
}
```

Run `pdpp connect https://pdpp.example.com` first so a scoped client token is cached at
`.pdpp/clients/<host>.json`.

## CLI

```
pdpp-mcp-server --provider-url <url> [--cache-root <dir>] [--server-name <name>]
```

Flags can also come from environment variables: `PDPP_PROVIDER_URL`,
`PDPP_CACHE_ROOT`, `PDPP_MCP_SERVER_NAME`.

The adapter writes only MCP protocol messages to stdout. Diagnostics go to stderr.

## Tools

All tools are read-only and forward to existing RS endpoints under the scoped token.

| Tool | RS endpoint |
| --- | --- |
| `schema` | `GET /v1/schema` |
| `list_streams` | `GET /v1/streams` |
| `query_records` | `GET /v1/streams/{stream}/records` |
| `search` | `GET /v1/search` |
| `fetch_blob` | `GET /v1/blobs/{blob_id}` |

Plus one resource template: `pdpp://stream/{name}` → `GET /v1/streams/{name}`.

## Errors

Resource-server error responses (4xx/5xx including `invalid_token`, `insufficient_scope`,
`needs_broader_grant`, `invalid_cursor`) are surfaced as MCP `isError: true` results with
the original envelope preserved in `structuredContent.error`. The adapter does not retry
with broader credentials.
