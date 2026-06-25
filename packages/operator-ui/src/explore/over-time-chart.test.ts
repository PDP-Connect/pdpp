import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AggregateSource,
  type Bucket,
  barsToRange,
  bucketKeyForDisplayAt,
  bucketLabel,
  chartCaption,
  chartIsBrushable,
  chartIsVisible,
  deriveBucketSeries,
  deriveGranularity,
  rangeToSelectedBars,
} from "./over-time-chart.ts";

const MS_PER_DAY = 86_400_000;

function daySource(groups: Array<{ key: string | null; count: number }>, ok = true): AggregateSource {
  return { granularity: "day", groups, ok };
}

// ── granularity ladder ──────────────────────────────────────────────────────

test("deriveGranularity snaps the span to friendly units", () => {
  assert.equal(deriveGranularity(1 * MS_PER_DAY), "hour"); // ≤ 2 days
  assert.equal(deriveGranularity(2 * MS_PER_DAY), "hour");
  assert.equal(deriveGranularity(10 * MS_PER_DAY), "day"); // ≤ ~10 weeks
  assert.equal(deriveGranularity(70 * MS_PER_DAY), "day");
  assert.equal(deriveGranularity(365 * MS_PER_DAY), "week"); // ≤ ~2 years
  assert.equal(deriveGranularity(730 * MS_PER_DAY), "week");
  assert.equal(deriveGranularity(2000 * MS_PER_DAY), "month"); // larger
  assert.equal(deriveGranularity(0), "day"); // unknown extent → day
  assert.equal(deriveGranularity(-1), "day");
});

// ── tz bucketing == feed (design §4.3 invariant) ────────────────────────────

test("bucketKeyForDisplayAt day key === the feed's displayAt.slice(0,10)", () => {
  // The live feed groups by `displayAt.slice(0, 10)`. For ANY UTC ISO timestamp,
  // the chart's day key must equal that exact prefix — including a 23:30 UTC time.
  const samples = [
    "2026-05-03T00:00:00.000Z",
    "2026-05-03T23:30:00.000Z",
    "2026-05-03T12:00:00Z",
    "2026-12-31T23:59:59.999Z",
  ];
  for (const ts of samples) {
    assert.equal(bucketKeyForDisplayAt(ts, "day"), ts.slice(0, 10), `day key for ${ts}`);
  }
});

test("bucketKeyForDisplayAt handles a DST-transition day without off-by-one (UTC has no DST)", () => {
  // US spring-forward 2026-03-08. In UTC bucketing both these instants are the
  // same day and bucket together — matching the feed (which also slices UTC).
  assert.equal(bucketKeyForDisplayAt("2026-03-08T06:30:00.000Z", "day"), "2026-03-08");
  assert.equal(bucketKeyForDisplayAt("2026-03-08T07:30:00.000Z", "day"), "2026-03-08");
});

test("bucketKeyForDisplayAt null/empty/unparseable → null bucket", () => {
  assert.equal(bucketKeyForDisplayAt("", "day"), null);
  assert.equal(bucketKeyForDisplayAt(null, "day"), null);
  assert.equal(bucketKeyForDisplayAt(undefined, "day"), null);
  assert.equal(bucketKeyForDisplayAt("not-a-date", "day"), null);
});

test("bucketKeyForDisplayAt week snaps to Monday (UTC)", () => {
  // 2026-05-03 is a Sunday → its ISO week started Monday 2026-04-27.
  assert.equal(bucketKeyForDisplayAt("2026-05-03T10:00:00Z", "week"), "2026-04-27");
  // 2026-05-04 is a Monday → its own week start.
  assert.equal(bucketKeyForDisplayAt("2026-05-04T10:00:00Z", "week"), "2026-05-04");
});

test("bucketKeyForDisplayAt month/hour keys", () => {
  assert.equal(bucketKeyForDisplayAt("2026-05-03T10:00:00Z", "month"), "2026-05-01");
  assert.equal(bucketKeyForDisplayAt("2026-05-03T10:45:00Z", "hour"), "2026-05-03T10:00");
});

// ── bucket-count honesty (design §9: true totals, NOT loaded-only) ──────────

test("deriveBucketSeries sums to the TRUE aggregate total (1,183), never the loaded count", () => {
  // Fixture: loaded feed would be 32, but the window=exact aggregate totals 1,183.
  // The series is built from the AGGREGATE groups, so the bar heights sum to 1,183.
  const series = deriveBucketSeries(
    [
      daySource([
        { key: "2026-05-01", count: 1000 },
        { key: "2026-05-03", count: 183 },
      ]),
    ],
    "day"
  );
  assert.equal(series.total, 1183);
  assert.equal(
    series.buckets.reduce((sum, b) => sum + b.count, 0),
    1183
  );
  assert.equal(series.partial, false);
});

test("deriveBucketSeries fans IN across sources: a bucket count is the UNION total", () => {
  const series = deriveBucketSeries(
    [
      daySource([{ key: "2026-05-01", count: 10 }]),
      daySource([{ key: "2026-05-01", count: 5 }]),
      daySource([{ key: "2026-05-02", count: 7 }]),
    ],
    "day"
  );
  const byKey = new Map(series.buckets.map((b) => [b.key, b.count]));
  assert.equal(byKey.get("2026-05-01"), 15); // 10 + 5 union
  assert.equal(byKey.get("2026-05-02"), 7);
  assert.equal(series.total, 22);
});

// ── empty buckets are shown, not hidden (design §4.2) ───────────────────────

test("deriveBucketSeries zero-fills the gaps (empty buckets present with count 0)", () => {
  const series = deriveBucketSeries(
    [
      daySource([
        { key: "2026-05-01", count: 3 },
        { key: "2026-05-04", count: 2 },
      ]),
    ],
    "day"
  );
  assert.deepEqual(
    series.buckets.map((b) => [b.key, b.count]),
    [
      ["2026-05-01", 3],
      ["2026-05-02", 0],
      ["2026-05-03", 0],
      ["2026-05-04", 2],
    ]
  );
});

test("deriveBucketSeries drops the null bucket from the axis (no axis position) but never absorbs it", () => {
  const series = deriveBucketSeries(
    [
      daySource([
        { key: null, count: 9 },
        { key: "2026-05-01", count: 1 },
      ]),
    ],
    "day"
  );
  assert.deepEqual(
    series.buckets.map((b) => [b.key, b.count]),
    [["2026-05-01", 1]]
  );
  // The null bucket's 9 is NOT folded into the May 1 bar.
  assert.equal(series.total, 1);
});

// ── partial source (design §2 / §4.1) ───────────────────────────────────────

test("deriveBucketSeries flags partial when a source is not-ok and never fabricates its counts", () => {
  const series = deriveBucketSeries([daySource([{ key: "2026-05-01", count: 4 }]), daySource([], false)], "day");
  assert.equal(series.partial, true);
  assert.equal(series.total, 4); // the not-ok source contributes nothing
});

test("deriveBucketSeries flags partial on a granularity mismatch (cannot union honestly)", () => {
  const series = deriveBucketSeries(
    [
      daySource([{ key: "2026-05-01", count: 4 }]),
      { granularity: "week", groups: [{ key: "2026-04-27", count: 99 }], ok: true },
    ],
    "day"
  );
  assert.equal(series.partial, true);
  assert.equal(series.total, 4); // the mismatched week source is skipped, not summed
});

// ── brush → since/until (design §4.4 inclusivity) ───────────────────────────

function dayBucket(key: string, count = 1): Bucket {
  const startMs = Date.parse(`${key}T00:00:00Z`);
  return { key, count, startMs, endMs: startMs + MS_PER_DAY };
}

test("barsToRange yields whole-day-inclusive (since, until) for a contiguous day run", () => {
  const buckets = ["2026-05-03", "2026-05-04", "2026-05-05"].map((k) => dayBucket(k));
  const { since, until } = barsToRange(buckets);
  assert.equal(since, "2026-05-03"); // 00:00:00.000 of B3
  assert.equal(until, "2026-05-05"); // inclusive of the whole last day
});

test("barsToRange single-bar click → that one bucket's inclusive span", () => {
  const { since, until } = barsToRange([dayBucket("2026-05-03")]);
  assert.equal(since, "2026-05-03");
  assert.equal(until, "2026-05-03");
});

test("barsToRange empty selection clears the filter", () => {
  assert.deepEqual(barsToRange([]), { since: "", until: "" });
});

test("barsToRange on a week bucket spans the whole week (last day inclusive)", () => {
  const startMs = Date.parse("2026-04-27T00:00:00Z");
  const weekBucket: Bucket = { key: "2026-04-27", count: 3, startMs, endMs: startMs + 7 * MS_PER_DAY };
  const { since, until } = barsToRange([weekBucket]);
  assert.equal(since, "2026-04-27");
  assert.equal(until, "2026-05-03"); // Sunday of the week, inclusive
});

// ── round-trip exactness (design §9: no drift) ──────────────────────────────

test("round-trip barsToRange → rangeToSelectedBars returns exactly [Bi..Bj]", () => {
  const buckets = ["2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05"].map((k) => dayBucket(k));
  const selected = buckets.slice(1, 4); // [B2..B4] (indices 1,2,3)
  const { since, until } = barsToRange(selected);
  assert.deepEqual([...rangeToSelectedBars(since, until, buckets)], [1, 2, 3]);
});

test("rangeToSelectedBars is a PURE function of the URL params (no gesture needed)", () => {
  const buckets = ["2026-05-01", "2026-05-02", "2026-05-03"].map((k) => dayBucket(k));
  // Setting since/until DIRECTLY (as the Date popover or before:/after: would)
  // highlights the same bars — proving single-source-of-truth with the Date chip.
  assert.deepEqual([...rangeToSelectedBars("2026-05-02", "2026-05-03", buckets)], [1, 2]);
});

test("rangeToSelectedBars treats a partially-covered edge bucket as selected", () => {
  const startMs = Date.parse("2026-04-27T00:00:00Z");
  const weekBucket: Bucket = { key: "2026-04-27", count: 3, startMs, endMs: startMs + 7 * MS_PER_DAY };
  // A window covering only the middle of the week still selects the week bucket.
  assert.deepEqual([...rangeToSelectedBars("2026-04-29", "2026-04-30", [weekBucket])], [0]);
});

test("rangeToSelectedBars with no since AND no until → no selection (resting full extent)", () => {
  const buckets = ["2026-05-01", "2026-05-02"].map((k) => dayBucket(k));
  assert.deepEqual([...rangeToSelectedBars("", "", buckets)], []);
});

test("rangeToSelectedBars open-ended since (until empty) selects from since to the end", () => {
  const buckets = ["2026-05-01", "2026-05-02", "2026-05-03"].map((k) => dayBucket(k));
  assert.deepEqual([...rangeToSelectedBars("2026-05-02", "", buckets)], [1, 2]);
});

// ── empty-span brush is honest zero (design §4.2) ───────────────────────────

test("barsToRange over an all-empty span yields a window that filters the feed (never a non-empty claim)", () => {
  // Brushing zero-count buckets still produces a real window; the feed then shows
  // an honest zero-results routing — the bar never implies data you can't open.
  const empty = ["2026-05-10", "2026-05-11"].map((k) => dayBucket(k, 0));
  const { since, until } = barsToRange(empty);
  assert.equal(since, "2026-05-10");
  assert.equal(until, "2026-05-11");
});

// ── kind gating (design §4.1 / §5) ──────────────────────────────────────────

test("chartIsBrushable: exhaustive kinds yes, relevance_bounded no", () => {
  assert.equal(chartIsBrushable("complete_chronological"), true);
  assert.equal(chartIsBrushable("keyword_pageable"), true);
  assert.equal(chartIsBrushable("filtered_exact"), true);
  assert.equal(chartIsBrushable("relevance_bounded"), false);
});

test("chartIsVisible suppresses the chart over relevance_bounded", () => {
  // fromSearch=false isolates the KIND gate.
  assert.equal(chartIsVisible("relevance_bounded", false), false);
  assert.equal(chartIsVisible("complete_chronological", false), true);
});

// ── SEARCH gate: chart suppressed during a free-text search (the aggregate
//    cannot scope to the query, so its bars would be a corpus-wide lie). ──────

test("chartIsVisible suppresses the chart during search (fromSearch=true) for EVERY exhaustive kind", () => {
  // keyword_pageable is produced ONLY by the search lens; suppress it.
  assert.equal(chartIsVisible("keyword_pageable", true), false);
  // Even a kind that would otherwise be visible is suppressed under search:
  // the aggregate cannot be query-scoped, so no honest distribution exists.
  assert.equal(chartIsVisible("complete_chronological", true), false);
  assert.equal(chartIsVisible("filtered_exact", true), false);
  assert.equal(chartIsVisible("relevance_bounded", true), false);
});

test("chartIsVisible NEGATIVE CONTROL: the non-search browse/filter feed still renders", () => {
  // The gate must NOT over-suppress: the browse timeline and a structurally
  // date/connection-filtered feed are honest time-distributions and DO render.
  assert.equal(chartIsVisible("complete_chronological", false), true);
  assert.equal(chartIsVisible("filtered_exact", false), true);
});

// ── caption (design §4.1: never claims "Matching" — bars are never query-scoped) ─

test("chartCaption NEVER says 'Matching records' (bars are not query-scoped) and never 'most recent N'", () => {
  // Every rendered state describes the structural time-distribution, so the lead
  // is always "Records over time" — never "Matching records over time" (which
  // would imply bars the feed-scope cannot back).
  const browse = chartCaption("complete_chronological", "day");
  assert.equal(browse, "Records over time · by day");
  // filtered_exact (a date/connection-filtered feed) ALSO must not claim "Matching":
  // since/until only pick granularity; they do not scope the aggregate, so the bars
  // are the broader structural distribution shown for brushing.
  const filtered = chartCaption("filtered_exact", "month");
  assert.equal(filtered, "Records over time · by month");
  assert.ok(!filtered.toLowerCase().includes("matching"), "filtered_exact caption never claims 'matching'");
  // Quarter/year are honest units now (the full-corpus view returns yearly buckets):
  // the caption must say "by quarter" / "by year", never the old "by month" mislabel.
  assert.equal(chartCaption("complete_chronological", "quarter"), "Records over time · by quarter");
  assert.equal(chartCaption("complete_chronological", "year"), "Records over time · by year");
  // Negative control across every kind + a representative unit: no caption ever
  // contains "matching" or "most recent".
  for (const kind of ["complete_chronological", "keyword_pageable", "filtered_exact", "relevance_bounded"] as const) {
    const cap = chartCaption(kind, "week").toLowerCase();
    assert.ok(!cap.includes("matching"), `caption for ${kind} must not say 'matching'`);
    assert.ok(!cap.includes("most recent"), `caption for ${kind} must not say 'most recent'`);
  }
});

const DAY_LABEL_RE = /May 3, 2026/;
const WEEK_LABEL_RE = /Week of/;

test("bucketLabel renders a human prose label per granularity", () => {
  assert.match(bucketLabel(dayBucket("2026-05-03"), "day"), DAY_LABEL_RE);
  assert.match(bucketLabel(dayBucket("2026-04-27"), "week"), WEEK_LABEL_RE);
});

test("bucketLabel: a year bucket reads the 4-digit year (not the old 'January 2019' mislabel)", () => {
  // The full-corpus yearly bars MUST read "2019"/"2020", not "January 2019".
  assert.equal(bucketLabel(dayBucket("2019-01-01"), "year"), "2019");
  assert.equal(bucketLabel(dayBucket("2020-01-01"), "year"), "2020");
});

test("bucketLabel: a quarter bucket reads 'Q<n> <year>' derived from the bucket month", () => {
  assert.equal(bucketLabel(dayBucket("2019-01-01"), "quarter"), "Q1 2019");
  assert.equal(bucketLabel(dayBucket("2019-04-01"), "quarter"), "Q2 2019");
  assert.equal(bucketLabel(dayBucket("2019-07-01"), "quarter"), "Q3 2019");
  assert.equal(bucketLabel(dayBucket("2019-10-01"), "quarter"), "Q4 2019");
});
