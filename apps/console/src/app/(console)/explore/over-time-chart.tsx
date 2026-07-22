"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * OverTimeChart — a quiet Grafana-style VOLUME BAND above the feed (design
 * over-time-chart §1/§5). Records-per-time-bucket of the SAME filtered set the
 * feed shows, from the server `group_by_time` aggregate (TRUE totals over the
 * filtered grant-scoped corpus — bar height == reachable reality). Brushable
 * (drag a span) + click-a-bar + hover tooltips. The brush writes the ONE
 * canonical `(since, until)` Date object via the same widened `setRange` the
 * Date controls use; the shaded selection overlay is a PURE function of the URL
 * `since`/`until` (so the Date chip, typed operators, and the brush are three
 * views of one object — never a parallel range).
 *
 * Pure math (bucketing, brush↔range round-trip, gating, captions) lives in
 * `./explore-over-time-chart.ts`; this file is presentation + pointer handling.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import {
  type Bucket,
  type BucketSeries,
  barsToRange,
  bucketLabel,
  chartCaption,
  chartIsBrushable,
  rangeToSelectedBars,
} from "./explore-over-time-chart.ts";

interface OverTimeChartProps {
  descriptorKind: "complete_chronological" | "relevance_bounded" | "keyword_pageable" | "filtered_exact";
  /** Commit a brushed/clicked span into the ONE canonical (since, until) object. */
  onSelectRange: (range: { since: string; until: string }) => void;
  series: BucketSeries;
  /** Current canonical date filter (URL params). The overlay derives from these. */
  since: string;
  until: string;
}

/** Local index span [start, end] (inclusive) while dragging, else null. */
interface DragState {
  end: number;
  start: number;
}

/**
 * DOMAIN AUTO-FIT: fit the time axis to where the data actually lives. Trims
 * leading/trailing buckets only up to a tiny CUMULATIVE-COUNT threshold (≤0.5% of
 * `total` per edge), so a single degenerate-timestamp outlier (e.g. one record
 * whose null/epoch-0 time defaulted to 1970-01-01) collapses, while a genuine
 * long-tail distribution (early buckets holding a meaningful share) is preserved.
 * DISPLAY-ONLY: the caller's `total` stays the exact reachable count —
 * count==reachability is never touched and no record's count is altered; trimmed
 * records remain reachable via the feed and the unbrushed resting view.
 * Datadog/Grafana fit the axis to the populated range the same way.
 */
function fitBucketDomain(buckets: readonly Bucket[], total: number): readonly Bucket[] {
  const n = buckets.length;
  if (n === 0 || total <= 0) {
    return buckets;
  }
  const edgeBudget = Math.max(1, Math.floor(total * 0.005));
  const advance = (from: number, step: 1 | -1, bound: number): number => {
    let i = from;
    let shed = 0;
    while (i !== bound) {
      const count = buckets[i]?.count ?? 0;
      if (count > edgeBudget || shed + count > edgeBudget) {
        break;
      }
      shed += count;
      i += step;
    }
    return i;
  };
  const lo = advance(0, 1, n - 1);
  const hi = advance(n - 1, -1, lo);
  return lo === 0 && hi === n - 1 ? buckets : buckets.slice(lo, hi + 1);
}

export function OverTimeChart({ series, since, until, descriptorKind, onSelectRange }: OverTimeChartProps) {
  const { buckets: rawBuckets, granularity, total, partial } = series;
  const brushable = chartIsBrushable(descriptorKind);

  // DOMAIN AUTO-FIT (see `fitBucketDomain`): trim leading/trailing buckets that
  // hold a negligible share so a single degenerate-timestamp outlier can't stretch
  // the axis. DISPLAY-ONLY — `total` (the exact reachable count) is never touched.
  const buckets = useMemo(() => fitBucketDomain(rawBuckets, total), [rawBuckets, total]);

  // The shaded selection is a PURE function of the URL since/until — set the
  // params directly (Date popover / before:/after:) and the overlay matches with
  // no gesture. Indices the canonical range currently covers.
  const selectedIndices = useMemo(() => new Set(rangeToSelectedBars(since, until, buckets)), [since, until, buckets]);

  const maxCount = useMemo(() => buckets.reduce((m, b) => Math.max(m, b.count), 0), [buckets]);

  // Transient drag span (desktop brush). Null when not dragging.
  const [drag, setDrag] = useState<DragState | null>(null);
  const draggingRef = useRef(false);
  const [hovered, setHovered] = useState<number | null>(null);

  const commitIndices = useCallback(
    (a: number, b: number) => {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const span = buckets.slice(lo, hi + 1);
      onSelectRange(barsToRange(span));
    },
    [buckets, onSelectRange]
  );

  const onBarClick = useCallback(
    (i: number) => {
      if (!brushable) {
        return;
      }
      // Toggle-off when this bar is already the SOLE selection (a fast clear);
      // the canonical clear remains the Date chip ×.
      if (selectedIndices.size === 1 && selectedIndices.has(i)) {
        onSelectRange({ since: "", until: "" });
        return;
      }
      commitIndices(i, i);
    },
    [brushable, selectedIndices, commitIndices, onSelectRange]
  );

  const onPointerDown = useCallback(
    (i: number) => {
      if (!brushable) {
        return;
      }
      draggingRef.current = true;
      setDrag({ end: i, start: i });
    },
    [brushable]
  );

  const onPointerEnterBar = useCallback((i: number) => {
    setHovered(i);
    if (draggingRef.current) {
      setDrag((d) => (d ? { ...d, end: i } : { end: i, start: i }));
    }
  }, []);

  const onPointerUp = useCallback(() => {
    if (draggingRef.current && drag) {
      draggingRef.current = false;
      commitIndices(drag.start, drag.end);
      setDrag(null);
      return;
    }
    draggingRef.current = false;
    setDrag(null);
  }, [drag, commitIndices]);

  // While dragging, the live read-out shows the tentative span.
  const dragSpanLabel = useMemo(() => {
    if (!drag) {
      return null;
    }
    const lo = Math.min(drag.start, drag.end);
    const hi = Math.max(drag.start, drag.end);
    const loB = buckets[lo];
    const hiB = buckets[hi];
    if (!(loB && hiB)) {
      return null;
    }
    return lo === hi
      ? bucketLabel(loB, granularity)
      : `${bucketLabel(loB, granularity)} – ${bucketLabel(hiB, granularity)}`;
  }, [drag, buckets, granularity]);

  if (buckets.length === 0) {
    return null;
  }

  const dragLo = drag ? Math.min(drag.start, drag.end) : null;
  const dragHi = drag ? Math.max(drag.start, drag.end) : null;

  return (
    <div className="rr-x-chart">
      <div className="rr-x-chart__head">
        <span className="rr-x-chart__caption">{chartCaption(descriptorKind, granularity)}</span>
        <span className="rr-x-chart__total">
          {partial ? (
            <span className="rr-x-chart__partial" title="Some streams could not be counted exactly">
              Some counts unavailable
            </span>
          ) : (
            <>
              <span className="rr-x-chart__total-num">{total.toLocaleString()}</span> records
            </>
          )}
        </span>
      </div>
      {/* The band groups the bars; each bar is a button (or a static slot when
          not brushable) carrying its day + honest count. The brush overlay is the
          focus+context band — the whole distribution stays visible. */}
      {/* biome-ignore lint/a11y/useSemanticElements: a chart band is an ARIA grouping of bars, not a form fieldset; role="group" with an aria-label is the correct semantic. */}
      <div
        aria-label={`${chartCaption(descriptorKind, granularity)}${brushable ? ", brush to filter" : ""}`}
        className={["rr-x-chart__band", brushable ? "is-brushable" : ""].filter(Boolean).join(" ")}
        // biome-ignore lint/performance/noJsxPropsBind: non-memoized, inline binding intentional
        onPointerLeave={() => {
          setHovered(null);
        }}
        onPointerUp={onPointerUp}
        role="group"
      >
        {buckets.map((bucket, i) => (
          <ChartBar
            brushable={brushable}
            bucket={bucket}
            granularity={granularity}
            hovered={hovered === i}
            inDrag={dragLo !== null && dragHi !== null && i >= dragLo && i <= dragHi}
            key={bucket.key}
            maxCount={maxCount}
            // biome-ignore lint/performance/noJsxPropsBind: non-memoized, inline binding intentional
            onClick={() => onBarClick(i)}
            // biome-ignore lint/performance/noJsxPropsBind: non-memoized, inline binding intentional
            onPointerDown={() => onPointerDown(i)}
            // biome-ignore lint/performance/noJsxPropsBind: non-memoized, inline binding intentional
            onPointerEnter={() => onPointerEnterBar(i)}
            selected={selectedIndices.has(i)}
          />
        ))}
      </div>
      {/* Live read-out during a drag-brush (the tentative span). */}
      {dragSpanLabel ? (
        <div aria-live="polite" className="rr-x-chart__readout">
          {dragSpanLabel}
        </div>
      ) : null}
    </div>
  );
}

interface ChartBarProps {
  brushable: boolean;
  bucket: Bucket;
  granularity: BucketSeries["granularity"];
  hovered: boolean;
  inDrag: boolean;
  maxCount: number;
  onClick: () => void;
  onPointerDown: () => void;
  onPointerEnter: () => void;
  selected: boolean;
}

function ChartBar({
  bucket,
  brushable,
  granularity,
  hovered,
  inDrag,
  maxCount,
  onClick,
  onPointerDown,
  onPointerEnter,
  selected,
}: ChartBarProps) {
  // Height by relative intensity over true totals. An empty bucket renders as a
  // faint baseline tick (a present, visible zero — never a gap).
  const ratio = maxCount > 0 ? bucket.count / maxCount : 0;
  const label = bucketLabel(bucket, granularity);
  const ariaLabel = `${label} · ${bucket.count.toLocaleString()} ${bucket.count === 1 ? "record" : "records"}`;
  const className = [
    "rr-x-chart__bar",
    bucket.count === 0 ? "is-empty" : "",
    selected ? "is-selected" : "",
    inDrag ? "is-dragging" : "",
    hovered ? "is-hovered" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const fill = (
    <span
      aria-hidden
      className="rr-x-chart__bar-fill"
      // The height percentage is a data-driven value, not a theme token; inline
      // style is the honest place for a per-bar measurement.
      style={{ height: `${Math.max(ratio * 100, bucket.count > 0 ? 6 : 0)}%` }}
    />
  );
  if (!brushable) {
    return (
      <span aria-label={ariaLabel} className={className} role="img" title={ariaLabel}>
        {fill}
      </span>
    );
  }
  return (
    <button
      aria-label={ariaLabel}
      className={className}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerEnter={onPointerEnter}
      title={ariaLabel}
      type="button"
    >
      {fill}
    </button>
  );
}
