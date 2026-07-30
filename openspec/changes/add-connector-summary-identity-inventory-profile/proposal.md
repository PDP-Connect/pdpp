## Why

Fable ruling `terminal-read-architecture-fable-0730.md` §8 (R8.1) found that
Explore's facet rail, exact-selection lookup, and peek path consume only five
identity/membership fields from the ~22-24-read, 32-field connector-summary
projection — the server still pays the full health/evidence/run/schedule/
runtime dependency cost to synthesize fields Explore never reads. The
one-projection-N-profiles pattern already exists (`includeRunSummaries`,
`includeRetainedSizeSnapshot`); this proposal adds one more named profile
rather than a new read surface.

## What Changes

- Add a named `identity_inventory` profile to the existing
  `listConnectorSummaryPage` operation behind `GET /_ref/connectors?profile=identity_inventory`
  (and the existing single-connection `?connection=` selector). No new route,
  no new `_ref` route, no new owner-token scope.
- The profile's dependency matrix is the identity page + one evidence-row
  batch + one declared-manifest lookup (at most 4 page-scoped statements);
  zero spine, browser-surface/runtime, or run-history reads; zero writes.
- `streams` under this profile is the evidence engine's stored
  declared∪observed union, read as stored; a connection with no evidence row
  yet serves declared-only from the manifest with an explicit
  `membership_state: "pending"`.
- Route Explore's facet pager, exact-selected-summary lookup
  (`resolveExactSelectedSummaries`), and peek relationship path through this
  profile.

## Capabilities

- Modified: `reference-implementation-architecture`

## Impact

- `reference-implementation/operations/ref-connectors-list/pagination.ts`
- `reference-implementation/operations/ref-connectors-list/index.ts`
- `reference-implementation/server/ref-control.ts`
- `reference-implementation/server/routes/ref-connectors.ts`
- `reference-implementation/server/index.ts`
- `apps/console/src/app/(console)/lib/ref-client.ts`
- `apps/console/src/app/(console)/lib/data-source.ts`
- `packages/operator-ui/src/lib/data-source.ts`
- `packages/operator-ui/src/lib/ref-client.ts`
- `packages/operator-ui/src/explore/explore-data-assembler.ts`
- `packages/operator-ui/src/explore/search-hit-attribution.ts`
- `apps/site/src/app/sandbox/_demo/data-source.ts`
