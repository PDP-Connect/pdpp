# Tasks: pilot-storage-backend-interface

## 1. Conformance harness (do FIRST, before touching production)

- [ ] 1.1 Write `test/helpers/aggregation-rows-conformance.js` — the shared
      harness + driver shape (`setup`, `teardown`, `seed`, `listRows`).
- [ ] 1.2 Write `test/helpers/sqlite-aggregation-rows-driver.js` calling the real
      SQLite path.
- [ ] 1.3 Write `test/aggregation-rows-conformance.test.js` (SQLite, always-run).
- [ ] 1.4 Write `test/helpers/postgres-aggregation-rows-driver.js` calling the
      real Postgres path.
- [ ] 1.5 Write `test/aggregation-rows-conformance-postgres.test.js` (env-gated).
- [ ] 1.6 Assert the `record_json` string-normalization invariant explicitly.
- [ ] 1.7 Verify BOTH conformance files green against CURRENT production code
      (pre-migration baseline — MUST pass before any production edit).

## 2. Interface + adapters

- [ ] 2.1 Define `StorageBackend` interface (JSDoc) with `listRowsForAggregation`
      as its sole method, including the record_json-is-string contract.
- [ ] 2.2 Implement the Postgres adapter satisfying the interface (the existing
      `postgresQuery` + stringify-normalization).
- [ ] 2.3 Implement the SQLite adapter satisfying the interface (the existing
      `iterate(referenceQueries.recordsAggregateIterateStreamRecordsForAggregation)`).
- [ ] 2.4 Wire `listRowsForAggregation` at `records.js:2547` to dispatch through
      the interface; remove its `isPostgresStorageBackend()` branch.

## 3. Verification

- [ ] 3.1 SQLite conformance green post-migration.
- [ ] 3.2 Postgres conformance green post-migration (disposable pgvector).
- [ ] 3.3 Existing aggregate-route tests green, unmodified.
- [ ] 3.4 Typecheck / ultracite clean on touched files.
- [ ] 3.5 Adversarial audit of adapters + harness assertions (no behavior change,
      no hidden backend-specific logic absorbed).
- [ ] 3.6 the independent reviewer RI-owner direct diff/test review and sign-off.

## 4. Acceptance gate

- [ ] 4.1 Owner decides: continue to next seam OR close pilot as sufficient proof
      for the design decision.
