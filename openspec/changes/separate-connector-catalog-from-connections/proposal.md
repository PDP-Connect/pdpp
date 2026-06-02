# Separate connector catalog from connections

## Why

A fresh reference instance shows registered "connections" the owner never created — Notion, Oura, Strava, and every other `public_listing.listed: true` first-party connector — each as a zero-record active connection. The owner asked why they have connections they do not use instead of connectors to choose from.

Root cause: the dashboard read path `listConnectorInstanceRowsForDashboard` (`reference-implementation/server/ref-control.ts`) materializes a default-account `connector_instances` row for every registered public connector whenever the owner has zero active connections, via `ensureDefaultAccountConnection`, which is an `upsert`. A read endpoint thereby persists durable connection rows the owner never created. Those phantom `status: 'active'` rows then surface on every owner-connections surface and participate in grant fan-in resolution (`connection-identity.js` `listActiveByConnector`).

This conflates two distinct concepts the reference already names elsewhere: a **catalog connector** (a `connector_id` you can add, owned by the `connectors` table) versus a **connection** (a `connector_instance_id` you configured). The catalog-completeness honesty contract (`Reference connector catalog SHALL be complete for listed first-party manifests`) is about catalog visibility on `GET /_ref/connectors`; it does not require — and should not produce — `connector_instances` rows.

## What Changes

- A reference-side **read** SHALL NOT create, upsert, or persist a `connector_instances` row. The dashboard catalog projection SHALL stop calling `ensureDefaultAccountConnection` for the registered connector set. Default-account connection materialization remains demand-driven at ingest/resolution time only.
- The reference SHALL distinguish a catalog connector (registered, no connection) from a connection (a `connector_instance_id`). An owner with zero configured connections SHALL see zero connections, and the catalog of addable connectors SHALL remain complete.
- The owner-facing connection projection (`listConnectorSummaries` / `_ref/connections`) SHALL list only configured connections — rows backed by a real `connector_instance_id`. A connector that has no connection SHALL NOT be synthesized into the connection projection (neither as an active connection nor as a placeholder row); it remains a catalog connector discoverable through the connector catalog (the registered `connectors` table and the add-connection surface). Because a catalog connector with no connection is absent from the connection projection, owner connection actions (sync, pause, resume, revoke, delete) are not offered for it.
- Catalog completeness on a fresh database is preserved: every `listed: true` first-party manifest remains visible on `GET /_ref/connectors`, sourced from the `connectors` table, without a `connector_instances` row.

## Capabilities

### Modified Capabilities

- `reference-connector-instances` — adds normative requirements that a read SHALL NOT persist connection rows, and that catalog connectors are distinct from connections in owner projections.
- `reference-implementation-architecture` — clarifies that catalog completeness is satisfied by the `connectors` table and `GET /_ref/connectors`, independent of `connector_instances`.

## Impact

- A fresh reference instance shows an honest empty connections list plus a complete catalog of addable connectors, instead of ~14 phantom zero-record connections.
- Removes a durable-state side effect from a read path and removes phantom active rows from grant fan-in resolution.
- `notion`, `oura`, `strava` (and the other listed connectors) remain visible in the catalog; they no longer appear as connections until the owner adds one or ingest materializes one.
- No PDPP protocol contract change. The `_ref` / owner-connections surface now lists only real connections; clients reading real connections are unaffected, and the previously-fabricated zero-record catalog rows no longer appear. Catalog discovery moves to the connector catalog surface (registered `connectors` table projection + add-connection picker), independent of `connector_instances`.
- The catalog-completeness regression test (`connector-public-catalog-completeness.test.js`) continues to pass because it asserts `connector_id` visibility, not a `connector_instance_id`.
