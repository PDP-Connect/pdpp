# Explore redesign — RECOMPOSITION spec (the structural work under-scoped in the first deploy)

The first deploy shipped the BEHAVIORAL slices (sans input, zero-results routing, 3-zone chips, autocomplete)
but PATCHED them onto the old toolbar instead of RECOMPOSING to the prototype's structure → live ~35/60, not
the approved 53/60. This spec is the grounded decomposition (real line numbers in the impl worktree
/home/tnunamak/.tmp/pdpp-explore-redesign) so the recomposition reassembles existing pieces to match
prototype/final/feed-desktop.html — NOT net-new behavior.

Tim's direction (2026-06-23): build the real recomposition to hit 53/60; partial is net-positive but NOT final;
declare the live-stack mutex + coordinate with Codex's MCP tranche before ANY redeploy (whoever lands first, the
other rebases onto that deployed tip).

## Current structure (explore-canvas.tsx FeedControls, lines 1025-1098) — what exists
- `rr-x-controls`
  - `rr-x-searchrow`: <QueryInput …/> (already has value-aware autocomplete + counts) + a REDUNDANT
    `Search` button (1048-1050) + `rr-x-sort` cluster newest/oldest (1051-1069)
  - `rr-x-ranges` (1072-1094): today/7d/30d/all buttons + `operators` <details> popover + <CopyViewLinkButton/>
  - <ActiveFilterChips chips onClearAll/> (1096) — already 3-zone, already mobile horiz-scroll
- Facet RAIL: StreamFacets / SourceFacetGroup / ConnectionFacets / FacetRow (1084-1298) — a collapsible
  <details> left rail; ALREADY carries per-source + per-stream loaded counts.
- The peek/detail, day grouping, Upcoming, zero-results routing are all already correct.

## Target structure (prototype/final/feed-desktop.html) — what it must become
- Left SIDEBAR (always-visible on desktop, sheet on mobile): VIEWS (Explore N, Upcoming N) + SOURCES grouped
  w/ live counts — a calm sidebar, NOT a collapsible grey "Filters" blob.
- Main: ONE command-bar (just the search input; NO separate Search button) → chip strip → saved-view tabs → feed.
  Sort + ranges + operators + copy-link are PROGRESSIVE-DISCLOSED (a single quiet control), not a flat toolbar row.
- Placeholder: "Search or filter…" (not the "…or paste a record id…" paragraph).

## THE RECOMPOSITION (R1-R5), risk-ordered
- **R1 (small)**: remove the redundant `Search` button (canvas 1048-1050). QueryInput commits on Enter already.
- **R2 (small)**: placeholder copy → "Search or filter…" (find in QueryInput's IcInput placeholder prop).
- **R3 (medium)**: collapse the toolbar — move sort(newest/oldest) + ranges(today/7d/30d/all) + operators popover
  + copy-link OUT of the flat `rr-x-searchrow`/`rr-x-ranges` rows into ONE quiet progressive-disclosure control
  (a "Sort / filter" or "⋯" popover anchored right of the search input). Result: the bar is search-input + one
  small control. Match the prototype's calm single row. Keep ALL functions (sort/range/operators/copy) reachable.
- **R4 (medium-large)**: the facet RAIL → the prototype's SIDEBAR. Reuse StreamFacets/SourceFacetGroup data
  (counts already there); restyle from collapsible `<details>` "Filters" rail into the calm always-visible
  desktop sidebar + VIEWS header; on mobile it's a sheet (the existing "Filters" details can BE the sheet, just
  restyled). Mostly CSS + small markup move; do NOT rebuild the facet logic.
- **R5 (large, OPTIONAL/last)**: saved-view tabs above the feed — localStorage-backed named queries
  ("All · Money · Messages · This week · + Save view"). Net-new; lowest value; can defer.

## Gate (per the established pattern)
console tsc + the named explore *.test.ts (page.invariants is strictest — reads components.css + canvas source;
UPDATE its assertions if a class/structure it pins moves) + ultracite + git diff --check. Then Codex review +
the SHARED-branch deploy dance (mutex, cherry-pick onto current deploy HEAD, read-evidence+mcp-server+openspec
gates) + LIVE RE-WALK re-scoring ALL 12 dims AGAINST THE PROTOTYPE (verify-before-claiming: look at the live
pixels, don't trust bundle-grep alone). Loop until live actually matches prototype/final.

## Verify-before-claiming (the guardrail from this turn)
- After building: re-walk the LIVE site vs prototype/final/*.png and re-score all 12 dims. The deploy is only
  "the redesign" when the live toolbar is gone, the sidebar is there, the bar is one input. Bundle-class greps
  are necessary-not-sufficient.
- After any tmux send to Codex: capture-pane to confirm it submitted (chips need a 2nd Enter).
