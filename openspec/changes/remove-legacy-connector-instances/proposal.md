## Why

Connector instances are now the durable configured-source identity, but the reference still creates and displays compatibility rows with `source_kind = "legacy"` and `cin_legacy_*` identifiers. That leaks migration history into owner UX, grant/connection disambiguation, and MCP consent surfaces.

## What Changes

- Replace legacy default connector instances with deterministic default account connections.
- Migrate existing `legacy` connector instance rows and every direct `connector_instance_id` reference to the new default connection ids.
- Remove `legacy` from accepted connector-instance source kinds and fresh database schemas.
- Rename compatibility helpers so new code describes default connections rather than legacy defaults.
- Keep unrelated historical uses of the word "legacy" intact.

## Capabilities

Modified:
- `reference-implementation-architecture`

## Impact

- Affected code: connector instance store, SQLite/Postgres schema migrations, reference dashboard/connection projections, and tests that seed default connector instances.
- Data migration: existing default rows and direct instance references are rewritten in place with no record loss.
- Public protocol impact: none; connector instance identity remains reference/runtime owner metadata.
