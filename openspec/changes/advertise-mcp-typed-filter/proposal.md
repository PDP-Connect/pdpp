## Why

Chat-hosted MCP clients build tool calls from the advertised JSON Schema. A top-level object/string union for `filter` can collapse to `filter?: string`, leaving clients unable to send typed filter objects even though the resource server prefers them.

## What Changes

- Advertise MCP `filter` inputs as typed object records for read tools that support filters.
- Preserve legacy literal bracket filter strings at runtime for existing MCP clients.
- Add schema and legacy-compatibility tests.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `mcp-adapter`: read tools advertise typed filter objects instead of a top-level object/string union.

## Impact

- Affected package: `packages/mcp-server`.
- No REST contract changes, routes, storage changes, or dependency changes.
