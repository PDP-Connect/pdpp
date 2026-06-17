## 1. Runtime

- [x] Populate Postgres stored record sort positions for new ingests without a
  per-record manifest DB lookup.
- [x] Invalidate cached manifest-stream metadata and backfill null stored cursor
  values when connector manifests are registered or refreshed.
- [x] Order Postgres record-list pages by stored sort-position columns.
- [x] Use clean retained-size stream projections for unfiltered full-stream
  exact/estimated counts, with guarded fallback.

## 2. Tests

- [x] Add Postgres runtime coverage for stored cursor population and backfill.
- [x] Add Postgres runtime coverage for retained-size projection count fallback
  rules.
- [x] Run focused Postgres runtime tests and broader type/OpenSpec gates.

## 3. Live Verification

- [ ] Deploy under the live-stack mutex.
- [ ] Re-run the RS API benchmark and record before/after numbers.
- [ ] Re-run a browser benchmark for dashboard routes to confirm no regression.
