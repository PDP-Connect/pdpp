## Why

The owner console overview and runs pages block on reference spine list routes.
Live measurement after the connector-summary fix showed `/_ref/traces` at about
365-900ms and `/_ref/runs?limit=100` at about 700-950ms. The traces route was
doing a full aggregate over roughly 579k spine events to show six recent rows.

## What Changes

- Add a Postgres recent-event first-page path for unfiltered `/_ref/traces`,
  `/_ref/runs`, and `/_ref/grants` overview lists.
- Keep filtered and cursor-paginated requests on the existing aggregate path.
- Hydrate the selected first-page summaries concurrently with a bounded worker
  count instead of issuing every summary read sequentially.
- Provision Postgres recent-correlation indexes during schema bootstrap and
  migration.
- Stop the dashboard home from fetching failed traces/runs that are no longer
  used by the hero or any rendered block.

## Capabilities

Modified:
- `reference-implementation-architecture`

## Impact

- Runtime: `reference-implementation/lib/postgres-spine.js`
- Runtime: `reference-implementation/server/postgres-storage.js`
- Console: `apps/console/src/app/dashboard/page.tsx`
- Tests: spine overview-list regression tests
