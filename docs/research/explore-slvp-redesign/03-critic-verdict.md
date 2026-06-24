# Explore redesign — critic verdict (2026-06-23)

Design critic pass scored against `01-benchmark-synthesis-and-rubric.md`.
Benchmarks: Vercel Geist typography, Linear filter docs, Things 3, Primer ActionList, Raycast/Stripe.
Screenshots reviewed: all concept finals + live Explore mobile-01 (the thing being replaced, ~25/60).

---

## What I saw in the pixels — per-concept findings

### Concept A — Command-bar-led

**Feed + Autocomplete (desktop, `screenshot-desktop-feed-autocomplete.png`, `desktop-feed-final.png`):**
- Left sidebar: Sources listed with live counts (18k / 4.2k / 3.1k / 2.8k / 847). Correct hierarchy. Clean.
- Autocomplete dropdown: sections OPERATORS / STREAMS / SEARCH, each entry shows `source: Claude Code`, real source name, description stub, count (18,421). This is the Superhuman/Linear model done correctly. Value-aware, count-bearing, teaches the query language in flow.
- Row anatomy: title is dark primary, source tag on right, relative time right-aligned in mono. Second line: muted metadata. Hierarchy is correct.
- Upcoming section: orange pill "Upcoming · 188 records", subtitle "Future-dated YNAB budget months · pinned past today's ceiling." Toys / Collateral Repayment rows show "$150.00" / "-$750.00" right-aligned in orange mono with "Aug 2026" date tag. Correct financial presentation.
- **Defects visible in desktop-feed-final.png (mobile state):** Row titles truncate correctly. BUT `[tool_result]` and `[tool_use: Bash]` in brackets look awkward — they read like debug labels, not human titles. This is a content honesty issue not a design defect per se. The "project_explore_slvp_consolidate..." row title is a snake_case ID in the primary position — uuid-as-title problem still partially present (the record's own title IS that string, but it's still an eyesore). Design can't fix content, but the prototype doesn't demonstrate a graceful fallback either.
- Sidebar "Saved" row at the bottom of VIEWS section is there but has no count — looks abandoned compared to Explore (32) and Upcoming (188).

**Search results (`screenshot-desktop-search.png`):**
- "Search results 25" badge. Left sidebar still shows source counts. Top: "Top matches for 'deploy'" with muted sub "Browse matching records, newest first · 25 in view." HYBRID badge explaining retrieval method — unusual but honest. Three result rows, each with title leading in blue/accent, MATCH badge, source tag, timestamp. Content of snippet is readable ("deploy a separate Modal function per u..."). Correct hit-led presentation, not uuid-led. Detail pane opens to real content title "Successfully deployed a6e2ec5 to Preview" — h1 is human-readable, not a composite key.
- **Defect:** Search result rows lead with the hit content in blue but the snippet excerpt is very short ("MATCH: exact term · ChatGPT conversation"). Raycast/Superhuman standard is a full prose excerpt, not a metadata label.
- **Defect:** The HYBRID badge is a "developer told you" element — Stripe/Things would hide this from the end user. It's noise.

**Zero-results (`screenshot-desktop-zero.png`):**
- "No results 0" clear. Center panel: "No assistant-role records in these results" with explanation "The query `stream:messages role:assistant` matched 25 records, but the `role:assistant` filter removed all of them." Then TRY INSTEAD section with 4 escape actions: Remove role:assistant filter (25 records), Search all streams (search all), Relax to: any role matches (~18k), Clear all filters (32 records). Each has a count. This is Raycast doctrine executed almost perfectly.
- **Defect:** The stale detail pane on the right still shows the previously-open record ("Successfully deployed a6e2ec5") which is confusing — zero-results state should clear or gray the detail pane, not leave an orphan record open.

**Mobile (`clean-mobile-390.png`):**
- Single-column, source/views list is gone (correct for mobile). Autocomplete dropdown occupies full width, keyboard hint at bottom. Upcoming section with financial rows renders clearly. Amounts right-aligned. Day section header clear. Push-nav implied.
- **Defect:** No visible chip bar or filter state on mobile — after applying `con: Claude Code` the mobile view does not show what filters are active. The desktop has chips in the input; mobile shows just "con" typed in the box. If you dismiss autocomplete with a filter applied, it's unclear how to see/edit/remove it.
- Row title truncation: "project_explore_slvp_consolidate..." hits the ellipsis — no visibility into full title without tapping.

---

### Concept B — Calm Chronology

**Desktop (`clean-desktop-1440.png`):**
- Tabs across top: "Default feed | Search focused | Search results | Zero results" — this is a prototype navigation, not a design defect, but it exposes B's core model: tabbed SPA where Default/Search are distinct modes.
- UPCOMING card: blue-tinted card with "UPCOMING · Wednesday, July 1, 2026 · 198 scheduled · Show all ↓". Five rows inside the card: Toys (New Budget · month_categories), Collateral Repayment (Financial Independence · $16,000), Overflow (Monthly Expenses), Natural Gas (Regular Bills), Taxes (True Expenses). "View all 188 upcoming records →" link.
- **Defect:** "Collateral Repayment" shows "Financial Independence" as category and "$16,000" as amount. But the other rows show "—" for amount. Inconsistent — some rows have amounts, others dash. This looks like a fixture gap but the inconsistency reads as a bug from a user's perspective.
- **Defect (critical):** The Upcoming card title column: "C..." is visibly truncated to one character on "Collateral Repayment" in the card. The card is plenty wide; this truncation is a pure layout bug. In the mobile screenshot it gets worse: "C..." and "Over..." and "Natural G..." — titles truncated to essentially nothing. Things 3 Upcoming shows full, beautiful titles. This is a 0-to-4 gap.
- TODAY section: "TODAY · Monday, June 23, 2026 · 32 records". Rows: title in dark primary, source + stream in muted second line. Hierarchy is correct and calm. Row density is good — about the same as Primer ActionList.
- Left sidebar: Views (Explore 32, Upcoming 188) + Sources (Claude Code 14, YNAB 5, Slack 3, Oura 2, Chase 4). Clean and functional but counts feel low-contrast compared to Linear's sidebar.
- Detail pane (right): Opens with "Explore SLVP consolidated sweep..." — content starts at the content, not a uuid header. Good. Metadata table below.
- **Defect:** The search input "Search or type source:, type:, before:..." uses what appears to be the brand sans (Schibsted Grotesk), correct. But the placeholder text reads like a manual; Linear's "Filter issues..." is a four-word hint. The operator syntax hint in the placeholder is a developer affordance, not a user affordance.
- **Defect:** No visible chip/operator UI at all — the prototype's search state is a separate tab ("Search focused"), not an evolved state of the same surface. The "Default feed" tab has no filter controls visible beyond the search input. This means the chip model, operator discovery, and filter state are entirely absent from the main feed view.

**Mobile (`clean-mobile-390.png`):**
- Tabs scroll horizontally: "Default feed | Search focused | Search results | Zero re..." — tabs extend off screen. On 390px this is not great; Things 3 uses segmented control or drawer.
- Upcoming card: major truncation problem. "C..." / "Over..." / "Natural G..." visible. $16,000 is readable. "View all 188 upcoming records →" link present. The card takes up most of the visible viewport, leaving only the TODAY header and one partial record below the fold.
- Feed rows below: "Explore SLVP consolidated sweep (P..." truncated. Source + stream muted below. Confirmed: git diff 41a671ef..HEAD — mono snippet in the title position. This is a real defect: the message content of a Claude Code tool use bleeds into the primary title field in mono.
- **Defect (typography):** "Confirmed: git diff 41a671ef..HEAD..." — the `git diff` part renders in what appears to be mono inline within the title. This needs to be sanitized or the title field must be the human-readable part only, not the raw message content.

---

### Concept C — Filter-Rail Workbench

**Desktop default (`screenshot-desktop-1440x900.png`):**
- Three-pane layout: left rail (224px) + center list + right detail. Rail shows: STREAMS (All / messages / money), then SOURCES grouped by category (AI CODING: peregrine Claude Code 32, Simon VM Claude... vivid fish Claude..., peregrine Codex; MESSAGING: Vana Slack 15, tim.nunamaker@g... 1, WhatsApp; FINANCE: YNAB, Chase, USAA; DEV: GitHub, ChatGPT variants). SAVED VIEWS at bottom: "This week", "Money feed".
- **Defect:** Rail source names truncate hard: "Simon VM Claude ...", "vivid fish Claude C...", "peregrine Codes" — at 224px these are unintelligible. Linear's sidebar names are longer (project names) and don't truncate because Linear doesn't pack as much in a rail at this width. These truncated names look like the uuid-as-title problem relocated to the sidebar.
- Tabs above list: "All 32 | Money — | Messages — | This week —" with "+ Save view". Clean and scannable. Good model.
- List rows: title in dark primary (~14px), source + stream muted, right-side tag for stream type, relative time. Hierarchy correct. Leading glyph (colored square) for source kind.
- Active chip bar: "Source | is | peregrine Claude Code ×" plus "Stream | is not | attachments ×" plus "Today ×" plus "+ messages" — structured 3-zone chips. This is the richest chip model of the three.
- **Defect visible in screenshot:** The chip bar sits above the tab bar. This stacks two horizontal chrome rows before the list starts. On 900px viewport height this costs significant vertical real estate. The list content starts ~180px down from the top of the pane.
- Detail pane: "MEMORY NOTE" label in orange accent, then "project_explore_slvp_consolidated_sweep_v1" as the title. This is still a snake_case ID in the detail header — uuid-as-title not fully solved in the detail pane. Content below is readable prose. Metadata: Source, Stream, Recorded, Record key (in mono — correct), Retrieval type.
- "RELATED RECORDS" section in detail with 2 entries — nice touch, not seen in A or B.

**Desktop search (`screenshot-desktop-search-1440x900.png`):**
- Search query "deploy" in the input. "Top results for 'deploy' · 41 results · 12 in view" header. Rows: each hit shows the matched snippet in italics below the title, with the word "deploy" in the snippet. This is a much better hit presentation than A's "MATCH: exact term" label or the live Explore's uuid-primary hit.
- **Defect:** The rail is still fully visible during search, taking up 224px of horizontal space. In Linear's command bar, filtering collapses or hides secondary nav. The rail competes with the search results for attention. On search, the user wants results, not the source rail.
- The search snippets are readable: "Should we deploy a separate Modal function per user on force containers to shut down after each user" — real prose content. This is better hit scannability than A.

**Desktop zero-results (`screenshot-desktop-zero-1440x900.png`):**
- Active chips: "Source | is | peregrine Claude Code", "Stream | is not | attachments", zero-results state.
- Center: "No assistant-role records in these 25 matches" — honest explanation, explains the post-filter gap. Two escape actions: "Remove role:assistant — show 25 message matches" (arrow button), "Search all streams for 'role:assistant'" (globe button). Plus "Clear all filters and start over" text link. Good routing but fewer options than A's four-action panel.
- **Defect:** The escape actions are styled as filled buttons, which is heavier than Raycast's lightweight list items. The "Search all streams for 'role:assistant'" escape action doesn't make semantic sense — role:assistant is a filter, not a search term.
- Detail pane remains open with a record during zero-results — same orphan problem as A.

**Mobile (`screenshot-mobile-390x844.png`):**
- Top nav: pdpp logo + "Explore" heading + "Default | Search | Zero results" segmented tabs. Clean.
- "Filter ①" button (with active count badge), chip bar below showing "Source | is | Stream" active chips that wrap. Search input below chips.
- Tabs: "All 32 | Money — | Messages — | This week — | + Sa..." — this horizontal tab row wraps poorly, "+ Sa" is cut.
- List rows: title primary, muted source + name below, right-side stream tag, relative time. Rows look clean and well-spaced.
- **Defect:** Two rows of chrome before content: (a) segmented tab bar at top, (b) "Filter" button + chip row, (c) search input, (d) tab/view row, (e) count + sort row. That's five chrome rows before the first data row. On 390px, the fold cuts off at around row 4. Too much overhead.
- **Defect:** The rail (224px desktop) collapses to a bottom sheet "Filter" button — good. But the chip bar remains fully visible in the horizontal scroll zone, which duplicates filter state. On mobile you see both a "Filter ①" badge AND the active chips. Redundant.
- Row: "project_explore_slvp_consolidated_sw..." — still snake_case title in primary. Same content problem, same truncation.
- "Upcoming · scheduled / future-dated · 188 ›" collapsed pill with chevron — clean, one line.

---

## Scorecard: 12 dimensions × 3 concepts

Scores 1–5 (5 = SLVP-tier). Rubric bar = ≥4 on all 12.

| # | Dimension | A | B | C | Notes |
|---|-----------|:-:|:-:|:-:|-------|
| 1 | **Visual hierarchy** | 4 | 4 | 4 | All three fix the inverted hierarchy. A and C have slightly better contrast discipline; B's card titles truncate which undermines the hierarchy signal. |
| 2 | **Typography craft** | 4 | 3 | 4 | A: brand-sans input, mono for timestamps/amounts/counts — correct throughout. B: mono bleeds into row titles (git diff snippet in primary field). C: correct application, but rail names in truncated sans look fine. B docked for mono leak. |
| 3 | **Toolbar / composition** | 5 | 3 | 3 | A: one input, chips in-flow, sidebar for context — cleanest composition of the three. B: search is a separate tab, no chips in default feed mode — not one-input. C: chip bar + tab bar + search input = three chrome rows stacked; rail takes 224px from content. |
| 4 | **Autocomplete depth** | 5 | 2 | 3 | A: operators + real values + counts in one dropdown — the Superhuman/Linear model hit. B: no autocomplete visible, placeholder hint only. C: autocomplete implied by README but not well demonstrated in screenshots; one screenshot shows "con:" suggestions but fewer than A. |
| 5 | **Filter chips / operators** | 4 | 2 | 5 | A: chips appear in the input bar as structured tokens, one-click negate shown in zero-results chips. B: zero chip model in default feed; search is a separate tab. C: 3-zone structured chips [Property][Operator][Value], suggested vs active separate, "Clear all" present — the fullest chip model. |
| 6 | **Row scannability** | 4 | 4 | 4 | All three: title primary, ≤2-3 muted metadata fields, leading glyph, right-aligned time/tag. B and C still show snake_case strings in titles but that's content, not design. C's search hit snippets are the best for scannability. |
| 7 | **Zero-results / honesty** | 5 | 2 | 4 | A: 4 escape actions with counts, exact explanation of post-filter removal, no contradictory counts. B: no zero-results state shown (separate tab exists but not evaluated with content). C: explanation + 2 escape actions, but one action's label is semantically confused; orphan detail pane on zero. |
| 8 | **Chronology / upcoming** | 4 | 3 | 4 | A: "Upcoming · 188 records" inline pill + financial rows with amounts + dates — clean and scannable. B: Upcoming card concept is beautiful in intent but title truncation kills it (C... / Over... / Natural G...). C: Upcoming as collapsed pill one-liner — too minimal, doesn't show content preview. A wins because it shows real upcoming items without truncation. |
| 9 | **Search-hit presentation** | 3 | 3 | 4 | A: hit title in accent + MATCH badge + short label — better than live but excerpt is brief. B: hit presentation tab exists but prototype is thin. C: prose snippet below title, word visible in context — best search-hit scannability. |
| 10 | **Detail / peek** | 4 | 4 | 3 | A: detail H1 is "Successfully deployed a6e2ec5 to Preview" — human-readable. B: detail content starts at prose. C: detail H1 is "project_explore_slvp_consolidated_sweep_v1" — snake_case ID remains in H1 position; RELATED RECORDS is a plus but doesn't compensate. |
| 11 | **Beauty / overall feel** | 4 | 4 | 3 | A: calm sidebar + clean two-pane, consistent accent (blue), spacing-as-separator. B: the Upcoming card blue-tint is charming; day sections breathe. C: three-pane instrument-panel is powerful but reads as a power-user workbench, not a calm personal data browser; the rail density and stacked chrome lower the premium feel. |
| 12 | **Mobile-specific** | 3 | 3 | 3 | A: full-width autocomplete works, but active filter state after dismissal is invisible. B: tab overflow and card truncation are bad; good row rhythm beneath. C: "Filter ①" + chip bar is clean in principle but five chrome rows before content is too costly. None hit 4. |
| | **TOTAL** | **49** | **37** | **44** | |

---

## 1. Winner: Concept A

**Score: 49/60** vs B's 37 and C's 44.

A wins on the three dimensions that matter most: toolbar/composition (5), autocomplete depth (5), and zero-results routing (5). These are the hardest problems to get right and they are the exact dimensions where the live Explore scores 1–2. A's autocomplete dropdown is the only one of the three that demonstrates the Superhuman/Linear in-flow value-aware model — operators, real source names, counts — in actual rendered pixels. Its zero-results routing with four escape actions and accurate counts is Raycast doctrine executed correctly. Its single-input composition with chips-in-bar eliminates the 19-control toolbar problem cleanly.

B has the most beautiful day-group rhythm but is architecturally thin: no chip model, search as a separate tab instead of an evolved state of one input, and the Upcoming card's critical truncation bug. B's score of 37 is damning — it doesn't clear ≥4 on 7 of 12 dimensions.

C has the richest chip model and best search-hit prose excerpts, but the three-pane instrument-panel approach stacks too much chrome and the rail truncates source names into unintelligibility. C's filter-rail is a power-user tool; for a calm personal data browser it reads as over-engineered at 44/60.

---

## 2. Graft list — what to take from B and C and merge into A

These are specific elements from the losing concepts that are strictly better than A's equivalent. Each references the screenshot where the element appears best.

**From B (Concept B):**

1. **B's day-group header rhythm and Upcoming card breathe** (`clean-desktop-1440.png`): B's "UPCOMING · Wednesday, July 1, 2026 · 198 scheduled · Show all ↓" card with the tinted background and the "TODAY · Monday, June 23, 2026 · 32 records" section header is more crafted than A's plain "Today 32 in view" label. Graft the section-header weight and spacing discipline: date in bold, count subdued muted, a subtle bg tint on the Upcoming card. Keep A's inline placement; replace A's plain text header with B's visual treatment.

2. **B's detail pane metadata table layout** (`clean-desktop-1440.png`): B's right-pane shows Source / Kind / Created / Record ID in a clean key→value two-column table with consistent alignment. A's detail pane shows the same fields but in a less structured layout. Take B's table presentation for the detail metadata block.

**From C (Concept C):**

3. **C's 3-zone structured chip model** (`screenshot-desktop-1440x900.png`): A's chips render as `stream: is messages ×` inside the input bar as tags, which is correct but the internal structure [Property][Operator][Value] is not visually articulated. C's chips with three distinct zones and the ability to click the operator to toggle negate are a better interaction model. Graft C's chip rendering (three visually distinct zones) onto A's input-bar placement.

4. **C's prose search-hit snippets** (`screenshot-desktop-search-1440x900.png`): A's search results show "MATCH: exact term · ChatGPT conversation" — a metadata label, not a prose excerpt. C shows the full sentence containing the matched word. Graft C's snippet rendering: one full sentence below the title with the matched term bolded or underlined, replacing A's "MATCH:" label.

5. **C's saved-view tabs** (`screenshot-desktop-1440x900.png`, `screenshot-mobile-390x844.png`): "All · Money · Messages · This week · + Save view" tabs above the list. A has "Saved" in the sidebar with no count, which looks abandoned. Replace A's sidebar "Saved" with C's inline tab bar above the list. These tabs act as pre-applied filter presets and give the surface genuine wayfinding without a full rail.

6. **C's "Related Records" detail section** (`screenshot-desktop-zero-1440x900.png` detail pane): A's detail pane has no cross-referencing. C shows "RELATED RECORDS · [tool_use: Bash] — 25m ago, [tool_result] — 25m ago" at the bottom. This is a net addition to A; graft it as the final section of the peek/detail pane.

---

## 3. Remaining gaps — what the synthesis must still close to hit ≥4 on every dimension

**Mobile filter visibility (Dim 12, A scores 3):**
After the user selects a filter from autocomplete and dismisses the dropdown, the mobile view shows no indication of active filters. The chips must persist in a one-line horizontal-scroll strip below the search input on mobile, exactly as C does — but with C's chrome overhead reduced. Maximum two rows of chrome before content on 390px: input row + optional chip strip (hidden when no filters active). This gets mobile to 4.

**Active filter state on mobile (Dim 12):**
A's `clean-mobile-390.png` shows the autocomplete open over the feed. Once dismissed, there is no chip bar. The synthesis must add the chip strip that B and C both show.

**Upcoming card title truncation must not happen (Dim 8, B's failure):**
In the grafted day-header treatment from B, ensure the Upcoming preview rows use the full item width for the title — no C-style card with fixed-width columns that truncate to one character. A's current Upcoming rows ("Toys", "Collateral Repayment", "Groceries") already show full titles; preserve A's Upcoming row anatomy inside B's card chrome.

**Search excerpt depth (Dim 9, A scores 3):**
The HYBRID explanation badge and "MATCH:" labels must be replaced with a full prose sentence excerpt (graft from C). The HYBRID badge is developer communication, not user communication — drop it. The "25 in view" count is sufficient to convey retrieval scope.

**Detail pane: snake_case IDs must not appear in H1 (Dim 10, C scores 3):**
C's detail pane still shows `project_explore_slvp_consolidated_sweep_v1` as the title. A mostly avoids this ("Successfully deployed a6e2ec5 to Preview" is human-readable). The synthesis must define a fallback hierarchy for detail H1: (1) manifest-declared display title; (2) first meaningful sentence of content (truncated at 80 chars); (3) record key in mono in a secondary position, never as H1.

**Stale detail pane on zero-results (Dim 7, A and C both have this):**
When the list transitions to zero-results, the detail pane must close or show a neutral "Select a record" empty state, not leave the previous record open. This is a confusing ghost.

**Saved-view tabs: dead counts (Dim 5, all three):**
C's tabs show "Money —" and "Messages —" with dash instead of counts. The synthesis must show live counts on the tabs when the view's count is known, and a spinner or "—" only during load.

**Autocomplete: "Search for X" action (Dim 4):**
A's autocomplete shows a "Search for 'con' · Full-text + semantic across all records" option at the bottom of the dropdown. This is excellent. Preserve it and make sure it is always the last item, visually separated from the operator/value completions above.

---

## 4. Synthesized "final" design spec

### Layout

**Desktop (≥1024px):**
- Two-pane: sidebar (224px, fixed) + main (flex). No persistent right rail on the default feed.
- Sidebar: VIEWS (Explore N, Upcoming N, Saved — replaced by inline tabs below), SOURCES (grouped by category, live counts, full names — if a name truncates at 224px, show on hover tooltip). No saved views in sidebar; they move to inline tabs.
- Main pane: search input at top (full width). Chip strip below input (hidden when no active filters, appears on first chip). Saved-view tabs below chip strip ("All · Money · Messages · This week · + Save view"). Then list.
- On search (fulltext query active): list switches to search-results mode with prose excerpts. Sidebar stays but dims slightly (opacity 0.6) to signal "results mode." No separate tab needed.
- On record click: detail slides in as a right pane (360px), shrinking the list. On narrow desktop, detail replaces list; Back button returns to list. This is the Superhuman model.

**Mobile (390px):**
- Single column. No sidebar — hamburger or swipe-from-left draws Sources as a full-screen sheet.
- Row 1: "Explore" heading (left) + sort control (right).
- Row 2: Search input (full width) + "/" shortcut hint.
- Row 3: Chip strip — appears only when filters active (hidden = no row). Horizontal scroll.
- Row 4: Saved-view tabs scrollable (hide count dashes; show count or omit).
- Then: list. Upcoming collapsed pill. Day section headers. Feed rows.
- Maximum 3 fixed chrome rows before first data row (heading + input + conditional chips). Tabs count as content-adjacent chrome, acceptable.

### Type scale (anchored to Geist/Primer; expressed in PDPP brand tokens)

| Role | Font | Size | Weight | Color |
|------|------|------|--------|-------|
| Row title | Schibsted Grotesk | 14px | 500 | #171717 (primary) |
| Row meta (source, stream, role) | Schibsted Grotesk | 12px | 400 | #8f8f8f (muted) |
| Section header (TODAY, day) | Schibsted Grotesk | 11px | 600 | #8f8f8f uppercase spaced |
| Upcoming header | Schibsted Grotesk | 12px | 600 | accent (#0055cc) |
| Search input | Schibsted Grotesk | 14px | 400 | #171717 |
| Autocomplete operator token | JetBrains Mono | 12px | 400 | #0055cc (accent) |
| Chip label (property/operator) | Schibsted Grotesk | 12px | 500 | #171717 |
| Chip value | Schibsted Grotesk | 12px | 400 | #171717 |
| Timestamps in rows | JetBrains Mono | 11px | 400 | #8f8f8f |
| Amounts (right-aligned) | JetBrains Mono | 13px | 400 | positive: #171717, negative: #c0392b |
| Detail H1 | Schibsted Grotesk | 18px | 600 | #171717 |
| Detail meta key | Schibsted Grotesk | 12px | 400 | #8f8f8f |
| Detail meta value | Schibsted Grotesk / Mono | 12px | 400 | #171717 / mono for ids |
| Record ID in detail | JetBrains Mono | 11px | 400 | #8f8f8f (secondary, never H1) |

Rule: JetBrains Mono is used ONLY for: timestamps, ids/keys, amounts-as-columns, autocomplete operator syntax tokens. Never in titles, search input, chip labels, or prose excerpts.

### Command-bar and autocomplete behavior

One input. Placeholder: "Search or filter..." (not a syntax tutorial). "/" shortcut to focus.
- Typing any text: opens dropdown with three sections: SOURCES (matching by name, with count), STREAMS (matching, with count), SEARCH ("Search for 'X' · Full-text + semantic across all records"). Each source row: icon + `source:` token in mono accent + source name in sans + description stub in muted + count right-aligned in mono.
- Typing a recognized prefix (`con:`, `source:`, `stream:`, `role:`, `after:`, `before:`): autocomplete narrows to matching values within that dimension.
- Selecting a value from autocomplete: collapses to a structured chip in the bar, clears the input. Cursor returns to input for next filter.
- Pressing Enter with free text and no selection: executes full-text + semantic search, transitions to search-results mode.
- Escape: closes dropdown, clears typed text, does not remove active chips.
- Keyboard footer in dropdown: "↑↓ navigate · Enter apply · Esc close · Type source: stream: role: to filter" (exactly as A demonstrates).

### Chip model (grafted from C, placed in A's bar)

Each chip: `[Property pill][Operator pill][Value pill] ×`
- Property pill: source/stream/role/date in Schibsted Grotesk 12px/500, bg #f0f0f0
- Operator pill: "is" / "is not" in Schibsted Grotesk 12px/400, bg #e8e8e8; click toggles between "is" and "is not"
- Value pill: the value in Schibsted Grotesk 12px/400, bg #f0f0f0; click opens re-picker dropdown
- × button: removes chip
- "Clear all" text link at end of chip strip when ≥2 chips active

### Upcoming treatment

Inline in the feed, above TODAY section. Style:
- Header row: clock icon + "Upcoming" in accent weight + date of next event in Schibsted Grotesk + "188 records" in muted mono + "Show all →" link
- Preview rows (3–5): same anatomy as feed rows — icon, full title, category muted, amount right-aligned in mono (if financial), date tag in muted mono. No card border, use bg-subtle (#f9f9f9) band or just extra-generous top padding as separator.
- Collapsed by default on mobile (single-line pill with count badge and chevron); expanded on desktop.

### Zero-results routing

When active filters produce 0 results:
1. Clear explanation: "No [filter-value] records in these [N] matches" — specific about what the pre-filter matched and what post-filter removed.
2. TRY INSTEAD section with 2–4 escape actions as list items (not buttons): each has an icon, a label, a count or scope label right-aligned. Minimum: Remove the most-restrictive filter (show N), Clear all filters (show M). Contextual: Relax [dimension] (show ~K) when applicable.
3. Detail pane: show neutral empty state ("← Select a record from the list") — never leave a stale previous record open.

### One accent + spacing discipline

- One accent: `#0055cc` (consistent with C and A). Used for: Upcoming header, autocomplete operator tokens, active chip operator pill highlight, active sidebar item, primary links.
- Background: `#ffffff` content area, `#f9f9f9` sidebar + section bands. No card borders within a section — spacing only. One subtle `1px #e5e5e5` divider between sidebar and main.
- Row separator: 0px border within a day group; a `16px` vertical gap between day groups is the only separator. No horizontal rules within a group.
- Row height: 52px nominal (enough for title + meta, comfortable tap target). Upcoming rows: 44px (less meta).
- Section header top padding: 24px above, 8px below. Compact but breathable — Things-model.

---

## 12-line summary

| | A | B | C |
|---|:-:|:-:|:-:|
| Totals | **49** | **37** | **44** |

**Winner: Concept A** (49/60). Only concept that demonstrates value-aware autocomplete, one-input composition, and Raycast-grade zero-results routing in actual pixels.

**Top 5 grafts into A:**
1. B's day-group section header visual treatment (weight, spacing, Upcoming card bg-tint) — `clean-desktop-1440.png`.
2. C's 3-zone structured chip rendering [Property][Operator][Value] with click-to-negate on operator — `screenshot-desktop-1440x900.png`.
3. C's prose search-hit snippet (full sentence + matched term, no MATCH: label) — `screenshot-desktop-search-1440x900.png`.
4. C's saved-view tabs above the list ("All · Money · Messages · This week · + Save view") — `screenshot-desktop-1440x900.png`.
5. C's "Related Records" section in the detail pane — `screenshot-desktop-zero-1440x900.png`.

**Top gaps to close:**
1. Mobile active-filter visibility: add persistent chip strip below input (hidden until first chip) — fixes Dim 12 from 3→4.
2. Zero-results stale detail pane: clear detail or show "Select a record" empty state when list is empty.
3. Search excerpt: replace MATCH: label with prose sentence excerpt (graft from C).
4. Detail H1 fallback: display title → first sentence of content → record key (mono, secondary) — never raw snake_case as H1.
5. Upcoming in grafted B-style card: preserve A's full-title row anatomy inside B's visual section header to avoid B's truncation bug.
