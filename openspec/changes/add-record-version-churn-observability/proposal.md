## Why

The reference implementation fixed a Postgres no-op bug and a Codex forked-session bug only after ad-hoc SQL exposed extreme `record_changes` churn. That is not an SLVP operating posture: future adapter or connector regressions should be visible through a bounded owner/operator read, not discovered by manual database spelunking after storage growth becomes suspicious.

## What Changes

- Add reference-only version/churn observability over retained record history.
- Expose owner-only rows per `(connector_instance_id, stream)` with current record count, history version count, versions-per-record, recent write time, and simple risk classification.
- Keep this read derived from durable reference state and bounded by grouped rows rather than raw record payload scans.
- Do not add content-hash columns, automatic compaction, cross-connection dedupe, source-evidence fields, or a general cursor-vs-record reconciler.

## Capabilities

Modified:

- `reference-implementation-architecture`

## Impact

- Affects reference-only `_ref` reads, operator dashboard data, and route documentation.
- Does not change PDPP Core, Collection Profile messages, grants, `/v1` resource-server responses, connector manifests, or record storage schema.
- Historical compaction remains a separate owner-approved retention operation.
