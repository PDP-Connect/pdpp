## Why

The reference dashboard exposes two top-level surfaces that both try to be the
record-exploration product: `/dashboard/explore` (the connection-aware records
canvas with query, recency, and time-range lenses) and `/dashboard/search`
(which renders artifact buckets for spine jumps and then a paginated record
results section that re-implements lexical, semantic-uplift, and hybrid
retrieval).

The Search records section duplicates Explore's search lens. Two distinct
top-level surfaces compete for the same operator intent (`I want to find records
that mention this string`), with different chrome, different result shapes,
different pagination semantics, and different connection-identity handling.
This is the IA drift the prior closeout reports (`ri-explorer-unified-ia-closeout`,
`ri-explorer-unified-ia-owner-fix*`) explicitly named as the remaining IA
work, and the owner has confirmed the target shape: Search should not compete
as a second data-exploration surface; if retained, it should be a jump/spine
lookup utility with clear scope.

`promote-explore-to-top-level-ia` and `absorb-timeline-into-explore-ia`
deliberately deferred Search-records retirement to a separate change because
narrowing Search changes an operator-visible behavior reviewers should be able
to audit later: today an operator who types `payroll` into Search lands on a
record-results page; after this change, they land on Explore with the query
applied. That is a durable IA decision, not a one-off bug fix, so it goes
through OpenSpec.

## What Changes

- The `/dashboard/search` page SHALL narrow its scope to spine artifact lookup
  only: exact id jumps for traces, grants, and runs via `GET /_ref/search`,
  plus the existing prefix/text matches for those artifact buckets in the
  spine response.
- `/dashboard/search` SHALL NOT call `GET /v1/search`, `GET /v1/search/hybrid`,
  or `GET /v1/search/semantic`; SHALL NOT render a record results section;
  and SHALL NOT show semantic / hybrid retrieval notices.
- When a user submits a free-text query that does not resolve to a spine
  artifact, `/dashboard/search` SHALL redirect to
  `/dashboard/explore?q=<query>` (using existing per-route Explore behavior),
  not render a competing record-results page.
- The `Search` top-level navigation entry SHALL be relabeled to make its
  spine-jump role explicit (recommended label: `Jump`; mockup-only — final
  label is a UX call in the implementation tranche). The nav entry remains a
  top-level peer of `Explore` so the muscle memory of `⌘K → Search` stays
  intact; the implementation tranche MAY instead retire the top-level nav
  entry in favor of command-palette-only access if the implementer prefers,
  provided the command palette and search-id deep links keep working.
- The command palette `Search` shortcut SHALL continue to land at
  `/dashboard/search` (or its renamed equivalent). The `?q=` free-text submit
  from the command palette SHALL submit to `/dashboard/search?q=...&jump=1`;
  when the query does not resolve to a spine id, the page redirects to
  Explore as above.
- The records section of the Search page (lexical pagination, retrieval
  notice, semantic-uplift badge, hybrid badge, debug pane) and its dependent
  helpers in `search/page.tsx` (`searchRecords`, `RecordPage`,
  `RetrievalDebug`, the timestamp-metadata fetcher reused only here, the
  `dedupeWarnings` adapter in the console app) SHALL be removed.
- The shared `SearchView` component SHALL be slimmed to render only spine
  artifact buckets (traces, grants, runs) and the empty-state hint. The
  unused `SearchFiltersForm` component (already dead code) SHALL be removed
  in this tranche.
- The sandbox `/sandbox/search` surface SHALL mirror this scope: spine
  artifact buckets via the deterministic mock spine, no record-results
  section, with the same redirect-to-Explore behavior on free-text submit.
- `/dashboard/search?q=<artifact-id>&jump=0` SHALL still render the
  spine-only results without auto-redirect (the existing opt-out for users
  who want to inspect what matched).
- This change SHALL NOT modify any RS or `_ref` read contract. `GET /v1/search`,
  `GET /v1/search/hybrid`, `GET /v1/search/semantic`, and `GET /_ref/search`
  remain unchanged; only the dashboard's consumption of them changes.
- This change SHALL NOT alter Explore's existing search behavior. Explore
  already calls `searchRecordsHybrid` and `searchRecordsLexical` through its
  shared assembler; that path is the canonical record-search surface after
  this change.

## Capabilities

### Modified

- `reference-implementation-architecture` — narrows the dashboard Search
  surface to spine artifact lookup, designates Explore as the sole
  record-search surface for owner-token retrieval, and reaffirms that the
  public lexical / semantic / hybrid retrieval endpoints remain unchanged.

## Impact

- Affects `/dashboard/search` and `/sandbox/search` only at the page level.
  No protocol change. No backend handler change. No grant or manifest change.
- Existing free-text search URLs (`/dashboard/search?q=alpha`) continue to
  resolve — they land on Explore instead of a Search-records page. Spine
  artifact deep links (`/dashboard/search?q=tr_...&jump=1` redirecting to
  `/dashboard/traces/tr_...`) continue to work unchanged.
- The command-palette free-text submit (`/dashboard/search?q=...&jump=1`)
  continues to work: if the query resolves to a spine id, redirect to that
  artifact; otherwise redirect to Explore.
- Removes ~200 lines of duplicated retrieval handling from
  `apps/web/src/app/dashboard/search/page.tsx` and the parallel
  `apps/console` page. Removes `SearchView`'s records section and the
  `RetrievalNoticeCallout`, `PaginationBar`, `RecordRow`, `RetrievalBadge`,
  and `Highlight` subcomponents from `search-view.tsx`. Removes the dead
  `search-filters-form.tsx` from both apps.
- Updates `apps/web/src/app/dashboard/lib/actions.ts`: the `nav-search`
  command's description SHALL describe spine-jump scope ("Search traces,
  grants, runs, and connectors by id"), not record content.
- The retired records section had its own UX state (cursor pagination via
  `prev` stack, hybrid/semantic notice surfaces). Explore's existing
  pagination is per-stream peek navigation; bulk record search results
  appear in Explore's `?q=` lens. Operators who depended on Search's
  cursor-paginated record results SHALL find equivalent functionality in
  Explore's search lens, which already supports pagination through the
  RecordsExplorer's existing controls.
- Out of scope: the `/dashboard/records` → `/dashboard/connections` URL
  rename (separate deferred change). The `routes.section.search` field
  stays at `/dashboard/search` until that rename, even if the nav label
  becomes `Jump`.
