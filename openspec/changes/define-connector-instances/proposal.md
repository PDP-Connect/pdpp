## Why

The reference implementation is approaching real multi-account and multi-device collection, where a single `connector_id` can represent two Gmail accounts or the same Claude/Codex connector running on multiple devices. Treating `connector_id` as the durable state, record, schedule, lease, and UX key would create silent collisions and make ownership/debugging ambiguous.

## What Changes

- Introduce first-class connector instances as the durable runtime identity for a configured connector binding.
- Require connector state, records, schedules, active-run leases, diagnostics, and owner UX to key by connector instance rather than by `connector_id` alone.
- Define migration expectations from existing connector-only rows into single-instance rows per owner/connector.
- Preserve `connector_id` as connector type identity for manifests, code lookup, source descriptors, and compatibility labels.
- Implement a first substrate tranche for the connector instance registry and connector-only compatibility resolver without moving state, records, schedules, leases, or dashboard UX yet.

## Capabilities

### New Capabilities
- `reference-connector-instances`: Defines reference-owned connector instance identity, isolation, migration, and owner-facing semantics.

### Modified Capabilities
- `reference-implementation-architecture`: Clarifies that multi-connector orchestration must use instance-scoped runtime identity rather than connector-type-only keys.

## Impact

- Affects future reference runtime storage schemas for connector state, records, schedules, active-run leases, diagnostics, and dashboard views.
- Affects future local collector/device exporter enrollment and ingest by requiring device/source bindings to resolve to connector instances.
- Does not change PDPP Core semantics or public protocol routes in this tranche.
