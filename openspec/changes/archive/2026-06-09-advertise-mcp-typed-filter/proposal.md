## Why

Chat-hosted MCP clients build tool calls from the advertised JSON Schema. MCP tool inputs are object-root JSON payloads; exposing `filter` as an object/string union or as a raw query string makes structured filters hard for clients to construct and easy to misroute into a bare REST `filter=` parameter.

## What Changes

- Advertise MCP `filter` inputs as typed object records for read tools that support filters.
- Reject string filters at the MCP input boundary; bracket query syntax remains an internal REST encoding detail.
- Add schema and validation tests.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `mcp-adapter`: read tools advertise typed filter objects instead of a top-level object/string union.

## Impact

- Affected package: `packages/mcp-server`.
- No REST contract changes, routes, storage changes, or dependency changes.
