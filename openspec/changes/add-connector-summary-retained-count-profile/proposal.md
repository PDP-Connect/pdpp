## Why

Design review `add-source-perf-design-agy-0730.md` (independently corroborated
by Fable ruling `terminal-read-architecture-fable-0730.md` §2 R4/R5, §3 G2/G4)
found that Add Source's existing-connection discovery issued 33
`GET /_ref/connections?connector_id=` calls (one per registered catalog
connector type) plus one scoped full-summary `GET /_ref/connectors?connection=`
call per live connection to backfill `total_records`, `total_records_state`,
and `acquisition_coverage.latest_batch` — 53 reference requests at a measured
n=30 owner, with p50/p95 of 7.381s/7.871s. The existing single `connector_id`
summary filter cannot answer "does any of these N catalog connectors already
have a source" without the same 33-way fan-out; an unfiltered `limit=100`
page can omit a requested connector and turns a catalog question into a
full-fleet traversal.

The one-projection-N-profiles pattern already exists
(`includeRunSummaries`, `includeRetainedSizeSnapshot`, and the
`identity_inventory` named profile). This proposal adds:

1. A bounded repeated `connector_id` **set** scope on the existing
   `GET /_ref/connectors` paged route (1..100 canonical distinct ids per
   request, cursor bound to the set's canonical fingerprint), letting one
   exhausted traversal answer "every connection across these N catalog
   types," partitioned into disjoint ≤100-id scopes for a catalog larger than
   100 types.
2. A named `retained_count_summary` profile carrying exactly the three
   fields Add Source's existing-sources card renders, plus identity.

Neither is a new route, cache, hydrator, or write path.

## What Changes

- Generalize the `connector_id` filter on `listConnectorSummaryPage` /
  `parseConnectorSummaryPageRequest` from `string | null` to
  `string | readonly string[] | null`. A repeated query value
  (`?connector_id=A&connector_id=B`) parses to a canonicalized, deduplicated,
  size-bounded (≤100) set; a single value keeps its exact prior behavior
  byte-for-byte. The opaque cursor binds to the set's canonical (sorted,
  deduplicated) fingerprint, not raw user ordering, so a reordered-but-equal
  set still resolves and a different/omitted/reordered-and-different set does
  not.
- Add two static SQL templates (SQLite `json_each` membership join,
  PostgreSQL bound `unnest($n::text[])` join) mirroring the existing
  single-id FILTERED template's index-seekable shape — no dynamic SQL, no
  `OR`-defeated composite-index scan.
- Add a named `retained_count_summary` profile: identity fields plus
  `total_records`, `total_records_state`, `acquisition_coverage.latest_batch`
  only. Dependency matrix: the identity page (already read) + one
  evidence-row batch + one acquisition-batch-store batch (`limit: 1`, the
  same page-scoped batch `loadPageProductEvidence` already proves flat per
  page) — zero spine/runtime/browser-surface/schedule/run-history reads,
  zero writes.
- Replace `existing-sources-by-connector.ts`'s 33-call catalog inventory and
  per-live-connection scoped-summary N+1 with a batched, partitioned,
  exhausted traversal over the `retained_count_summary` profile.

## Capabilities

- Modified: `reference-implementation-architecture`

## Impact

- `reference-implementation/operations/ref-connectors-list/pagination.ts`
- `reference-implementation/operations/ref-connectors-list/index.ts`
- `reference-implementation/server/ref-control.ts`
- `reference-implementation/server/routes/ref-connectors.ts`
- `reference-implementation/server/index.ts`
- `reference-implementation/server/stores/connector-instance-store.ts`
- `apps/console/src/app/(console)/lib/ref-client.ts`
- `apps/console/src/app/(console)/components/existing-sources-by-connector.ts`
