# Absorb Timeline into Explore IA

## Why

`promote-explore-to-top-level-ia` shipped `/dashboard/explore` as the top-level records-exploration surface and explicitly deferred the time-range lens to a follow-on tranche. Today, owners who want to look at records by data-time (rather than by recency or by query) must navigate a hidden Records subpage at `/dashboard/records/timeline`, which contradicts the IA target: Explore is the durable noun for data exploration, and time is one of its lenses — not a separate page under Records.

This change folds the existing timeline behavior into Explore as a date-window mode, retires the standalone Timeline route behind a non-permanent redirect, and removes the Records subnav's Timeline entry. The underlying timeline loader (`loadTimeline`) and its read contract are unchanged.

## What changes

- Add `since` / `until` query params to `/dashboard/explore`. When either is set, Explore renders a connection-preserving time-anchored cross-stream feed (interleaved by the manifest-declared `consent_time_field`) instead of the recency or search feed.
- Add an inline date-window picker to the Explore toolbar mirroring the current Timeline form (Since / Until inputs, Apply, Reset, and 1d / 7d / 30d / 90d quick-window links).
- Keep query, connection, and stream filters available in time mode. Submitting a query while `since`/`until` are set falls back to the existing search feed; the date-window picker is preserved in the URL but the lens label says so.
- Redirect `/dashboard/records/timeline` → `/dashboard/explore` (non-permanent) in both `apps/web` and `apps/console`, preserving the `since` and `until` query string.
- Remove the Records subnav's `Timeline` entry. The Explore top-level entry is the durable destination.
- Relabel the Records subnav header from `Records` to `Connections` for vocabulary clarity. Route prefix stays `/dashboard/records/*`; the Connections rename of public URLs is still its own future tranche.

## Out of scope

- Renaming the `/dashboard/records/*` URL subtree to `/dashboard/connections/*`. That is a separate tranche that touches every records route, redirect, and internal caller.
- Removing the records section from `/dashboard/search`. Search retains its spine artifact-id jump value (traces, grants, runs); the records portion of Search remains a peer lens until a future tranche moves it.
- Any change to the canonical RS, `_ref`, or owner-token read contracts. Explore continues to read through `listConnectorSummaries`, `listConnectorManifests`, `queryRecords`, `searchRecordsHybrid` / `searchRecordsLexical`, `getRecord`, and the shared `loadTimeline` helper only.
- New backend filtering primitives. Time-range filtering uses existing per-connection `queryRecords` reads plus manifest metadata; no RS or `_ref` contract changes are introduced.
