## 1. Audit And Classification

- [ ] 1.1 Inventory every production runtime import/use of `getDb`,
  `better-sqlite3`, `node:sqlite`, SQLite store factories, and SQLite query
  modules.
- [ ] 1.2 Classify each reachable Postgres-mode SQLite use as guarded
  SQLite-backend code, explicitly ephemeral/test-only compatibility, a
  boundary violation, or owner-decision-required.
- [ ] 1.3 Add the classification to the change design or a scoped design note
  before implementation proceeds beyond the dataset-summary correction.

## 2. Dataset Summary Active-Backend Projection

- [ ] 2.1 Add Postgres tables/indexes for the dataset-summary global and
  per-stream projection rows with the same freshness/rebuild metadata as the
  SQLite projection.
- [ ] 2.2 Add backend-neutral dataset-summary projection functions that dispatch
  to SQLite or Postgres by active backend.
- [ ] 2.3 Wire record, record-change, blob, dirty-extrema, rebuild, and
  reconcile paths to the active backend's projection.
- [ ] 2.4 Make `GET /_ref/dataset/summary` use the active backend projection in
  Postgres mode instead of the raw fallback once the Postgres projection exists.
- [ ] 2.5 Keep raw recomputation only as rebuild/recovery evidence, not the hot
  dashboard read path.

## 3. Guards And Diagnostics

- [ ] 3.1 Add a test or lightweight runtime guard that prevents unclassified
  persistent SQLite reads from serving Postgres-mode reference/runtime routes.
- [ ] 3.2 Add a focused regression test with divergent SQLite projection data
  and Postgres records proving the dashboard summary ignores stale SQLite.
- [ ] 3.3 Update deployment diagnostics to surface whether Postgres mode still
  has classified local SQLite compatibility state.

## 4. Validation

- [ ] 4.1 Run focused dataset-summary read-model tests for SQLite and Postgres.
- [ ] 4.2 Run Postgres-gated reference runtime tests against a real Postgres
  service.
- [ ] 4.3 Run relevant dashboard typechecks/build checks.
- [ ] 4.4 Run `openspec validate complete-postgres-runtime-boundary --strict`.
- [ ] 4.5 Run `git diff --check` and a final grep/read consistency pass for old
  SQLite/Postgres boundary assumptions in touched files.
