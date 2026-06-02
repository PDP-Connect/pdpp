## Context

See `design-notes/connector-catalog-vs-connection-lifecycle-2026-06-02.md` for the full investigation, repro, and blast-radius audit. Summary of the proven facts this design rests on:

- `listConnectorInstanceRowsForDashboard` (`ref-control.ts` ~750) calls `ensureDefaultAccountConnection` for every registered public connector when the owner has zero active instances. `ensureDefaultAccountConnection` (`connector-instance-store.js` ~348) is an `upsert` — it persists `status:'active'` rows.
- This is the only production path that proactively materializes default-account rows across the whole catalog. Ingest/resolution (`resolveNamespace` with `allowDefaultAccount: true`) materializes on demand, per-connector, when data actually resolves — that path is correct and stays.
- Phantom rows are read by `owner-connections.ts`, `owner-connector-templates.ts`, `ref-connectors.ts`, `ref-device-exporters.ts`, and the grant fan-in resolver `connection-identity.js` `listActiveByConnector` (SQL `WHERE status='active'`).
- The catalog-completeness contract (`reference-implementation-architecture` → "Reference connector catalog SHALL be complete for listed first-party manifests") is satisfied by the `connectors` table + `GET /_ref/connectors`; it says nothing about `connector_instances`.

## Decision

1. **A read never persists a connection.** Remove the `ensureDefaultAccountConnection` fan-out from `listConnectorInstanceRowsForDashboard`. The dashboard projects:
   - the real configured/ingest-materialized `connector_instances` rows (unchanged), AND
   - for each registered public connector with **no** connection, a **not-connected catalog entry** projected directly from the `connectors` table (manifest) with **no** `connector_instance_id`.

2. **Catalog entry shape.** A not-connected catalog entry in `listConnectorSummaries` / `_ref/connections` carries `connector_id`, `display_name`, `streams`, `manifest_version`, `total_records: 0`, and an explicit not-connected marker (`connection_state: "not_connected"` and `connector_instance_id: null` / absent `connection_id`). It SHALL NOT fabricate a `connector_instance_id`.

3. **Actions gate on connection identity.** The console offers Add (initiate enrollment) for a not-connected catalog entry. Sync / pause / resume / revoke / delete are offered only for entries with a real `connector_instance_id`. The action routes already resolve with `allowDefaultAccount: false`, so they correctly refuse a non-existent instance; this change removes the UI affordance that implied otherwise.

4. **Lifecycle states are explicit** (catalog connector → draft/pending → active → revoked → deleted), as tabulated in the design note. "Draft/pending" reuses existing pending shapes (local-collector enrolled awaiting first ingest; static-secret awaiting capture) — this change does not invent a new pending mechanism, it just stops treating "catalog connector" as "active connection."

## Alternatives Considered

- **Keep persisting but hide phantoms in the UI.** Rejected: a read still mutates durable state and the grant resolver still sees phantom active rows. The voice/honesty bar and the grant-safety risk both require removing the rows, not hiding them.
- **Persist phantoms but mark them with an `is_phantom` column and filter everywhere.** Rejected: spreads a filter obligation across every `listByOwner` caller and the grant resolver; one missed call site re-leaks. Not creating the row is strictly safer and simpler.
- **Drop catalog connectors from the dashboard entirely (show only real connections).** Viable and clean, but it would regress catalog discoverability and the `connector-public-catalog-completeness` contract unless the catalog moves to a dedicated "add connection" surface in the same change. Kept as an implementation option (B1 in the design note) for the console lane; the contract here only requires that catalog connectors are not represented as connections.

## Acceptance Checks

- On a fresh DB with registered listed connectors and zero owner connections, `listConnectorSummaries()` returns catalog entries with `connection_state: "not_connected"` and no `connector_instance_id`, and **no** `connector_instances` rows are written (assert `store.listByOwner(owner).length === 0` after the read).
- `connector-public-catalog-completeness.test.js` still passes (every `listed:true` `connector_id` visible).
- Grant fan-in resolution for a connector with no connection does not resolve to a phantom binding (it resolves to "no active connection" / fails closed, exactly as if the owner never connected).
- After the owner creates one real connection (or ingest materializes one), that connection appears as a connection; the remaining catalog connectors stay not-connected.
- `git diff --check` clean; focused console + reference projection tests pass.
