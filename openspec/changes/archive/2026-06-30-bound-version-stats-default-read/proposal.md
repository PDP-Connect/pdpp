# Bound version-stats default reads

## Why

The Sources page (`/dashboard/records`) loads in roughly seven seconds on the
live corpus because it blocks on `GET /_ref/records/version-stats?limit=8`.
That route still runs an unbounded `record_changes` aggregate whenever the
retained-size global projection is dirty. On the live Postgres corpus this means
sorting and grouping more than three million `record_changes` rows on each page
load.

The Sources page is an owner navigation surface, not a maintenance audit. Its
load-bearing read must be the source summary projection. Version churn is an
advisory diagnostic and must never turn the page into a whole-history aggregate.

## What Changes

- Keep `/dashboard/records` on the single source-summary read path; do not block
  the page on version-churn diagnostics.
- Change the unfiltered `/_ref/records/version-stats` contract from
  "exact-or-full-scan" to "bounded advisory by default, exact when scoped."
- Preserve exact ground truth for explicit `connector_instance_id` / `stream`
  diagnostic requests.
- Report dirty or incomplete projection state honestly instead of synchronously
  repairing it with an unbounded full scan.

## Capabilities

Modified:
- `reference-implementation-architecture`

Added:
- None

Removed:
- None

## Impact

- `reference-implementation/server/record-version-stats.js` stops using the
  unbounded full-scan fallback for unfiltered default requests.
- `apps/console/src/app/dashboard/records/page.tsx` stops fetching
  version-stats in the load-bearing Sources route.
- Tests pin both invariants.
