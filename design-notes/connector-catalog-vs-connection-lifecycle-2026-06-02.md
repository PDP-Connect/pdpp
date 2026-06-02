# Catalog connector vs connection lifecycle (zero-record "phantom" connections)

Status: decided-promote
Owner: RI worker lane `ri-zero-record-connection-lifecycle-v1`
Created: 2026-06-02
Updated: 2026-06-02
Related: `openspec/specs/reference-connector-instances/spec.md`, `openspec/specs/reference-implementation-architecture/spec.md` (Requirement: Reference connector catalog SHALL be complete for listed first-party manifests), archived `add-connector-public-listing-honesty`, archived `remove-legacy-connector-instances`

## Question

Why does a fresh reference instance show registered connections the owner never created (Notion, Oura, Strava, …) as zero-record "active connections," and what is the correct lifecycle distinction between a *catalog connector* (something you can add) and a *connection* (a source you configured)?

## Context

The owner's complaint — "why are there registered connections I do not use instead of just connectors to choose from?" — is a real conflation defect, not a seeding artifact or a UI projection glitch alone.

Root cause (proven, see report):
`reference-implementation/server/ref-control.ts` → `listConnectorInstanceRowsForDashboard()` (~lines 750-781). When the owner has **zero** active `connector_instances`, the dashboard read path calls `store.ensureDefaultAccountConnection(...)` for **every registered public connector**. `ensureDefaultAccountConnection` (`reference-implementation/server/stores/connector-instance-store.js` ~line 348) is an **`upsert`** — it **persists** a `status:'active'` row. So merely viewing the dashboard of a fresh instance writes ~14 durable `connector_instances` rows (one per `public_listing.listed:true` first-party manifest), each projected as an active connection with `total_records: 0`.

Two requirements collided to produce this:

1. **Catalog completeness** (`add-connector-public-listing-honesty`, now archived): every `listed:true` first-party manifest SHALL appear on `GET /_ref/connectors` on a fresh DB so the operator knows what they *can* connect. The change explicitly names `notion`, `oura`, `strava` as connectors auto-registered for catalog completeness. **This requirement is about the `connectors` table and catalog visibility — it does NOT ask for `connector_instances` rows.**

2. **Instance-scoped projection** (`remove-legacy-connector-instances`, now archived): the dashboard "projects exclusively from `connector_instances`." To make catalog connectors appear under that projection, someone wired the dashboard read to materialize default-account instance rows for the whole catalog when no real ones exist.

The legitimate default-account materialization is **demand-driven at ingest/resolution time** (`connection-identity.js` ~line 214; `connector-instance-store.js` `resolveNamespace` with `allowDefaultAccount: true` ~line 285): a connection row is created when data actually resolves for that connector. The dashboard read is the **only** production path that proactively fans the materialization across the entire catalog with no data trigger.

Blast radius (audited): the persisted phantom rows are read by every owner-connections surface (`owner-connections.ts`, `owner-connector-templates.ts`, `ref-connectors.ts` `/_ref/connections` + `/_ref/connector-instances`, `ref-device-exporters.ts`) and — highest risk — by the grant fan-in resolver (`connection-identity.js` `listActiveByConnector`, SQL `WHERE status='active'`). A grant that names a `connector_id` without pinning a `connector_instance_id` can resolve to a phantom default-account binding.

## Stakes

- **Honesty / SLVP**: the console presents catalog connectors as connections the owner created. That is precisely the "hosted-service drift" and connector over-claim the voice guide warns against.
- **Durable state**: a *read* endpoint mutates durable state. No spec authorizes the dashboard read to create connections.
- **Grant safety**: phantom active rows participate in grant resolution fan-in.
- **Lifecycle clarity**: the system has no first-class representation of "available connector, not yet connected" distinct from "connection with no data yet."

## Lifecycle distinction (recommended SLVP)

| State | Identity | Durable row? | Meaning | Owner action |
| --- | --- | --- | --- | --- |
| **Catalog connector** | `connector_id` (manifest, `public_listing.listed:true`) | `connectors` table only — **no `connector_instances` row** | A connector you *can* add | Add connection |
| **Draft / pending enrollment** | `connector_instance_id` | `connector_instances`, `status` reflecting pending capture (e.g. local-collector enrolled but no first ingest, static-secret awaiting capture) | A connection you started but that has not collected yet | Complete capture / wait for first ingest |
| **Active connection** | `connector_instance_id` | `connector_instances`, `status:'active'`, has records OR in-flight run OR attention | A working connection | Sync, pause, inspect, revoke, delete |
| **Revoked connection** | `connector_instance_id` | `connector_instances`, `status:'revoked'` | Stopped collecting; records retained under grant/retention rules | Re-initiate (explicit) |
| **Deleted connection** | (gone) | row removed (delete cascade) | Erased; audit spine survives | — |

The defect is that "catalog connector" is currently materialized straight into "active connection," skipping the distinction entirely.

## Current Leaning

Two-part fix; part A is the safe core, part B is the contract/UX shape that needs owner sign-off.

**A. Stop the dashboard read from persisting catalog connectors as connections (core fix).**
`listConnectorInstanceRowsForDashboard` must NOT `upsert` default-account rows. Catalog completeness is owned by the `connectors` table + `GET /_ref/connectors`, not by `connector_instances`. The dashboard should project from the connectors table for catalog visibility WITHOUT writing instance rows. This removes the durable phantom rows and the grant-resolution leak at the source. A *read* must not mutate durable state.

**B. Give the catalog vs connection distinction a first-class projection shape (owner decision).**
Decide how a catalog-only connector appears to the owner:
  - Option B1: the connections list shows ONLY real connections; catalog connectors live in a separate "Add a connection" / available-connectors surface. (Cleanest; matches the owner's mental model "connectors to choose from".)
  - Option B2: `listConnectorSummaries` keeps emitting one row per catalog connector but flags it `is_catalog_only: true` (or `connection_state: "not_connected"`) with no `connector_instance_id`, and the console renders those as "Available — not connected" with an Add action instead of Sync/pause/revoke.

Either way, "Sync now" / pause / revoke / delete SHALL NOT be offered for a catalog connector that has no connection. Action routes already resolve with `allowDefaultAccount: false`, so they correctly refuse a non-existent instance — the UI must stop offering those actions on catalog-only entries.

The catalog-completeness test (`connector-public-catalog-completeness.test.js`) asserts only that each `listed:true` `connector_id` is visible via `listConnectorSummaries()`; it does not assert a `connector_instance_id`. So part A can preserve that test by projecting catalog rows without persistence.

## Promotion Trigger

This changes a reference contract (the `listConnectorSummaries` / `_ref/connections` shape and the durable-state side effect of a read), an architecture boundary (catalog vs connection), and a grant-resolution input. It must be promoted to an OpenSpec change before the projection shape (part B) is implemented. Part A (remove the read-time persistence) is a defect fix that the OpenSpec change should also record so the catalog-vs-connection invariant is auditable.

## Decision Log

- 2026-06-02: Captured + investigated + promoted. Root cause proven by repro; blast radius audited; lifecycle table recommended. Promoting to OpenSpec change `separate-connector-catalog-from-connections`. Worker did NOT flip grant-affecting runtime code without owner review (lane constraint #4: do not fake a runtime fix).
