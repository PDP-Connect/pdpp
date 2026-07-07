## Why

Owner-triggered connector runs already resolve a concrete `connection_id`, but the runtime spine events record only the connector type in the source binding. When an owner has two active connections for the same connector, the connector-summary projection cannot safely attach a completed direct run to either connection. The owner-visible result is that "Sync now" can complete while the row still shows the older run and stale coverage.

## What Changes

- Stamp runtime-authored run events with the resolved `connection_id` / `connector_instance_id` in event data while preserving the public source object as `{ kind: "connector", id: <connector_id> }`.
- Project `connection_id` / `connector_instance_id` from run-correlation summaries for SQLite and Postgres.
- Add regression coverage for same-connector multi-account runs so a connector-wide fallback cannot mask missing connection identity.

## Capabilities

Modified:

- `reference-implementation-runtime`
- `reference-connector-instances`

## Impact

- Affects runtime event emission, spine run-summary projection, and connection summary evidence selection.
- Does not change public source identity or grant source binding semantics.
- Existing legacy connector-wide run summaries remain usable only through the existing singleton fallback.
