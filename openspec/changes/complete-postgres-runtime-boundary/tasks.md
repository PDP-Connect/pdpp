## 1. Audit And Classification

- [x] 1.1 Inventory every production runtime import/use of `getDb`,
  `better-sqlite3`, `node:sqlite`, SQLite store factories, and SQLite query
  modules.
- [x] 1.2 Classify each reachable Postgres-mode SQLite use as guarded
  SQLite-backend code, explicitly ephemeral/test-only compatibility, a
  boundary violation, or owner-decision-required.
- [x] 1.3 Add the classification to the change design or a scoped design note
  before implementation proceeds beyond the dataset-summary correction.
  → `design-notes/postgres-runtime-boundary-sqlite-classification-2026-05-28.md`

## 2. Dataset Summary Active-Backend Projection

The audit (task 1) established that the Postgres dashboard summary read
path is already wired through the retained-size projection, not a
parallel `dataset_summary_*` Postgres table. Items 2.1–2.3 below are
deferred as a separate slice; items 2.4–2.5 are already true at the
route level (`getRetainedSizeDatasetSummaryProjection` is the projection
source in Postgres mode; raw aggregates remain only as the rebuild
recovery path).

- [ ] 2.1 Add Postgres tables/indexes for the dataset-summary global and
  per-stream projection rows with the same freshness/rebuild metadata as the
  SQLite projection.
  → Deferred. Postgres dashboard summary reads from `retained_size_*`
    via `getRetainedSizeDatasetSummaryProjection`. A second parallel
    Postgres projection would be duplicate work for the same dashboard
    surface. Promotion is out of scope for this closeout; revisit if a
    second read surface needs the `dataset_summary` shape specifically.
- [ ] 2.2 Add backend-neutral dataset-summary projection functions that dispatch
  to SQLite or Postgres by active backend.
  → Deferred with 2.1. Backend-neutrality is currently enforced at the
    route boundary in `server/index.js` (the host adapter selects the
    SQLite or Postgres source). The dataset-summary read-model module
    stays SQLite-only by design + boundary guard (3.1).
- [ ] 2.3 Wire record, record-change, blob, dirty-extrema, rebuild, and
  reconcile paths to the active backend's projection.
  → Already true via the retained-size projection in Postgres mode:
    `applyRetainedSizeRecordDelta` and `applyRetainedSizeBlobDelta`
    dispatch on `isPostgresStorageBackend()`, and Postgres ingest in
    `records.js:245-269` and `:2312-2330` wires its `outcome.retainedSizeDelta`
    through them.
- [x] 2.4 Make `GET /_ref/dataset/summary` use the active backend projection in
  Postgres mode instead of the raw fallback once the Postgres projection exists.
  → Already true in `server/index.js:4525-4529`: Postgres mode selects
    `getRetainedSizeDatasetSummaryProjection`, SQLite mode selects
    `getDatasetSummaryProjection`. The boundary guard (3.1) now makes
    accidental SQLite reads in Postgres mode fail-fast.
- [x] 2.5 Keep raw recomputation only as rebuild/recovery evidence, not the hot
  dashboard read path.
  → True. The hot read path uses the projection; raw aggregate
    dependencies are invoked only by `/_ref/dataset/summary/rebuild`.

## 3. Guards And Diagnostics

- [x] 3.1 Add a test or lightweight runtime guard that prevents unclassified
  persistent SQLite reads from serving Postgres-mode reference/runtime routes.
  → `assertSqliteBackendForDatasetSummary(operation)` at the top of
    `reference-implementation/server/dataset-summary-read-model.js` is
    called from every exported entry point (`listStreamProjections`,
    `getDatasetSummaryProjection`, `applyDatasetSummaryRecordDelta`,
    `applyDatasetSummaryBlobDelta`, `markDatasetSummaryProjectionStale`,
    `rebuildDatasetSummaryProjection`,
    `reconcileDirtyDatasetSummaryRecordTimeBounds`). Removed a latent
    unconditional `markDatasetSummaryProjectionStale` call from the
    Postgres branch of `postgresDeleteAllRecordsForConnector` in
    `server/records.js` that the guard surfaced.
- [x] 3.2 Add a focused regression test with divergent SQLite projection data
  and Postgres records proving the dashboard summary ignores stale SQLite.
  → `reference-implementation/test/dataset-summary-postgres-boundary.test.js`
    seeds a deliberately wrong SQLite `dataset_summary_projection` row,
    initializes Postgres, and asserts every guarded entry point throws
    `storage_backend_mismatch`. Gates on `PDPP_TEST_POSTGRES_URL`.
- [ ] 3.3 Update deployment diagnostics to surface whether Postgres mode still
  has classified local SQLite compatibility state.
  → Deferred. `/_ref/deployment` already exposes `storage_backend`
    (`lib/controller-boot.ts:106`). The SQLite classification table is
    captured in
    `design-notes/postgres-runtime-boundary-sqlite-classification-2026-05-28.md`;
    promoting it into a runtime diagnostic surface is a follow-on
    if/when an operator-facing summary view is needed.

## 4. Validation

- [x] 4.1 Run focused dataset-summary read-model tests for SQLite and Postgres.
  → Verified by
    `tmp/workstreams/ri-semantic-index-boundary-closeout-report.md`.
- [x] 4.2 Run Postgres-gated reference runtime tests against a real Postgres
  service.
  → Verified by
    `tmp/workstreams/ri-semantic-index-boundary-closeout-report.md`.
- [x] 4.3 Run relevant dashboard typechecks/build checks.
  → Verified by
    `tmp/workstreams/ri-semantic-index-boundary-closeout-report.md`.
- [x] 4.4 Run `openspec validate complete-postgres-runtime-boundary --strict`.
  → Verified by
    `tmp/workstreams/ri-semantic-index-boundary-closeout-report.md`.
- [x] 4.5 Run `git diff --check` and a final grep/read consistency pass for old
  SQLite/Postgres boundary assumptions in touched files.
  → Verified by
    `tmp/workstreams/ri-semantic-index-boundary-closeout-report.md`.
