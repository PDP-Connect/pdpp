# Explore Redesign — Final Synthesis Prototype

**Concept A base + B day-headers + C chips + C excerpts + C saved-tabs + C related records**

Built 2026-06-23. Spec: `03-critic-verdict.md §4`.

## Files

| File | State | Mobile at 390px |
|------|-------|----------------|
| `feed-desktop.html` | Feed + autocomplete open, record selected in peek | Autocomplete closed; persistent chip strip; full upcoming list |
| `search-desktop.html` | Search results for "deploy" with prose excerpts | Mobile search results |
| `zero-desktop.html` | Zero-results routing: chips + 4 escape actions + neutral detail | Mobile zero state |
| `styles.css` | Shared styles for all 3 files | Responsive via media query at ≤768px |

Serve via `python3 -m http.server 8899` from the `prototype/` directory.

## Screenshots

| File | Description |
|------|-------------|
| `desktop-feed-1440x900.png` | Feed state, 1440×900 |
| `desktop-search-1440x900.png` | Search results, 1440×900 |
| `desktop-zero-1440x900.png` | Zero-results routing, 1440×900 |
| `mobile-feed-390x844.png` | Feed state, 390×844 |
| `mobile-search-390x844.png` | Search results, 390×844 |
| `mobile-zero-390x844.png` | Zero-results routing, 390×844 |

## 5 Grafts from B and C

1. **B day-group section headers**: `TODAY · Monday, June 23, 2026 · 32 records` — 11px/600/muted/uppercase, 24px top padding, spacing-as-separator
2. **C 3-zone chips**: `[source][is][Claude Code]×` with click-operator-to-negate — in the command bar
3. **C prose search excerpts**: Full sentence below hit title with matched term bolded — replaces `MATCH:` label and drops HYBRID badge
4. **C saved-view tabs**: `All · Money · Messages · This week · + Save view` with live counts above the list
5. **C Related Records**: Cross-reference section at bottom of detail pane

## 6 Gap-fixes

1. **Mobile chip strip** (Dim 12 → 4): Persistent horizontal-scroll strip below search input; appears on first chip, hidden when no filters. Chrome count at 390px: heading+input (1) + chip strip conditional (2) + view tabs (3).
2. **Zero-results empty detail** (Dim 7 → 5): Detail pane shows neutral "← Select a record" state — no stale orphan record from previous selection.
3. **Prose search excerpts** (Dim 9 → 4): `MATCH:` label replaced with full sentence excerpt; `HYBRID` badge dropped.
4. **Detail H1 fallback** (Dim 10 → 5): Display title leads; record key in mono as secondary line never H1; no snake_case in H1 position.
5. **Upcoming no-truncation** (Dim 8 → 5): B's Upcoming card chrome with A's full-title row anatomy inside — Toys, Collateral Repayment, Groceries, Natural Gas, Taxes all fully visible.
6. **Live view-tab counts** (Dim 5 → 5): All tab counts populated from fixture data (32 / 2.8k / 18k / 147).

## Type Scale (§4 exact)

| Role | Font | Size | Weight | Color |
|------|------|------|--------|-------|
| Row title | Schibsted Grotesk | 14px | 500 | #171717 |
| Row meta | Schibsted Grotesk | 12px | 400 | #8f8f8f |
| Section header | Schibsted Grotesk | 11px | 600 | #8f8f8f uppercase |
| Upcoming header | Schibsted Grotesk | 12px | 600 | #0055cc |
| Search input | Schibsted Grotesk | 14px | 400 | #171717 |
| Operator token | JetBrains Mono | 11px | 400 | #0055cc |
| Timestamps | JetBrains Mono | 11px | 400 | #b0b0b0 |
| Amounts | JetBrains Mono | 13px | 400 | #171717 / #c0392b |
| Detail H1 | Schibsted Grotesk | 18px | 600 | #171717 |
| Record ID | JetBrains Mono | 11px | 400 | #b0b0b0 (secondary only) |

Mono used exclusively for: timestamps, record keys/IDs, amounts, operator syntax tokens. Never in titles, input, chip labels, or prose excerpts.
