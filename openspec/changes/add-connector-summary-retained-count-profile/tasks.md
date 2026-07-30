## 1. Set-scope contract

- [x] Generalize `ConnectorIdScope` (`pagination.ts`) to
      `string | readonly string[] | null`; parse a repeated `connector_id`
      query value into a canonicalized, deduplicated, ≤100-id set (a
      duplicate-after-canonicalization set or an oversized set is a typed
      invalid request; a 1-element set collapses to the plain single-id
      filter).
- [x] Bind the opaque cursor to the set's canonical (sorted, deduplicated)
      fingerprint, not raw user ordering; a mismatched/omitted/reordered-and-
      different scope is a typed invalid cursor.
- [x] Add `SQLITE_OWNER_VISIBLE_IDENTITY_PAGE_SET_SQL` (`json_each`
      membership) and `POSTGRES_OWNER_VISIBLE_IDENTITY_PAGE_SET_SQL`
      (`unnest($n::text[])`), both seekable on the composite
      `idx_connector_instances_owner_identity_page` index — no dynamic SQL,
      no `OR`-defeated scan.

## 2. `retained_count_summary` profile

- [x] Add `ConnectorRetainedCountSummary` and
      `projectConnectorRetainedCountSummaryPage` (identity page + evidence-row
      batch + acquisition-batch-store batch only).
- [x] Branch `listConnectorSummaryPage` and `getConnectorSummaryForRoute` on
      `profile: "retained_count_summary"` without changing default (full) or
      `identity_inventory` behavior.
- [x] `total_records`/`total_records_state` mirror the evidence-first
      derivation `projectConnectorSummaryForInstance` already uses exactly
      (known/known_zero/stale/unobserved); `acquisition_coverage.latest_batch`
      is the most recent acquisition batch for the connection, or `null`.

## 3. Route and console wiring

- [x] Thread the set scope and `profile` through `GET /_ref/connectors`
      (paged form); reject mixing `connector_id`/set/`profile` with
      `connection` at the route boundary (unchanged mutual-exclusivity rule).
- [x] Add `RefConnectorRetainedCountSummary`/`RefConnectorsListRetainedCountItem`
      types; extend console `listConnectorSummaries` to accept a bounded
      `connectorId: readonly string[]` scope, sent as repeated query values
      (never CSV-encoded).

## 4. Add Source migration

- [x] Replace `existing-sources-by-connector.ts`'s 33-call catalog inventory
      (`listConnectionsByConnector` per catalog connector) and the
      per-live-connection scoped `connectionRouteId` backfill N+1 with a
      batched, partitioned (≤100 ids per request), cursor-exhausted traversal
      over `retained_count_summary`.
- [x] Preserve the exact `ExistingSourceSetupLink` output contract and
      revoked-connection filtering (`status !== "revoked" && !revoked_at`) so
      both `existingSourcesForConnector` and `existingSourcesByConnectorCatalog`
      callers (Add Source, manual-upload) are unaffected by the internal
      seam change.

## 5. OpenSpec, tests, verification

- [x] Add an OpenSpec scenario delta extending the existing "Connection-summary
      route supports single-connection scoping" requirement; no existing
      SHALL-NOT touched.
- [x] Contract test, BOTH backends
      (`test/ref-connectors-retained-count-summary-profile.test.ts`): pinned
      field set, known/known_zero/stale/unobserved derivation,
      acquisition_coverage.latest_batch selection, view-model parity to the
      full `detail` profile, exact-set oracle (duplicate connector types,
      zero-configured id, revoked rows, foreign owner), N=0/1/25/100 page
      sizing, >100/empty/duplicate-after-canonicalization set rejection,
      cursor scope/owner/set-mismatch rejection, sparse-in-dense-fleet
      isolation, cost gate (page-scoped statements only, zero writes, zero
      spine reads), and dense-unrelated-fleet statement-count ceiling parity
      — 25/25 pass (14 fixtures × ~2 backends, some SQLite-only for parser
      unit tests).
- [x] EXPLAIN-plan proof, BOTH backends
      (`test/ref-connectors-identity-page-set-scope-explain.test.ts`): the
      SET template seeks the composite index on `owner_subject_id` AND
      `connector_id` (SQLite `EXPLAIN QUERY PLAN`, PostgreSQL `EXPLAIN` Index
      Cond) against a sparse 2-connector-type target inside a 1000-connection
      unrelated fleet — 4/4 pass.
- [x] Mounted-route HTTP proof, BOTH backends
      (`test/ref-connectors-retained-count-summary-route-parity.test.ts`):
      the actual repeated `?connector_id=A&connector_id=B` query-string shape,
      >100-id rejection, `connection`+`connector_id` mutual exclusivity, and
      single-repeated-value parity, all through a live mounted server via
      `fetch` — 2/2 pass.
- [x] Updated `existing-sources-by-connector.test.ts` structural assertions to
      pin the new batched-profile seam (was pinned to the removed 33-call
      fan-out); all 5 pass.
- [x] Focused typecheck (reference-implementation, apps/console) and biome
      check on every touched file: clean.
- [x] No regression in existing pagination/identity-inventory/route-parity
      test files (`ref-connectors-list-pagination.test.ts`,
      `ref-connectors-identity-inventory-profile.test.ts`,
      `ref-connectors-identity-page-filter-explain.test.ts`,
      `ref-connectors-list-page-route-parity.test.ts`,
      `ref-connectors-list-operation.test.ts`): all pass unchanged.
