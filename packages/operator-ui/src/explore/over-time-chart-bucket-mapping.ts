/**
 * The ONE mapping from the server bucket-aggregate response
 * (`ExploreRecordBucketsResponse`, `GET /_ref/explore/records/buckets`) to the
 * chart's `BucketSeries`. Shared so the deferred client-side load (the
 * `loadExploreBuckets` server action) maps the response IDENTICALLY to the way
 * the assembler's old inline `loadBucketSeries` did — same `buckets → Bucket`
 * map, same `extent.count → total`, same `partial` flag, same granularity ladder
 * + `key` derivation. Pure (no I/O), so it can be unit-tested directly.
 *
 * HONESTY: `total` is the server's EXACT reachable `extent.count` — never a
 * summed-bar total. Deferring the load (server → client post-mount) changes only
 * WHEN this runs, never the number it reports (count == reachability).
 */
import type { ExploreRecordBucketsResponse } from "../lib/rs-client.ts";
import type { Bucket, BucketGranularity, BucketSeries } from "./over-time-chart.ts";

/**
 * Map the server's bucket granularity onto the chart's `BucketGranularity` ladder.
 * `quarter` and `year` pass THROUGH so the caption/label honestly say "by quarter"
 * / "by year" and each bar reads "Q1 2019" / "2019" — not the old mislabel that
 * snapped yearly bars to "month" and rendered them as "January 2019". Sub-minute
 * `minute` still collapses to `hour`; any truly-unknown value falls back to
 * `month` (a safe default, never a fabricated unit). Only the chart's span/label
 * math reads this; the true bar bounds come from the server's `start`/`end`
 * instants.
 */
export function toBucketGranularity(granularity: string): BucketGranularity {
  switch (granularity) {
    case "hour":
    case "day":
    case "week":
    case "month":
    case "quarter":
    case "year":
      return granularity;
    case "minute":
      return "hour";
    default:
      return "month";
  }
}

/**
 * The chart bucket `key` for a server bucket start instant. For day/week/month the
 * key is the ISO date prefix (`YYYY-MM-DD`) — IDENTICAL to the live feed's
 * `displayAt.slice(0, 10)` dayKey, so a bar can never land in a different feed
 * day-header. Sub-day (hour/minute) keeps the full ISO instant.
 */
export function bucketKeyFromIso(start: string, granularity: string): string {
  if (granularity === "hour" || granularity === "minute") {
    return start;
  }
  return start.slice(0, 10);
}

/**
 * Map the dense bucket-aggregate response → the chart's `BucketSeries`. `partial`
 * is supplied by the caller (true when one or more in-scope streams could not be
 * counted exactly); the bars and `total` come straight from the server response.
 */
export function mapBucketsResponseToSeries(response: ExploreRecordBucketsResponse, partial: boolean): BucketSeries {
  // `start`/`end` are the server's ISO bucket bounds (UTC); `key` is the
  // day-prefix slice for day/week/month (IDENTICAL to the feed's
  // `displayAt.slice(0, 10)` dayKey) or the full ISO for sub-day buckets, so a
  // bar can never land in a different feed day-header.
  const buckets: Bucket[] = response.buckets.map((b): Bucket => {
    const startMs = Date.parse(b.start);
    const endMs = Date.parse(b.end);
    return {
      count: b.count,
      endMs,
      key: bucketKeyFromIso(b.start, response.granularity),
      startMs,
    };
  });

  return {
    buckets,
    granularity: toBucketGranularity(response.granularity),
    // `extent.count` is the EXACT reachable total over the scoped set — never a
    // fabricated/summed-bar total.
    partial,
    total: response.extent.count,
  };
}
