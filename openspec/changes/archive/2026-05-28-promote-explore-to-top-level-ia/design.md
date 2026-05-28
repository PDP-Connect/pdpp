# Design — Promote Explore to top-level IA

## Context

`add-dashboard-records-explorer` shipped a records-only browsing surface at `/dashboard/records/explorer`. That surface is correct in its data-plumbing (canonical RS + `_ref` reads, connection identity preserved, partial fan-in surfaced honestly, no fake projection chrome) but wrong in its placement.

Designer intent and operator-console feedback both point to "Explore" being the top-level surface an owner reaches for when they want to look at their data. The current path forces a Records → Explorer drilldown, which mis-frames Explore as a sub-tool of the Connectors list rather than a peer of Search.

The owner-stated target IA is:

- `/dashboard/explore` is a top-level operator-console path.
- Explore combines the records query, recency, and time-range lenses currently scattered across `/dashboard/records/explorer`, `/dashboard/records/timeline`, and the records section of `/dashboard/search`.
- The Records subtree relabels to Connections; the index becomes the Connections list, and the per-connection drilldown lives under `/dashboard/connections/...`.
- `/dashboard/search` remains the spine artifact jump (traces, grants, runs); it stops dual-purposing as a records surface once Explore absorbs that role.

## Decision

Split the IA shift into three tranches, only the first of which is in scope for this change:

1. **Promote** — top-level `/dashboard/explore` route + nav entry + redirect from `/dashboard/records/explorer`. This change.
2. **Connections rename** — `/dashboard/records` → `/dashboard/connections`, with all child paths and internal callers updated. Separate change.
3. **Explore absorbs** — Explore page grows a time-range lens (the current Timeline view's `since`/`until` semantics) and a "see in Explore" link from the Search records section; records-section of `/dashboard/search` is removed once Explore covers the query lens. Separate change.

Splitting them is deliberate. Tranche 1 is a route mount + nav copy + redirect — small blast radius, immediately useful, no public-URL retirement. Tranche 2 retires a public URL prefix and touches many internal links; it should ship behind redirects and a careful audit pass. Tranche 3 changes which surface owns records-text-query; it requires a UI composition pass on the Explore view plus a careful Search-page slimming and should be designed with the time-range mode visible.

## Why a new top-level route and not just a nav reshuffle

The existing route at `/dashboard/records/explorer` carries the breadcrumb `Records / Explorer`. Promoting Explore in nav without moving the route would leave the page chrome saying "you are inside Records," which contradicts the IA shift. Mounting a fresh route at `/dashboard/explore` lets the breadcrumb, the page header, and the top-level nav agree.

The redirect at `/dashboard/records/explorer` ensures existing deep links, bookmarks, and any internal references that pre-date this change continue to land on the explorer. The Records subnav also retains its `Explorer` entry during the transition (pointing at the new top-level path), so an owner navigating from the Connectors list still finds the explorer.

## Why not move the page wholesale and drop the old route now

`add-dashboard-records-explorer` is recently shipped. There are tests, docs, and likely external references to `/dashboard/records/explorer`. Issuing a redirect rather than a 404 protects those callers. The redirect is non-permanent so the path can be removed in a later tranche when Records becomes Connections and the entire subtree relocates.

## Why Connections rename and Timeline absorption are deferred

- The Connections rename retires a public URL prefix used by the records index, per-connector page, per-stream page, per-record page, and the stream-health route. It touches `routes.ts`, the shell subnav, the `dashboardRoutes.section.records*` keys, every `routes.section.records` consumer, every `routes.connector`/`stream`/`record`/`streamHealth` consumer, and any Next.js redirect entries. That is a coherent slice, but it deserves its own change so the rename, the redirects, and the internal call-site sweep can be reviewed as one tranche.
- Explore-absorbs-Timeline means giving the Explorer view a time-range mode. The current Explorer's empty-query feed is recency-sorted by a bounded fan-out per connection; the Timeline view loads a date-range window from a separate timeline data source. Composing them requires either a new mode toggle on Explore or a shared underlying loader, and the result interacts with the existing search lens, the warning surface, and the peek panel. That is real UI work and benefits from being designed once we see the top-level route in use.

Both deferrals are written into this change's spec delta as scenarios so a future reader can find the direction without re-reading commit history.

## Scope of this change

In scope:

- Add `/dashboard/explore` route in `apps/web` and `apps/console` that renders the existing `RecordsExplorerView` with the same data wiring and breadcrumb update (`Explore` as the page label rather than `Records / Explorer`).
- Add `routes.section.explore` to the shared `Routes` interface so the live and sandbox bindings agree.
- Add `Explore` to the top-level nav between `Search` and `Traces`.
- Issue a `next.config.mjs` non-permanent redirect from `/dashboard/records/explorer` → `/dashboard/explore` (and the same in `apps/console/next.config.mjs`).
- Keep the Records subnav entry for `Explorer`, pointing at the new top-level path so the subnav and top-level nav reach the same place.
- Update the explorer page's `DashboardShell active` from `records` to `explore` and add `explore` to the `DashboardSection` union so the top-level nav lights up correctly when the user is on Explore.

Out of scope:

- Renaming Records → Connections.
- Adding a time-range mode to the Explorer.
- Removing the records section from `/dashboard/search`.
- Any change to RS or `_ref` endpoints.
- Any change to the consent / disclosure surface.
- Any change to the sandbox shell.

## Acceptance checks

- `/dashboard/explore` resolves and renders the records explorer with the top-level nav `Explore` entry highlighted (not `Records`).
- `/dashboard/records/explorer` issues a redirect to `/dashboard/explore`; deep links with query params (`?q=...&connection=...&peek=...`) round-trip through the redirect with their query string intact.
- The Records subnav still shows an `Explorer` entry; clicking it lands on `/dashboard/explore`.
- The top-level nav contains `Explore` between `Search` and `Traces`. The mobile drawer and command palette inherit it.
- `pnpm -C apps/web run types:check` passes.
- `pnpm -C apps/console run types:check` passes.
- `openspec validate promote-explore-to-top-level-ia --strict` passes.

## Open questions and follow-ons

- Q: Should the redirect be permanent (`308`) once the top-level Explore route has been live for a release? — Defer to the Connections-rename tranche; if `/dashboard/records/*` is retired entirely, a single permanent redirect block can cover the whole subtree.
- Q: Should the page-level `breadcrumbs` array still mention Records once Explore is top-level? — The page should set breadcrumbs to `[{ label: "Explore" }]` at the top level (no parent), matching the Search and Traces pages. Records-only callers that want a `Records → Explorer` framing can be addressed when Records becomes Connections.
- Q: Is `/dashboard/explore` the final noun, or should it be `/dashboard/data`? — `/dashboard/data` was the pre-v1 dashboard URL (we already redirect it to `/dashboard/records` in the records IA migration). Reintroducing it would conflict with that redirect chain. `/dashboard/explore` is the durable noun.
