# Explore SLVP redesign — TARGET DESIGN (approved 2026-06-23)

The design layer of the artifact. The approved target for implementation. Verified SLVP-tier:
**53/60, ≥4 on all 12 rubric dimensions, PASS** (independent verification 04-final-verification.md).

## The approved prototype
`prototype/final/` — clean static HTML/CSS, PDPP brand tokens, real-data fixture, feed/search/zero ×
desktop(1440)/mobile(390). Screenshots:
- desktop-feed-1440x900.png · mobile-feed-390x844.png
- desktop-search-1440x900.png · mobile-search-390x844.png
- desktop-zero-1440x900.png · mobile-zero-390x844.png

This is the visual + interaction contract. Implementation must MATCH these pixels.

## How we got here (provenance — earned, not guessed)
- 5 best-in-class benchmarks (Linear, Raycast+Stripe, Vercel-Geist+Primer, Superhuman, Things3) — reports +
  ~28 real screenshots in ../slvp-benchmark-2026-06-23/. Convergent diagnosis → rubric (01-...).
- 3 interaction-model concepts built + pixel-critiqued (03-...): Concept A (command-bar-led) WON 49/60.
- Synthesized A + grafts (B's day-headers/Upcoming card; C's 3-zone chips, prose search excerpts, saved-view
  tabs, Related Records) + 6 gap-fixes → final → independent verification PASS 53/60 (04-...).

## THE DESIGN (what implementation must deliver)

### Layout
- **Desktop (≥1024px):** 2-pane — sidebar 224px (VIEWS: Explore N, Upcoming N; SOURCES grouped w/ live counts)
  + main (command-bar → chip strip → saved-view tabs → list). Record click → 360px peek pane slides in
  (list shrinks). Search active → list = results mode, sidebar dims to 0.6. NO persistent right rail on default.
- **Mobile (390px):** single column. Heading+sort / search input / chip strip (hidden until first filter) /
  saved-view tabs (scroll) / list. Sources = full-screen sheet (swipe/hamburger). Max 3 fixed chrome rows
  before first data row. Record → full-screen push (Back returns), scroll restored.

### Type scale (04-verified; express through @pdpp/brand tokens — Schibsted Grotesk + JetBrains Mono)
| Role | Font | Size | Weight | Color |
|------|------|-----:|-------:|-------|
| Row title | Schibsted Grotesk | 14 | 500 | #171717 |
| Row meta | Schibsted Grotesk | 12 | 400 | #8f8f8f |
| Section/day header | Schibsted Grotesk | 11 | 600 | #8f8f8f uppercase tracked |
| Upcoming header | Schibsted Grotesk | 12 | 600 | accent #0055cc |
| Search input | Schibsted Grotesk | 14 | 400 | #171717 |
| Autocomplete operator token | JetBrains Mono | 12 | 400 | #0055cc |
| Chip label/value | Schibsted Grotesk | 12 | 500/400 | #171717 |
| Timestamps | JetBrains Mono | 11 | 400 | #8f8f8f |
| Amounts (right-aligned, tnum) | JetBrains Mono | 13 | 400 | +#171717 / −#c0392b |
| Detail H1 | Schibsted Grotesk | 18 | 600 | #171717 |
| Record key (detail, secondary) | JetBrains Mono | 11 | 400 | #8f8f8f |
**RULE: JetBrains Mono ONLY for timestamps, ids/keys, amounts, autocomplete operator tokens. NEVER titles,
search input, chip labels, or prose excerpts.** Two text colors total. One accent #0055cc. Spacing-as-separator
(no row borders within a day group; 16px gap between groups). Row 52px; section header 24px top / 8px bottom.

### Command-bar + autocomplete (the keystone interaction)
One input. Placeholder "Search or filter…" (NOT a syntax tutorial). "/" focuses. Typing → dropdown:
SOURCES (matching, w/ count) · STREAMS (matching, w/ count) · SEARCH ("Search for 'X' · Full-text + semantic
across all records", always last, separated). A recognized prefix (con:/source:/stream:/role:/after:/before:)
narrows to that dimension's real values. Select value → collapses to a structured chip, clears input, cursor
returns. Enter on free text → full-text+semantic search → results mode. Esc closes dropdown, keeps chips.
Keyboard footer: "↑↓ navigate · Enter apply · Esc close · Type source: stream: role: to filter".

### Chip model (3-zone), upcoming, zero-results, search hits, peek
- Chips: [Property][Operator][Value] ×; click operator toggles is/is-not; click value re-picks; "Clear all" when ≥2.
- Upcoming: inline above TODAY; header (clock + "Upcoming" accent + next date + "N records" muted mono + "Show all →");
  preview rows use FULL row anatomy (no truncation — B's bug); bg-subtle band; collapsed pill on mobile.
- Zero-results: honest explanation (what pre-filter matched, what post-filter removed — count==reachability);
  TRY INSTEAD = 2–4 escape list-items each w/ count; detail pane → neutral "Select a record" empty state.
- Search hits: FULL prose excerpt below title, matched term bolded; NO "MATCH:" label, NO HYBRID badge; "N in view".
- Peek/detail: H1 fallback = display-title → first content sentence (≤80ch) → (record key in mono SECONDARY,
  never H1). Clean key→value field table. "Related Records" cross-links at bottom.

### Honesty (non-negotiable, carries from the deployed sweep)
count==reachability everywhere (zero-results explains, never contradicts). No field-name/magnitude/shape
guessing of MEANING — declared (x_pdpp_role/type) or honest-generic only; declared-only kind. Mono only for
machine values. Money formatted only when declared currency type; else neutral number.

## Non-blocking polish (fold in where cheap during impl; NOT gates)
1. Feed-row fallback for raw `[tool_result]`-style titles (these ARE the honest content; a content-class glyph helps).
2. Lighter escape-action list styling (less heavy than filled cards).
3. Sidebar count contrast bump.
4. Apply the mobile chip-strip treatment to the zero state too.

## Next: P3 implementation
Map this to real files (pdpp-brand-react components.css + tokens; apps/console/.../explore/explore-canvas.tsx;
packages/operator-ui assembler/record-preview). Slice into independently-shippable pieces, each gated +
Codex-reviewed (waspflow gpt-5.5) + deployed + live-re-walk-re-scored. See 00-AUTONOMOUS-PLAN.md P3–P6.
