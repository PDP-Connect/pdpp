## Why

The records explorer added by `add-dashboard-records-explorer` ships at `/dashboard/records/explorer`, buried under the Records subnav. Operator-console feedback and designer intent agree that records-as-substrate browsing is a top-level concern of the console — co-equal with Search, Traces, Grants, and Runs — not a subentry of Connectors. Owners who land on the dashboard to "look at my data" reach for a top-level surface, and the current location forces them to navigate Connectors → Explorer or Connectors → Timeline first.

Two adjacent IA pressures are surfaced but not resolved here:

- The current `/dashboard/records` index is in practice a Connections list (one row per concrete `connection_id`, with display name and connector type). The noun "Records" is overloaded: it names both this index and the record envelopes themselves. The full-context noun model already settled on `connection` as the load-bearing word for "owner-facing configured source," and `connections` is the honest label for the index.
- The records-explorer view, the records-timeline view, and the records section of `/dashboard/search` are three angles on the same substrate — text query, recency facet, time-range scope — currently maintained as three separate surfaces with three separate route trees.

This change promotes Explore to a top-level operator-console route, preserves the existing Explorer behavior in place, and writes down the follow-on IA tranches (Connections rename, Explore as the records query/timeline canvas, spine-only Search) so the next worker can take them without re-deriving the direction.

## What Changes

- Add a top-level `/dashboard/explore` route that mounts the existing records-explorer view, with identical query-param contract (`q`, `connection`, `stream`, `peek`) and identical underlying RS / `_ref` reads as `/dashboard/records/explorer`.
- Add `Explore` as a top-level navigation entry between `Search` and `Traces`. The Records subnav keeps its `Explorer` link pointing at the same view during the transition; visitors arriving via either path see the same page.
- Issue a non-permanent redirect from `/dashboard/records/explorer` to `/dashboard/explore` so deep links continue to work and bookmarks land on the top-level path.
- Mirror the route, redirect, and nav addition under `apps/console` so the live `pdpp.vivid.fish` deployment ships them, matching the operator-console parity pattern already established by `add-dashboard-records-explorer` task 8.
- Document the next IA tranches as deferred but committed direction:
  - the records index at `/dashboard/records` becomes a Connections index at `/dashboard/connections`, with the per-connection drilldown trees moved accordingly;
  - the records-timeline view and the records section of `/dashboard/search` are absorbed into Explore as additional lenses (time-range scope and `?q=` deep links), with the spine artifact jump (traces, grants, runs) remaining the responsibility of `/dashboard/search`;
  - these tranches require their own OpenSpec changes because they rename a public dashboard URL prefix (the Records subtree), they change which surface owns spine vs records browsing, and they have broader blast radius than a single route mount.

This change does NOT alter any RS or `_ref` contract, does NOT invent UI affordances for unsupported backend behavior, and does NOT remove `/dashboard/records/explorer` (the route still resolves, via the redirect). It does NOT introduce a Connections route in this tranche; that follow-on is documented but deferred.

## Capabilities

### Modified

- `reference-implementation-architecture`: promotes the records explorer to a top-level operator-console route, while preserving the existing requirement that the explorer reads only through canonical public RS and existing `_ref` endpoints.

## Impact

- Affects the live `/dashboard/**` operator console only. No change to the sandbox shell, the protocol, the public RS contract, the `_ref` contract, or any backend behavior.
- Existing deep links to `/dashboard/records/explorer` continue to work via redirect; subagents and docs that link the deep URL keep working.
- Operator-console nav grows by one top-level entry. Mobile drawer and command palette inherit the entry through the existing `routes.section` plumbing.
- Ships in both `apps/web` and `apps/console`, matching the parity established by `add-dashboard-records-explorer`.
- The follow-on Connections rename and Explore-absorbs-Timeline tranches are NOT in scope here and require their own OpenSpec changes before implementation.
