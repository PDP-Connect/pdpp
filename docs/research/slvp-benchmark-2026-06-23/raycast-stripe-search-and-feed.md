# Design Benchmark: Raycast + Stripe Dashboard
## Steering a Redesign of the Explore Surface (search box + operators + filter chips + record feed)

**Date:** 2026-06-23
**Method:** WebSearch fan-out (5 angles), primary-source fetch (8 pages), adversarial claim verification
**Scope:** Raycast command palette UX + Stripe payments list/filter UX

---

## Part A — Principles to Steal

### From Raycast

**R1. Frequency × recency is the only ranking signal you need to ship first.**
Raycast's root search ranks by two signals: text match (acronym/prefix-of-words, not full BM25) weighted by how often and how recently the user ran that item. There is no cloud ML, no collaborative filtering. On a personal data feed, "things I searched for last week" already surfaces the right records. Start here; add semantic ranking later.

**R2. Zero-match is not an error — it is a routing opportunity.**
When Root Search returns zero results, Raycast replaces the list with a "Fallback Commands" section: a user-ordered list of commands (File Search, Google Search, any Quicklink or Script Command) that each accept the typed string as an argument. The section appears only when the result set is empty — it is not a persistent "also try" affordance. For an Explore feed: zero-result state should offer "search the web for X", "search all time (remove date filter)", "relax filters" — context-sensitive escapes, not a dead end.

**R3. Teach shortcuts inside the flow, not in a help modal.**
The Action Panel (Cmd-K) lists every available action for the current selection with its keyboard shortcut inline. Raycast's own guidance: "Build a habit of using ⌘K to search for an action. See and learn the keyboard shortcut to control Raycast even faster." The lesson: shortcut education happens in the moment of use, not in onboarding. For Explore: show operator shortcuts (e.g., "Press F to add a filter") in a subtle action bar at the bottom of the panel, not in a tooltip buried in settings.

**R4. Aliases collapse multi-step flows into a single gesture.**
Any command can have a user-assigned alias (e.g., `f` → File Search). Typing the alias + space + query routes directly to the command with the query pre-filled. For Explore: pre-built filter presets ("saved views") accessible by short codes or keyboard shortcuts eliminate the "open filter panel → pick field → pick value" drill. One keystroke to apply a canned operator set is qualitatively different from building it from scratch each time.

**R5. Icon-first scanning — every row starts with a recognizable 16pt icon.**
The 2021 "fresh look" redesign explicitly enlarged leading icons ("making it quicker to scan for what you need to find"). Raycast's icon set uses consistent stroke weight and corner radii — a monoline system at a 16pt grid. For Explore: connectors/sources have logos; use them as leading icons at fixed size. A human eye lands on the icon before reading text. If all rows show the same icon, you've lost this affordance.

**R6. Keep the list lean; push depth into the detail pane.**
When `isShowingDetail` is true, Raycast renders a right-side panel showing markdown content + structured key-value metadata (`List.Item.Detail.Metadata`) for the selected item. The guidance: "do not show accessories when `isShowingDetail` is true — put that info in the detail pane." For Explore: the record list rows carry only the minimum to identify and triage (icon, title, date, status). Full field values, source metadata, raw JSON live in the side panel — triggered by selection, not by opening a new route.

**R7. Two-state row: compact scan list + expanded detail panel.**
Raycast's master-detail split is persistent (not a modal or drawer): as you navigate up/down, the panel updates in real time. This is more powerful than click-to-open-route because you stay in the list, in keyboard mode, scanning at speed. For Explore on desktop: a peek panel alongside the feed, updated on keyboard navigation, is the right pattern. Mobile: full-page push nav (separate route) per the existing SLVP verdict.

**R8. Compact mode as user-controlled density.**
Raycast ships a "Compact" mode preference that blends all elements for a minimal appearance, reducing chrome during search-and-execute flows. Users who are in "find and act" mode want fewer distractions than users in "browse and learn" mode. For Explore: a density toggle (compact / comfortable) respects both power-user and casual-user needs without designing for the average.

---

### From Stripe Dashboard

**S1. Amount leads — monetary outcome is the primary scan target.**
The Stripe payments/transactions list puts the amount column first (left anchor), right-aligned within its column with tabular numbers (`font-feature-settings: 'tnum'`). Currency symbols and decimal points stay in vertical register. For a data feed of financial records (YNAB transactions, Plaid transactions): lead with the amount. Amount is what the user is scanning for. Title/description is secondary.

**S2. Color + size hierarchy, not weight, to separate primary from secondary data.**
Stripe uses only two font weights: 400 (body) and 300 (subdued/headings). Hierarchy is communicated through color and size:
- Amount: `16px`, `#061b31` (near-black) — dominant
- Description/customer: `14px`, `#273951` (dark blue-gray)
- Date/metadata: `14px`, `#64748d` (medium gray) — visually recedes

No bold amounts. The whisper-authority principle: restraint creates clarity. For Explore: resist the urge to bold-weight primary data. Use color contrast and size instead — it is lighter on the eye across a long feed.

**S3. Status pills are background-tinted, not solid-filled.**
Stripe's badge colors use the 100-level tint (very pale background) with 600-700 level text — e.g., success green is a pale green background with dark green text. This keeps "Succeeded" present on every row without saturating the feed with color. For Explore record states (collected / pending / failed / skipped): follow this pattern. Solid fills compete with actual content; tinted pills categorize without dominating.

**S4. Progressive disclosure via "More filters" — show 4-5 up front, hide the rest.**
Stripe's Connected Accounts page shows a few prominent filters (Default category), then hides the rest behind a "More filters" expandable list organized into named categories (Account, Capability, Properties, Risk Management, Metadata). Metadata filters appear last. For Explore: surface 4-5 high-value operators (date range, source/connector, status, keyword) inline. Additional operators (metadata keys, exact field values, numeric comparators) live behind a disclosure. Don't front-load 20 chips.

**S5. Filter chips as the active-state receipt, not as the entry point.**
Stripe's chip pattern has two distinct states: (1) Suggested chip — shows field name + `+` symbol, invites interaction; (2) Active chip — shows `FieldName: Value` + `×` to clear. The two states are rendered as completely separate elements (a bug occurs if you wrap an active chip in a Link). The chip bar is the canonical display of "what filters are currently applied" — it is the state receipt, not the query builder. Building the filter happens in the menu/popover that opens from the suggested chip. For Explore: the same separation. Chips above the feed show current query state. Adding a new filter is a separate gesture (button or keyboard shortcut) that opens a picker.

**S6. "Clear filters" appears conditionally, never clutters the resting state.**
The Stripe pattern shows a "Clear filters" link at the end of the chip row only when at least one filter is active:
```jsx
{(tierFilter || statusFilter) && (
  <Link onPress={clearAll}>Clear filters</Link>
)}
```
This keeps the toolbar clean when no filters are applied. For Explore: don't persist a "Clear all" button in the empty-filter state.

**S7. Minimal column count — hide IDs and fingerprints behind the detail view.**
Stripe's payments list shows exactly four data points per row: amount, description/customer, status badge, date. Card brand appears as a small icon, not a text column. Payment IDs, risk scores, card fingerprints, metadata keys — all live behind a row click into the detail view. For Explore: 3-4 data points per row is the ceiling before the feed feels like a spreadsheet.

**S8. Row hover reveals bulk selection and contextual actions; they don't persist.**
Checkboxes for bulk selection and contextual row actions (retry, refund) appear on hover only. This is pure progressive disclosure: the resting feed is clean; affordances appear precisely when needed. For Explore: row-level actions (open detail, copy link, mark as read) should be hover-only, not persistent icon columns.

---

## Part B — Stripe Row Layout + Money Formatting (Specifics)

### Column order (left → right)
```
[Amount]  [Description / Customer name + card icon]  [Status pill]  [Date]
```

- **Amount** is right-aligned within its column. `font-feature-settings: 'tnum'` ensures decimal alignment without requiring a monospace font.
- **Description/Customer** can be: subscription description, customer display name, card brand + last 4 (e.g., "Visa •••• 4242"), or email.
- **Status pill** is compact, lowercase, tinted background: "Succeeded" (green tint), "Pending" (orange tint), "Failed" (red tint), "Refunded" (gray tint). Border-radius `100px` (fully pill-shaped).
- **Date** is the trailing column, right-aligned, in subdued gray. Format: relative for recent ("3 minutes ago"), short absolute for older ("Jun 18, 4:32 PM"), date-only for distant ("Jun 18").

### Typography values (extracted from live Stripe token audit, designmd.cc, May 2026)
- **Font:** `sohne-var`, system-ui fallback
- **Weights used across stripe.com:** 400 (dominant, 1,136 occurrences) and 300 (subdued, 242 occurrences) — no 500/600/700 in the dashboard UI itself
- **Amount:** 16px / weight 400 / color `#061b31` (heading-solid)
- **Description/customer:** 14px / weight 400 / color `#273951` (input-text-label)
- **Status badge label:** 10–12px / weight 400 / semantic color (pale tint bg + dark text)
- **Date/metadata:** 14px / weight 400 / color `#64748d` (heading-subdued)

### Money formatting rules (Stripe)
- Always full decimal: `$49.00`, `$1,234.56` — never abbreviated in the list view
- Currency symbol precedes amount for USD/GBP; follows for EUR (locale-aware)
- Tabular numbers via `font-feature-settings: 'tnum'` for column alignment
- Amount column is right-aligned
- Zero-decimal currencies (JPY, KRW): no cents shown
- Foreign currency: primary line shows settlement amount, small secondary line shows original currency (e.g., "€42.00 EUR")
- Negative/refund amounts: minus prefix, sometimes red/danger color

### Spacing grid
- 4pt/8pt base: tokens `0, 4, 8, 12, 16, 20, 24, 32px`
- No visible row borders — generous row height (implied ~44–48px) separates entries
- Background: pure white `#ffffff` or off-white `#f8fafd`

---

## Part C — Raycast Instant-Value-Aware Results + Fallback Action Pattern

### How results appear as you type

**Unified pool, local-only, zero latency:**
Raycast searches a single local pool at every keystroke: apps, built-in commands, extension commands, Quicklinks, Snippets, Clipboard History. No server round-trip. The "value-aware" aspect comes from the ranking signal: frequency × recency of use. Items you ran yesterday rank above items you've never run, even if the text match is equivalent. This is purely on-device.

**Match type:**
Acronym/prefix-of-words match confirmed (type `sf` → "Search Files"). Not published as BM25 or TF-IDF. Extensions can opt into Raycast's built-in client-side filter (`filtering={true}` on `<List>`) or handle `onSearchTextChange` themselves for custom ranking (e.g., server-side search with its own scoring).

**Value-aware accessory display:**
List items carry `accessories` (trailing right-aligned metadata): dates, counts, status tags, avatar icons. These update per-item as you navigate. The accessory array renders right-to-left from the trailing edge — the most important metadata (e.g., recent date) appears closest to the text, lesser metadata (e.g., author avatar) at the far right.

### Fallback action pattern (zero-results state)

**Trigger:** When Root Search returns exactly zero matching results for the current query.

**What appears:** The results area is replaced with a "Fallback Commands" section — a user-ordered list of commands that each receive the typed text as their argument:
- Default entries: File Search, Google Search
- User-configurable: any Quicklink with a single `{argument}` placeholder, any Script Command with a single argument
- Access via: search for "Manage Fallback Commands" in Raycast, or click the gear icon in the fallback section header

**UX mechanics:**
- The fallback section has its own section header with a settings (gear) icon in the header — discoverability and customization in one place
- Users reorder fallback commands via the Action Panel (same interaction as Favorites)
- Pressing Enter on a fallback invokes it with the current query text pre-filled

**What this teaches for Explore:**
Zero results should not show a blank state. It should show ranked "try instead" options:
1. "Search all time" (remove the date filter)
2. "Search all sources" (remove the connector filter)
3. "Relax to: results containing any of these terms" (AND → OR)
4. "Clear all filters and search" (nuclear reset)

The zero-results fallbacks are ordered by how likely they are to find something — analogous to Raycast's user-configurable fallback ordering.

### Detail/preview pane

**Two mechanisms:**

1. **`List.Item.Detail` — persistent right-side panel wired to keyboard navigation**
   Enabled via `isShowingDetail={true}` on the `<List>` component. The panel renders:
   - Markdown content area (top)
   - `List.Item.Detail.Metadata` panel (structured key-value section below): supports `Label` (key + value + optional icon), `Link` (clickable key-value), `TagList` (colored tag chips), and `Separator`. Updates in real time as the user moves up/down the list.

   Official guidance: "When `isShowingDetail` is true, do not also show accessories on `List.Item`" — avoid information doubling between list row and panel.

2. **Quick Look — floating file preview**
   Triggered with Cmd-Y. OS-level file preview (images, PDFs, documents) that floats inline and tracks navigation. Dismissed with a second press of Cmd-Y.

---

## Part D — How Each Pattern Maps to Explore (search + operators + chips + record feed)

### Mapping table

| Raycast/Stripe pattern | Explore equivalent |
|---|---|
| Root Search frequency × recency ranking | Surface recently-viewed / frequently-viewed records first before any query is typed; recency-sorted by default |
| Acronym/prefix match | Operator keywords shortened: type `dat` to get "date range", type `sou` to get "source:". No need to type exact field names |
| Fallback Commands section (zero results) | Zero-results state shows: "remove date filter", "search all sources", "clear all filters" as actionable buttons, not static copy |
| Action Panel (Cmd-K) shortcut education | Bottom action bar showing "F: Add filter | S: Sort | ?: Help" — visible at all times, teaches keyboard flow |
| Aliases → preset saved filters | Named filter presets (e.g., "This week from YNAB") accessible by keyboard shortcut or dropdown; one action to restore a saved query state |
| `isShowingDetail` persistent panel | Desktop: right-side peek panel updates on keyboard navigation. Mobile: full-page push nav on row tap |
| Accessories: date, count, tag, icon | Row trailing: relative date + source icon (connector logo) + status tag (collected / pending) |
| 16pt leading icon per row | Connector/source logo or record-type icon at left of each row — the primary visual anchor for scanning |
| Compact mode user toggle | Density control: compact (44px row height, icon-only accessories) vs. comfortable (56px, full accessory text) |
| Stripe Amount-leads column order | For financial records: amount leads left. For messages/notes: title leads. Let record type determine column order. |
| Stripe status pills (tinted, not solid) | Record status (collected, pending, failed) as tinted pills: pale background + darker text in semantic color |
| Stripe progressive "More filters" disclosure | Show 4-5 operators inline (date range, source, keyword, status). "More filters" reveals: metadata keys, exact field match, numeric comparators |
| Stripe chip dual-state (suggested vs. active) | Suggested operator button: `[+ Date range]` — opens a picker. Active chip: `[Date: Jun 1–22  ×]` — clearly shows current state, × to clear |
| Stripe "Clear filters" conditional | Show "Clear all" link only when ≥1 operator is active |
| Stripe hover-only bulk actions | Row-level actions (copy link, mark, open in new tab) on hover only — not persistent icon columns |
| Stripe tabular number alignment | Amounts right-aligned in their column with `font-feature-settings: 'tnum'` |
| Stripe 2-weight typography hierarchy | Use color + size for hierarchy, not font weight. Body = 400. Avoid 700 in feed rows. |

### Specific operator chip design recommendation

Based on the Stripe pattern:

```
[Resting, no operators active]
  [+ Date range]  [+ Source]  [+ Status]  [+ More filters ▾]

[Active, date operator set]
  [Date: Jun 1–22  ×]  [+ Source]  [+ Status]  [+ More filters ▾]   Clear all
```

- Suggested chips: `[+  FieldName]` — lighter visual weight, invites interaction
- Active chips: `[FieldName: Value  ×]` — shows current state, × clears that filter
- "Clear all" appears only when ≥1 filter active, at the end of the chip row
- Chips are rendered as separate elements for active vs. inactive state — don't conditionally wrap a chip in a link (causes Stripe's documented double-event bug)

### Record row layout recommendation

Based on Stripe (financial records) and Raycast (icon-first scan):

```
[16pt source/connector icon]  [Title / description]  [Amount if financial]  [Status pill]  [Relative date]
```

- Icon: leftmost, fixed width, from connector's branding
- Title: primary text, 400 weight, near-black, truncated at 1 line
- Amount: if present, right-aligned before status, tabular numbers, full decimal
- Status: tinted pill, compact, lowercase
- Date: trailing, subdued gray, relative ("3 days ago" / "Jun 18")
- Hover: checkbox (bulk) + action kebab appear; everything else stays identical

---

## Part E — Sources

### Official primary sources
| Source | URL |
|---|---|
| Raycast v1 Manual — Fallback Commands | https://manual.raycast.com/v1/fallback-commands |
| Raycast v1 Manual — Command Aliases and Hotkeys | https://manual.raycast.com/v1/command-aliases-and-hotkeys |
| Raycast Developer Docs — List API | https://developers.raycast.com/api-reference/user-interface/list |
| Raycast Developer Docs — Detail API | https://developers.raycast.com/api-reference/user-interface/detail |
| Raycast Developer Docs — Colors API | https://developers.raycast.com/api-reference/user-interface/colors |
| Raycast Developer Docs — Best Practices | https://developers.raycast.com/information/best-practices |
| Raycast Blog — A Fresh Look and Feel | https://www.raycast.com/blog/a-fresh-look-and-feel |
| Raycast Blog — Technical Deep Dive (v2) | https://www.raycast.com/blog/a-technical-deep-dive-into-the-new-raycast |
| Raycast Changelog — Windows v0.50 (Quick Look) | https://www.raycast.com/changelog/windows/0-50 |
| Stripe Docs — Dashboard Search Filters | https://docs.stripe.com/dashboard/search |
| Stripe Docs — Filter Controls Pattern | https://docs.stripe.com/stripe-apps/patterns/filter-controls |
| Stripe Docs — Chip Component | https://docs.stripe.com/stripe-apps/components/chip |
| Stripe Docs — Dashboard Basics | https://docs.stripe.com/dashboard/basics |
| Stripe Docs — Connect Dashboard Filters | https://docs.stripe.com/connect/dashboard/filters |
| Stripe Docs — Search API | https://docs.stripe.com/search |
| Stripe Support — Dashboard Update May 2024 | https://support.stripe.com/questions/dashboard-update-may-2024 |

### Secondary sources (UX teardowns and design analysis)
| Source | URL |
|---|---|
| DesignMD — Stripe token audit (May 2026, live CSS extraction) | https://designmd.cc/benchmarks/stripe |
| DesignMD — Stripe design system breakdown | https://www.designmd.run/blog/stripe-design-system-breakdown |
| Eleken — Making it like Stripe (UX teardown) | https://www.eleken.co/blog-posts/making-it-like-stripe |
| Eleken — Filter UX for SaaS | https://www.eleken.co/blog-posts/filter-ux-and-ui-for-saas |
| SaaSFrame — Stripe payments dashboard screenshots | https://www.saasframe.io/examples/stripe-payments-dashboard |
| Setproduct — Data Table UI Design (June 2026) | https://www.setproduct.com/blog/data-table-ui-design |
| Pencil & Paper — Enterprise Data Tables UX (Feb 2026) | https://www.pencilandpaper.io/articles/ux-pattern-analysis-enterprise-data-tables |
| UX Planet — Usable Data Tables (Jan 2025) | https://uxplanet.org/best-practices-for-usable-and-efficient-data-table-in-applications |
| Nielsen Norman Group — Progressive Disclosure | https://www.nngroup.com/articles/progressive-disclosure/ |

---

## Verification Notes (Adversarial checks)

**Claim: Stripe uses only weights 400 and 300 (no bold).**
Verified against live token extraction from designmd.cc (May 2026). Consistent with multiple secondary teardowns. The Stripe Elements Appearance API does allow weight 500 for embedded payment forms, but dashboard UI itself does not use 500+. **CONFIRMED.**

**Claim: Raycast frequency × recency is the explicit ranking signal.**
Stated directly in the v1 manual ("Use the suggestions to open frequently and recently used ones even quicker"). Consistent with the v2 technical deep-dive (all ranking is local, no cloud lookup). No contradicting source found. **CONFIRMED.**

**Claim: Fallback commands appear only on zero-results, not as a persistent "also try" list.**
Directly stated in the v1 manual: "when your search term doesn't have any matching result, you see a list of pre-defined commands." The section appears only when the result count is zero. **CONFIRMED.**

**Claim: Stripe Chip component has a known bug when wrapping active chip in a Link.**
Directly stated in the official Stripe docs (stripe-apps/patterns/filter-controls): "Render each state separately — wrapping an active chip in a Link causes onClose and the Link's press event to be sent simultaneously, which clears the filter and reopens the menu." **CONFIRMED (primary source).**

**Claim: Stripe does not have saved filters/views in the standard payments list.**
No Stripe changelog, doc page, or secondary source references a "saved filters" or "saved views" feature for the main payments list. Stripe Sigma has saved SQL queries, but that is a separate analytics product. **CONFIRMED ABSENT** — this is a genuine gap in Stripe's filter UX that Explore can beat.

**Claim: Raycast uses Inter in v2 / developers.raycast.com.**
CSS class `font-Inter` on the docs site root. v2 architecture is a WebKit WebView (TypeScript + React), consistent with using a web font. v1 was native Swift/AppKit using SF Pro (system font). **CONFIRMED for v2 / docs site; v1 used SF Pro.**

**Unverifiable claim: Exact row height / spacing pixels in Raycast.**
Raycast does not publish layout metrics. Observable ~44pt row height (matching AppKit NSTableView default) is inference from screenshots, not from official docs. Treat as approximate. **NOT CONFIRMED from primary source.**

**Unverifiable claim: Stripe pays list column order (Amount → Description → Status → Date).**
Consistent across multiple secondary sources and SaaSFrame screenshots. However, the May 2024 redesign renamed "Payments" to "Transactions" and reorganized the dashboard. Column order may vary by account type or feature flag. Treat as high-confidence but not guaranteed from primary docs. **LIKELY CORRECT; verify against live Dashboard.**
