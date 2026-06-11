## Why

Google Maps now has both a file/import path and an API-backed Data Portability path, and agent hosts still vary in how much MCP tool output they expose. The reference needs a durable rule for reusing stream definitions across acquisition paths without erasing source identity, and MCP search needs to put a usable fetch handle where clipped previews still show it.

## What Changes

- Define the reference construction rule for multipath collection: stream definitions may be reused across connectors and acquisition paths, but records remain scoped by `connection_id` / `connector_instance_id`.
- Allow multiple acquisition paths to populate one logical connection only when an explicit source-identity rule proves they are the same owner source; otherwise they remain separate connections that may share stream definitions.
- Require acquisition-path provenance to stay visible in run/coverage/source metadata without replacing disclosure identity.
- Harden MCP search text by surfacing a parseable first fetch handle before verbose source metadata, while keeping `structuredContent.results` canonical.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `reference-connector-instances`: codify reusable stream definitions across acquisition paths, plus the identity bar for coalescing paths under one connection.
- `mcp-adapter`: require model-visible search text to expose a first fetch handle before host-clipped metadata.

## Impact

- Affected code: `packages/mcp-server/src/tools.js`.
- Affected tests: MCP self-contained result-id/search-fetch tests.
- No database migration, REST contract change, provider OAuth change, or connector runtime implementation is required in this tranche.
