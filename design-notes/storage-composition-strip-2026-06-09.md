# Storage Composition Strip

Status: captured
Owner: reference implementation owner
Created: 2026-06-09
Related: openspec/changes/surface-database-physical-footprint (design.md §Deferred items 1–2), packages/operator-ui/src/components/views/deployment-diagnostics-view.tsx, reference-implementation/server/deployment-diagnostics.ts

## Question

Should the deployment-diagnostics surface bucket the `top_relations[]` returned by `GET /_ref/deployment` into named categories (canonical / search-index / event-log / other) so the owner can see which subsystem owns what fraction of the physical on-disk footprint — and should a `reclaimable_bytes` estimate be added to `/_ref/records/version-stats`?

## Context

`surface-database-physical-footprint` landed `physical_bytes` (Postgres `pg_database_size`) and `top_relations[]` (`pg_total_relation_size` top-N) on `GET /_ref/deployment`. The live deployment shows:

- Physical footprint: ~22 GB (`pg_database_size('pdpp')`)
- Top relations: `semantic_search_blob` (~10.6 GB), `lexical_search_index` (~3.7 GB), `record_changes` (~3.3 GB), `records` (~2.8 GB), `spine_events` (~1.9 GB), and three smaller tables

This gives the headline size and the top drivers, but the operator still cannot immediately answer "how much of 22 GB is canonical records vs. search indexes vs. event log?" without mentally bucketing the relation list.

The change deferred two follow-up items:

1. **Storage composition strip (audit P1).** A UI grouping that buckets `top_relations[]` into named categories by table-name prefix — e.g., `semantic_search_*` → "Semantic index", `lexical_search_*` → "Lexical index", `record_changes` + `records` → "Canonical records", `spine_events` + `device_ingest_*` → "Event log", everything else → "Other". Code-only over the existing `top_relations[]` data; no new contract field needed.
2. **Compaction reclaimable-bytes estimate (audit P2b).** A `reclaimable_bytes` display field on `/_ref/records/version-stats` summing `octet_length(record_json)` over the removable-version set — i.e., versions whose disposition is removable. Must preserve `disposition_affects_thresholds: false`; this is a display-only read, not a gate or threshold mutation.

Both items are code-only UI derivations over data the contract already returns or already exposes on a separate endpoint. Neither requires a new wire field.

## Current Leaning

Implement the composition strip as a pure client-side `buildStorageFootprintModel` derivation in `packages/operator-ui/src/lib/storage-footprint.ts` (or similar), keyed on table-name prefixes. Ship it as part of the next `deployment-diagnostics-view.tsx` pass — no OpenSpec delta required because no new contract field is added.

For `reclaimable_bytes`: add it to the `/_ref/records/version-stats` response payload under the existing `disposition_affects_thresholds: false` display invariant. Requires a small server-side aggregate (`SUM(octet_length(record_json::text))` filtered to removable versions); scope to a separate OpenSpec change because it modifies the contract shape.

Both items are low-leverage and low-risk; neither affects health, scheduling, or collection semantics.

## Promotion Trigger

Promote the composition strip when the deployment-diagnostics view is next touched for any reason (no standalone lane needed). Promote the `reclaimable_bytes` estimate when a compaction or version-cleanup surface is next opened as an OpenSpec lane — include it as a contract addendum rather than a standalone change.

## Decision Log

- 2026-06-09: Captured as deferred items 1 and 2 from `surface-database-physical-footprint`. Both deferred to avoid scope creep on the P0 footprint landing. No owner decision outstanding — implement at next natural touch point.
