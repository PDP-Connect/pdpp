# Over-time chart — PERFORMANCE, RESTING DOMAIN & GRANULARITY prior art

**Cell:** the over-time activity histogram that sits above the Explore feed and brushes to filter.
**Scope of THIS doc:** the *performance and domain/granularity* sub-problem at scale (streams 0 →
1,000,000+ records). The *brush/filter UX + a11y + honesty* sub-problem already has a deep prior-art
doc at `./over-time-chart/prior-art.md` and a design at `./over-time-chart/design.md` — this doc is the
missing **"how do you compute the bars fast and pick a sane span/bucket"** half. Read both together.

**Today's defect (PDPP):** the chart does a **full table scan per stream into JS and buckets in JS**
(slow at 1M rows), and the **default/unfiltered view buckets a ~20-year corpus at DAY granularity**
(~7,300 buckets, almost all empty → a sparse desert that is both slow and ugly).

**Method:** product docs + engineering blogs, real URLs, fetched/indexed via context-mode. Every claim
below is cited.

---

## 1. PERFORMANCE AT SCALE — "count records per time bucket, fast"

The convergent answer across every mature tool: **never bucket raw rows in the client. Push the
`GROUP BY time_bucket` into the datastore, served by a time-range index (or a pre-aggregated rollup),
and return only the ~N tiny bucket rows.** The transport is N integers, not N records.

### 1a. Index-backed `date_trunc`/`time_bucket` GROUP BY (the baseline, and what PDPP should do first)

Postgres counting per bucket is a one-line aggregate:
```sql
SELECT date_trunc('week', emitted_at) AS bucket, count(*)
FROM records
WHERE stream_id = $1 AND emitted_at BETWEEN $2 AND $3
GROUP BY 1 ORDER BY 1;
```
The cost at scale is the scan, not the grouping. Two indexing strategies make it fast on a
time-ordered table:

- **BRIN on the timestamp column** is the canonical fit for append-only, naturally time-ordered event
  data. A BRIN index summarizes *block ranges* (min/max per page range) rather than individual rows, so
  it's ~1/100th the size of a B-tree and drives a Bitmap Index Scan that **skips most blocks outside the
  date filter**. Crunchy's benchmark: BRIN matched B-tree on a `date_trunc` hourly aggregation while
  using >99% less space; the benefit grows with table size (tested to 100M rows). Caveat: BRIN depends
  on *physical* ordering and degrades on out-of-order inserts / heavy updates, and is wrong for point
  lookups. ([Crunchy: BRIN big-data performance](https://www.crunchydata.com/blog/postgresql-brin-indexes-big-data-performance-with-minimal-storage))
- A plain **B-tree on `(stream_id, emitted_at)`** also serves the windowed `GROUP BY` well and is the
  safe default when insert order isn't guaranteed. Postgres can also **parallelize** the aggregation; in
  the Crunchy benchmark a parallel seq-scan sometimes *beat* the indexed scan when the range covered most
  of the table. ([Crunchy: easy Postgres time bins](https://www.crunchydata.com/blog/easy-postgresql-time-bins),
  [oneuptime: optimize GROUP BY in Postgres](https://oneuptime.com/blog/post/2026-01-25-postgresql-group-by-performance/view))

This index-backed `GROUP BY` is the **baseline that gets PDPP to "fast enough" with zero new
infrastructure** — it replaces the JS scan directly.

### 1b. Pre-aggregated rollups / continuous aggregates (the scale ceiling)

When even a windowed scan is too slow (huge ranges over hundreds of millions of rows), every tool moves
to **materialized rollups** queried instead of raw rows:

- **TimescaleDB continuous aggregates** = an incrementally-maintained materialized view over
  `time_bucket('1 hour', ts), count(*)`. Only changed buckets recompute on refresh. The canonical war
  story: a 7-day `time_bucket` dashboard over a **400M-row** hypertable drops from **14 s → a few
  thousand pre-aggregated points**. The biggest lever is **bucket width matching dashboard resolution**
  (a 1-min CAGG materializes nearly as many rows as the source — pointless); secondary levers are a
  bounded refresh policy, `materialized_only = true` for max read speed, and **hierarchical rollups**
  (`SUM(sample_count)` from the hourly CAGG into daily — counts are cleanly composable, unlike
  percentiles). On a 100M-row table TimescaleDB's time-ordered merge-append made a bucketed query ~396×
  faster than vanilla Postgres (82 ms).
  ([Timescale optimize CAGGs for large datasets](https://dev.to/philip_mcclarence_2ef9475/optimizing-continuous-aggregate-performance-for-large-datasets-39mj),
  [Stack Harbor: CAGG rollup strategy](https://stackharbor.com/en/knowledge-base/timescaledb-continuous-aggregates-strategy/),
  [Tiger/Timescale: create a continuous aggregate](https://www.tigerdata.com/docs/use-timescale/latest/continuous-aggregates/create-a-continuous-aggregate),
  [Alibaba: TimescaleDB practices (396×)](https://alibaba-cloud.medium.com/postgresql-time-series-database-plug-in-timescaledb-deployment-practices-6a07e246eb0d))
- **Elasticsearch / Kibana rollup indices** pre-aggregate old data into hourly/daily summary docs;
  queries transparently fall back to raw data for recent windows. ([Opster: ES date histogram optimization](https://opster.com/guides/elasticsearch/search-apis/elasticsearch-date-histogram/))
- **Stripe** doesn't expose raw events for distant history at full fidelity at all — it keeps a
  **trailing retention window** (13 months live; full detail only the last 30 days, older = summary
  view). The product simply *doesn't offer* an unbounded-extent chart over raw events.
  ([Stripe event retention](https://support.stripe.com/questions/stripe-event-retention-period))

**ES date histograms are intrinsically cheap** because dates are stored as `long` epoch-ms and bucket
assignment is integer arithmetic; the dominant cost is *number of buckets returned*, which is exactly
why "avoid bucket explosion" is the headline ES optimization. ([ES date histogram aggregation](https://www.elastic.co/docs/reference/aggregations/search-aggregations-bucket-datehistogram-aggregation))

**Verdict for PDPP perf:** Phase 1 = an index-backed server `GROUP BY date_trunc` aggregate endpoint
(BRIN or `(stream_id, emitted_at)` B-tree). Phase 2 *only if a real stream proves it slow* = a
per-stream day-bucket rollup table refreshed incrementally; coarser views `SUM()` up from it. Do **not**
build the rollup speculatively — the windowed scan is the cheap honest baseline.

---

## 2. RESTING DOMAIN — what span the chart shows when there is NO time filter

Two distinct, defensible conventions exist; PDPP's data shape picks the answer.

- **Trailing-window default (observability tools).** Datadog, Grafana Explore, Honeycomb all open on a
  *recent* window (Datadog's docs use "last 15 minutes" throughout; Stripe financial reports default to
  the **prior month**; Stripe home charts auto-fit the unit to the data). This avoids the empty-desert
  problem by simply never showing 20 years by default. ([Datadog Log Explorer](https://docs.datadoghq.com/logs/explorer/),
  [Stripe report configuration](https://docs.stripe.com/reports/options),
  [Stripe home charts date range](https://support.stripe.com/questions/customizing-the-date-range-for-dashboard-home-charts))
- **Auto-fit-to-populated-extent (Grafana full-range log volume — the closest analog).** When Explore
  *does* show a full-range histogram, it **anchors the start to the timestamp of the first matching row
  and the end to "now" (the To range)** — i.e. it fits the domain to where data actually exists rather
  than a fixed calendar window. ([Grafana: logs in Explore](https://grafana.com/docs/grafana/latest/visualizations/explore/logs-integration/),
  [Grafana 8.4 full-range log volume](https://grafana.com/blog/2022/03/02/new-in-grafana-8.4-how-to-use-full-range-log-volume-histograms-with-grafana-loki/))

**SLVP-ideal for PDPP** (a personal-data archive, not a live-tail console — the user *wants* to see the
whole life of a stream, but not a half-empty desert): **auto-fit the resting domain to the stream's
populated extent** (`min(emitted_at) … now`, Grafana-style), then **let granularity (§3) coarsen so the
extent renders as a calm 30-ish bars, not 7,300 day-cells.** This is exactly what the LAND'd
`over-time-chart/design.md` already specifies (§4.5: "no date filter → full data extent, anchored like
Grafana to first-record … now"). A 20-year corpus auto-fit to **month** buckets is ~240 dense bars, not
a sparse day desert — the granularity ladder, not a trailing-window clamp, is what kills the desert.

---

## 3. ADAPTIVE GRANULARITY — bucket size vs span, and the target bar count

Every tool picks bucket width from `span / target_bar_count`, then **snaps to a calendar-friendly unit**.

- **Grafana `$__interval`** is computed per-render from *time range ÷ panel pixel width* (so a ~1000px
  panel never tries to draw 250k points); the SQL helper `$__timeGroup(col, $__interval)` does the
  server-side bucketing. Bucket size grows with the range so bucket *count* stays in a readable band.
  ([CodeSignal: time bucketing in Grafana](https://codesignal.com/learn/courses/getting-started-with-grafana-using-postgres-demo-metrics/lessons/time-bucketing-in-grafana),
  [Grafana intro to histograms](https://grafana.com/docs/grafana/latest/fundamentals/intro-histograms/))
- **Elasticsearch `auto_date_histogram`** inverts the API: you give a **target `buckets` count
  (default 10)** and ES returns ≤ that many, snapping the interval to a fixed ladder:
  **seconds ×{1,5,10,30} · minutes ×{1,5,10,30} · hours ×{1,3,12} · days ×{1,7} · months ×{1,3} ·
  years ×{1,5,10,20,50,100}**. A `minimum_interval` floor (year/month/day/hour/minute/second) both bounds
  granularity and makes collection cheaper. Worst-case edge: when daily buckets overflow the target, you
  get ~**1/7th** of the requested count (it jumps day→7-day→month).
  ([ES auto_date_histogram](https://www.elastic.co/docs/reference/aggregations/search-aggregations-bucket-autodatehistogram-aggregation))
- **d3 `scale.ticks(count)` / d3-time `tickInterval`** is the client-side analog of the same idea: from
  a sorted ladder of `[interval, step, durationMs]` candidates it computes `target = span / count` and
  picks the candidate whose duration is **geometrically closest** to the target
  (`target/dur(i-1) < dur(i)/target ? i-1 : i`), so ticks land on human boundaries (midnights, month
  starts) — count is a *hint*, default 10. ([d3 time scales](https://d3js.org/d3-scale/time),
  [d3-time/src/ticks.js](https://github.com/d3/d3-time/blob/main/src/ticks.js))

**Target bar count.** The "10" defaults above are for *axis ticks*, not bars. For a **volume histogram**
the readable band is higher: Grafana sizes to panel pixels (~hundreds), and PDPP's own LAND'd design
already pins a **calm ~24–60 bar band** (`over-time-chart/design.md` §4.5) with this snapped ladder:
span ≤ 2 days → hour · ≤ ~10 weeks → day · ≤ ~2 years → week · larger → month. **Recommendation:
target ~30–60 bars, snap to the calendar ladder, floor at the brand min bar width — keep the existing
ladder, it matches ES/d3/Grafana prior art.** Always **show the active granularity in the caption**
("· by week") so the bucket meaning is never a silent rule (the GitHub-Insights anti-pattern).

---

## 4. EMPTY BUCKETS — zero-fill vs collapse

The dominant convention is **zero-fill within the rendered window so the time axis stays linear and
honest** (a gap *means* "no activity then"), *not* collapse-to-dense (which would lie about cadence).

- **Elasticsearch** zero-fills only on request: `min_doc_count: 0` fills interior gaps, and
  `extended_bounds {min,max}` (only meaningful with `min_doc_count:0`) extends zero buckets to the chart
  *edges* even where no docs exist; `hard_bounds` strictly clips. Note `extended_bounds` does **not**
  filter — to *restrict* a window you nest under a range filter / use `hard_bounds`.
  ([ES filling empty buckets](https://seanmcgary.com/posts/elasticsearch-date-histogram-aggregation---filling-in-the-empty-buckets),
  [OpenSearch date histogram](https://docs.opensearch.org/latest/aggregations/bucket/date-histogram/))
- **GitHub's contribution graph** is the cautionary counter-pattern for *color* bucketing, not time
  bucketing: it shows every day (zero days are gray), but the green levels are **adaptive quartiles of
  non-zero days**, an undocumented silent rule that makes the same commit count look different across
  users. The lesson PDPP already absorbed: never encode meaning in a hidden statistical rule — keep the
  scale legible. ([GitBlend: GitHub contribution graphs](https://gitblend.com/kb/understanding-github-contribution-graphs),
  [Built In: replicate GitHub contributions](https://builtin.com/data-science/github-contribution-plot))

**Verdict for PDPP:** the resting domain is auto-fit to *populated* extent (§2), so the desert is solved
by **coarsening granularity, not by collapsing empties**. Within the chosen window, **zero-fill** every
bucket (linear time axis, gaps = real silence) — server-side `generate_series(since, until, interval)`
LEFT JOIN the counts so the API returns a dense, gap-filled series the client renders verbatim.

---

## 5. ASYNC / LOAD BEHAVIOR — is the chart on the critical first paint?

Mature tools treat the volume chart as a **separate, deferred query off the list's critical path** —
the list is the product; the chart enriches it.

- **Grafana Explore** runs the log-volume histogram as its **own metric query**, tagged with the HTTP
  header `X-Query-Tags: Source=logvolhist`, distinct from the logs query. It is **resource-intensive**
  on wide ranges (one user saw a histogram fire **721 subqueries**; Grafana recommends a proxy with a
  ~10s timeout) and can be **toggled off entirely** via the `FullRangeLogsVolume` feature flag when it
  loads the backend too hard. Crucially, **zooming/brushing does NOT auto-re-query** — there's an
  explicit "Reload log volume" button to re-run at higher resolution, so interaction never silently
  refetches.
  ([Grafana 8.4 full-range log volume](https://grafana.com/blog/2022/03/02/new-in-grafana-8.4-how-to-use-full-range-log-volume-histograms-with-grafana-loki/),
  [Grafana logs in Explore](https://grafana.com/docs/grafana/latest/visualizations/explore/logs-integration/))
- The **client-side fallback** (when the source can't serve a full-range volume) is exactly PDPP's
  current anti-pattern: count returned rows into auto-interval buckets anchored at the first row — which
  only describes the *loaded window*, not the true distribution (a Sentry-class reconciliation lie).
  ([Grafana logs in Explore](https://grafana.com/docs/grafana/latest/visualizations/explore/logs-integration/))

**Verdict for PDPP:** the histogram is **off the first-paint critical path**. Stream the list first;
fetch the aggregate as a **separate, deferred request** that fills the chart shortly after (skeleton →
bars). A brush that changes granularity *does* re-query the aggregate (PDPP's design takes a stricter,
honest stance than Grafana's manual Reload — it re-derives rather than leave stale bars), but the *list*
is never blocked on the chart.

---

## SLVP-IDEAL SYNTHESIS for PDPP (prior-art-grounded)

1. **Architecture — one index-backed server aggregate endpoint, not per-stream JS scans.** Replace the
   JS full-table scan with a server `GROUP BY date_trunc(<unit>, emitted_at)` over a time-range index
   (BRIN on `emitted_at` for append-only streams, else `(stream_id, emitted_at)` B-tree). One generic
   endpoint takes `(stream/grant filter, since, until, granularity)` and returns ~30–60 `{bucket, count}`
   rows. Mirrors Grafana's separate `logvolhist` query and ES `date_histogram`. (§1, §5)
2. **Scale ceiling, built only when proven needed.** If a real stream is slow even windowed, add a
   per-stream **day-bucket rollup/continuous-aggregate**; coarser views `SUM()` up from it (counts are
   composable). Don't build it speculatively. (§1b)
3. **Resting domain = auto-fit to populated extent** (`min(emitted_at) … now`, Grafana-style), NOT a
   fixed 20-year calendar window and NOT a trailing-30d clamp. The desert is killed by granularity, not
   by hiding history. (§2)
4. **Granularity = `span / target` snapped to a calendar ladder**, target **~30–60 bars** (keep the
   LAND'd ladder: ≤2d→hour, ≤~10wk→day, ≤~2yr→week, larger→month), floored at brand min bar width. A
   20-yr corpus → month buckets (~240 dense bars), never 7,300 day-cells. **Always caption the active
   unit** ("· by week"). Matches ES `auto_date_histogram` / d3-time / Grafana `$__interval`. (§3)
5. **Empty buckets = zero-fill, never collapse.** Server emits a dense, gap-filled series
   (`generate_series` LEFT JOIN counts) over the chosen window; gaps render as real zero-activity. Keep
   the scale legible — no hidden GitHub-style quartile rules. (§4)
6. **Load = deferred, off the critical path.** List streams first; chart fetches as a separate request
   (skeleton → bars). Brush re-derives granularity and re-queries the aggregate; the list never blocks on
   the chart. (§5)

This complements `./over-time-chart/design.md` (brush/filter/honesty/a11y) — together they specify the
full cell. The single highest-leverage change vs. today: **move bucketing from JS into one index-backed
SQL aggregate, and auto-fit the resting domain + coarsen granularity so the all-time view is ~30–60
dense bars instead of a sparse 20-year day desert.**
