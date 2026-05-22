# Retained Size And Data Explorer Substrate

Status: researching
Owner: reference implementation owner
Created: 2026-05-22
Updated: 2026-05-22
Related: openspec/changes/complete-postgres-runtime-boundary, openspec/changes/add-dashboard-summary-read-model, design-notes/full-context-refresh.md

## Question

What retained-size and exploration substrate should the reference
implementation build so an owner can eventually explore the shape and size of
their data smoothly, without raw corpus scans or incidental dashboard-specific
queries?

## Context

The dashboard currently needs global retained-record totals and per-connection
retained-size breakdowns. The live Postgres deployment exposed two related
problems:

- global summaries were previously stale because they read a SQLite projection
  in Postgres mode;
- after the correctness stopgap, global and connection summaries can still be
  slow because they aggregate large Postgres tables on the request path.

The owner also wants it to be straightforward to build a future data explorer:
not only "how big is the dataset?", but "which connections, streams, blobs,
record families, or records account for this size?".

## Stakes

This is reference-implementation/operator-console work, not PDPP Core. It must
not leak collection or storage mechanics into grant/disclosure semantics. It
does matter for SLVP quality because a personal server with millions of records
needs honest, fast, explainable operator introspection.

The wrong answer is an ad hoc dashboard query per view. That would reproduce
the current problem: accurate enough at small scale, slow and hard to trust at
real scale. The right answer should make future UI work mostly a matter of
presentation over bounded, well-named read models.

## Current Leaning

Build a retained-size read model as a narrow extension of the dataset-summary
projection:

- keep canonical records, record changes, blobs, and manifests as the source of
  truth;
- maintain derived aggregate rows incrementally where cheap and mark rows dirty
  where exact maintenance is unsafe;
- rebuild or reconcile from canonical Postgres state without connector reruns;
- report freshness/staleness/error metadata for every aggregate family that can
  be stale;
- expose bounded reference-only `_ref` reads that future dashboard/data
  explorer views can consume.

The minimum useful grain set is:

- global dataset;
- connection (`connector_instance_id`);
- stream (`connector_instance_id`, `stream`);
- retention class (`current_record_json`, `record_history_json`, `blob`);
- optional top-N heavy hitters for blobs, records, streams, and connections.

Do not build a generic BI engine, arbitrary group-by system, or full data
explorer UI now. The substrate should make those possible later.

## Prior Art Findings

- PostgreSQL materialized views persist derived query results and are refreshed
  from source tables. They are useful as the read-model analogy, but plain
  refresh replaces the contents by re-running the backing query, so the
  reference should prefer explicit incremental projection hooks plus bounded
  rebuild/reconcile for hot dashboard paths.
- BigQuery `INFORMATION_SCHEMA.TABLE_STORAGE` distinguishes current snapshots
  of storage usage from billing over time, and breaks out byte categories such
  as active, long-term, time-travel, physical, and logical bytes. PDPP should
  similarly label `current`, `history`, and `blob` bytes rather than presenting
  one opaque total.
- Datadog facets/measures separate qualitative dimensions from quantitative
  measures and attach units such as bytes to measures. PDPP should treat
  retained size as a typed measure and connections/streams/source kinds as
  dimensions.
- Elastic/Kibana Discover field statistics show the value of field-level
  summaries, top values, distributions, cardinality, and examples before a user
  builds visualizations. PDPP should not implement field stats now, but the
  future data explorer should have an analogous "understand this slice" mode.
- Metabase drill-through shows the interaction pattern to preserve: click a
  number or chart segment, then zoom in, view composing records, break out by a
  dimension, or auto-explain the slice. PDPP's substrate should make "show me
  the records/blobs/streams behind this number" straightforward.

## Design Implications

Retained size needs explicit semantics:

- `current_record_json_bytes`: current non-deleted record JSON retained by the
  server;
- `record_history_json_bytes`: retained historical versions and tombstone
  evidence in `record_changes`;
- `blob_bytes`: content-addressed blob payload bytes retained by the server;
- `total_retained_bytes`: sum of the above categories for the same grain;
- `record_count`: current non-deleted records, not historical versions;
- `blob_count`: retained blobs or blob bindings, labeled clearly;
- `freshness`: projection state and timestamp, not data-source freshness.

Useful drill dimensions should be finite and authored by the system/manifest,
not arbitrary JSON paths by default:

- connection;
- connector type;
- source kind, such as remote connector or local device;
- stream;
- retention class;
- time bucket based on emitted time or manifest-declared record time;
- optional connector-authored record family where a connector can classify
  records without inspecting arbitrary raw payloads on every query.

Future field-level exploration should be a separate capability. It needs
sampling/cardinality/top-value privacy decisions and should not be smuggled
into the retained-size projection.

## Promotion Trigger

Promote this into OpenSpec before implementing:

- new retained-size projection tables;
- new `_ref` retained-size/data-explorer endpoints;
- dashboard UX that depends on connection/stream/top-N retained-size rows;
- field-level statistics, record-family classification, or query-builder
  semantics.

## Decision Log

- 2026-05-22: Captured after the live dashboard summary proved accurate but
  slow on Postgres raw aggregation. Current leaning: extend the active-backend
  dataset-summary projection into a retained-size read model with global,
  connection, stream, retention-class, freshness, and top-N heavy-hitter
  support; defer UI and arbitrary field exploration.
