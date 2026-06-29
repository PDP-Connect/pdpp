# Unify Read Evidence Surface

## Why

PDPP now exposes read paths through REST, CLI, MCP, and the owner console. The surfaces share the same underlying records and grants, but their evidence presentation, truncation, continuation handles, and display semantics can drift.

The MCP/ChatGPT Hyperlane investigation showed the failure mode: search can prove that matches exist, but a client still cannot answer correctly unless it receives compact evidence and a reliable path to inspect omitted content. The fix must not become MCP-only. The read/evidence model should be shared below MCP so CLI, REST projections, Explore, SDKs, and MCP adapters render the same core semantics.

## What Changes

- Add a shared read/evidence layer for evidence cards, continuation metadata, binary metadata, declared-role presentation, and no-dead-end truncation semantics.
- Keep RS/REST as the authorization and canonical query authority.
- Keep MCP, CLI, REST projections, and Explore as renderers/adapters over shared evidence concepts.
- Add CLI support for the existing field-window read path.
- Build on the `add-mcp-content-ladder` implementation once that prerequisite has landed in the active checkout; until then this change must treat `read_record_field`, MCP content ladders, and `pdpp://field-window/...` as prerequisite work, not current baseline.
- Migrate MCP evidence cards/content ladders to shared logic after the prerequisite exists in code.
- Add cross-surface parity and client-smoke gates.

## Capabilities

Modified:

- `mcp-adapter`
- `reference-implementation-architecture`

## Impact

- Affects MCP response shaping, CLI read commands, and shared reference implementation read helpers.
- Does not change grant authorization semantics.
- Does not make resources or `structuredContent` the only recovery path.
- Does not introduce connector-specific or field-name guessing presentation.
- Does not require a dashboard UI change in the first tranche.
- Depends on landing or importing `add-mcp-content-ladder` before MCP migration slices can claim parity with deployed ladder behavior.
