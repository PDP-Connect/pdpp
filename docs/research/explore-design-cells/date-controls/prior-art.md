# Date / Time-Range Filtering — SLVP Prior Art for Explore

Prior-art research for redesigning the PDPP Explore date controls. Date: 2026-06-23.

## The two problems we are solving

1. **No specific-date / custom-range picker.** Explore offers only relative shortcut
   buttons — `Today / 7d / 30d / All`. There is no way to say "since June 12" or
   "May 1 → May 14".
2. **Redundant double-representation.** Selecting a shortcut *both* highlights the
   button (`aria-pressed`) *and* pushes a separate `Since 2026-06-12` chip into the
   chip row. One concept, two on-screen representations.

### What the code already gives us (so the gap is narrower than it looks)

Confirmed by reading the live source:

- `apps/console/src/app/dashboard/explore/explore-canvas.tsx`
  - L1170–1176: renders `today / 7d / 30d / all` as `rr-lens` buttons with
    `aria-pressed={activeRange === v}`, calling `setRange(v)`.
  - L920–921: `setRange` only ever calls `sinceForRange(range)` and **hard-clears
    `until`** (`until: ""`). So the UI can *never* produce a bounded `[since, until]`.
  - L960–977: `rangeLabel` is computed (`since {date}` or `{since} → {until}`) and
    **pushed into the chips array as a second representation** — this is the
    double-rep.
- `apps/console/src/app/dashboard/explore/explore-control-state.ts`
  - `sinceForRange(range)` → ISO `YYYY-MM-DD` (or `""` for `all`).
  - **`activeRangeKey` already returns `"custom"` when `until` is set or `since`
    doesn't match a preset.** The model *anticipates* custom ranges.
- The URL contract already carries both `since` and `until` (L141–142, L883). There
  is **no `<input type="date">`, no calendar, no DatePicker** anywhere in the canvas.

**Conclusion: the data model and URL contract are already range-capable; only the
control surface is missing.** This makes the SLVP move cheap — we add one popover and
collapse two representations into one, without touching the query layer.

---

## Per-product findings

### 1. Datadog — the canonical time-range picker

Source: https://docs.datadoghq.com/dashboards/guide/custom_time_frames/

- **Presets + absolute coexist in ONE control.** A single time selector exposes "a
  list of common time frames and a calendar picker for quick selection." Picking a
  preset or typing/clicking an absolute date both resolve into the *same* selector
  state — there is no separate "active" pill elsewhere.
- **A three-way taxonomy that is the real insight** (this is the honesty model PDPP
  needs):
  - **Sliding** — both ends move with time (`5h` = always the last 5 hours).
  - **Growing** — fixed start, end tracks `now` (`since Jun 1`).
  - **Fixed** — both ends frozen (`Jan 1 – Jan 2`).
- **Relative syntax**: `N{unit}` for a sliding window (`3mo`), `… to now` for a
  growing window (`10am to now`). Units accept many spellings (`m/min/minute`,
  `h/hr/hour`, `d/day`, `w/week`, `mo/month`).
- **Keyboard**: highlight a portion of the displayed time frame and use `[↑]`/`[↓]`
  to increment by minute/hour/day/month/year. Direct in-place editing, no modal.
- **Persistence/honesty**: URL encodes `from_ts`/`to_ts` (Unix ms) plus `live=true`,
  where `live` records *whether the range is relative* — i.e. the system explicitly
  remembers "is this window sliding or frozen," which is exactly PDPP's honesty
  concern about what "the active window" means.

### 2. Grafana — relative + absolute in one popover, the cleanest reference impl

Sources:
- https://grafana.com/docs/grafana/latest/visualizations/dashboards/use-dashboards/
- https://grafana.com/blog/2022/02/03/pro-tip-how-to-use-semi-relative-time-ranges-in-grafana/

- **One popover, two regions.** Clicking the current time range opens a popover with:
  (a) **Absolute time range** — `From` and `To` fields *plus* a calendar; and
  (b) a **Relative time ranges** quick-list (Last 5m, Last 15m, … presets).
- **Unified input field.** The `From`/`To` fields accept *either* an exact timestamp
  (`2020-05-14 00:00:00`) *or* a relative expression (`now-24h`) — then **Apply time
  range**. One text affordance spans both modes.
- **Relative grammar** (worth borrowing for honest labels): `now`, `now-24h`,
  `now/d` (the day so far), `now/w` (this week), `now-1M/M` (previous month). The
  `/unit` suffix snaps to a calendar boundary.
- **Semi-relative** = absolute start + `now` end (a "growing" window in Datadog
  terms). The doc explicitly distinguishes this from a fully-relative window.
- **Active selection has ONE representation**: the trigger button itself shows the
  current range; hovering it reveals exact timestamps and their source (e.g. "local
  browser"). There is no second pill duplicating it.
- Shows "recently used absolute ranges" inside the popover for fast re-selection.

### 3. Linear — relative date language in a filter chip (the chip *is* the editor)

Sources:
- https://linear.app/docs/filters
- https://linear.app/developers/filtering

- **Date is a filter category like any other**: `Completed`, `Created`, `Due`,
  `Updated` (Filters → Filter categories).
- **The filter chip is the single representation** *and* the editor. Press `F`, pick
  the date field, then **click the chip's operator/value segment to change it** —
  "the filter type itself cannot be changed, but clicking any other part of the
  filter formula gives you options to modify the query." There is no separate
  highlighted preset button *and* a chip; the chip carries the whole statement.
- **Relative is first-class in the data model**: the API expresses relative windows
  as ISO-8601 durations against `now` — `completedAt: { gt: "-P2W" }` (closed in the
  last 2 weeks), `dueDate: { lt: "P2W" }` (due in next 2 weeks). Comparators
  `gt/lt/gte/lte` + null. This is the cleanest "one honest statement" encoding:
  `<field> <operator> <relative-or-absolute value>`.
- **Natural-language entry** ("what issues are due next week") resolves into the same
  chip — input mode varies, representation is singular.

### 4. Stripe Dashboard — preset OR custom from one dropdown, plus compare

Source: https://support.stripe.com/questions/customizing-the-date-range-for-dashboard-home-charts

- **One dropdown serves both** preset and custom: "select a preset or custom date
  range from the first dropdown menu." Choosing "Custom" opens the calendar in the
  same surface.
- A **separate** dropdown handles *comparison* period (prior period) — a clean lesson
  in *not* overloading the primary range control with unrelated concerns.
- Boundary honesty matters and Stripe documents it: a `Jan 13 – Jan 14` range filters
  `Jan 13 00:00:00 → Jan 14 23:59:59` (inclusive end-of-day), and they note the
  convention differs between Dashboard and Sigma — i.e. *the exact window a label
  denotes must be stated, not assumed.* Directly relevant to PDPP's honesty rule.

### 5. GitHub (Primer) — query grammar + a hard-won "single label hides the range" lesson

Sources:
- https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests (date qualifiers)
- https://primer.style/product/components/date-time-picker/
- https://medium.com/primer-design/the-journey-of-a-date-picker-90621a04381f

- **Query grammar** (issues/PRs/commits/repos): `created:>2020-01-01` (after),
  `created:>=2020-01-01` (on/after), `created:<…` (before), and **range**
  `created:2020-01-01..2020-12-31`. Qualifiers: `created`, `updated`, `merged`,
  `closed`. Dates are ISO-8601 `YYYY-MM-DD`, optional `THH:MM:SS+00:00`. One text
  qualifier = one honest statement of the window. (Note: code search does *not*
  support date filters — backend limitation.)
- **The Primer date-picker case study is the single most on-point source for our
  double-rep bug.** Their *early* version had preset buttons that auto-filled and
  submitted — "we didn't show the selected date range. So if you picked 'Last 7
  days,' it would auto-fill the dates, but **you wouldn't see which range you had
  actually chosen.**" That is the *inverse* of PDPP's bug (PDPP shows the range
  *twice*; Primer showed it *zero* times) — but the resolution principle is the same:
  **the preset and the resolved range must be ONE coherent surface, not two
  disconnected controls.** Primer's fix was a **hybrid input**: a calendar/date-field
  *and* a preset list in the same popover, with the chosen preset reflected into the
  date fields. Selecting a preset updates the inputs; the inputs are the single
  source of truth for "what's selected."
- Primer also added an **action bar (Apply/Cancel)** because auto-submit-on-end-date
  caused errors and gave "no clear indication that the range would be submitted" — a
  caution for confirm-vs-instant on *custom* ranges specifically.

### 6. Notion & Airtable — relative operators inside a view filter

Sources:
- (Notion) https://www.notion.so + community: "is within" → "the past week" / "the next month"
- (Airtable) https://support.airtable.com/docs/filtering-records-using-conditions

- **Notion**: native relative filter — date property → operator **`is within`** →
  relative window **`the past week` / `the past month` / `the next month`**, plus
  `is before` / `is after` / `is on or before` for absolute. The operator + value is
  the single representation, shown as one filter row.
- **Airtable**: `is within` supports `this month`, `the past year`, `the next week`
  (rolling, e.g. "past year = past 365 days, *not* the previous calendar year" —
  documented to avoid ambiguity). For a *calendar* month users combine
  `is on or after <first>` AND `is on or before <last>` — i.e. two bounded
  conditions = an explicit `[since, until]`. Reinforces that "rolling vs. calendar"
  must be made explicit in copy.
- Lesson for PDPP: relative windows should read as a *single* operator+value
  statement ("within the past 7 days"), and the rolling-vs-anchored ambiguity has to
  be resolved in the label.

### 7. Things 3 / Linear — relative date *language*

- Things uses human relative anchors ("Today", "This Evening", "Upcoming",
  "Anytime") rather than absolute dates in its primary surface — relative language is
  the default vocabulary, absolute is the exception. Linear's `last 2 weeks` /
  `next week` natural phrasing is the same instinct. Takeaway: **lead with relative,
  human phrasing; offer absolute as the precise fallback.**

---

## Cross-product synthesis

What every SLVP-tier product does that PDPP currently violates:

1. **ONE control, ONE representation.** The trigger/chip *is* the selection. Presets,
   absolute calendar, and relative text all live *inside* that one control's popover
   and resolve into *the same* displayed state. Nobody renders a highlighted preset
   button **and** a duplicate "Since X" pill. (PDPP does — that's the double-rep.)
2. **Presets + custom are not separate features — they are two entry modes into one
   range.** Datadog, Grafana, Stripe, and Primer all merge them in a single popover;
   Linear/Notion merge them into one operator+value chip.
3. **The resolved window is always visible and unambiguous.** Grafana shows exact
   timestamps on hover; Stripe documents inclusive end-of-day; Datadog distinguishes
   sliding/growing/fixed. The *one honest statement* names not just the dates but the
   *kind* of window.
4. **Relative is the default vocabulary; absolute is the precise fallback** (Things,
   Linear, Notion lead relative; Grafana/Datadog/GitHub allow exact).
5. **Custom-range entry deserves a confirm step** (Primer's action bar, Grafana's
   "Apply") — presets apply instantly, but a hand-picked `[start, end]` should not
   auto-submit on the second click.

---

## Recommended SLVP-ideal pattern for Explore

**One date control. One chip. One honest statement of the active window.**

### The control

Replace the four standalone `rr-lens` range buttons **and** the separate `rangeLabel`
chip with a **single "Date" control** that is *both* the active-state display and the
editor (Linear/Grafana model):

- **Resting state** = a single chip/button that reads the current window as one honest
  phrase:
  - All time → `Date: all` (or just omit the chip when unfiltered, matching the other
    facet chips).
  - Preset → `Date: last 7 days` (relative phrasing, Things/Linear style).
  - Anchored open-ended → `Date: since Jun 12` (growing window — end is "now").
  - Bounded → `Date: May 1 – May 14` (fixed window).
  - There is exactly **one** of these on screen. No `aria-pressed` button lit up
    *and* a chip; the chip carries the whole statement.
- **Clicking it opens a popover** (Grafana/Primer hybrid layout):
  - **Left/top: preset list** — `Today`, `Last 7 days`, `Last 30 days`, `All time`,
    `Custom…`. Presets apply **instantly** and close (cheap, reversible). The active
    preset is the one shown in the resting chip — not separately highlighted
    elsewhere.
  - **Right/bottom: absolute fields** — `From` and `To` inputs backed by a single
    calendar panel (dual on desktop ≥861px, single on mobile, per `uxpatterns.dev`).
    Picking dates here is the **Custom** path. Custom requires an explicit **Apply**
    (Primer's lesson: don't auto-submit a hand-picked range).
  - Selecting a preset reflects its resolved dates into the From/To fields (Primer
    hybrid: inputs are the single source of truth), so the user always sees *which*
    window a preset means.

### Wiring it to the existing model (low-cost)

- `setRange` already exists for the four presets — keep it for the instant presets,
  but **stop hard-clearing `until`** on the Custom path.
- The **Custom** path sets *both* `since` and `until` via the URL contract that
  already exists (L141–142). `activeRangeKey` **already returns `"custom"`** — wire
  the popover's Apply to set `until`.
- **Delete the `rangeLabel`-into-chips push (L976–977 region).** The single Date chip
  *is* the representation. This is the line that creates the double-rep. The chip's
  `clear()` resets to `all` (already implemented).
- Label copy = one honest statement, derived from `(since, until)`:
  - `since && until` → `{since} – {until}` (fixed window).
  - `since && !until` → `since {since}` (growing/anchored — end is now).
  - matches a preset → the preset's human phrase (`last 7 days`).
  - neither → no chip (all time).

### Honesty rules satisfied

- **Exactly one representation** of the active window (resolves the double-rep gap).
- **The label names the window precisely** — and, borrowing Datadog/Stripe, can
  distinguish *anchored/growing* (`since Jun 12`, end = now) from *fixed*
  (`May 1 – May 14`, both frozen). A relative preset reads as relative phrasing
  (`last 7 days`), not a frozen date, so it never lies about being a snapshot.
- **No custom-range gap** — the From/To calendar + Custom path fills it using the
  URL/data model that already supports `until`.

### Accessibility / keyboard (from uxpatterns.dev + Primer)

- Popover is `role="dialog"`; preset group is `role="group"
  aria-label="Date presets"`; each preset button applies immediately and updates the
  From/To inputs.
- Range-selection progress announced via `aria-live="polite"` ("Select a start date" →
  "Start date selected: May 1. Now select an end date").
- Completed range announced as one summary ("Date filter: May 1 to May 14, 2026").
- Calendar panels keyboard-navigable (arrow keys); focus returns to the Date trigger
  on close; in-range day cells convey state by more than color.
- If end < start, swap automatically and announce (forgiving default).

### What to explicitly NOT do

- Don't keep both the lit preset button *and* the chip (the current double-rep).
- Don't auto-submit a hand-picked custom range on the second calendar click (Primer's
  documented mistake).
- Don't overload the Date control with a "compare period" concept (Stripe keeps that
  separate) — out of scope for Explore.

---

## Sources

- Datadog — Custom Time Frames: https://docs.datadoghq.com/dashboards/guide/custom_time_frames/
- Datadog DRUIDS DateRangePicker (component index, JS-rendered): https://druids.datadoghq.com/components/time/DateRangePicker
- Grafana — Use dashboards / time range: https://grafana.com/docs/grafana/latest/visualizations/dashboards/use-dashboards/
- Grafana — Semi-relative time ranges (blog): https://grafana.com/blog/2022/02/03/pro-tip-how-to-use-semi-relative-time-ranges-in-grafana/
- Linear — Filters: https://linear.app/docs/filters
- Linear — API Filtering (relative ISO-8601 durations): https://linear.app/developers/filtering
- Stripe — Customizing the date range for Dashboard home charts: https://support.stripe.com/questions/customizing-the-date-range-for-dashboard-home-charts
- GitHub — Searching issues and pull requests (date qualifiers / range syntax): https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests
- GitHub Primer — DateTimePicker (component): https://primer.style/product/components/date-time-picker/
- GitHub Primer — "The journey of a date picker" (case study, the single-label pitfall + hybrid fix): https://medium.com/primer-design/the-journey-of-a-date-picker-90621a04381f
- Airtable — Filtering records using conditions: https://support.airtable.com/docs/filtering-records-using-conditions
- Notion — relative date filters ("is within" → "the past week"): https://www.notion.so/help/views-filters-and-sorts
- UX Patterns for Developers — Date Range pattern (anatomy, a11y, presets): https://uxpatterns.dev/patterns/forms/date-range
- Evolving Web — Most popular date filter UI patterns: https://evolvingweb.com/blog/most-popular-date-filter-ui-patterns-and-how-decide-each-one
