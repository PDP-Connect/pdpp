## Why

Live MCP and REST smoke coverage proved the backend read surface is healthy, but three non-reconnect issues remain:

- The CLI can cache and print scoped tokens, but cannot exercise grant-scoped reads.
- Hosted MCP package ambiguity can advertise children that later fail with grant authorization errors.
- Connector manifests must only expose aggregate probes that match declared capability metadata.

## What Changes

- Add CLI read commands for schema, streams, records, record detail, search, and aggregate using the existing scoped credential cache.
- Make hosted MCP package ambiguity/selection evidence distinguish usable children from children that return grant authorization failures.
- Keep integration smoke coverage aligned with REST, MCP, and CLI behavior.

## Capabilities

Modified:
- `reference-agent-access-workflow`
- `mcp-adapter`

## Impact

- Code: `packages/cli`, hosted MCP package adapter, read-surface smoke.
- Tests: CLI smoke/unit coverage and package adapter tests.
