## Context

The `define-connector-instances` change introduced the right durable identity: a configured source is a connection, implemented as a `connector_instance_id`. During migration, the reference created connector-only fallback rows using `source_kind = "legacy"`, `source_binding.kind = "legacy_default"`, and ids prefixed with `cin_legacy_`.

That bridge has outlived its usefulness. It is now visible in operator and consent flows, and it creates a second conceptual model for "the default connection" that does not describe a real source binding.

## Decision

Use a single construction for connector-only defaults:

- `source_kind = "account"`
- `source_binding_key = "default"`
- `source_binding = { "kind": "default_account" }`
- `connector_instance_id = cin_<hash(owner, connector_id, "account", "default")>`

This is deliberately not a new `default` source kind. A default connector-only binding represents the owner-configured account/source for connectors that do not yet have richer account metadata. Local-device connectors that have real device bindings continue to use `source_kind = "local_device"` and device-specific bindings.

## Migration Shape

Fresh schemas SHALL reject `source_kind = "legacy"`.

Existing rows with `source_kind = "legacy"` SHALL be rewritten to the deterministic default account connection. The migration SHALL update direct `connector_instance_id` columns in the reference storage tables before deleting or rewriting the old connector instance row.

If a destination default account row already exists, the migration SHALL move references from the old id to the destination id and remove the old row. If uniqueness constraints would make that merge ambiguous, the migration should fail rather than silently discard data.

Historical uses of "legacy" that refer to unrelated external formats, old browser/CDP env vars, CLI aliases, or parser compatibility are out of scope.

## Alternatives Considered

- Keep `cin_legacy_*` ids and only relabel `source_kind`: rejected because the owner-facing id still exposes compatibility history and keeps grant/connection debugging confusing.
- Add a new `default` source kind: rejected because it encodes implementation incompleteness rather than a real source binding class.
- Hide legacy rows in the dashboard only: rejected because MCP grants, `_ref` APIs, and migrations would still carry the old model.

## Acceptance Checks

- Fresh SQLite and Postgres schemas no longer admit `source_kind = "legacy"`.
- Existing SQLite and Postgres databases with legacy rows are migrated to deterministic default account connections.
- Direct reference tables that carry `connector_instance_id` point to the migrated id.
- `_ref/connections`, `/dashboard/records`, and hosted MCP consent projections no longer show `source_kind = "legacy"` or `cin_legacy_*` for migrated default connections.
- `rg` confirms no connector-instance helper or production code path creates legacy connector instances.
