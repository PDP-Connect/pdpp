# Explore over-time chart — SLVP-ideal design (brush-to-filter histogram)

**Status:** DRAFT for adversarial Codex review (gpt-5.5, high effort). Chart cell = highest effort tier.
**Decision:** design now / build later. Prior art: `./prior-art.md` (canonical = Grafana Explore
log-volume histogram; corroboration = Datadog Log Explorer, Stripe Workbench; anti-patterns = Sentry
sparkline reconciliation lie + GitHub Insights silent counting rules + **our own legacy `ActivityStrip`**;
a11y floor from the d3-brush/USWDS/MIT corpus). Code re-audited **by content** on deploy tip `36d51f49`
(`workstream/explore-feel-integration`); every file:line below was verified this session.

This cell composes with the **date-controls cell** (`../date-controls/design.md`, LAND'd). It does NOT
introduce a date model — it is a *visual + brush front-end over the canonical `(since, until)` object
that cell already owns.* That is the core of why it's break-resistant.

---

## 0. What this closes (THE-LENS Gate 2, the last UNBUILT workbench capability)

> "An interactive over-time visualization that doubles as a filter — restore it (it existed, was dropped
> for performance; 6/18: *'I don't think the solution was to get rid of it'*). SLVP/observability
> products (Datadog) are the references."

Live state (verified): **no chart on the live `ExploreCanvas`.** A legacy `ActivityStrip` exists only in
the dead `records-explorer-view.tsx` (`:328`, `:718`), is fed by loaded entries
(`computeActivityStripCells`, `explorer-utils.ts:457`), labels itself **"from the most recent N records,"**
and **has no brush**. It is the anti-pattern, not the starting point. We build a NEW honest, brushable
strip in the live canvas and delete/retire the legacy one.

---

## 1. Chosen pattern (prior-art-cited)

**"A quiet volume band above the feed, brushable into the canonical Date object."** (Grafana Explore
log-volume histogram — `prior-art.md` §canonical.)

- **Placement (2-pane layout):** a full-width, short horizontal **bar strip** spanning the MAIN column,
  pinned directly **below the command bar / chip row and above the day-grouped feed**, inside the same
  scroll container header region (sticky with the toolbar, not floating). Sidebar (224px) and peek
  (360px) columns are untouched. Height ≈ 44–56px for bars + ~16px axis = one calm band, never a hero
  panel (Stripe restraint). It is the same width as the feed so a bar lines up over the column it counts.
- **Bars = records-per-time-bucket of the EXACT set the feed currently shows** (same filters, same
  search, same connection/stream selection). One query population, two renders (Grafana/Datadog).
- **Interaction:** (a) **brush** — drag across bars to select a contiguous span → writes `(since, until)`;
  (b) **click a single bar** → selects that one bucket's span (brushing is the wrong tool for one
  pre-defined bucket — Observable when-not-to-brush rule); (c) **hover** → tooltip with bucket label +
  honest count; (d) **resize handles** on an active brush to adjust either edge; (e) **clear** via the
  Date chip's `×` (single clear affordance — see §3) or by clicking outside the brush.
- **Bucket granularity is auto-derived from the active window span and snapped** to friendly units
  (Grafana): see §4 for the exact ladder. Never arbitrary widths; never hundreds of hairline bars.
- **Brushed selection renders as a shaded overlay over the FULL strip** (focus + context): the whole
  distribution stays visible; the selection is a translucent band, so the chart never hides the whole
  while you narrow (the d3 focus+context rule).

**Explicitly rejected alternatives** (so build doesn't re-litigate):
- A heatmap/calendar grid (GitHub-style): wrong for a continuous-time brush; reads as a separate widget,
  not a filter over the feed. Rejected.
- A line/area chart: harder to brush precisely to a bucket edge; bars map 1:1 to the day-grouped feed
  below. Rejected.
- Promoting the legacy loaded-entry `ActivityStrip`: it lies (loaded-only) and can't brush. Rejected;
  retire it.
- d3-brush / a charting lib: a CSS/SVG bar strip + pointer math is enough; avoid a heavy dep (residual
  §9 confirms at build). The d3 *grammar* (resize handles, clear, translate) is mirrored, not the lib.

---

## 2. Data source — the honesty engine (the load-bearing decision)

**Bars MUST come from the server time-bucket aggregate, NOT from loaded feed entries.**

- **Endpoint (exists, verified):** `GET /v1/streams/{stream}/aggregate`
  (`reference-implementation/server/index.js:896`, `queryShape:'stream_aggregate'`) with
  `metric=count`, `group_by_time=<the timestamp field>`, `granularity=<day|week|hour|…>`,
  `time_zone=<owner IANA zone>`, the **same `filter`/`connection_id`/search scope the feed uses**, and
  **`window=exact`** (`records.js` `SUPPORTED_WINDOW_KINDS={none,exact}`; `SUPPORTED_AGGREGATE_*` sets
  verified at `records.js` ~`:549-577`). `window=exact` returns the **TRUE count per bucket over the
  filtered, grant-scoped corpus** — not the loaded page. This is what makes bar height == reachable
  reality.
- Cross-source: Explore fans across connections/streams. The chart sums the per-stream/per-connection
  aggregates for the active selection into one merged bucket series (same fan-in the feed already does;
  the assembler is the home for this — `explore-data-assembler.ts`). A bucket's count is the union total.
- **`computeActivityStripCells(feed)` is NOT the source** (it counts loaded-only). It may remain ONLY as
  an instant **skeleton/placeholder** while the exact aggregate is in flight (clearly marked
  provisional — see §6 loading), then is replaced by the exact series. It must never be the resting
  state, and the resting bars must never be labeled "most recent N records."

**Why this is cheap (verified):** the granularity/tz/`date_trunc`/Monday-week machinery and the
`window=exact` total already ship (OpenSpec `archive/2026-05-29-add-aggregate-time-buckets-and-distinct`).
The build is a front-end strip + a fan-in call, not a new server capability.

---

## 3. CANONICAL-STATE CHECK (the highest-value step — the brush must not create a parallel range)

The chart's brush selects a date range. **That range is the SAME `(since, until)` canonical Date object
the date-controls cell defines** (`../date-controls/design.md` §"THE CANONICAL DATE-FILTER OBJECT").
There is exactly ONE date filter in Explore, and the chart is just a third entry path into it — alongside
the Date chip/popover and the typed `before:`/`after:` operators.

**The single source of truth (unchanged from date-controls):** the URL `since`/`until` params
(`explore-canvas.tsx` reads/writes them throughout — verified `:249-252, :1921, :1945-1947, :1989-1990`;
`setRange` writes them; `activeRangeKey` at
`apps/console/src/app/dashboard/explore/explore-control-state.ts:15` —
`activeRangeKey(state: {since, until}, nowMs)` — already returns `"custom"` when `until` is set). The Date **chip label is a pure function of `(since, until)`**; so is the chart's
brush overlay.

**Normalization (so chart-brush + Date chip + operators + URL are never competing reps):**
1. **Brush/click → `setRange({since, until})`.** A brush release (or single-bar click) computes a
   `(since, until)` pair (in owner-local tz, §4 inclusivity) and writes it through the **same `setRange`
   path the Date popover's Custom Apply uses** — NOT a new param, NOT a new state field. The date-controls
   cell already requires `setRange` to accept a `{since, until}` custom range (its build note item 2);
   the chart reuses that exact entry. (Today `setRange` only takes `"all"` at `explore-canvas.tsx:377` /
   `"today"|"7d"|"30d"|"all"` at `:1037`; both cells depend on the same widened `setRange` — flagged as a
   shared build dependency, §8.)
2. **`(since, until)` → brush overlay.** The chart reads `since`/`until` and renders the shaded selection
   by mapping those instants onto the bar axis. So if the owner sets the range via the Date popover,
   types `after:2026-05-01`, or brushes — **the chart shows the identical shaded span.** One state, one
   overlay. (Kills the Part-0 "same thing two ways" regret: the brush overlay and the Date chip are two
   *views* of one object, never two competing values — analogous to how the day-headers and the chip both
   derive from the same data.)
3. **Typed operators already lift in.** `before:`/`after:` are lifted into `since`/`until` by the
   date-controls cell's `liftFacetTokens`-style normalization (`explore-grammar.ts:16-17,56-59` document
   `after:→since`, `before:→until`). The chart inherits that for free: a typed date operator becomes the
   chip AND the brush overlay, never a separate token chip beside the chart.
4. **Clear is single.** The chart exposes NO separate clear control. Clearing the date filter is the Date
   chip's `×` (date-controls owns the one clear affordance); clicking outside the brush also calls the
   same clear. Result: no "clear the chart" vs "clear the chip" divergence.
5. **Last-write-wins.** Brushing while a `7d` preset is active REPLACES `(since, until)` and re-derives
   BOTH the chip label and the overlay (same conflict rule date-controls already specifies). The chart
   never stacks a second range.

**Net:** the chart adds zero new canonical state. It is a read/write skin on `(since, until)`. This is
the property that makes it impossible for the chart to "say a different thing" than the Date chip.

---

## 4. HONESTY SEMANTICS IN FULL (Gate 1 — boundary lies are the failure mode)

### 4.1 What a bar counts, and naming its KIND (count == reachability)
- A bar's height = **the true number of records whose display-time falls in that bucket, within the
  active filter set, over the whole grant-scoped corpus** (`window=exact`). It is NOT "loaded so far."
  Because it's the true total and the feed paginates exhaustively to the same set, **every record a bar
  counts is reachable** by scrolling/loading the feed (count == reachability, SACRED).
- **Kind label is mandatory and legible** (defeats Sentry + GitHub anti-patterns). The strip carries one
  quiet caption naming the kind of the active set, e.g.:
  - `complete_chronological` (browse): **"Records over time"** (no qualifier needed — it's the true
    distribution of everything in scope).
  - `relevance_bounded` (search top-N): the chart is **suppressed or explicitly labeled "Top matches
    over time"** — because a relevance-bounded set has no honest exhaustive distribution (its descriptor
    lacks completeness). **Default: do not render the brushable chart over a `relevance_bounded` set**;
    if shown at all, it is a non-interactive, explicitly-labeled "top matches" strip with NO brush (you
    cannot brush-filter a set whose membership isn't time-complete). Decision: **chart is only brushable
    over `complete_chronological`, `keyword_pageable`, and `filtered_exact` descriptors** — the kinds
    whose membership is exhaustive and time-honest. (Reuses the existing set-descriptor contract;
    `descriptor.kind` already gates header/sort/Load-more.)
- The caption NEVER reads "from the most recent N records" (the legacy strip's lie). If, for a perf
  reason, the exact aggregate is unavailable for some stream in the union, the bar series is marked
  **partial** with a legible "+ more not yet counted" note — never silently undercount as if complete.

### 4.2 Empty buckets are honest
- A bucket with zero records renders as an explicit **empty slot** (a faint baseline tick), not a gap and
  not omitted — so the time axis stays continuous and the absence of data is visible, not hidden. (The
  legacy strip already does zero-fill, `explorer-utils.ts` `computeActivityStripCells` "Cells with no
  matching entries render as zero, not as gaps"; we keep that property, but over true totals.)
- An empty bar is **not brushable to a non-empty claim**: brushing a span that is all-empty yields a
  `(since, until)` that filters the feed to zero, and the feed shows the honest zero-results routing
  (Gate 1) — the bar never implies data you can't open.

### 4.3 Timezone + bucketing must MATCH the feed's day-grouping (the subtle correctness trap)
- **The chart buckets in the owner's LOCAL IANA timezone** via the aggregate's `time_zone` param (server
  uses `Intl.DateTimeFormat`, DST-correct, weeks start Monday — `records.js` group_by_time section). The
  Date chip's boundaries are also owner-local (date-controls §honesty). So brush edges, chip label, and
  bar boundaries all agree.
- **The trap (must be resolved at build):** the FEED today groups by
  `dayKeyFromDisplayAt = displayAt.slice(0,10)` (`explorer-utils.ts:395-403`) — the ISO date-prefix of
  the record's `displayAt`, i.e. the record's **source/emit tz**, NOT owner-local. If the chart buckets
  owner-local while the feed groups source-tz, a record near midnight can land in **bar day X but feed
  day-header X±1** — the strip and the day-headers visibly disagree. **Invariant:** the chart and the
  feed day-grouping MUST use the SAME bucketing function and the SAME tz. Resolution (pick at build, both
  are correct as long as they MATCH): **(A, preferred)** move the feed day-grouping to owner-local tz too,
  so chart + feed + Date chip are uniformly owner-local (one tz everywhere — the SLVP-honest answer); OR
  **(B)** drive the chart from the SAME `displayAt.slice(0,10)` ISO-prefix the feed uses by passing the
  matching `time_zone` to the aggregate so the server's day key equals the feed's. The design REQUIRES
  they match; it does not let them drift. (A) is recommended because owner-local is the mental model the
  Date chip already commits to.
- This adds an invariant to THE-LENS Gate 1 (see §10).

### 4.4 Inclusivity of a brushed range (no off-by-one boundary lie)
- A brush/click maps bar edges to `(since, until)` using the date-controls inclusivity contract: `since`
  = 00:00:00.000 local of the first selected bucket's start day; `until` = 23:59:59.999 local of the last
  selected bucket's end day (inclusive of the whole end bucket). Selecting "the May 3 bar" yields a window
  that includes every record shown in that bar — the brush can't select a bar yet exclude its records.
- **Round-trip exactness:** brushing bars `[B_i … B_j]` → `(since, until)` → re-deriving the overlay from
  those params → highlights exactly `[B_i … B_j]`. No drift, no half-bar selection ambiguity (a partially
  covered edge bucket is treated as selected — its records are within `(since, until)`).

### 4.5 The granularity ladder (auto-derived, snapped, legible)
Derived from the active window span (or, with no date filter, from the full data extent — anchored like
Grafana to first-record … now). Snapped to friendly units; bar count kept in a calm band (~24–60 bars):
- span ≤ 2 days → **hour** buckets
- span ≤ ~10 weeks → **day** buckets (the default for the unfiltered all-time view if it fits)
- span ≤ ~2 years → **week** buckets
- larger → **month** buckets
The active granularity is shown in the strip caption ("· by day"/"· by week") so the bucket meaning is
never hidden (GitHub silent-rule defeat). Re-deriving granularity after a brush is allowed and re-queries
the aggregate at the new resolution (we re-derive rather than leave stale bars — a stricter stance than
Grafana's "Reload" button, and the honest one for a personal-data tool).

---

## 5. EXACT UI / STATES / INTERACTION

**Resting (no date filter):** the band shows the full-extent distribution (anchored first-record→now) at
the auto granularity; caption `Records over time · by {unit}` left, and a quiet right-aligned
`{totalInScope} records` (the true in-scope total, a value not a dash). No brush overlay.

**Hover a bar:** tooltip = `{bucket label, e.g. "Mon, May 3, 2026"} · {count} records`; the hovered bar
lightens. Tooltip uses sans for the label and **tabular-nums** for the count; mono is NOT used here (it's
prose, not a machine value column).

**Brush (drag):** pointer-down on a bar starts a selection; drag highlights the covered bars as a
translucent accent band with resize handles at both edges; pointer-up commits `(since, until)` via
`setRange`, the feed filters, the Date chip updates, the URL gains `since`/`until`. A live read-out
during drag shows the tentative span (`May 3 – May 9`).

**Click a single bar:** selects that bucket's span (same commit path). A second click on the same bar
while it's the sole selection clears (toggles off) — but the canonical clear remains the Date chip `×`.

**Active brush present:** the shaded band persists (derived from `since`/`until`); edge handles allow
arrow-key/drag adjustment; the rest of the strip stays visible (focus+context). The Date chip shows the
same window. **No "clear" button on the chart** — clear is the chip `×` or click-outside.

**Color/type (craft constants):** bars = `#171717` foreground fill with intensity by relative height
(matches legacy strip's intensity ramp but over true totals); selection band = the one accent `#0055cc`
at low opacity; empty = faint baseline. Two text colors only; one accent. No second hue.

**Loading:** see §6. **Mobile:** see §7.

---

## 6. Loading / async states (honest under latency)
- On first paint, an **instant skeleton** may use `computeActivityStripCells(feed)` (loaded-only) to show
  bar *shape* immediately, rendered at reduced opacity with `aria-busy` and a caption
  `Counting…` — explicitly provisional, NEVER labeled with a total. When the `window=exact` aggregate
  returns, bars snap to true counts and the caption resolves. (Reuses the existing in-page loading
  primitives: top progress bar, `aria-busy`, reduced-motion gating — per the loading-states work.)
- If the aggregate fails or a stream's exact total is unavailable, the strip shows the partial series with
  a legible `Some counts unavailable` note (never a fabricated total, never silent undercount).
- Brushing is disabled while provisional (you can't brush a window off counts you don't trust yet); the
  Date chip/popover remains fully usable (the a11y/keyboard floor never depends on the chart).

## 7. Mobile (≤390px)
- The band collapses to a **compact full-width strip** above the feed within the ≤3 fixed chrome rows
  budget; height ~36px. Touch targets: a **single tap on a bar = select that bucket** (touch brushing is
  imprecise — the Observable/USWDS guidance), and a **"+ range" affordance opens the Date popover sheet**
  for precise From/To (the keyboard/touch form path that the a11y floor requires). Drag-brush is a
  desktop enhancement; on touch the canonical path is tap-bucket or the Date sheet. Filter state stays
  visible+editable as the Date chip at 390px (date-controls already guarantees this).

## 8. Build dependencies + sequencing (so build is unambiguous)
- **Depends on date-controls cell** for the widened `setRange({since, until})` and the canonical Date chip
  clear. Build date-controls first (it's LAND'd); the chart consumes it. Both cells widen the SAME
  `setRange` — do it once, in date-controls.
- New code (build-later): a pure `deriveBucketSeries(aggregateResponses, granularity, tz, window)` (fan-in
  + zero-fill, in `explore-data-assembler.ts`); a pure `barsToRange(selectedBuckets, tz) → {since,until}`
  and `rangeToSelectedBars(since, until, buckets) → indices` (the round-trip pair); a presentational
  `<OverTimeChart>` in the live canvas region. The server aggregate, granularity tz math, and
  set-descriptor gating already exist — reuse, don't rebuild.
- Retire the legacy `ActivityStrip` + its loaded-only labeling so two strips can never both ship.

---

## 9. ACCEPTANCE CRITERIA + EXECUTABLE TEST MATRIX (the >95% proof)

**Pure-logic (the load-bearing proofs — no DOM needed):**
- [ ] **brush → since/until:** `barsToRange([B3..B9], tz)` yields `since` = 00:00:00.000 local of B3's day,
      `until` = 23:59:59.999 local of B9's day; single-bar click yields that one bucket's inclusive span.
- [ ] **round-trip:** `rangeToSelectedBars(barsToRange([Bi..Bj]).since, .until, buckets)` returns exactly
      `[Bi..Bj]` — no drift, partially-covered edge bucket counts as selected.
- [ ] **bucket-count honesty:** `deriveBucketSeries` over a fixture where loaded feed = 32 but
      `window=exact` aggregate totals = 1,183 produces bar heights summing to **1,183** (the true total),
      NOT 32. Assert the series is built from the aggregate, never from `computeActivityStripCells`.
- [ ] **kind gating:** a `relevance_bounded` descriptor → no brushable chart (suppressed or non-interactive
      "Top matches" label, brush handlers absent); `complete_chronological`/`keyword_pageable`/
      `filtered_exact` → brushable. Assert brush is disabled exactly for the bounded kind.
- [ ] **tz bucketing == feed:** a record at 23:30 local on day X is placed in the SAME bucket day the feed
      day-grouping assigns (assert `deriveBucketSeries` day key === the feed `dayKey` for the same record;
      the resolution-A/B choice from §4.3 makes these equal). A DST-transition day buckets without
      off-by-one.
- [ ] **empty buckets:** a zero-record bucket appears as an explicit empty slot (present in the series with
      count 0), and `barsToRange` over an all-empty span yields a window that filters the feed to zero
      (honest zero-results), never a non-empty claim.
- [ ] **reachability:** for each bar count C in a fixture, paginating the feed under that bar's
      `(since,until)` returns exactly C records (count == reachability holds bar-by-bar).
- [ ] **last-write-wins:** brushing while `7d` is active replaces `(since,until)`; both the chip label and
      the overlay re-derive to the brushed span; no stacked second range.
- [ ] **partial source:** if one stream's exact aggregate is missing, the series is flagged partial and the
      caption reads "Some counts unavailable" — never a fabricated total.

**UI / behavior:**
- [ ] Chart renders above the feed in the MAIN column; sidebar/peek untouched; sticky with the toolbar.
- [ ] Brush overlay is derived purely from URL `since`/`until` (set the params directly → overlay matches,
      no brush gesture needed) — proves single-source-of-truth with the Date chip.
- [ ] Caption never contains "from the most recent N records"; the legacy `ActivityStrip` no longer
      renders on the live surface (assert absence).
- [ ] Hover tooltip shows day/bucket label + count; count is tabular-nums; no mono in the label.
- [ ] **reduced-motion:** bar grow/selection transitions gated behind `prefers-reduced-motion:
      no-preference` with a static fallback (reuse the existing motion-token discipline).
- [ ] **mobile (390px):** band ≤36px within ≤3 chrome rows; tap-bucket selects; "+ range" opens the Date
      sheet; drag-brush not required on touch; Date chip filter state visible+editable.
- [ ] **keyboard/a11y:** chart is NOT the only range path (Date chip/popover fully operable without it);
      each bar exposes an `aria-label` = "{day} · {count} records"; brush handles are focusable with
      arrow-key adjust; the strip has descriptive alt/`aria-label` ("Records over time, by day").
- [ ] **reload roundtrip:** brush a custom span → URL carries `since`+`until` → reload → identical overlay
      + identical Date chip + identical feed filter.
- [ ] **clear:** Date chip `×` (or click-outside) clears `since`/`until`, removes the overlay, restores the
      full-extent distribution; no separate chart-clear control exists.

---

## 10. NEW honesty invariant folded back into THE-LENS Gate 1
> **An over-time chart's bars state TRUE per-bucket totals over the filtered, grant-scoped corpus
> (`window=exact`), bucketed in the owner's local tz using the SAME bucketing as the feed's day-grouping;
> the chart's brush writes the ONE canonical `(since, until)` object (never a parallel range); the
> bucketing unit and set-kind are legibly captioned; empty buckets are shown not hidden; and a bar never
> implies data the feed can't reach. A chart fed by loaded-only counts, or labeled "most recent N
> records," is a count-reachability lie and does not ship.**

(Add to THE-LENS Gate 1 "Counts, reachability, and caps" block at integration time.)

---

## 11. SELF-CRITIQUE vs THE-LENS Part 0 + gates

**Part 0 — the Regret Check (each answered "no, the owner won't catch this"):**
- *Claiming done-in-code-not-lived-in?* This is a DESIGN cell (build later) — it claims nothing is live;
  it explicitly names the legacy strip as NOT shippable. No false "done." ✓
- *"What problem / why best solution"?* Restores the Gate-2 capability the owner explicitly asked to bring back;
  pattern is the cited Grafana/Datadog reference, not invented. ✓
- *"Same thing two ways"?* The single deepest risk for a chart-with-a-date-filter — RESOLVED by §3: the
  brush overlay and the Date chip are two views of ONE `(since, until)`; the chart adds zero new state and
  has no own clear. ✓
- *"A number that doesn't reconcile"?* The named anti-pattern (Sentry). RESOLVED by §2/§4: bars are true
  `window=exact` totals reconciling with the feed bar-by-bar; "most recent N" lie is banned. ✓
- *"Reads as machine output / wasted space"?* Calm single band, Stripe-restraint, one accent, captioned in
  human prose. ✓
- *"Meaning guessed from names/shape"?* The chart counts records by time — no field-name guessing; the
  timestamp field is the declared `group_by_time` field, not a guessed "date-ish" column. ✓

**Gate 1 (honesty):** count==reachability (true totals, reachable), no cap (aggregate is whole-corpus),
counts reconcile (one source: the aggregate), kind named (caption + descriptor gating), tz/inclusivity
exact (§4.3/§4.4). Adds the §10 invariant. ✓
**Gate 2 (workbench):** delivers the last UNBUILT capability — an interactive over-time viz that filters,
prior-art-grounded, brush + click + keyboard/Date-sheet paths. ✓
**Gate 3 (modes):** chart is gated by `descriptor.kind` so it only claims a distribution where the set is
time-exhaustive; suppressed/labeled over relevance-bounded search. Consistent with the three honest modes. ✓
**Gate 4 (feel):** quiet band, two text colors, one accent, tabular-nums counts, varied spatial rhythm
(a strip above ledger rows — not "cards on cards"); matches the Datadog/Grafana volume-band feel. (Feel is
DESIGN-asserted here; live side-by-side vs the product-UI shots is a build/verify gate, not claimed now.) ✓

## 12. BOUNDED RESIDUAL (<5%, does NOT touch correctness)
- **Exact visual treatment of the brush handles** (pill vs bracket) + bar corner radius/gap — an A/B
  against the Grafana/Datadog shots at build. Does not affect `(since,until)`, counts, or tz.
- **Whether the resting all-time view defaults to day vs week buckets** for very large extents — a width-fit
  tuning of the §4.5 ladder thresholds; both are honest, just a density preference.
- **Skeleton-vs-blank first paint** — using the loaded-only strip as a provisional skeleton is optional; a
  blank reserved-height band is equally honest. Pick at build; neither implies a total.
- **The §4.3 tz resolution A (move feed to owner-local) vs B (drive chart from feed's source-tz key)** — a
  build decision; the design REQUIRES they match and tests assert equality, so either choice is correct.
  (Flagged, not left ambiguous: the invariant is "they match," recommendation is A.)

None of these touch the canonical-object guarantee, the `window=exact` honesty, the tz-match invariant, or
the reachability proof.

---

## 13. Send to Codex (gpt-5.5, high effort) — break it
Attack surface to probe: (1) a better high-level pattern than the Grafana volume-band? (2) any path where
the brush produces a range that diverges from the Date chip / operators / URL (canonical-state hole)?
(3) any way a bar count can fail to reconcile with the feed (honesty hole) — esp. the cross-source fan-in
sum and the relevance-bounded gating? (4) the tz-match invariant — is there a record placement where chart
bucket ≠ feed day-header even under resolution A? (5) any stale code claim (re-verify the aggregate
endpoint + `setRange` widening dependency on the real tip)? (6) Part-0 triggers (wasted space, two-ways,
machine-feel) on the band itself. HOLD → revise → re-review → LAND.

## DEFINITION OF DONE — pixel gate (mandatory, with a flagged gap)
This is the ONE cell with NO corpus reference shot (no histogram-over-feed was captured). DONE requires:
1. Capture a REAL Grafana/Datadog volume-band-over-list screenshot at execution time and add it to the
   corpus (close the missing reference) — OR explicitly accept doc-level validation, logged.
2. Build → capture the live band (desktop + mobile) → side-by-side vs that reference → the owner confirms the
   bars/brush/density/feel match. Until a reference exists, this cell carries HIGHER pixel risk than the
   others — do not over-trust the doc-only validation.
