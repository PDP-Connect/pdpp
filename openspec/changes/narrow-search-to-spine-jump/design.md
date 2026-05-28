# Narrow Search To Spine Jump — Design

## Context

After the `promote-explore-to-top-level-ia` and
`absorb-timeline-into-explore-ia` archives shipped, `/dashboard/explore`
became the canonical record-exploration surface: recency, time-range, and
search lenses on one canvas, connection-identity preserving, with structured
warnings for partial fan-in and capability downgrades.

`/dashboard/search` was not pruned at the same time. It still renders:

1. Artifact buckets for traces, grants, and runs from the spine search
   (`refSearch` → `GET /_ref/search`), with an exact-id auto-redirect when
   `jump=1`.
2. A second record-results section that calls the public lexical, semantic
   (uplift), and hybrid retrieval endpoints, with its own pagination, its own
   retrieval-state notices, its own semantic / hybrid badges, and a debug
   pane.

Section (2) duplicates the search lens of Explore. The two surfaces don't
even produce identical results: Search has its own cursor pagination, its
own per-page semantic uplift cap, and shows hybrid + semantic + lexical
provenance badges that Explore doesn't surface. Two operator-visible record-
search surfaces with different chrome is exactly the IA split the owner
named as the remaining gap.

## Goals

- Restore Search to a single, well-scoped responsibility: spine artifact
  lookup (traces, grants, runs, by id and prefix).
- Concentrate record content search on Explore. Operators have one place to
  go when they want to find records by text.
- Preserve all existing deep links and command-palette flows: nothing 404s
  after this change; free-text submits land on Explore instead of a
  duplicate page.
- Make no protocol or backend change. The public lexical / semantic / hybrid
  endpoints stay exactly as they are.

## Non-Goals

- Renaming `/dashboard/records/*` to `/dashboard/connections/*`. That
  remains the separate, larger `rename-records-to-connections-ia` tranche
  named in prior closeouts.
- Inventing a new spine search backend or extending `/_ref/search`. The
  spine response shape is unchanged; only the dashboard's record-search
  call is removed.
- Adding new pagination, sort, or filter capabilities to Explore's search
  lens. Explore's existing `?q=` behavior is the carrier; if operators want
  cursor pagination over search hits, that is its own future change.
- Adding a new entry to the public protocol for "search this record by id"
  or merging spine and record search. Spine and record search remain
  separate read endpoints; only their dashboard consumption is
  consolidated.

## Two Viable Shapes

Both shapes are compatible with the proposal and the spec deltas below. The
implementation tranche picks one based on owner judgment after a brief
review.

### Shape A: Search nav stays, label clarifies role (recommended)

- `/dashboard/search` continues to exist at the same URL.
- The top-level nav entry stays in the same position but the label changes
  to `Jump` (or similar) to signal the spine-id scope.
- The command palette retains a primary `Search` (or `Jump`) shortcut.
- Free-text submits redirect to Explore.

Why recommend it: muscle memory is preserved (operators still know where to
go to type an id), the URL keeps working, and the IA reads honestly. The
downside is a nav label diff every operator has to learn once.

### Shape B: Search nav retired, command palette becomes the sole entrypoint

- Top-level Search nav entry removed entirely.
- `/dashboard/search` URL still works (for deep links and the palette).
- The command palette is the primary access path for typing an id.
- A small banner on Search explains "type an id to jump; for record search,
  use Explore".

Why consider it: the simplest IA — Explore is *the* exploration surface,
period. The downside is a steeper UX change and the lack of an obvious
visual entrypoint for new operators who don't yet know about the command
palette.

The proposal authorizes either shape. The implementation worker should
state which shape they chose in the implementation tranche report.

## Spec Approach

The spec delta lives in `reference-implementation-architecture` because that
capability already owns the dashboard IA requirements
(`promote-explore-to-top-level-ia`, `absorb-timeline-into-explore-ia`,
`Reference dashboard exposes a records explorer surface`).

The delta MODIFIES the existing `Reference dashboard exposes a records
explorer surface` requirement (scenario `The explorer does not replace the
cross-artifact search page`) because that scenario currently says "owner
needs to jump to a trace, grant, or run by id … that flow SHALL remain at
`/dashboard/search`" — which stays true — but its companion sentence about
the explorer being reachable from the Records subnav references a subnav
that was removed by the prior closeout. Cleaning that up is in scope so the
spec stops describing UI that does not exist.

The delta ADDS a new requirement: "Reference dashboard SHALL scope Search
to spine artifact jumps." It carries the WHEN/THEN scenarios for
spine-only behavior, the redirect to Explore on free-text, and the
preservation of `jump=0` opt-out behavior.

## Acceptance Checks

The implementation tranche SHALL prove (and the spec scenarios SHALL
require) that, after the change:

1. `GET /dashboard/search?q=tr_<id>&jump=1` for a real trace id resolves to
   a 307 to `/dashboard/traces/tr_<id>`.
2. `GET /dashboard/search?q=alpha&jump=1` for a free-text query that does
   not match a spine id resolves to a 307 to `/dashboard/explore?q=alpha`.
3. `GET /dashboard/search?q=alpha&jump=0` renders the spine buckets only
   (no record-results section), with the empty-state hint pointing at
   Explore.
4. The page no longer calls `GET /v1/search`, `GET /v1/search/hybrid`, or
   `GET /v1/search/semantic`. Asserted by a grep test on `search/page.tsx`.
5. The shared `SearchView` no longer exports `RecordRow`, `RetrievalBadge`,
   `PaginationBar`, `RetrievalNoticeCallout`, `Highlight`, or `SearchData`
   fields specific to record results (`hits`, `hasMore`, `nextCursor`,
   `prevStack`).
6. The sandbox `/sandbox/search` surface mirrors the same behavior with the
   deterministic mock spine.
7. `pnpm -C apps/web run types:check` and `pnpm -C apps/console run
   types:check` are clean.
8. The mock-owner shell parity test still passes (`/dashboard` and
   `/sandbox` parity preserved).

## Risks

- **Operator who knew the Search retrieval debug pane.** The
  `?debug=1` overlay surfaced internal retrieval state (lexical vs
  semantic vs hybrid counts, dedupe counts, semantic backend status). That
  was a private inspection tool for the implementer, not a documented
  operator surface. Anyone who depended on it can re-add an equivalent
  overlay to Explore as a separate change.
- **Operator who used the Search cursor pagination over record hits.**
  Explore's search lens does not currently paginate hits beyond the
  fan-out cap. Operators who genuinely need cursor-paginated record
  search results SHALL surface that as a follow-on Explore enhancement.
  Until then, the lexical endpoint is callable directly under the owner
  token for the rare ad hoc case.
- **Spec staleness from the prior tranches.** The existing
  `reference-implementation-architecture` spec contains scenarios that
  reference a Records subnav that was removed in the prior closeout
  (`ri-explorer-unified-ia-closeout`). The delta cleans up the scenarios
  that directly conflict with this change; broader spec cleanup of
  archived-IA leftovers is its own follow-on.

## Alternatives Considered

- **Add records-section search to Explore that mirrors Search's pagination
  and badges.** Rejected: the goal is to converge, not duplicate behavior
  in the other direction. Explore can grow more record-search UX, but
  doing it before retiring the Search records section just creates three
  surfaces instead of two.
- **Keep the records section on Search but mark it deprecated with a
  banner.** Rejected: deprecation banners that stay forever are worse than
  cleaning up. The spec deltas here are deliberately small enough to ship
  one tranche.
- **Remove the spine search from Search and merge everything into
  Explore + command palette.** Rejected for this change because it
  changes more than the IA gap the owner named — it also retires the
  `/dashboard/search` URL and the existing spine deep links. That belongs
  to a later change if the team decides to go further.
