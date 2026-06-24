# Concept C — Filter-Rail-Led / Data Workbench

**Model:** Linear + Stripe instrument-panel direction. Structured source/filter rail
(left) + content-led flat list (center) + peek detail (right, 3-pane desktop).
Filter chips as first-class structured tokens. Saved views as tabs.

## Rubric dimensions targeted (from `01-benchmark-synthesis-and-rubric.md`)

| # | Dimension | Target | Design choice |
|---|-----------|:------:|---------------|
| 1 | Visual hierarchy | ≥4 | Title 14px/500 primary (#171717); meta 12px muted (#8f8f8f). Inverted hierarchy eliminated. |
| 2 | Row density / near-empty | ≥4 | Leading kind-glyph + content title + ≤2 subordinated meta + right mono time. Vercel deployments-list model. |
| 3 | Search & operators | ≥4 | Single sans input; autocomplete shows operators (con:/stream:/after:) + real values + counts in-flow. No separate popover split. |
| 4 | Autocomplete depth | ≥4 | Value-aware: sources listed with counts, operator tokens discoverable inline (Superhuman/Linear model). |
| 5 | Filter chips / operators | ≥4 | 3-zone chip [Property][Operator][Value], click operator→negate (is/is not), click value→re-picker. Suggested vs active chips rendered separately (Stripe). Clear all present. |
| 6 | Source / filter rail | ≥4 | Linear-style rail: sources grouped by category, in-view counts, one-click active, hover→"not" exclude. Stream type pills above. Mobile: collapses to bottom sheet. |
| 7 | Zero-results / honesty | ≥4 | Route with escape actions ("remove role:assistant" / "search all roles") — never show contradictory count. |
| 8 | Chronology / upcoming | ≥4 | Upcoming collapsed-by-default (188 YNAB rows would bury Today) with true count badge. Day-group headers w/ spacing-as-separator. |
| 9 | Saved views as tabs | ≥4 | "All · Money · Messages · This week" tabs above list; quiet, not primary chrome. "+ Save view" inline. |
| 10 | Desktop list+detail | ≥4 | 3-pane: rail (224px) + list (flex) + detail (360px). Detail starts at content, not uuid. |
| 11 | Premium feel / palette | ≥4 | One accent (#0055cc), two text colors (primary/muted), bg-subtle rail. No borders within groups — spacing as separator. |
| 12 | Mobile | ≥4 | Rail → beautiful bottom sheet with handle + group headers + Done/Apply. Chips wrap (horizontal scroll). Push-nav preserved. |

## Brand tokens honored
- **Sans:** Schibsted Grotesk — all prose, titles, search input, chip labels
- **Mono:** JetBrains Mono — ONLY timestamps, ids, amounts, operator tokens, counts
- Two text colors: `#171717` (primary) + `#8f8f8f` (muted). One accent: `#0055cc`.
- Spacing-as-separator within groups; borders only between groups/sections.
- Geist/Primer type scale: 14px/500 row title, 12px muted meta, 16px/600 day headers.

## Screenshot files
- `screenshot-desktop-1440x900.png` — 3-pane desktop default state
- `screenshot-mobile-390x844.png` — mobile with visible chip bar and list
