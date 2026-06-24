# Explore → SLVP-tier: benchmark synthesis + scored gap rubric (2026-06-23)

The diagnosis layer of the redesign artifact. Synthesizes 5 best-in-class benchmarks (reports +
real screenshots in `../slvp-benchmark-2026-06-23/`) into ONE reference bar, then scores the current
live Explore (`../explore-mobile-review-2026-06-22/mobile-0*.png` + measured tokens) against each
dimension. Conclusions are evidence-anchored: every "should" cites a benchmark with a real value.

Decision context (Tim, 2026-06-23): **rethink the interaction model** (not just re-skin) + **multi-agent
design+critique loop**. So this rubric defines the bar; `02-target-design.md` + `prototype/` propose the
rethought model; a critic scores the prototype against THIS rubric until it clears.

## The 5 benchmarks and what each anchors
1. **Linear** — command bar + structured filter chips + instrument-panel density. (linear-command-and-filters.md)
2. **Raycast + Stripe** — value-aware palette + zero-results routing; filterable data table, money rows, chip dual-state. (raycast-stripe-search-and-feed.md)
3. **Vercel Geist + GitHub Primer + Datadog** — heterogeneous day-grouped feed; PUBLISHED type/color/space tokens. (timeline-feed-and-visual-systems.md; shots: geist-typography, primer-action-list, vercel-deployments-list)
4. **Superhuman** — search over personal history, list+detail, feels-instant, operator-discovery-in-flow. (superhuman-personal-stream-search.md)
5. **Things 3** — Today/Upcoming/Scheduled chronology + visual beauty + mobile calm. (things3-chronology-and-beauty.md)

## THE UNANIMOUS CONVERGENCE (where ≥4 of 5 independently agree — these are non-negotiable)
- **Hierarchy via SIZE + COLOR (and restrained weight), almost never bold.** Stripe uses only weight 400/300 across the whole dashboard. Geist uses 3 weights (400/500/600). Things uses weight-not-color but with a tight 3-size scale. → A row TITLE must read as primary by being darker + appropriately sized, with metadata in ONE muted token. Two text colors total (primary + muted) is the whole hierarchy (Geist `#171717`+`#4d4d4d`; Primer `#1f2328`+`#59636e`).
- **Monospace ONLY for machine values** (ids, hashes, timestamps, amounts-as-columns, code) — NEVER the search input, NEVER titles, NEVER prose. (Linear: Berkeley Mono only for IDs/shortcuts. Geist: `label-12-mono` only for timestamps. Superhuman/Things: no mono in the reading surface.)
- **Content leads the row; unify row STRUCTURE, vary only the leading glyph.** 3–4 data points max per row; everything else on tap/peek. (Vercel/GitHub/Datadog/Grafana converge; Things: "row anatomy is nearly empty"; Raycast: "3–4 data points, push depth to the detail pane".)
- **Spacing is the separator; one accent color; calm dense list.** No row borders within a group (Things, Superhuman, Geist). One accent for the single primary action per screen (Linear acid-lime; Things blue; Stripe restraint).
- **Operator/value discovery happens IN THE FLOW of the one input, not a separate help panel.** Typing a prefix autocompletes real values (Superhuman `from:`→your contacts; Linear "Andreas"→"Assignee is Andreas" with counts). One input, not a toolbar of separate controls.
- **Zero-results is a routing opportunity, not a dead-end.** (Raycast doctrine; Stripe "clear all" only when active.) Offer escape actions ("remove the role filter", "search all sources"), never "try different terms" while also claiming N results exist.
- **Mobile = full-screen push nav, one list, no split, no bottom-sheets; row expands in place or pushes to detail.** (Superhuman + Things both; validates Explore's existing push-nav choice.)

## SCORED RUBRIC — current Explore vs the bar (1=broken, 5=SLVP-tier)
Evidence: live measurements taken 2026-06-23 at 390px (JetBrains Mono search input 13px; row title 14px grey `oklch .47`; row meta 16px dark `oklch .18`; 19 toolbar controls; count line 16px) + the mobile-0*.png set.

| # | Dimension | Score | Benchmark bar (real value) | The gap (evidence) |
|---|-----------|:---:|---------------------------|--------------------|
| 1 | **Visual hierarchy** | **2** | Title primary/darker; metadata one muted token, smaller (Geist copy-13 + muted; Superhuman sender-bold→snippet-muted) | INVERTED: row title 14px grey, meta 16px dark. Eye lands on the wrong line. |
| 2 | **Typography craft** | **2** | Mono ONLY for ids/timestamps; prose+input in the brand sans; a tight 3-tier scale | Search INPUT is JetBrains Mono 13px → whole surface reads "terminal". 9px mono uppercase micro-labels ("sort"). |
| 3 | **Toolbar / composition** | **1** | One input; a few scoped controls; progressive disclosure (Linear one-input; Stripe "4-5 inline, rest behind More") | 19 controls in a 250px band; redundant full-width Search button (heavier than the input); split operator discovery (popover + inline). |
| 4 | **Autocomplete depth** | **2** | Value-aware: completes operators + real VALUES + counts, in-flow (Superhuman, Linear) | Completes ONLY source names (`con:`). No operators, no values, no counts. Sets an expectation it doesn't keep. |
| 5 | **Filter chips / operators** | **3** | 3-zone structured chips (property/operator/value), one-click negate, AND-default OR-behind-Advanced (Linear); suggested vs active chip are separate elements (Stripe) | Chips render + negate correctly (`not stream: attachments`). But discovery is split and the operator popover clips/overlaps on mobile. |
| 6 | **Row scannability** | **2** | Content leads; ≤3-4 fields; leading glyph; rest on peek (Vercel/Things/Raycast) | Rows can lead with `Color: 28a745` / `Index: 0` (decorative fields); message_attachments wall. Too many fields competing. |
| 7 | **Zero-results / honesty** | **1** | Routing with escape actions; counts never contradict reachability (Raycast; count==reachability) | `0 in view · 25 search results returned` + "try different terms" — a count==reachability contradiction (role: post-filter removed all). |
| 8 | **Chronology / upcoming** | **3** | Upcoming labeled, structured (7-day→week→month), beautiful; day headers w/ year for multi-year corpus (Things; finance camp) | Upcoming works + collapses (defensible for 188); ynab content now real. But day-header + section styling is plain, not crafted. |
| 9 | **Search-hit presentation** | **2** | Hit leads with readable content + matched snippet; instant, ranked (Superhuman; Raycast) | Hit primary = raw uuid, "Match" tiny underneath. Honest but not scannable; uuid dominates. |
| 10 | **Detail / peek** | **2** | Detail starts at CONTENT, no duplicate header; updates on keyboard nav (Superhuman split; Things push) | Detail-page H1 is the raw composite key (`C017NG64T24:...`). Same id-as-title problem, different path. |
| 11 | **Beauty / overall feel** | **2** | Calm, premium, content-hero, one accent, spacing-as-separator (Things ADA; Geist; Stripe) | Reads as a developer console: mono input, inverted hierarchy, accreted toolbar, decorative-field rows. Tim: "this looks like a mess." |
| 12 | **Mobile-specific** | **3** | Full-screen push, one list, row calm (Superhuman, Things) | Push-nav + filter sheet are right. But the toolbar mess + row noise are WORST on 390px. |

**Aggregate: ~25/60.** (Aligns with the standing "critique 28/40" signal — Explore is mid-tier, not SLVP-tier.) The structural bones (push-nav, count-honesty intent, manifest-authored presentation, the upcoming model) are sound; the **visual system, input composition, autocomplete, and row craft** are where it falls down.

## WHAT THE PROTOTYPE MUST HIT (acceptance bar for the design+critique loop)
A redesigned Explore is SLVP-tier when, judged against the 5 benchmarks, it scores ≥4 on every dimension. Concretely the prototype must demonstrate:
1. **One command-bar**, brand-sans, replacing the 19-control toolbar; scoped controls (sort/date) progressive-disclosed; the redundant Search button gone.
2. **Value-aware autocomplete**: typing a prefix completes operators AND real values AND counts, teaching the query language in-flow (Superhuman/Linear model).
3. **Corrected type scale**: title primary (darker, ≥ meta in size, restrained weight), metadata ONE muted token smaller; mono confined to ids/timestamps/amounts. A real 3-tier scale anchored to Geist/Primer values, expressed in PDPP brand tokens.
4. **Near-empty rows**: leading glyph + content title + ≤2 subordinated metadata; decorative/identifier fields never lead; depth on peek.
5. **Day-grouped feed + upcoming** styled with Things-grade calm (spacing-as-separator, crafted headers w/ year, labeled upcoming).
6. **Zero-results routing** with escape actions; counts that never contradict reachability.
7. **Search hits** that lead with readable content + a clear matched excerpt (not a uuid).
8. **Desktop list+detail** (Superhuman/Linear split) + **mobile push-nav**; both shown.
9. **One accent, calm palette, premium feel** — passes the "does not look like a dev console" test.

## Honest tensions to resolve in the design (not paper over)
- **Day headers**: dev-tool benchmarks (Vercel/GitHub) AVOID date headers (continuous relative-time); finance + Things day-group. For a multi-year personal corpus the finance/Things camp wins — but it IS a deliberate fork, justified by corpus shape, not by copying the dev tools. (timeline report flagged this.)
- **Upcoming as in-page section vs a destination**: Things makes it a separate navigation destination; Explore currently inlines it as a collapsed pill. With the interaction-model rethink on the table, "upcoming as its own view/tab" is now a real option to evaluate.
- **Mono for amounts**: Geist uses tabular-figures (not necessarily mono) for column alignment. Prefer `font-feature-settings:'tnum'` on the sans over a mono amount, to keep money calm + aligned without the terminal feel.
- **PDPP brand tokens are fixed inputs**: the redesign expresses these benchmark principles THROUGH the existing `@pdpp/brand` tokens (Schibsted Grotesk + JetBrains Mono are the brand fonts) — the fix is how they're APPLIED (sans for input/titles, mono only for ids), not new fonts.

## Evidence index
- Benchmark reports: `../slvp-benchmark-2026-06-23/{linear-command-and-filters, raycast-stripe-search-and-feed, timeline-feed-and-visual-systems, superhuman-personal-stream-search, things3-chronology-and-beauty}.md`
- Benchmark shots (20): `../slvp-benchmark-2026-06-23/shots/` (Geist typography table, Vercel deployments-list, Linear filters, Primer ActionList, Stripe, Raycast) + `shots/MANIFEST.md`
- Current Explore (live, 390px): `../explore-mobile-review-2026-06-22/mobile-0*.png` + measured tokens (in this file's rubric row).
