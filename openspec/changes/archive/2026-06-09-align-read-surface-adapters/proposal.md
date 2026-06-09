## Why

The MCP battery fixed the normal agent read journey, but MCP is only one
implementation of the public read surface. The reference needs an explicit
architecture boundary so REST remains the canonical contract and MCP/CLI cannot
grow stronger, divergent query semantics through duplicated adapter code.

## What Changes

- Define the SLVP ideal for the read surface across REST, MCP, and CLI:
  canonical semantics live in resource-server operations and shared transforms;
  adapters only translate transport, validation shape, authentication cache, and
  presentation.
- Require schema discovery, source disambiguation, projection, search fan-in,
  pagination, counts, warnings, and typed errors to be implemented once and
  consumed by every public read adapter.
- Align CLI read commands with the canonical discovery loop instead of leaving
  MCP as the only polished agent-facing path.
- Extend the read-surface smoke/battery so REST, MCP, and CLI are verified
  against the same behavior matrix.
- Preserve protocol-specific presentation differences, including MCP
  `content[]` summaries and document-shaped `fetch`, only where the transport
  requires them.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `reference-implementation-architecture`: public read behavior is owned by
  canonical operations/shared transforms; REST, MCP, and CLI are adapters over
  that substrate and SHALL NOT duplicate read semantics.
- `reference-agent-access-workflow`: CLI-first and MCP-first agent setup paths
  use the same canonical discovery/read loop, with CLI exposing the same
  source-scoped schema navigation needed by broad grant packages.

## Impact

- Affects `reference-implementation/operations/rs-*`,
  `reference-implementation/server/routes/rs-read.ts`, and package-level
  fan-in/read-client helpers where canonical read behavior is currently split.
- Affects `packages/mcp-server` only to remove adapter-local semantics or keep
  MCP-only presentation wrappers clearly isolated.
- Affects `packages/cli/src/read` so CLI exposes canonical schema scoping and
  avoids deprecated selector vocabulary in recommended commands.
- Affects `scripts/read-surface-smoke.mjs` and related tests by adding
  cross-surface parity checks.
- No PDPP Core or Collection Profile change.
