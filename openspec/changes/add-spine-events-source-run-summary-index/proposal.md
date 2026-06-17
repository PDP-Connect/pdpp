## Why

`listSpineCorrelations` aggregates `spine_events` by correlation id and supports source filters. Postgres already carries a source/run summary index for that hot path; SQLite lacked equivalent coverage.

## What Changes

- Add the SQLite `spine_events(source_kind, source_id, run_id, occurred_at DESC)` partial index for source-filtered run aggregation.
- Keep Postgres and SQLite DDL covered by equivalent schema tests.
- Do not change query results, live databases, deployments, or provider runs.

## Capabilities

Modified: `reference-implementation-architecture`

## Impact

- Runtime schema: `reference-implementation/server/db.js`
- Tests: `reference-implementation/test/spine-source-boot-backfill.test.js`
