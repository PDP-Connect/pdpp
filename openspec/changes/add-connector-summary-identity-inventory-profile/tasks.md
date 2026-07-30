## 1. Server profile

- [x] Add `profile` to `ConnectorSummaryPageRequest` and parse
      `?profile=identity_inventory` (reject any other value).
- [x] Add `ConnectorIdentityInventorySummary` and
      `projectConnectorIdentityInventoryPage` (identity page + evidence-row
      batch + declared-manifest lookup only).
- [x] Branch `listConnectorSummaryPage` and `getConnectorSummaryForRoute` on
      `profile` without changing default (full) behavior.

## 2. Route and console wiring

- [x] Thread `profile` through `GET /_ref/connectors` (`?connection=` and
      paged forms) to the operation dependency.
- [x] Add `RefConnectorIdentitySummary`/`RefConnectorsListIdentityItem` types
      and thread `profile` through console `listConnectorSummaries` and the
      `DashboardDataSource` seam (operator-ui + console + sandbox mock).

## 3. Explore routing

- [x] Route the facet pager, `resolveExactSelectedSummaries`, and the peek
      path (via the shared `summaries` map) through `profile: "identity_inventory"`.
- [x] Confirm `toConnectionFacet`'s view model is unchanged for both profiles.

## 4. OpenSpec, tests, verification

- [x] Add an OpenSpec scenario delta clarifying the profile surface; no
      existing SHALL-NOT touched.
- [x] Contract test, BOTH backends: declared-only / observed-unexpected /
      revoked / pre-sweep fixtures
      (`test/ref-connectors-identity-inventory-profile.test.ts`). Every test
      body runs once against a fresh SQLite temp DB and once against a
      disposable PostgreSQL database on the sanctioned dedicated test cluster
      (`PDPP_TEST_POSTGRES_URL=postgresql://postgres:pdpp_test@127.0.0.1:55447/pdpp_test`),
      via a shared `withBothBackends` harness (mirrors the
      `ref-connectors-list-page-route-parity.test.ts` dual-backend pattern).
      14/14 pass (7 fixtures × 2 backends).
- [x] Cost-gate instrumentation: page-scoped statement shapes only, zero
      `spine_events` reads, zero writes — proven on BOTH backends (SQLite via
      `Database.prototype.prepare`, PostgreSQL via the pool's `query` method).
- [x] `toConnectionFacet`/view-model equivalence test (identity row vs. full
      row) — proven on BOTH backends.
- [x] N=0/1/25/100 page-size checks against the `identity_inventory` profile
      itself (not the full profile's own N=100 proof elsewhere, which
      exercises a different dependency-gating branch) — proven on BOTH
      backends, including a no-duplicate-identity check on the N=100 page.
- [x] Grep sweep: no unnamed full-profile Explore call remains (facet pager,
      `resolveExactSelectedSummaries`, and `buildPeekRelationships` all pass
      `profile: "identity_inventory"`).
- [x] Focused typecheck/format/OpenSpec validate (reference-implementation,
      operator-ui, console, site all clean; `openspec validate --strict`
      passes).
