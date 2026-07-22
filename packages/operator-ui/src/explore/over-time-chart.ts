// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure over-time chart logic for the Explore canvas.
 *
 * A quiet Grafana-style volume band above the feed: records-per-time-bucket of
 * the SAME filtered set the feed shows, brushable into the ONE canonical
 * `(since, until)` Date object (the same widened `setRange` the Date controls
 * use). This module is React-free and "use client"-free so node:test suites can
 * exercise the brush/bucket math directly. The presentational component lives in
 * `over-time-chart.tsx`; the canvas owns state/navigation.
 *
 * DESIGN: docs/research/explore-design-cells/over-time-chart/design.md
 *
 * Honesty invariants enforced here (THE-LENS Gate 1 §10):
 *  - Bars are TRUE per-bucket totals over the filtered grant-scoped corpus
 *    (server `group_by_time` aggregate), NOT loaded-feed counts. This module
 *    consumes already-fetched aggregate group lists; it never derives counts
 *    from loaded entries.
 *  - Bucketing matches the FEED's day-grouping. The live feed groups by
 *    `displayAt.slice(0, 10)` (the ISO date-prefix, UTC wall-clock); so the
 *    chart buckets in UTC too (design §4.3 resolution B: chart + feed + Date
 *    chip uniformly UTC). The `BUCKET_TIME_ZONE` constant is the single source
 *    of that decision; the aggregate is queried with this zone so the server's
 *    day key equals the feed's.
 *  - Empty buckets are present in the series with count 0 (never omitted).
 *  - `(since, until)` boundaries are inclusive whole-bucket-day local: `since` =
 *    00:00:00.000 of the first selected bucket's day, `until` = 23:59:59.999 of
 *    the last selected bucket's last day (so a brushed bar can never exclude its
 *    own records).
 *  - The chart is brushable ONLY over time-exhaustive descriptors; a
 *    relevance_bounded set has no honest time-distribution to brush.
 */

import type { SetDescriptor } from "./set-descriptor.ts";

/**
 * The timezone the chart buckets in. UTC, to MATCH the live feed's day-grouping
 * (`displayAt.slice(0, 10)`) and the day-header labels (formatted `timeZone:
 * "UTC"` in explore-feed-grouping.ts) and the Date chip boundaries (UTC ISO
 * `since`/`until`). The aggregate request passes this same zone so the server's
 * `date_trunc` day key equals the feed's. Changing the feed's grouping tz
 * REQUIRES changing this constant in lockstep (the design's "they must match"
 * invariant). See design §4.3.
 */
export const BUCKET_TIME_ZONE = "UTC";

const MS_PER_DAY = 86_400_000;

/** Granularity ladder units. Mirrors the server's SUPPORTED_AGGREGATE_GRANULARITIES. */
export type BucketGranularity = "hour" | "day" | "week" | "month" | "quarter" | "year";

/** One bar in the volume band. `count` is the TRUE total for the bucket. */
export interface Bucket {
  /** TRUE number of records in this bucket over the filtered corpus. */
  count: number;
  endMs: number;
  /** Stable ISO bucket-start key, in `BUCKET_TIME_ZONE` (server `date_trunc`). */
  key: string;
  /** Inclusive UTC millisecond bounds of the bucket [startMs, endMs). */
  startMs: number;
}

/** The full volume band: zero-filled, contiguous, with its granularity + honesty flags. */
export interface BucketSeries {
  buckets: readonly Bucket[];
  granularity: BucketGranularity;
  /**
   * True when one or more in-scope streams could not be counted exactly (no
   * declared time aggregate, or the aggregate read failed). The caption then
   * says "Some counts unavailable" — never a fabricated total, never silent
   * undercount. (design §2 partial-source / §4.1 partial.)
   */
  partial: boolean;
  /** Sum of all bucket counts = the true total in scope. */
  total: number;
}

/** A single per-stream aggregate group list (the server `group_by_time` groups). */
export interface AggregateGroup {
  count: number;
  /** ISO bucket-start key (`YYYY-MM-DD` for day/week/month, `…THH:MM` for hour), or null. */
  key: string | null;
}

/** One stream's contribution to the union series. `ok=false` marks a partial source. */
export interface AggregateSource {
  granularity: BucketGranularity;
  groups: readonly AggregateGroup[];
  /** False when this stream's exact aggregate is unavailable (drives `partial`). */
  ok: boolean;
}

// ── Granularity ladder (design §4.5) ───────────────────────────────────────
//
// Auto-derived from the active window span (or the full data extent when no
// date filter is set) and snapped to friendly units, keeping the bar count in a
// calm band. Re-derived after a brush (a stricter, honest stance than Grafana's
// manual "Reload").

const SPAN_HOUR_MAX_MS = 2 * MS_PER_DAY; // ≤ 2 days → hour buckets
const SPAN_DAY_MAX_MS = 70 * MS_PER_DAY; // ≤ ~10 weeks → day buckets
const SPAN_WEEK_MAX_MS = 730 * MS_PER_DAY; // ≤ ~2 years → week buckets

/**
 * Pick the bucket granularity for a time span (ms). Snapped to friendly units so
 * the band never renders hundreds of hairline bars. `spanMs <= 0` (single point
 * / unknown extent) defaults to `day`.
 */
export function deriveGranularity(spanMs: number): BucketGranularity {
  if (!(spanMs > 0)) {
    return "day";
  }
  if (spanMs <= SPAN_HOUR_MAX_MS) {
    return "hour";
  }
  if (spanMs <= SPAN_DAY_MAX_MS) {
    return "day";
  }
  if (spanMs <= SPAN_WEEK_MAX_MS) {
    return "week";
  }
  return "month";
}

// ── Bucket-key ↔ instant math (UTC, matching the feed) ──────────────────────

/**
 * The bucket KEY a record's display-time falls into, at `granularity`, in
 * `BUCKET_TIME_ZONE` (UTC). For `day` this is `displayAt.slice(0, 10)` — IDENTICAL
 * to the live feed's `dayKey` derivation, so a record can never land in chart bar
 * day X but feed day-header X±1. The same UTC truncation extends to hour/week/
 * month. Returns null for an empty/unparseable timestamp (the null bucket).
 */
export function bucketKeyForDisplayAt(
  displayAt: string | null | undefined,
  granularity: BucketGranularity
): string | null {
  if (typeof displayAt !== "string" || displayAt === "") {
    return null;
  }
  const ms = Date.parse(displayAt);
  if (Number.isNaN(ms)) {
    return null;
  }
  return bucketKeyForMs(ms, granularity);
}

/** The bucket KEY for a UTC instant (ms) at `granularity`. */
export function bucketKeyForMs(ms: number, granularity: BucketGranularity): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth(); // 0-based
  const day = d.getUTCDate();
  switch (granularity) {
    case "hour":
      return `${iso10(ms)}T${pad2(d.getUTCHours())}:00`;
    case "day":
      return iso10(ms);
    case "week": {
      // Snap back to Monday (ISO week start), matching the server (weeks start Monday).
      const dow = d.getUTCDay(); // 0=Sun..6=Sat
      const offset = dow === 0 ? 6 : dow - 1;
      const monday = Date.UTC(y, mo, day - offset);
      return iso10(monday);
    }
    case "month":
      return `${y}-${pad2(mo + 1)}-01`;
    case "quarter": {
      // First month of the quarter the instant falls in (Jan/Apr/Jul/Oct).
      const quarterStartMonth = Math.floor(mo / 3) * 3; // 0,3,6,9
      return `${y}-${pad2(quarterStartMonth + 1)}-01`;
    }
    case "year":
      return `${y}-01-01`;
    default: {
      const _exhaustive: never = granularity;
      return _exhaustive;
    }
  }
}

/** Inclusive [startMs, endMs) UTC bounds of the bucket whose start key is `key`. */
export function bucketBounds(key: string, granularity: BucketGranularity): { startMs: number; endMs: number } {
  if (granularity === "hour") {
    const startMs = Date.parse(`${key}:00Z`);
    return { startMs, endMs: startMs + 3_600_000 };
  }
  const startMs = Date.parse(`${key}T00:00:00Z`);
  const d = new Date(startMs);
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth();
  switch (granularity) {
    case "day":
      return { startMs, endMs: startMs + MS_PER_DAY };
    case "week":
      return { startMs, endMs: startMs + 7 * MS_PER_DAY };
    case "month":
      return { startMs, endMs: Date.UTC(y, mo + 1, 1) };
    case "quarter":
      // Advance 3 months (DST-free in UTC; Date.UTC normalizes month overflow).
      return { startMs, endMs: Date.UTC(y, mo + 3, 1) };
    case "year":
      return { startMs, endMs: Date.UTC(y + 1, mo, 1) };
    default:
      return { startMs, endMs: startMs + MS_PER_DAY };
  }
}

/** The key of the bucket immediately AFTER `key` (used to zero-fill the gaps). */
function nextBucketKey(key: string, granularity: BucketGranularity): string {
  const { endMs } = bucketBounds(key, granularity);
  return bucketKeyForMs(endMs, granularity);
}

function iso10(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// ── Series assembly (fan-in + zero-fill) ────────────────────────────────────

/**
 * Build the union volume band from per-stream aggregate group lists (design §2
 * cross-source fan-in: a bucket's count is the UNION total). The series is
 * zero-filled and contiguous from the earliest to the latest non-empty bucket so
 * the time axis stays continuous and empty buckets are visible (design §4.2).
 *
 * HONESTY: this consumes the server `group_by_time` groups (true totals over the
 * filtered corpus) — it NEVER counts loaded feed entries. If any source is
 * `ok=false`, the series is flagged `partial` so the caption can say "Some counts
 * unavailable" rather than imply a complete total. Sources whose granularity does
 * not match the requested one are treated as partial (their counts cannot be
 * union-summed into mismatched buckets without lying).
 *
 * The null/unparseable bucket is dropped from the visible series (it has no place
 * on a time axis), but it is NOT silently absorbed into a neighbour.
 */
export function deriveBucketSeries(sources: readonly AggregateSource[], granularity: BucketGranularity): BucketSeries {
  const { counts, partial } = accumulateSourceCounts(sources, granularity);
  const { buckets, total } = zeroFillBuckets(counts, granularity);
  return { buckets, granularity, total, partial };
}

/**
 * Fan the per-stream aggregate group lists into ONE keyed count map (the union
 * total per bucket). A not-ok source contributes nothing (we never fabricate); a
 * granularity-mismatched source is skipped (cannot union honestly). Either makes
 * the series `partial`. The null bucket is excluded (no axis position).
 */
function accumulateSourceCounts(
  sources: readonly AggregateSource[],
  granularity: BucketGranularity
): { counts: Map<string, number>; partial: boolean } {
  const counts = new Map<string, number>();
  let partial = false;
  for (const source of sources) {
    if (!source.ok || source.granularity !== granularity) {
      partial = true;
      continue;
    }
    for (const group of source.groups) {
      if (group.key != null) {
        counts.set(group.key, (counts.get(group.key) ?? 0) + group.count);
      }
    }
  }
  return { counts, partial };
}

/**
 * Materialize a contiguous, zero-filled bucket series from earliest to latest
 * present key (empty buckets present with count 0 — never omitted; design §4.2).
 */
function zeroFillBuckets(
  counts: ReadonlyMap<string, number>,
  granularity: BucketGranularity
): { buckets: Bucket[]; total: number } {
  const presentKeys = [...counts.keys()].sort();
  const buckets: Bucket[] = [];
  let total = 0;
  if (presentKeys.length === 0) {
    return { buckets, total };
  }
  const lastKey = presentKeys.at(-1) as string;
  let key = presentKeys[0] as string;
  // Guard against an unbounded loop on a malformed key.
  const guardMax = 10_000;
  for (let guard = 0; guard < guardMax; guard += 1) {
    const { startMs, endMs } = bucketBounds(key, granularity);
    const count = counts.get(key) ?? 0;
    total += count;
    buckets.push({ key, count, startMs, endMs });
    if (key === lastKey) {
      break;
    }
    key = nextBucketKey(key, granularity);
  }
  return { buckets, total };
}

// ── Brush ↔ canonical (since, until) round-trip (design §4.4) ────────────────

/**
 * Map a contiguous run of selected buckets to the canonical `(since, until)`
 * pair, inclusive of the whole edge buckets (UTC):
 *   since = 00:00:00.000Z of the first bucket's start day
 *   until = 23:59:59.999Z of the last bucket's LAST day
 * so the window includes every record the bars count (no off-by-one boundary lie).
 * Returns empty strings for an empty selection (clears the filter).
 */
export function barsToRange(selected: readonly Bucket[]): { since: string; until: string } {
  if (selected.length === 0) {
    return { since: "", until: "" };
  }
  const sorted = [...selected].sort((a, b) => a.startMs - b.startMs);
  const first = sorted[0] as Bucket;
  const last = sorted.at(-1) as Bucket;
  // `since`: the calendar day of the first bucket's start (00:00:00 UTC).
  const since = iso10(first.startMs);
  // `until`: the LAST calendar day fully inside the last bucket = the day before
  // the bucket's exclusive end. (For a day bucket this is the bucket's own day;
  // for week/month it is the bucket's final day.) The Date chip / server treat
  // `until` as inclusive-through-23:59:59.999 of that local day.
  const until = iso10(last.endMs - 1);
  return { since, until };
}

/**
 * Inverse of `barsToRange`: given the canonical `(since, until)` (ISO `yyyy-mm-dd`
 * or full ISO), return the INDICES of the buckets that fall within it. A bucket is
 * selected when it OVERLAPS the window at all (a partially-covered edge bucket
 * counts as selected — its records are within the window). This makes the brush
 * overlay a PURE function of the URL params: round-tripping `barsToRange` →
 * `rangeToSelectedBars` returns exactly the original run, with no drift.
 *
 * Empty `since` AND empty `until` → no selection (the resting full-extent view).
 */
export function rangeToSelectedBars(since: string, until: string, buckets: readonly Bucket[]): readonly number[] {
  const hasSince = typeof since === "string" && since.length > 0;
  const hasUntil = typeof until === "string" && until.length > 0;
  if (!(hasSince || hasUntil)) {
    return [];
  }
  // `since` is inclusive from 00:00:00.000 of its day; `until` is inclusive
  // through 23:59:59.999 of its day. Build the window in UTC ms.
  const sinceMs = hasSince ? startOfDayMs(since) : Number.NEGATIVE_INFINITY;
  const untilMs = hasUntil ? endOfDayMs(until) : Number.POSITIVE_INFINITY;
  const out: number[] = [];
  for (let i = 0; i < buckets.length; i += 1) {
    const b = buckets[i] as Bucket;
    // Overlap test against [startMs, endMs): the bucket [startMs, endMs) overlaps
    // the inclusive window [sinceMs, untilMs] when startMs <= untilMs and endMs > sinceMs.
    if (b.startMs <= untilMs && b.endMs > sinceMs) {
      out.push(i);
    }
  }
  return out;
}

function startOfDayMs(isoDate: string): number {
  // Accept either `yyyy-mm-dd` or a full ISO; normalize to the UTC day start.
  const day = isoDate.slice(0, 10);
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

function endOfDayMs(isoDate: string): number {
  const day = isoDate.slice(0, 10);
  const ms = Date.parse(`${day}T23:59:59.999Z`);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

// ── Descriptor gating (design §4.1 / §5) ────────────────────────────────────

/**
 * Whether the brushable chart may render over a set of this kind. Only
 * time-exhaustive sets have an honest time-distribution to brush:
 *   complete_chronological · keyword_pageable · filtered_exact → brushable
 *   relevance_bounded → NOT brushable (a ranked SAMPLE has no time-complete
 *   membership; a brush would filter a set whose distribution we cannot state).
 * The chart is SUPPRESSED entirely over relevance_bounded (design default).
 */
export function chartIsBrushable(kind: SetDescriptor["kind"]): boolean {
  return kind === "complete_chronological" || kind === "keyword_pageable" || kind === "filtered_exact";
}

/**
 * Whether the chart should render AT ALL for this descriptor + lens. Two gates:
 *
 *  1. KIND gate: suppress over relevance_bounded (no honest exhaustive
 *     distribution — design §4.1 default), rather than show a non-interactive
 *     "top matches" strip that invites a brush it cannot honor.
 *  2. SEARCH gate: suppress whenever the set is a free-text SEARCH result
 *     (`fromSearch`). The aggregate endpoint structurally cannot scope to a
 *     free-text query (it accepts structured connection/stream filters, NOT a
 *     `q`), so the bars over a search would sum the stream's FULL corpus while
 *     the caption claims "Matching records" — every bar implying matches the
 *     feed cannot reach. A search result-set is not an honest time-distribution
 *     surface; the chart is a BROWSE / timeline-navigation tool, so it is
 *     suppressed entirely during search. (`keyword_pageable` is produced ONLY by
 *     the search lens, so `!fromSearch` is the precise gate.)
 *
 * Both must hold. Caller passes `fromSearch` from the feed lens.
 */
export function chartIsVisible(kind: SetDescriptor["kind"], fromSearch: boolean): boolean {
  if (fromSearch) {
    return false;
  }
  return chartIsBrushable(kind);
}

// ── Caption (design §4.1 / §4.5 — kind + unit legible, never "most recent N") ─

const GRANULARITY_LABEL: Record<BucketGranularity, string> = {
  hour: "by hour",
  day: "by day",
  week: "by week",
  month: "by month",
  quarter: "by quarter",
  year: "by year",
};

/**
 * The one quiet caption naming the SET KIND and the bucket UNIT, so the bars'
 * meaning is never hidden (defeats the GitHub silent-rule + Sentry "most recent
 * N" anti-patterns). NEVER contains "from the most recent N records".
 *
 * HONESTY: the lead NEVER says "Matching records" unless the bars are actually
 * query-scoped. They never are — the aggregate endpoint cannot receive a
 * free-text query, and a date window (since/until) only picks the granularity, it
 * does NOT scope the aggregate (the bars are the broader structural distribution
 * you brush to navigate). And the chart is suppressed entirely during search
 * (`chartIsVisible(_, fromSearch)`), so a `keyword_pageable` caption never paints.
 * Therefore every rendered state ("Records over time") describes the structural
 * time-distribution of the in-scope sources — true bars, no "Matching" claim a
 * bar cannot back. The selected date window is shown by the brush overlay, not by
 * scoping the bars (design §4.4).
 */
export function chartCaption(_kind: SetDescriptor["kind"], granularity: BucketGranularity): string {
  return `Records over time · ${GRANULARITY_LABEL[granularity]}`;
}

/** Human bucket label for a tooltip / aria-label (e.g. "Mon, May 3, 2026" or the hour). */
const TOOLTIP_DAY_FMT = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: BUCKET_TIME_ZONE,
});
const TOOLTIP_MONTH_FMT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  timeZone: BUCKET_TIME_ZONE,
});
const TOOLTIP_HOUR_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  timeZone: BUCKET_TIME_ZONE,
});
/** Just the 4-digit calendar year (e.g. "2019") for a year bucket. */
const TOOLTIP_YEAR_FMT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  timeZone: BUCKET_TIME_ZONE,
});

/** Human label for a bucket, by granularity. Used in tooltip + per-bar aria-label. */
export function bucketLabel(bucket: Bucket, granularity: BucketGranularity): string {
  const at = new Date(bucket.startMs);
  switch (granularity) {
    case "hour":
      return TOOLTIP_HOUR_FMT.format(at);
    case "month":
      return TOOLTIP_MONTH_FMT.format(at);
    case "week":
      return `Week of ${TOOLTIP_DAY_FMT.format(at)}`;
    case "quarter": {
      // "Q1 2019" — quarter derived from the UTC month (0-based) of the bucket start.
      const quarter = Math.floor(at.getUTCMonth() / 3) + 1; // 1..4
      return `Q${quarter} ${at.getUTCFullYear()}`;
    }
    case "year":
      // "2019" — never the old "January 2019" mislabel from TOOLTIP_MONTH_FMT.
      return TOOLTIP_YEAR_FMT.format(at);
    default:
      return TOOLTIP_DAY_FMT.format(at);
  }
}
