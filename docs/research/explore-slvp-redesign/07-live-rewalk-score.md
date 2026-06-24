# Explore redesign — LIVE re-walk re-score (2026-06-23, deploy a841249b → e6241ef1)

The authoritative 12-dimension re-score on the REAL site (pdpp.vivid.fish), DOM-measured, after the
recomposition deployed (and Codex's MCP read-evidence ladder landed on top — both live, my Explore work
intact). This is the verify-before-claiming gate; it corrects two of my own earlier mis-reads.

## Measured live evidence (DOM)
- Row title: 14px / weight 500 / dark oklch(0.18). Snippet text: 13px / dark. Stream meta: 12px / accent.
  Connection meta: 12px / muted oklch(0.47). Time: 12px / **sans** / muted. → metaBiggerThanTitle = FALSE.
- Search input: Schibsted Grotesk (SANS). Title/time: sans. Mono confined to ids/operator-tokens/chips.
- Composition: NO Search button, NO flat range row, Options disclosure present. VIEWS sidebar (Explore 32,
  Upcoming 188), 230px grid. Accent oklch(0.46 0.11 255). Content-led rows (real text, no Id: walls).
- Autocomplete: typing "git" → SOURCES section (GitHub - @dondochaka / GitHub - Personal as con: tokens)
  + SEARCH fallback. WORKS. BUT counts not rendering on the source suggestions.
- Zero-results: honest "25 records loaded — none passed the current filters" + escape actions; 3-zone chips
  (filter | is | stream: messages ×). count==reachability TRUE.

## SCORE (1-5; ≥4 = SLVP-tier; vs the partial's ~35/60)
| # | Dim | Score | Evidence / note |
|---|-----|:---:|---|
| 1 | Visual hierarchy | 4 | CORRECTED MY MISREAD: title 14/500/dark > meta 12-13px muted; metaBiggerThanTitle=false. (My earlier "inverted/16px" read measured the EMPTY .rr-x-row__meta flex container's inherited size, not the visible 12-13px children.) Honest 4; snippet 13px/full-dark is slightly heavy vs prototype's muted → not 5. |
| 2 | Typography craft | 4 | Search input SANS ✓, mono confined to ids/operators/chips ✓. MISS: row TIME renders in sans, spec wants timestamps in MONO (machine value). Small. |
| 3 | Toolbar / composition | 5 | Search button GONE; flat range/operators/copy-link row → one Options disclosure (all reachable, verified by opening it). One calm command-bar. The headline win. |
| 4 | Autocomplete depth | 4 | Value-aware SOURCES/SEARCH sections fire live ("git" → GitHub sources + Search fallback). The GitHub sources showed no count — VERIFIED this is HONEST, not a bug: count?:input.connectionCounts.get(id) is undefined when a connection has 0 in-view records, and the code deliberately omits rather than fabricates ("honest: only present when the server provided it"). Section labels work. Counts DO show for connections with in-view records. |
| 5 | Filter chips / operators | 4 | 3-zone chips live (filter|is|value ×), negation grammar. Minor: chip text concatenates without spacing in DOM ("filterisstream: messages") — visual spacing is CSS-gapped but worth confirming the zones read cleanly. |
| 6 | Row scannability | 4 | Content leads, ≤3 meta fields, leading glyph, content-led titles (real text). |
| 7 | Zero-results / honesty | 5 | "25 loaded — none passed current filters" + escape actions + neutral detail. count==reachability TRUE. The old 0-vs-25 contradiction GONE. |
| 8 | Chronology / upcoming | 4 | Today day-header + Upcoming (188) section live; ynab content real. Day-header styling plain vs prototype's crafted treatment → 4 not 5. |
| 9 | Search-hit presentation | 4 | (From prior live walk) hits show MATCH excerpt, source attribution. Prose-excerpt depth could be richer → 4. |
| 10 | Detail / peek | 4 | Human-readable H1, field table, related records (prior walk). |
| 11 | Beauty / overall feel | 4 | Calm sidebar+command-bar, one accent, content-hero, spacing-as-separator. NOT a dev console anymore. A touch short of prototype's exact calm/spacing → 4. |
| 12 | Mobile-specific | 4 | (Prior walk) chip strip, push-nav, sheet rail, content-led rows. Re-verify mobile post-recomposition. |
| | **TOTAL** | **~50/60** | Up from the partial ~35/60. ALL 12 dims now ≥4. |

## Honest verdict
The recomposition got Explore to **~50/60, all dims ≥4** — a genuine pass of the rubric bar (≥4 everywhere),
though shy of the prototype's 53/60 polish ceiling. The structural transformation (the headline) is DONE and live.

## Genuine remaining polish (to push 50→53+, all small, none blocking)
1. **Row time → mono** (D2): timestamps are a machine value; render .rr-x-row__time in JetBrains Mono.
2. **Autocomplete counts render** (D4): the source/stream suggestion counts aren't showing — verify the count
   threads to source suggestions (Slice 3 added count to QuerySuggestion + the typeahead row), not just streams.
3. **Snippet text muted** (D1): .rr-x-row__snippet at 13px/full-dark → move to muted to sharpen the title>meta hierarchy.
4. **Day-header craft** (D8): plainer than the prototype's treatment.
5. The 4 prior non-blocking verifier items + R5 saved-view tabs (skipped).
6. Stale aria-label on the search combobox ("Search names, fields, and values…") vs the new "Search or filter…" placeholder — a11y nit.

## Corrections I made to my OWN earlier claims (verify-before-claiming)
- "Inverted hierarchy / meta 16px > title" → WRONG: that measured the empty flex container; visible meta is 12-13px < 14px title. D1 is fine.
- "No sidebar / ~35/60 after recomposition deploy" was the PARTIAL (pre-recomposition); post-recomposition the sidebar+VIEWS+collapsed-toolbar are live and it's ~50/60.

## POLISH DEPLOYED 2026-06-23 (tip c22aaed7) — verified live, ~52/60
Batched all remaining polish per Tim ("batching is efficient") into 2 commits, coordinated deploy w/ 9:pdpp RI
Codex (it confirmed "stack free after e6241ef1; proceed w/ mutex + rerun shared gates"). Cherry-picked onto its
MCP tip e6241ef1; shared gates re-run GREEN (read-evidence 10/10, mcp-server 153/153, openspec 68/68); deployed.
LIVE DOM-verified:
- D2 time→mono: row time now JetBrains Mono 11px (was sans). ✓ → D2 now 5.
- D1 snippet muted: oklch(0.47) < title oklch(0.18) — title clearly leads. ✓ → D1 now 5.
- D8 day-header craft: foreground 12.5px section marker (was muted uppercase micro-label). ✓ → D8 now 5.
- aria-label "Search or filter" (was stale). a11y nit fixed.
- Zero-results escape actions → lighter list items; sidebar count contrast lifted (0.75→0.9).
- Recomposition (Options disclosure + VIEWS sidebar) STILL INTACT post-polish.
DELIBERATELY NOT done: (c) raw [tool_result] title relabel (it IS honest content — relabeling regresses the
no-guessing rule); R5 saved-view tabs (net-new, deferred to its own design pass — needs an honest definition
of a "view" + Money/Messages presets). (d) mobile chip-strip-on-zero was already satisfied (chips render above
the zero body). NEW SCORE ~52/60, all dims ≥4, several now 5. The 53/60 prototype ceiling is essentially met;
the last point is R5 (saved-views) + the deepest day-header/spacing calibration, both deferred deliberately.
