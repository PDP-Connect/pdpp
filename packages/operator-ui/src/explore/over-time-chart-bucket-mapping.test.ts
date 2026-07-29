// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared bucket-response → BucketSeries mapping (reused by the deferred
 * `loadExploreBuckets` action AND the assembler tests). It must map the server
 * response IDENTICALLY to the way the old inline `loadBucketSeries` did:
 *   - buckets → Bucket (count, startMs/endMs from ISO, day-prefix key for
 *     day/week/month; full ISO for sub-day),
 *   - extent.count → total (the EXACT reachable corpus — count == reachability),
 *   - caller-supplied partial flag,
 *   - granularity snapped to the chart ladder.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExploreRecordBucketsResponse } from "../lib/rs-client.ts";
import { bucketKeyFromIso, mapBucketsResponseToSeries, toBucketGranularity } from "./over-time-chart-bucket-mapping.ts";

function dayResponse(): ExploreRecordBucketsResponse {
  return {
    buckets: [
      { count: 30, end: "2026-06-06T00:00:00.000Z", start: "2026-06-05T00:00:00.000Z" },
      { count: 12, end: "2026-06-07T00:00:00.000Z", start: "2026-06-06T00:00:00.000Z" },
    ],
    extent: { count: 42, end: "2026-06-06T00:00:00.000Z", start: "2026-06-05T00:00:00.000Z" },
    granularity: "day",
    object: "explore_record_buckets",
    time_zone: "UTC",
  };
}

test("total is the EXACT reachable extent.count (count == reachability), never the summed bars", () => {
  const series = mapBucketsResponseToSeries(dayResponse(), false);
  // Bars sum to 42 here, but the contract is that `total` is the server's extent
  // count — assert it tracks extent.count even if it diverges from the bar sum.
  const forged: ExploreRecordBucketsResponse = { ...dayResponse(), extent: { ...dayResponse().extent, count: 999 } };
  assert.equal(series.total, 42, "total comes from extent.count");
  assert.equal(mapBucketsResponseToSeries(forged, false).total, 999, "total tracks extent.count, not the bar sum");
});

test("day/week/month bucket key is the YYYY-MM-DD prefix (reconciles with the feed dayKey)", () => {
  const series = mapBucketsResponseToSeries(dayResponse(), false);
  assert.deepEqual(
    series.buckets.map((b) => b.key),
    ["2026-06-05", "2026-06-06"],
    "day buckets key on the date prefix — identical to the feed's displayAt.slice(0,10)"
  );
  assert.equal(series.buckets[0]?.count, 30);
  assert.equal(series.buckets[0]?.startMs, Date.parse("2026-06-05T00:00:00.000Z"));
  assert.equal(series.granularity, "day");
});

test("sub-day buckets keep the full ISO key; granularity snaps to the chart ladder", () => {
  assert.equal(bucketKeyFromIso("2026-06-05T13:00:00.000Z", "hour"), "2026-06-05T13:00:00.000Z");
  assert.equal(bucketKeyFromIso("2026-06-05T13:00:00.000Z", "minute"), "2026-06-05T13:00:00.000Z");
  assert.equal(bucketKeyFromIso("2026-06-05T13:00:00.000Z", "day"), "2026-06-05");
  // minute → hour; year/quarter (supra-month) → month.
  // minute -> hour; year/quarter now pass THROUGH honestly (no longer snapped to
  // month -- that was the yearly-bars-mislabeled-as-monthly bug); unknown -> month.
  assert.equal(toBucketGranularity("minute"), "hour");
  assert.equal(toBucketGranularity("year"), "year");
  assert.equal(toBucketGranularity("quarter"), "quarter");
  assert.equal(toBucketGranularity("week"), "week");
  assert.equal(toBucketGranularity("nonsense"), "month", "truly-unknown still falls back to month");
});

test("quarter/year buckets key on the YYYY-MM-DD prefix (first day of the period)", () => {
  // Server returns a date-prefixed start for supra-month buckets (e.g. quarter
  // starts Jan/Apr/Jul/Oct-01, year starts Jan-01); the chart keys on the prefix.
  assert.equal(bucketKeyFromIso("2019-04-01T00:00:00.000Z", "quarter"), "2019-04-01");
  assert.equal(bucketKeyFromIso("2019-01-01T00:00:00.000Z", "year"), "2019-01-01");
});

test("a year-granularity response maps to a year series with year keys + total", () => {
  const yearResponse: ExploreRecordBucketsResponse = {
    buckets: [
      { count: 200, end: "2020-01-01T00:00:00.000Z", start: "2019-01-01T00:00:00.000Z" },
      { count: 300, end: "2021-01-01T00:00:00.000Z", start: "2020-01-01T00:00:00.000Z" },
    ],
    extent: { count: 500, end: "2021-01-01T00:00:00.000Z", start: "2019-01-01T00:00:00.000Z" },
    granularity: "year",
    object: "explore_record_buckets",
    time_zone: "UTC",
  };
  const series = mapBucketsResponseToSeries(yearResponse, false);
  assert.equal(series.granularity, "year", "year passes through -- not snapped to month");
  assert.deepEqual(
    series.buckets.map((b) => b.key),
    ["2019-01-01", "2020-01-01"]
  );
  assert.equal(series.total, 500, "total is the exact reachable extent.count");
});

test("a quarter-granularity response maps to a quarter series", () => {
  const quarterResponse: ExploreRecordBucketsResponse = {
    buckets: [
      { count: 40, end: "2019-04-01T00:00:00.000Z", start: "2019-01-01T00:00:00.000Z" },
      { count: 50, end: "2019-07-01T00:00:00.000Z", start: "2019-04-01T00:00:00.000Z" },
    ],
    extent: { count: 90, end: "2019-07-01T00:00:00.000Z", start: "2019-01-01T00:00:00.000Z" },
    granularity: "quarter",
    object: "explore_record_buckets",
    time_zone: "UTC",
  };
  const series = mapBucketsResponseToSeries(quarterResponse, false);
  assert.equal(series.granularity, "quarter", "quarter passes through -- not snapped to month");
  assert.deepEqual(
    series.buckets.map((b) => b.key),
    ["2019-01-01", "2019-04-01"]
  );
});

test("partial flag is the caller's (not summed) and is carried through verbatim", () => {
  assert.equal(mapBucketsResponseToSeries(dayResponse(), true).partial, true);
  assert.equal(mapBucketsResponseToSeries(dayResponse(), false).partial, false);
});
