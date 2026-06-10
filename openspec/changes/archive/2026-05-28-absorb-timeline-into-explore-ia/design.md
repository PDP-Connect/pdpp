# Design — Absorb Timeline into Explore IA

## Context

The IA target laid out in `promote-explore-to-top-level-ia/design.md` makes Explore the single top-level surface where an operator goes to look at records. Three lenses compose that surface:

- **Recency** — empty-query fan-out across visible connections (already in Explore).
- **Query** — lexical + hybrid record search (already in Explore).
- **Time-range** — interleaved time-anchored feed across every stream that declares `consent_time_field` (today lives at `/dashboard/records/timeline`).

Splitting time-range into its own route under `Records` mis-frames it as a Records sub-tool. It is the same canvas as Explore, just with a different filter. Users who would naturally think "what records do I have in the last 7 days?" have to navigate to a hidden subpage.

The original promote tranche flagged the time-range absorption as benefitting from the top-level route being in use first. That has held; Explore has been live with the recency and query lenses since `promote-explore-to-top-level-ia` shipped, and the time-range absorption is now the smallest coherent next step toward the unified IA.

## Decision

Make `since` and `until` first-class query params on `/dashboard/explore`. When either is set, the page uses the same manifest-declared `consent_time_field` semantics as the old Timeline page, but performs the fan-out per concrete connection instance. This preserves exact connection attribution in Explore instead of falling back to connector-scoped rows.

The page resolution becomes:

| `since`/`until` | `q` | Feed source | Lens label |
| --- | --- | --- | --- |
| absent | absent | `queryRecords` fan-out (recency) | `Recent` |
| absent | present | `searchRecordsHybrid` / `searchRecordsLexical` | `Search` |
| present | absent | `loadTimeline` window | `Time range` |
| present | present | `searchRecordsHybrid` / `searchRecordsLexical` | `Search · time window not applied to search` |

Query and time-range are not composed in this tranche. Server-side search does not yet accept a time window, and composing the two client-side would require re-fetching and trimming the search hits against the manifest-declared `consent_time_field`, which crosses the same "guessing connection identity" line the existing explorer carefully avoids. The honest behavior is to label the lens and tell the user which filter actually applies.

Stream/connection chips are preserved across all three lenses because they already filter at the `filteredSummaries` layer that both the recency fan-out and the search feed consume. The time-range feed uses those filtered summaries before querying, so selecting one connection queries that connection instance only. This is intentionally stricter than the old standalone Timeline loader, which was connector-scoped and could not distinguish multiple accounts of the same connector type.

Timeline's route at `/dashboard/records/timeline` becomes a non-permanent redirect to `/dashboard/explore`, preserving `since` and `until`. The Records subnav loses its `Timeline` entry; the top-level Explore entry is the durable destination, just as it became for `Explorer` in the previous tranche.

## Why not a mode toggle UI button?

The page already has a single composite URL state (`q`, `connection[]`, `stream[]`, `peek`). Adding a `mode` param would duplicate state that the presence of `since`/`until` already implies. URL-as-state keeps the lens reproducible from deep links — bookmarking the last-week feed is just `?since=2026-05-21&until=2026-05-28`.

## Why not absorb Search at the same time?

Search has two values: (1) records text search, and (2) artifact-id jump for traces, grants, and runs. Only (1) overlaps Explore. Removing the records section of Search before designing how artifact-id jump fits in Explore would be a regression. The cross-link from Search's empty state to Explore (shipped in `feat(dashboard): cross-link Search empty state to Explore`) already nudges discovery; the orderly retirement of Search-as-records can be a follow-on once artifact-id jump finds its home in Explore (probably as a peek-style affordance).

## Why relabel the Records subnav header to "Connections"?

The owner brief says the Records/Connections vocabulary should become less confusing without risky URL migration. Relabeling the subnav header from `Records` to `Connections` is the smallest possible vocabulary fix that doesn't touch URLs: the route prefix stays `/dashboard/records/*`, every `routes.section.records*` consumer keeps working, the visible operator vocabulary aligns with the canonical noun. The full `/dashboard/records/*` → `/dashboard/connections/*` URL rename is still its own tranche.

## Why a redirect instead of moving the file?

The same reason `promote-explore-to-top-level-ia` chose a redirect for `/dashboard/records/explorer`: there are tests, possible bookmarks, and internal references to the old path. A non-permanent redirect protects callers and can be retired in a later tranche if the Records subtree is renamed.

## Scope of this change

In scope:

- `apps/web/src/app/dashboard/explore/page.tsx` and `apps/console/src/app/dashboard/explore/page.tsx`:
  - Accept `since` and `until` search params.
  - Branch into a time-range fan-out when either is present and `q` is empty.
  - Query each visible connection instance's time-anchored streams with `connectorInstanceId`, using the manifest-declared `consent_time_field` to filter and sort.
  - Map rows into the existing `ExplorerFeedEntry` shape so the same `RecordsExplorerView` renders them with exact connection attribution.
  - Filter time-anchored stream targets by the existing `selectedConnectionIds` / `selectedStreams` before issuing record queries so chip semantics are preserved.
- `apps/web/src/app/dashboard/components/views/records-explorer-view.tsx` (shared, used by both apps):
  - Add a date-window picker (Since / Until / 1d / 7d / 30d / 90d / Reset) inside the Toolbar.
  - Add a lens label under the toolbar that explains the active lens (`Recent`, `Search`, `Time range`, `Search · time window not applied to search`).
  - Time-range mode hides the recency-truncation hint when the loader returns the full slice; the existing partial-fan-in warning surface continues to render any per-stream errors.
- `apps/web/next.config.mjs` and `apps/console/next.config.mjs`: add a non-permanent redirect from `/dashboard/records/timeline` to `/dashboard/explore`.
- `apps/web/src/app/dashboard/components/shell.tsx` and `apps/console/src/app/dashboard/components/shell.tsx`:
  - Remove the `Timeline` entry from the Records subnav.
  - Relabel the Records subnav header from `Records` to `Connections`.
- `apps/web/src/app/dashboard/records/timeline/page.tsx` and `apps/console/src/app/dashboard/records/timeline/page.tsx`: delete (redirect handles all callers). Tests previously rooted under these directories are absorbed into the explore tests.

Out of scope:

- Composing search + time-range server-side or client-side.
- Renaming `/dashboard/records/*` to `/dashboard/connections/*`.
- Removing the records section from `/dashboard/search`.
- Any change to RS, `_ref`, or owner-token contracts.
- Any change to `/sandbox/**`.
- Any change to `loadTimeline` itself.

## Acceptance checks

- `/dashboard/explore?since=2026-05-21&until=2026-05-28` renders the time-range feed (interleaved across every time-anchored stream) with `Time range` as the lens label.
- `/dashboard/records/timeline?since=2026-05-21&until=2026-05-28` 308-or-302 redirects to `/dashboard/explore?since=...&until=...` and renders the same feed.
- `/dashboard/explore` with no params renders the existing recency feed and lens label `Recent`.
- `/dashboard/explore?q=foo` renders the existing search feed and lens label `Search`.
- `/dashboard/explore?q=foo&since=...&until=...` renders the search feed and lens label `Search · time window not applied to search`.
- Selecting a connection or stream chip while in time-range mode narrows the time-anchored fan-out to that connection/stream.
- The Records subnav's header reads `Connections` (not `Records`) and contains only `Connectors` and `Explorer` entries (no `Timeline`).
- `pnpm -C apps/web run types:check` passes.
- `pnpm -C apps/console run types:check` passes.
- `openspec validate absorb-timeline-into-explore-ia --strict` passes.
- `openspec validate --all --strict` passes.

## Open questions and follow-ons

- Q: Should `loadTimeline` learn connection identity? — Yes, but not in this tranche. The sandbox still uses the old helper, and changing that shared loader would require a broader sandbox IA pass. Explore cannot accept connector-scoped attribution, so it owns a per-connection time-range fan-out until the shared helper grows a connection-aware contract.
- Q: Should query + time-range compose? — Deferred. Public `/v1/search` does not accept time bounds, and an honest client-side compose would have to refetch hit bodies to read the consent-time field. The current resolution table is explicit instead of implicit.
- Q: When does `/dashboard/records/timeline` redirect retire? — When the Records subtree is renamed or removed entirely. The redirect stays non-permanent so a future tranche can fold it into a wider subtree retirement without a permanent-cache hazard.
