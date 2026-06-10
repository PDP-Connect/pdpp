## Why

Claude Code and Codex local collectors can now run successfully, but scheduled success only proves the declared streams ran. Real owner homes contain additional local stores and multiple devices can collide unless local collection has explicit completeness, privacy, and instance contracts before implementation.

## What Changes

- Define 100% local Claude/Codex collection as coverage of an approved per-tool source inventory, not just successful execution of declared streams.
- Add durable stream names and collection contracts for additional Claude Code and Codex local stores.
- Require explicit privacy/security exclusions for auth-adjacent files, raw caches, debug logs, backups, and other sensitive local state before collection.
- Require each local source home to bind to a connector instance so multiple devices and source homes do not collide.
- Add coverage diagnostics that report mounted-but-uncollected local stores without pretending they were collected.
- Keep implementation out of this change; this change defines the path and acceptance criteria.

## Capabilities

### New Capabilities

- `local-agent-collector-completeness`: Defines complete local Claude Code and Codex source inventory, stream contracts, exclusions, diagnostics, and multi-device assumptions.

### Modified Capabilities

- `reference-implementation-architecture`: Clarifies that local Claude/Codex collection completeness depends on connector-instance-scoped source homes and reference-only collector/runtime behavior.

## Impact

- Future `packages/polyfill-connectors` Claude Code and Codex manifests, stream emitters, source preflight, and tests.
- Future Docker/devcontainer/import-path wiring for multiple local source homes.
- Future reference scheduler, collector runner, ingest, diagnostics, and owner dashboard behavior.
- Future connector-instance migration work for local collector source bindings.
- No connector implementation changes in this lane.
