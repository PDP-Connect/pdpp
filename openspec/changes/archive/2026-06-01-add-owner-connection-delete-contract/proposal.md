## Why

`delete_connection` is the last destructive owner-agent control family still typed `unsupported` in the control catalog (`add-owner-agent-control-surface`, tasks 3.1d / 6.1d). Its sibling `revoke_connection` shipped (lane `ri-owner-revoke-durability-v1`) by reusing an existing connection-scoped soft-flip primitive; delete has no existing semantic to reuse. The connector-instance store has no delete method, and "delete a connection" is undefined: it could mean stop future collection, drop the configured row, erase collected records/history/blobs, drop device-source-instance bindings, drop the audit spine, or some combination. Advertising or implementing a destructive route before that cascade is specified would risk silent over-deletion (sibling connections, audit trail) or silent under-deletion (orphaned still-readable records), both of which the SLVP acceptance criteria forbid as faked success/failure.

This change defines the durable `delete_connection` contract — cascade semantics, invariants, typed errors, audit requirements, and acceptance tests — so a later implementation lane can land the route by construction. It is a spec/design change. It implements no destructive route; it makes a tiny no-runtime wording fix to the parent change's catalog reason so the parent stops describing delete as merely "needs a store method" and instead points at this specified cascade.

## What Changes

- Define `delete_connection` as a connection-scoped destructive operation distinct from `revoke_connection`, grant-package revoke, data-retention policy, and source/provider credential revocation. Delete = remove the configured connection AND erase its collected data, keyed strictly by one `connection_id`.
- Specify the exact cascade over the data model verified at this commit: `records`, `record_changes`, `version_counter`, `blobs`/blob bindings, lexical/semantic search indices (all keyed `connector_instance_id NOT NULL`), `connector_schedules` and `controller_active_runs` (PK `connector_instance_id`), `device_source_instances.connector_instance_id` (nullable soft-ref), and the `connector_instances` row itself.
- Specify what delete SHALL NOT touch: sibling connections, other devices, PDPP disclosure grants, and the `spine_events` audit trail (which has no `connector_instance_id` column and is the durable record that the deletion happened).
- Specify safety invariants: connection-scoped blast radius, explicit erasure (not implied), typed idempotency, typed foreign/unknown-connection behavior, default-account and local-device/browser-collector handling, and a no-silent-resurrection guard so a deleted default-account connection cannot re-materialize through `ensureDefaultAccountConnection` on the next owner read.
- Add a normative store-level delete primitive contract (`deleteConnection(connectionId, …)`) and an owner-bearer route contract (`DELETE /v1/owner/connections/{connection_id}`), neither implemented in this change.
- Make a one-line no-runtime wording fix in `reference-implementation/server/metadata.ts`: update the `delete_connection` catalog `reason` to point at this specified cascade contract instead of stating only "no store method exists." Status stays `unsupported`; method/URL stay `null`; no route is added.

## Capabilities

### Modified Capabilities

- `reference-connector-instances`: Add normative connection-delete cascade and erasure semantics — what a connection delete removes, preserves, and how it interacts with default-account re-materialization.
- `reference-owner-agent-control-surface`: Add the owner-agent `delete_connection` action contract — typed, connection-scoped, idempotent, audited, and unsupported-until-implemented.

## Impact

- Affected specs: `openspec/specs/reference-connector-instances/spec.md`, `openspec/specs/reference-owner-agent-control-surface/spec.md` (via deltas in this change).
- Affected code (future lane only; not in this change): `reference-implementation/server/stores/connector-instance-store.js` (new `deleteConnection`), `server/records.js` (connection-scoped records purge), `server/queries/records/delete/*` (new by-instance-all-streams queries), `server/stores/device-exporter-store.js` (clear `connector_instance_id` soft-ref), a new `server/routes/owner-connection-delete.ts`, `server/metadata.ts` catalog flip, and `@pdpp/reference-contract` ops.
- One no-runtime wording fix in this change: `server/metadata.ts` `delete_connection` catalog reason.
- No breaking change to grant-scoped MCP or public read semantics. `/mcp` owner-bearer rejection is untouched.
