# Tasks — add-dashboard-records-explorer

## 1. Page scaffolding

- [x] 1.1 Add `Records explorer` to `dashboardRoutes.section` (new field `recordsExplorer`) and wire it through to the shared `Routes` interface.
- [x] 1.2 Create `apps/web/src/app/dashboard/records/explorer/page.tsx` as a server component reading `searchParams` (`q`, `connection`, `stream`, `peek`).
- [x] 1.3 Verify dashboard session and return `ServerUnreachable` callout when the RS is down.

## 2. View component

- [x] 2.1 Add `apps/web/src/app/dashboard/components/views/records-explorer-view.tsx` rendering `PageHeader`, query form, facet chips, feed list, and an optional `RecordsExplorerPeek` slot.
- [x] 2.2 Encode connection / stream chips as repeated URL params so the view is link-shareable.
- [x] 2.3 Reuse `Timestamp`, `DataList`, `Section`, `FilterSummary`, and the existing `summarize` helper for hit summaries.

## 3. Data sources

- [x] 3.1 Empty query: fan out across visible connections via `listConnectorSummaries` + bounded `queryRecords` to build a recency-sorted feed. Cap the fan-out (max connections × max streams × max records per stream).
- [x] 3.2 Non-empty query: call `searchRecordsHybrid` when advertised, otherwise `searchRecordsLexical`. Reuse `hitToRecordHit` semantics (snippet > summarize > stream/key fallback) but keep them local to the explorer (do not export from the search page).
- [x] 3.3 Apply connection / stream chip filters as a post-fetch filter (no public RS endpoint accepts `connection_id` on `/v1/search` in v1).

## 4. Peek panel

- [x] 4.1 When `?peek=<connector>::<stream>::<id>` is present, read the record with `getRecord` (under connection scope when known) and render an inline `RecordsExplorerPeek`.
- [x] 4.2 Show the exact `GET /v1/streams/<stream>/records/<id>` URL with the `connector_id` and `connector_instance_id` query params the dashboard actually used.
- [x] 4.3 Provide an "open full →" link to `routes.record(...)`.

## 5. Navigation

- [x] 5.1 Add `Explorer` to the existing `RecordsSubnav` in `apps/web/src/app/dashboard/components/shell.tsx`.
- [x] 5.2 Add a routes entry on the sandbox `Routes` so the same view component compiles in both modes (page only mounted in live mode for this slice).

## 6. Tests

- [x] 6.1 Unit-test URL-param round-trip: chips encode/decode preserve `connection_id` identity (no collapse to `connector_id`).
- [x] 6.2 Snapshot-free test of the peek URL builder so future changes to `getRecord`'s URL shape stay in sync.

## 7. Validation

- [x] 7.1 `openspec validate add-dashboard-records-explorer --strict` passes.
- [x] 7.2 `pnpm -C apps/web run types:check` passes.
- [x] 7.3 Targeted explorer test passes via `pnpm -C apps/web exec node --test ...`.
- [x] 7.4 `pnpm -C apps/console run types:check` passes.
- [x] 7.5 Targeted explorer test passes via `pnpm -C apps/console exec node --test ...`.

## 8. Operator-console parity

- [x] 8.1 Mirror explorer page, view, peek-read-url, search-hit-attribution module, and tests under `apps/console`.
- [x] 8.2 Mirror the routes / shell / rs-client deltas under `apps/console` so the operator-console Docker target (`docker-compose.yml` service `console`) ships the Explorer for the live `pdpp.vivid.fish` deployment.

## Acceptance checks

- Visiting `/dashboard/records/explorer` without query params renders the shell, the records subnav with `Explorer` present, and a recent-records feed.
- Submitting `?q=test` re-renders with hits that respect connection chip filters.
- Clicking a feed row sets `?peek=...` and the peek panel shows the exact GET URL.
- A connection chip's URL form is stable: `?connection=<id>&connection=<other-id>` survives reload.
