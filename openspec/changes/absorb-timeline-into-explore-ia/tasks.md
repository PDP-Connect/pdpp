# Tasks — absorb-timeline-into-explore-ia

## 1. Time-range lens in the Explore page

- [x] 1.1 Accept `since` and `until` search params on `apps/web/src/app/dashboard/explore/page.tsx` and `apps/console/src/app/dashboard/explore/page.tsx`. Use ISO date parsing identical to the existing Timeline page's resolution; default to "no window" when both are absent.
- [x] 1.2 Add a `loadTimeRangeFeed` branch on each page when at least one of `since`/`until` is present and `q` is empty. Query each visible connection instance's time-anchored streams with `connectorInstanceId`, then map rows into `ExplorerFeedEntry` with concrete connection attribution.
- [x] 1.3 Filter time-range targets by `selectedConnectionIds` / `selectedStreams` before querying so chip state is honored consistently with the recency lens.
- [x] 1.4 Pass the active lens to `RecordsExplorerView` as an additional field on `RecordsExplorerData` (e.g. `lens: "recent" | "search" | "time_range" | "search_with_ignored_time_window"`).
- [x] 1.5 Preserve the existing peek panel behavior in time-range mode (the same `getRecord` call resolves the body; the row's record link uses `routes.record(connectorId, stream, recordId)`).

## 2. Date-window picker in `RecordsExplorerView`

- [x] 2.1 Add a Since / Until date input pair, an Apply button, a Reset link, and 1d / 7d / 30d / 90d quick-window links inside the existing Toolbar in `apps/web/src/app/dashboard/components/views/records-explorer-view.tsx`. Pattern matches `records-timeline-view.tsx` for consistency.
- [x] 2.2 The picker writes `since` and `until` into the URL via the existing `routes.section.explore` form action; chip state and `q` are preserved as hidden inputs.
- [x] 2.3 Add a one-line lens label under the toolbar that explains which lens is active and, in the search-with-ignored-time-window case, says so plainly.
- [x] 2.4 Update `buildExplorerHref` to accept `since` / `until` so chip toggles in time-range mode preserve the window.

## 3. Records subnav: drop Timeline, relabel header

- [x] 3.1 In `apps/web/src/app/dashboard/components/shell.tsx` and `apps/console/src/app/dashboard/components/shell.tsx`, remove the `recordsTimeline` entry from `RecordsSubnav` items.
- [x] 3.2 Change the subnav label from `Records` to `Connections`.

## 4. Redirect from old Timeline path

- [x] 4.1 In `apps/web/next.config.mjs`, add a non-permanent redirect from `/dashboard/records/timeline` → `/dashboard/explore`. Next.js redirects preserve the query string by default.
- [x] 4.2 Mirror the same delta in `apps/console/next.config.mjs`.
- [x] 4.3 Add `timeline` to the pre-v1 bare-connector wildcard's exclusion list in both configs so `/dashboard/records/timeline` is never misrouted into the `[connector]` segment.

## 5. Retire the Timeline page files

- [x] 5.1 Delete `apps/web/src/app/dashboard/records/timeline/page.tsx` and `apps/console/src/app/dashboard/records/timeline/page.tsx`. The redirect handles every previously-reachable URL.
- [x] 5.2 Retain `routes.section.recordsTimeline` for one cycle so the redirect target remains computable from `Routes`; mark it deprecated in a comment. Removing the field becomes a follow-on once the Records subtree retires.

## 6. Tests

- [x] 6.1 Add a focused page test that asserts the Explore page resolves `since`/`until` to the timeline feed when `q` is empty. Mirror in `apps/console`.
- [x] 6.2 Confirm `explorer-url.test.ts` still passes; extend it with cases for `since` / `until` round-tripping through `buildExplorerHref`.

## 7. Validation

- [x] 7.1 `openspec validate absorb-timeline-into-explore-ia --strict` passes.
- [x] 7.2 `openspec validate --all --strict` passes.
- [x] 7.3 `pnpm -C apps/web run types:check` passes.
- [x] 7.4 `pnpm -C apps/console run types:check` passes.
- [x] 7.5 Explore route tests pass under `node --test` in both apps.

## Acceptance checks

- `/dashboard/explore?since=YYYY-MM-DD&until=YYYY-MM-DD` renders the time-anchored feed with lens label `Time range`.
- `/dashboard/records/timeline?since=…&until=…` redirects to the equivalent Explore URL.
- `/dashboard/explore?q=foo&since=…&until=…` renders the search feed with a lens label that admits the time window is not applied.
- Records subnav shows `Connections` as the header and contains `Connectors` and `Explorer` only.
- No new RS, `_ref`, or owner-token endpoints exist.
