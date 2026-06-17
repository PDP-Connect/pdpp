## 1. Runtime

- [x] Add a Postgres recent-event first-page path for unfiltered spine overview lists.
- [x] Keep filtered/cursor list reads on the existing aggregate path.
- [x] Hydrate selected page summaries with bounded concurrency.
- [x] Add Postgres recent-correlation indexes to schema bootstrap and migration.
- [x] Remove unused failed-run/failed-trace reads from the dashboard home.

## 2. Tests

- [x] Add regression coverage for unfiltered recent first-page spine lists.
- [x] Add regression coverage that filtered/cursor reads do not use the recent fast path.
- [x] Run reference and console type checks.
- [x] Run OpenSpec strict/all.

## 3. Live Verification

- [x] Create the recent-correlation indexes on live Postgres or verify bootstrap created them.
- [ ] Verify `/_ref/traces?limit=6` and `/_ref/runs?limit=100` before/after latency.
- [ ] Verify `/dashboard` and `/dashboard/runs` with the browser harness.
