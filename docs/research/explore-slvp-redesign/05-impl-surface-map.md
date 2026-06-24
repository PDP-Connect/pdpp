# Explore SLVP redesign — implementation surface map (2026-06-23)

Read-only reconnaissance of the DEPLOYED tree (`/home/tnunamak/.tmp/pdpp-deploy`, HEAD 50294f00).
Maps where each redesign piece lives + a risk-ordered slice sequence. Build in
`/home/tnunamak/.tmp/pdpp-explore-redesign` (branch workstream/explore-redesign, off 50294f00).

## Key files (absolute, in the IMPL worktree substitute pdpp-explore-redesign for pdpp-deploy)
- Canvas: `apps/console/src/app/dashboard/explore/explore-canvas.tsx` (2715 lines)
- Grammar: `apps/console/src/app/dashboard/explore/explore-grammar.ts`
- Typeahead logic: `apps/console/src/app/dashboard/explore/explore-query-input.ts`
- URL builders: `apps/console/src/app/dashboard/explore/explore-navigation.ts`
- CSS (all rr-x-*): `packages/pdpp-brand-react/src/components.css` (rr-x starts line 1541)
- Tokens: `packages/pdpp-brand/ink-carbon.css` (--font-sans/mono, --foreground/muted-foreground/primary — ALREADY CORRECT)
- Assembler: `packages/operator-ui/src/explore/explore-data-assembler.ts` (assembleExplorerData @ 2492)
- Record preview: `packages/operator-ui/src/lib/record-preview.ts`
- STRICTEST GATE: `apps/console/src/app/dashboard/explore/page.invariants.test.ts` (reads components.css directly — asserts class/text/CSS patterns; UPDATE when CSS changes)

## Canvas component map (explore-canvas.tsx)
- buildFilterChips 339–385 (derives chips; single-zone today) · QueryInput 466–658 (the unified combobox: IcInput.rr-x-search + typeahead) · ActiveFilterChips 796–820 (chip bar, label+× only) · FeedControls 838–956 (toolbar) · SearchHeader 967–1032 · FacetRow/ConnectionFacets/SourceFacetGroup/StreamFacets 1084–1298 (rail) · kindGlyph/FeedRow 1299–1525 (row: glyph + rr-x-row__title + snippet + attr + time) · BurstRow 1526–1604 · FeedDays 1605–1706 (day groups; ZERO-STATE = rr-x-empty @ 1614–1626) · UpcomingSection 1716–1841 · FeedBody 1844–1984 · ExploreCanvas 1987–2715 (root).

## THE TWO CSS BUGS (Slice 1)
1. **Mono search input**: `.pdpp-input` (components.css ~310) sets `font-family: var(--font-mono)`. IcInput renders `<input class="pdpp-input rr-x-search">`. `.rr-x-search` (1881) + `.rr-x-queryinput .rr-x-search` (1990) set layout only, never font-family → input renders MONO. FIX: add `font-family: var(--font-sans)` (+ size 0.875rem) at `.rr-x-queryinput .rr-x-search` (1990).
2. **Row title weight**: `.rr-x-row__title` (2618–2626) = weight 600; target = 500 (authored) / 400 muted (.is-derived @ 2630–2633, already correct). Snippet (2635+) is sans (inherits) — verify no mono leak. row__time uses tabular-nums not mono (correct). typeahead__op is mono (correct — operator tokens).

## What data ALREADY exists vs net-new
- EXISTS: per-connection + per-stream loaded "in view" counts (ExplorerConnectionFacet / SourceStreamGroup). Negation grammar (-con:/-stream:, facet "is not"). plainSnippetText. detectSingleStreamDoor escape ramps.
- MISSING (net-new): QuerySuggestion has NO count field + no SEARCH-fallback item + no section headers + no value-aware date completion. No 3-zone chip structure (single label+×). No saved-views concept ANYWHERE (Slice 6 = net-new, lean localStorage-only). Zero-results is client-side rr-x-empty (no routing).

## SLICE SEQUENCE (recommended order: 1 → 5 → 4 → 2 → 3 → 7 → 6; risk-reducing-first)
| # | Slice | Files | ~Lines | Risk | Gate |
|---|-------|-------|-------:|------|------|
| 1 | CSS type-scale (kill mono-input + title weight 600→500) | components.css | ~6 | small | tsc+ultracite+page.invariants (update font assertion) |
| 5 | Row spacing / content-led anatomy (52px row, 16px day gap, header spacing) | components.css | ~10 | small | page.invariants+visual |
| 4 | Zero-results ROUTING (replace rr-x-empty @1614 w/ escape ramps: widen-window, clear-all, browse-all; build hrefs w/ buildNavigateHref) | explore-canvas.tsx, components.css | ~60 | small-med | acceptance.test (update copy) |
| 2 | 3-zone chips (buildFilterChips emits {label,value,canNegate,negated,negate(),clear()}; ActiveFilterChips renders 3 zones; click-to-negate uses existing -prefix grammar) | explore-canvas.tsx, components.css, explore-grammar.ts | ~80 | med | grammar.test+codex-hold.test |
| 3 | Autocomplete depth (QuerySuggestion +count; thread facet counts into buildTypeaheadSuggestions; SEARCH-fallback item last; section labels) | explore-query-input.ts, explore-canvas.tsx, components.css | ~120 | med | query-input.test (new cases) |
| 7 | Mobile chip strip + peek H1 (media query ≤860px horiz-scroll chip strip; H1 size) | components.css | ~20 | small | visual |
| 6 | Saved-view tabs (NET-NEW; lean localStorage client-only — tabs = named saved queries, NO assembler change) | explore-canvas.tsx, explore-navigation.ts, components.css | ~200 | large | new invariant tests |

## Gate per slice
`pnpm --dir apps/console types:check` (next typegen+tsc) + `pnpm --dir apps/console check` (ultracite) + `pnpm --dir apps/console build` + the named explore test files via `node --test --import tsx <file>` (NOT a named script). page.invariants.test.ts is strictest — it reads components.css and asserts patterns; any CSS class/font change must update it. Plus Codex (waspflow gpt-5.5) end-review per slice.

## NOTES
- Tokens need ZERO change (already Schibsted Grotesk / JetBrains Mono / correct colors). Redesign = CSS rule reassignment + component changes.
- The prototype/final/ is the visual contract — match those pixels.
- Honesty invariants carry (count==reachability, declared-or-generic, mono-only-for-machine-values).
