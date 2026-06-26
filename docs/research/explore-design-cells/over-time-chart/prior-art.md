# Over-time chart (brush-to-filter histogram) — prior art

**Cell:** the over-time chart — an interactive time-distribution histogram ABOVE the Explore feed that
doubles as a filter (brush a range → filter the list). Currently **UNBUILT** on the live surface
(`ExploreCanvas`); decision = design now, build later, to the SLVP-ideal.

**Method:** product-specific, on-disk, real URLs. Pages fetched + indexed via context-mode
(`grafana-log-volume-histogram`, `grafana-logs-in-explore`, `datadog-log-explorer`,
`datadog-log-visualize`, `datadog-custom-time-frames`). Searches captured for Stripe Workbench,
Sentry, GitHub Insights, and the d3-brush / Observable brushing-UX corpus.

---

## The canonical reference: Grafana Explore full-range log-volume histogram

**URL:** https://grafana.com/blog/2022/03/02/new-in-grafana-8.4-how-to-use-full-range-log-volume-histograms-with-grafana-loki/
· docs: https://grafana.com/docs/grafana/latest/visualizations/explore/logs-integration/

This is the closest analogue to what we want and the cleanest honesty model, so it is the **canonical
pattern**. Verbatim mechanics that matter:

- **Placement:** the volume graph sits DIRECTLY ABOVE the log-line list in Explore; one query drives
  both. "Results of log queries display as individual log lines and as a graph showing the logs volume
  for the selected time period." The chart is a *summary of the same set the list shows*, in the same
  pane — not a separate dashboard.
- **Brush = drag across bars → set the time picker → re-run.** "Click and drag on the histogram to zoom
  into a specific time range… Grafana will then update the time picker and re-run the query for that
  narrower selection." **Crucially the brush writes into the EXISTING time picker** — it does not create
  a parallel range object. This is the canonical-state lesson, already solved by the reference.
- **Bucket interval is auto-derived from the span and SNAPPED to friendly units** (1 minute, 1 hour, 1
  day). Grafana "automatically adjusts the interval based on the selected time span to simple and
  user-friendly values." Never arbitrary bucket widths.
- **Anchoring (honest extent):** "the start of the histogram is anchored by the first log row's
  timestamp from the result… the end of the time series is anchored to the time picker's To range." The
  chart's domain is the *resolved query window*, not an arbitrary fixed N days.
- **The honesty nuance we must copy:** "zooming in doesn't trigger a new query, so you are not
  unnecessarily running new queries." After a brush, Grafana shows a **"Reload log volume"** button to
  recompute buckets at the new resolution. i.e. Grafana is explicit that the *displayed bars can be
  stale relative to the brushed window* until reloaded — it never silently implies the old bars describe
  the new window. (We resolve this differently — re-derive on filter change — but the principle that a
  bar must describe the set it claims to describe is the takeaway.)
- **Stacked sub-series only from a RELIABLE signal:** bars stack by log level, and Grafana is careful —
  it uses the `level` label if present, else parses, else renders "unknown." It does **not** invent a
  level. Maps directly onto our Gate-1 "render from declared signal, never guess."

**Why canonical for us:** brush→existing time object, auto-snapped buckets, domain anchored to the
resolved window, and an explicit stance on bar-vs-window staleness. Four of our five honesty
requirements are demonstrated by one shipping product.

---

## Datadog Log Explorer — the "timeseries above the list" placement + drag-to-zoom

**URL:** https://docs.datadoghq.com/logs/explorer/ · visualize:
https://docs.datadoghq.com/logs/explorer/visualize/ · time frames:
https://docs.datadoghq.com/dashboards/guide/custom_time_frames/

- Log Explorer is "your home base for log troubleshooting… search and filter, group, visualize, and
  export logs." The **list and the timeseries are two visualizations of the same filtered set** ("view
  your logs in a list… or in a timeseries graph to measure your log data over time").
- **Drag-on-graph → zoom the time window** is the documented Datadog interaction across timeseries
  widgets (dragging across a series narrows the global time frame). The time frame is a **single global
  control** (preset list + calendar picker, top-right) — the graph drag and the picker write the same
  window. Same canonical-state lesson as Grafana.
- THE-LENS Gate 2 already names **Datadog** as the reference for "an interactive over-time visualization
  that doubles as a filter." This corroborates the placement (above/beside the list, one shared window)
  and the interaction (drag-to-zoom into the same time control).
- **Density:** Datadog favors a moderate bar count auto-fit to width; it does not render hundreds of
  hairline bars in the inline explorer context.

---

## Stripe (Workbench Logs) — calm, list-first, time-scoped; chart is secondary

**URL:** https://docs.stripe.com/workbench/overview · request logs:
https://docs.stripe.com/development/dashboard/request-logs

- Stripe's **Workbench Logs** "presents a timeline of API activity, with filters for time, endpoint,
  response code." The developer Logs page filters "by Date, Status, Method and API endpoint."
- **Takeaway = restraint.** Stripe's primary affordance is the filtered **list**; the over-time view is
  a calm, secondary timeline, not a hero dashboard chart. This matches the SLVP "workbench, not a
  dev-console wall" bar: the chart must be a *quiet band that aids navigation*, never the loud center of
  the screen. Stripe also surfaces explicit retention bounds (GET logs 31 days, etc.) rather than
  implying infinite history — an honesty cue: be explicit about the window you actually cover.

---

## Sentry issue stream — the cautionary tale (the ANTI-PATTERN to avoid)

**URL:** https://docs.sentry.io/product/issues/ · bug threads:
https://github.com/getsentry/sentry/issues/48625 · https://forum.sentry.io/t/number-of-events-showing/11007

Sentry's per-issue frequency sparkline is the **named anti-pattern**: a small over-time chart whose
**bar counts do not reconcile with the count shown beside it**. Users repeatedly report the chart
timeframe and the event count disagreeing ("only saw details about 2 events from the last hour instead
of 4"; requests that "the amount of events be consistent with the time frame shown in the graphs"). A
related Discover bug: changing the bar-chart interval doesn't re-bucket. **Lesson:** a time chart whose
bars don't reconcile with the list/count is a *trust break*, not a feature — exactly the Gate-1 failure
mode ("a number that doesn't reconcile"). Our design's #1 invariant is therefore *bars reconcile with
the feed's count and name their kind*.

---

## GitHub Insights — the OTHER anti-pattern: silent counting rules

**URL:** https://docs.github.com/en/repositories/viewing-activity-and-data-for-your-repository/viewing-a-projects-contributors

GitHub's contributor/commit graphs are time-distribution charts with **hidden counting rules that
mislead**: merge commits and empty commits aren't counted; the contributors graph "sums weekly commit
numbers onto each Sunday, so your time period must include a Sunday"; insights are unavailable for repos
>10,000 commits. Each is a *silent rule that makes the bars not mean what a naive reader assumes*.
**Lesson:** every exclusion/cap/bucketing rule a chart applies must be legible, or the chart lies by
omission. Our design states its counting rule on the chart (kind label + tooltip), never hides it.

---

## The brushing-UX corpus — interaction affordances + the accessibility floor

**URLs:** https://observablehq.com/blog/linked-brushing · https://d3js.org/d3-brush ·
USWDS time-picker a11y: https://designsystem.digital.gov/components/time-picker/accessibility-tests/ ·
MIT rich-screen-reader vis: https://vis.csail.mit.edu/pubs/rich-screen-reader-vis-experiences/

- **When brushing is right:** "when you don't want to limit a user to a pre-defined category/region" —
  continuous time selection is the textbook good case for a brush. **When it's the anti-pattern:** for
  *pre-defined* categories, a single click/select beats a drag. → our design supports BOTH: drag a
  custom span (brush) AND click a single bar (that bucket's day) — the latter is just a fast preset.
- **Focus + context:** the recommended temporal pattern is "focus on a shorter period while still seeing
  how it fits the longer-term pattern." Our chart stays visible and shows the brushed span as a shaded
  overlay over the full strip, so the selection never hides the whole.
- **d3-brush affordances** (handles to resize, drag-body to translate, click-overlay to start a new
  selection) are the interaction grammar to mirror; we do NOT need d3 itself for a bar strip, but the
  grammar (resize handles + clear) is the expectation.
- **The accessibility floor (hard requirement, not residual):** a brush "should NEVER be the only way to
  select a time range." It must be paired with (a) a keyboard/touch form input for start/end — *which we
  already have: the Date chip + From/To popover from the date-controls cell* — (b) a text/tabular
  equivalent (the feed itself + per-bar `title`/`aria-label` with day + count), (c) descriptive alt text,
  (d) focusable, arrow-key-adjustable handles. This is why the chart is an *enhancement layered on the
  canonical Date object*, never a replacement for it.

---

## Our own codebase — the inline anti-pattern already present (and why it's not shippable as-is)

Verified by content on tip `36d51f49` (branch `workstream/explore-feel-integration`):

- A histogram skeleton **already exists but is NOT on the live surface**: `ActivityStrip`
  (`packages/operator-ui/src/components/views/records-explorer-view.tsx:718`, rendered at `:328`) sits in
  the **legacy** `records-explorer-view.tsx` — NOT in the live `ExploreCanvas`
  (`apps/console/src/app/dashboard/explore/explore-canvas.tsx:43,125`; the live-path fact is asserted in
  `row-routing.test.ts:6`). So the deployed Explore has no chart (matches THE-LENS Part B "UNBUILT").
- That legacy strip is **our in-house anti-pattern**: it is fed by `computeActivityStripCells(feed)`
  (`explorer-utils.ts:457`) = **loaded entries only**, and its header literally reads
  **"from the most recent {N} records"** (`records-explorer-view.tsx` ~`:331`). It implies a distribution
  from a *capped loaded window* — a Sentry-class reconciliation lie — and it has **no brush** (no
  filtering). Do NOT promote it as-is.
- **The honest data source already exists server-side** (this is what makes the SLVP-ideal cheap):
  `reference-implementation/server/records.js` ships a grant-scoped, filter-aware **time-bucket
  aggregate**: `SUPPORTED_AGGREGATE_GRANULARITIES = {minute,hour,day,week,month,quarter,year}`,
  params `group_by_time` + `granularity` + `time_zone` + `metric=count`, with calendar `date_trunc`
  semantics in an explicit **IANA zone** via `Intl.DateTimeFormat` (weeks start Monday, DST-correct), and
  a `window=exact` opt-in that returns the **TRUE total over the filtered grant-scoped corpus** — not the
  loaded page. Route: `/v1/streams/{stream}/aggregate` (`index.js:896`, `queryShape:'stream_aggregate'`).
  OpenSpec change `archive/2026-05-29-add-aggregate-time-buckets-and-distinct` (shipped/archived).
- The feed's day grouping uses `dayKeyFromDisplayAt = displayAt.slice(0,10)`
  (`explorer-utils.ts:395-403`) — the ISO **date-prefix of the displayAt timestamp**, i.e. grouped by the
  record's own emitted/source tz, NOT owner-local. The chart's bucketing **must be reconciled** with the
  feed's bucketing (design §4), or the strip and the day-headers won't agree.

---

## Synthesis: the pattern this cell adopts

1. **Canonical = Grafana's "volume band above the list."** A quiet, full-width horizontal bar strip
   directly above the feed; bars are records-per-bucket of the SAME filtered set the feed shows.
2. **Brush writes the EXISTING `(since, until)`** (Grafana/Datadog both write the existing time control;
   no parallel range object) — composes with the date-controls cell's canonical Date object exactly.
3. **Bars come from the SERVER aggregate with `window=exact`** (true filtered totals + correct tz
   bucketing), NOT `computeActivityStripCells(feed)` (loaded-only). This is the fix for the Sentry +
   our-own anti-pattern.
4. **Counting rule is legible** (kind label + per-bar tooltip), defeating the GitHub-Insights
   silent-rule failure.
5. **Brush is an enhancement over the keyboard/touch Date control, never the only path** (the a11y
   floor) — and click-a-single-bar is supported because brushing is the wrong tool for a single
   pre-defined bucket (the Observable when-not-to-brush rule).
