# Linear: Command Bar + Filter UX — Design Benchmark

**Date:** 2026-06-23
**Purpose:** Concrete design evidence from Linear to steer PDPP's Explore surface redesign (search box + operators + filter chips + record feed).
**Sources:** Linear official docs, Linear design blog series (2024), Refero design-system extract, typography teardowns.

---

## Principles to Steal (The 12 Most Replicable)

1. **One input, multiple modes.** Linear does not place a separate "filter bar" alongside a search input. The command menu (`/`) handles free-text search; `F` opens the filter picker from within the same command surface. Chips appear in the header bar _below_ the single search entry point. The user never operates two separate input zones.

2. **Type-ahead by value, not just by property name.** In the filter menu, typing "Andreas" directly surfaces "Assignee is Andreas" — the system resolves the property from the value. Typing "High" surfaces "Priority is High." Users do not need to type the property name first. This is the quickest path to the correct filter.

3. **Prefix-scoped narrowing in the command input.** In the search/command menu, typing a single character followed by Space scopes results to an entity type: `i ` = issues, `p ` = projects, `u ` = users, `t ` = teams, `l ` = labels, `f ` = favorites, `d ` = documents. The menu teaches this vocabulary contextually — it is visible in the UI hint area, not in a help page.

4. **Chips are structured tokens, not text.** Each filter chip has three independently clickable zones: **[property] [operator] [value(s)]**. Clicking the operator (`is`) gives a popover to switch to `is not`. Clicking the value shows a re-selectable list. The property is intentionally not re-editable (you remove and re-add instead). This prevents the chip from becoming an ambiguous text field.

5. **Operator adapts to cardinality.** When you add a second value to a chip (e.g., two assignees), the operator automatically changes from `is` to `is either of`. Remove one value and it reverts. The operator vocabulary is: `is / is not` (single), `is either of / is not` (multi), `includes any / all / neither / either / none` (labels/links), `before / after` (dates). The UI never shows inapplicable operators.

6. **Negation is a one-click toggle on the chip.** There is no separate "exclude" input. You click the operator portion of an existing chip and select `is not` (or `does not include`). This teaches negation in-context; users discover it by interacting with an active filter.

7. **AND/OR is progressive-disclosed.** Default behavior: all chips are implicitly AND. The Advanced Filter mode (reached via "Advanced filter" from the filter menu) opens a structured builder that supports nested groups and explicit AND/OR toggles between conditions. This keeps the default surface uncluttered while making full expressiveness reachable.

8. **Filter picker shows match counts.** When the filter menu is open, each filterable property and value is shown with the count of matching issues. Users can see whether a filter will produce results before committing to it. This turns the filter UX into navigation, not guesswork.

9. **Saved views are the persistence model.** Active filter states are not ephemeral session state. `Option/Alt + V` saves the current filter combination as a named custom view, which appears in the sidebar. This converts a filter query into a first-class navigation destination — the "save filter" action is promoted to the same level as keyboard shortcuts.

10. **Content is the hero of every row; metadata recedes.** Issue title leads the row at full weight. Status indicator (small color dot), priority icon, assignee avatar, and identifier (Berkeley Mono) are all right-justified or placed after the title with significantly reduced visual weight. The scan axis is the left edge (title column), not a metadata-first layout.

11. **The type scale is calibrated, not bold.** Linear uses **weight 510** (not 600/700) for UI emphasis. This produces hierarchy through _precision_ rather than heaviness. Secondary text reads at weight 400, muted text at 400 + reduced opacity/color. The result is a dense list that does not feel heavy.

12. **LCH-generated surface system, not fill-based elevation.** Cards and surfaces distinguish elevation via `1px inset border` + `rgba(0,0,0,0.4)` drop shadow, never via fill-color alone. Because they generate themes in the LCH perceptual color space, dark/light variants remain perceptually consistent.

---

## Section 1: The Command Bar / Omnibar

### Entry Points and Shortcuts

Linear provides several overlapping entry points, each scoped to a different task:

| Shortcut | Behavior |
|---|---|
| `/` | Global search: issues, projects, documents by title/description/comments |
| `Cmd/Ctrl F` | In-view search: filters _current_ list by exact title — acts as a live view filter, not a search |
| `O` then `I` | Quick issue search: by issue ID or title only; shows recent issues on open |
| `F` | Opens the filter picker for the current view |
| `Cmd/Ctrl K` | Command palette: actions, navigation, anything |

**Key insight:** These are distinct modes, not one omnibar. `/` is exploratory. `Cmd/Ctrl F` is navigational within a view. The filter picker (`F`) is additive refinement. Users learn the difference through repetition, not explicit labeling.

### Autocomplete Behavior in the Filter Picker

When the filter picker is open:
- **Free-text search** across all filterable properties and values. Typing "Andreas" resolves to the Assignee property and the specific user "Andreas" as a value — no intermediate step to first select "Assignee."
- **Match counts are shown** alongside each option so users can see the impact before applying.
- **Quick filter names** (typing the exact value name, e.g., "In Progress", "High") allow single-step filter application without drilling into a category hierarchy.

The filter picker categorizes properties (Issue property, Workflow, Dates, User, etc.) but these categories collapse when you start typing — the list flattens to matching results across all categories.

### Teaching the Query Language In-Flow

Linear teaches the query system through:
1. **Prefix + Space** in the search/command menu: type `i ` and the menu narrows to issues only, with a visible label showing what the scope is.
2. **@ mentions in search**: typing `@status`, `@assignee`, `@team` in the global search bar automatically creates and applies a filter. The filter chip appears as the user types the mention.
3. **Operator mutation on chips**: clicking `is` to see `is not` teaches negation exactly when the user has a reason to negate.
4. **"Advanced filter" option** in the filter menu exposes AND/OR only when the user has actively reached the filter picker — it is not surface-level clutter.

### What is NOT in the filter UI

- No text box for writing raw query syntax in normal mode (no `status:in-progress assignee:me` style text query on the filter bar itself — that belongs to specialized CLI/API access).
- No separate "active filters" panel separate from the header bar — chips live in one place.
- No persistent "clear all" button when there are no filters active — it appears contextually.

---

## Section 2: Active Filters as Chips

### Chip Anatomy

Each chip is a structured token: `[Property Label] [Operator] [Value(s)]`

- Example: `Assignee is Andreas`
- Example: `Status is not Done`
- Example: `Labels includes any Bug, Performance`

The property label is read-only in the chip (no re-edit). Operator and value(s) are individually clickable.

### Adding a Filter

1. Press `F` (or click Filter button)
2. Type to search or browse by category
3. Select a property category (e.g., "Assignee")
4. Select specific values — multi-select is supported
5. Chip materializes in the filter bar

Press `F` again to add another filter. Multiple chips stack in the header bar.

### Editing a Filter (After it's Applied)

- Click the **operator** portion of the chip → popover with available operators for that filter type.
- Click the **value** portion → re-opens the value picker (checkbox list for multi-select types, date picker for date types).
- **You cannot change the property** of an existing chip — remove and re-add with the new property.

### Removing a Filter

- Click the `X` on the chip.
- Or: focus the filter area and press `Backspace/Delete` to clear.

### Negation (is / is not)

Clicking the operator portion reveals the inversion option. The system adapts the negation vocabulary to the cardinality:
- Single value: `is` → `is not`
- Multiple values: `is either of` → `is not` (i.e., excludes all of them)
- Labels/links: `includes any` → `includes none`, `includes all` → etc.

**Deliberate constraint:** There is no explicit "NOT" prefix syntax in the chip input itself. Negation is always applied by mutating an existing positive filter's operator. This keeps the creation flow positive and the negation discoverable but not accidental.

### AND / OR Logic

- **Default (implicit AND):** All chips in the bar are AND'd together.
- **Advanced filter mode:** A structured builder (accessed from the filter menu) allows grouping conditions and setting explicit AND/OR logic between groups, including nested groups.
- **Deliberate constraint:** OR is hidden behind "Advanced filter" — the default experience never exposes it. This keeps the common 95% case (AND-only filters) clean and uncluttered.

---

## Section 3: The Visual System

### Typography

| Role | Font | Size | Weight |
|---|---|---|---|
| All UI text | Inter Variable | 10–24px (UI), 32–72px (display) | 300, 400, 510, 590 |
| Issue title (primary row content) | Inter Variable | ~14px | 400–510 |
| Secondary metadata (assignee, dates) | Inter Variable | ~12px | 400 |
| Status badge labels | Inter Variable | 12px | 510 |
| Issue IDs (e.g., ENG-2703) | Berkeley Mono | ~12px | — |
| Keyboard shortcuts | Berkeley Mono | ~11–12px | — |
| Code references | Berkeley Mono | varies | — |

**Key rules:**
- Inter Variable weight 510 (between Regular and Medium) is the emphasis weight — used for badge labels, nav items, and anything needing hierarchy above body without shouting. Weight 590 is used sparingly for strong emphasis.
- Weight 300 appears only on large display headings (64–72px) — "authority through restraint."
- Berkeley Mono is used **exclusively** for technical metadata (IDs, shortcuts, code). Never for prose or UI labels. Its presence is a signal: "this is a precise identifier, not a name."
- Negative letter-spacing at display sizes: `-0.022em` at 72px scaling to `-0.010em` at 20px. No negative tracking below ~20px.
- OpenType features `cv01` and `ss03` are active on Inter Variable, contributing to its refined instrument-panel feel.
- Stop words are excluded from search automatically (standard English set).

### Color / Contrast

**Dark theme (primary):**

| Role | Value |
|---|---|
| Canvas background | `#08090a` |
| Nav/card surface | `#0f1011` |
| Deep card (row background) | `#161718` |
| Hairline border | `#23252a` |
| Input/control border | `#383b3f` |
| Primary text | `#f7f8f8` |
| Secondary text | `#8a8f98` |
| Muted text | `#62666d` |
| Accent (indigo, icons/links) | `#5e6ad2` |
| Primary action (filled button) | `#e4f222` (acid lime) |
| Success dot | `#27a644` (Emerald) |
| Error/warning dot | `#eb5757` (Crimson) |

**Key rules:**
- The accent color is rationed to **one primary action per screen**. Everything else exists in the near-black monochrome scale.
- Elevation is expressed via `1px inset border (#23252a)` + `rgba(0,0,0,0.4)` drop shadow. Never via fill color change alone.
- The color system is generated in **LCH color space** (perceptually uniform), enabling consistent theme generation. HSL is not used for theming.
- Content text (`#f7f8f8`) at a ~19:1 contrast ratio against canvas ensures the content is the hero; chrome text (`#8a8f98`) at ~4.5:1 provides comfortable secondary reading.

### Spacing / Density / Rhythm

| Metric | Value |
|---|---|
| Density descriptor | Compact |
| Base unit | 4px |
| Border radius: badges | 2px |
| Border radius: nav items, inputs, buttons | 6px |
| Border radius: cards | 12px |
| Button/pill padding | Compact (approx 4–8px vertical, 8–12px horizontal) |
| Element gap | 8–12px |
| Card padding | 24–32px |

Row height in the issue list is not published precisely, but teardowns suggest approximately **36–44px** per row in compact list mode — dense enough to show 20–30 issues without scrolling on a standard 1080p display.

The design avoids "breathing room" whitespace typical of marketing pages. Vertical rhythm is tight and purposeful.

---

## Section 4: The List / Feed Row

### Row Structure (Left to Right)

```
[Priority icon] [Status dot] [Issue title, weight 510 or 400]   [Labels chips] [Assignee avatar] [ID (mono)] [Date]
```

- **Title leads.** It is the widest element and the primary scan axis. All metadata is either left of the title (small glyphs) or right-justified after it.
- **Priority icon** is a small glyph (4 variants: urgent/high/medium/low/no-priority), not a word.
- **Status indicator** is a small colored dot or icon, not a badge with text in the row (text appears in grouped/section headers).
- **Labels** appear as compact colored chips only when present — they don't take space when absent.
- **Assignee avatar** is circular, ~20px, appears to the right.
- **Issue ID** (e.g., `ENG-2703`) is in Berkeley Mono, right-aligned or near the assignee, visually subdued (muted text color).
- **Timestamps** are relative ("2h", "3d") in muted text, right-aligned.

**Key rule:** The row is scannable left-to-right by content meaning. Glyphs encode status/priority without requiring reading. The eye naturally moves: priority → status → title → labels → who → when.

### What is NOT in the row

- No source URL or domain name
- No full timestamps (relative only)
- No truncated description text (unlike email clients) — the title IS the summary
- No heavy borders between rows — a subtle separator or hover state differentiates rows

### Hover State

On hover, the row gets a subtle background fill (`#161718` → slightly lighter). Action affordances (quick actions, drag handle) appear on hover. They are invisible at rest, reducing ambient clutter.

---

## Section 5: Mobile Adaptation

Linear does not extensively document its mobile filter UX, and the product is primarily desktop/macOS-first. Based on available evidence:

- **The main app (web/desktop) is not optimized for phone-width usage.** Linear's mobile app is separate and more limited in scope.
- **Mobile Linear app** (iOS/Android): Issue creation and basic list browsing are supported; the full filter/command surface is desktop-only.
- **Progressive web experience** at tablet widths: the sidebar collapses; filter chips remain in the header bar but may scroll horizontally.
- **The keyboard-first design is inherently desktop-bound.** Linear makes no attempt to replicate the command palette UX on touch — it adapts by simplifying to touch targets.

**Design decision (deliberate constraint):** Linear chose to build the full-power filter and command surface for keyboard+pointer users and offer a simplified mobile experience rather than compromise the desktop UX for touch parity.

**Implication for PDPP Explore:** Linear's mobile adaptation is not the model to copy for a mobile-primary use case. The SLVP verdict (full-page push nav on mobile, separate sheet for filters at phone width) remains the correct pattern for a surface expected to work on phones.

---

## Section 6: Mapping to PDPP's Explore Surface

| Linear Pattern | Applicable to Explore | Specific Recommendation |
|---|---|---|
| One input, multiple modes | Yes | Keep a single text input. Chips live below/beside it, not in a second input zone. |
| Value-first autocomplete | Yes | Typing a connection name or record type should resolve the property — don't require `con:gmail`, allow typing "gmail" and resolving to `con:gmail`. |
| Prefix + Space entity scoping | Yes | `con ` → scope to connector filter; `stream ` → scope to stream; etc. Visible hint in the dropdown. |
| Structured chip tokens | Yes | Each chip = [property] [operator] [value]. Clicking operator opens is/is-not. Clicking value opens re-picker. |
| Operator adapts to cardinality | Yes | Single value: `is / is not`. Multiple values: `is any of / is none of`. Date: `before / after`. |
| Negation via operator mutation | Yes | No separate "exclude" mode. Negate by clicking the operator on an existing chip. |
| AND-only by default; Advanced for OR | Yes, partially | Explore's current grammar is AND-only. If OR is needed, gate it behind an "Advanced" toggle, do not surface it in the primary bar. |
| Match counts in filter picker | Yes | Show count of matching records next to each filter option in the dropdown. |
| Content leads the row | Yes | Record content (message/transaction/event text or title) must lead the row at full weight. Connection name and timestamp are right-justified and muted. |
| Berkeley Mono for IDs | Yes | Record IDs and connector keys should be mono; prose/titles should not. |
| Elevation via border, not fill | Yes | Use `1px inset border` + soft shadow for cards/panels. Don't change background fill for depth. |
| LCH-based theme | No (PDPP uses brand colors) | Adopt the _principle_: use perceptual color space for any programmatic theme generation. |

---

## Section 7: Findings That Flag Deliberate Constraints vs. Affordances

**Deliberate constraints (not bugs or oversights):**

- **No OR in the default filter bar.** This simplification is intentional — AND-only is correct for 95% of queries. OR is progressively disclosed.
- **Property is not editable on existing chips.** You must remove and re-add. This prevents confusing state where a chip's structural identity changes in place.
- **Mobile is simplified, not adapted.** Linear accepted that the keyboard-first surface does not translate to touch. PDPP should not use Linear as the model for mobile filter UX.
- **No raw query syntax in the filter bar.** The filter picker _is_ the query builder. There is no text box for typing `assignee:me status:in-progress` on the main UI (that belongs to API/CLI).
- **Berkeley Mono only for technical identifiers.** Its use is a deliberate semantic signal — not decoration, not code-adjacent styling.

**Affordances (features that earn complexity):**

- **@ mentions in search** auto-convert to filter chips — this is an advanced shortcut, not a primary entry point.
- **Save as View** (`Option/Alt + V`) elevates filters to named navigation — making filters persistent and shareable.
- **Match counts in the filter picker** — adds meaningful real-time feedback that justifies the implementation cost.

---

## Sources

- [Linear Filters Documentation](https://linear.app/docs/filters) — Official source for filter categories, operators, chip behavior, and advanced filter AND/OR.
- [Linear Search Documentation](https://linear.app/docs/search) — Official source for shortcut modes, prefix narrowing, @ mention filters, sort behavior.
- [How we redesigned the Linear UI (part II)](https://linear.app/now/how-we-redesigned-the-linear-ui) — Design team retrospective on hierarchy, LCH colors, sidebar/header changes (2024).
- [A design reset (part I)](https://linear.app/blog/a-design-reset) — Co-founder Karri Saarinen on the redesign rationale, inverted-L chrome, and concept exploration process.
- [Welcome to the new Linear — Changelog March 2024](https://linear.app/changelog/2024-03-20-new-linear-ui) — Release announcement for the redesigned UI.
- [Linear Design System — Refero Styles](https://styles.refero.design/style/90ce5883-bb24-4466-93f7-801cd617b0d1) — Third-party documented design tokens: Inter Variable weights/sizes/tracking, Berkeley Mono role, color values, spacing table, elevation approach.
- [Inter UI in action on linear.app — Typ.io](https://typ.io/s/2jmp) — Typography specimen of Inter Variable as deployed on linear.app.
- [Command Palette UX Patterns — Medium/Bootcamp](https://medium.com/design-bootcamp/command-palette-ux-patterns-1-d6b6e68f30c1) — General UX analysis of command palette patterns applicable to Linear's approach.
- [Linear App Complete Guide — ProductivityStack](https://productivitystack.io/guides/linear-app-complete-guide/) — 2026 usage guide confirming keyboard-first, command-palette-centered workflow.
