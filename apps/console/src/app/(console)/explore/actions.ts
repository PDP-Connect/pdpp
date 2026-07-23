"use server";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ExploreBucketRequest } from "@pdpp/operator-ui/components/views/records-explorer-view";
import { BUCKET_TIME_ZONE, type BucketSeries, chartIsVisible } from "@pdpp/operator-ui/explore/over-time-chart";
import { mapBucketsResponseToSeries } from "@pdpp/operator-ui/explore/over-time-chart-bucket-mapping";
import { liveDashboardDataSource } from "../lib/data-source.ts";
import { getOwnerToken } from "../lib/owner-token.ts";
import { verifyDashboardSession } from "../lib/verify-session.ts";

/**
 * DEFERRED over-time chart load (the ~7s-Explore fix).
 *
 * `assembleExplorerData` no longer awaits the 3.6s `/_ref/explore/records/buckets`
 * aggregate on the server-component critical path — the feed (~860ms) renders
 * immediately. Instead it returns the computed `ExploreBucketRequest` and the
 * canvas calls THIS action post-mount to fill the chart band in
 * (Linear/Vercel "list instant, chart fills in"). The bucket aggregate counts the
 * full corpus by month — a scan that cannot be indexed away at all-scope — so
 * moving it off first paint is the whole win.
 *
 * HONESTY (preserved exactly):
 *   - count == reachability: `total` is the server's exact reachable
 *     `extent.count`, mapped by the SAME `mapBucketsResponseToSeries` the old
 *     inline `loadBucketSeries` used. Deferring changes only WHEN it loads.
 *   - search suppression: the assembler returns a null `bucketRequest` for
 *     search / relevance_bounded / no-targets (so the canvas never calls this),
 *     and we ALSO re-assert `chartIsVisible` here so a hand-forged request can
 *     never make the aggregate sum the full corpus under a search lens.
 *   - chart scope == feed scope: `connections`/`streams` are the IDENTICAL
 *     structural targets the feed shows, computed in the assembler.
 *
 * Owner-gated like every other dashboard action (`verifyDashboardSession` +
 * `getOwnerToken`). A read fault degrades the CHART to null — the feed is already
 * painted and unaffected — so this never throws into a route error boundary.
 */
export async function loadExploreBuckets(req: ExploreBucketRequest): Promise<BucketSeries | null> {
  // Re-assert the suppression gate server-side. The assembler already nulls the
  // request for search / relevance_bounded, but the action is independently
  // callable, so never let a forged request scope the all-corpus aggregate under
  // a search lens (the bars would lie against the matched feed).
  if (!chartIsVisible(req.descriptorKind, req.fromSearch)) {
    return null;
  }
  try {
    await verifyDashboardSession();
    await getOwnerToken();
    const response = await liveDashboardDataSource.listExploreRecordBuckets({
      connections: req.connections,
      // Carry the feed's `-con:` exclusions so the aggregate drops the same
      // connections the feed hid (chart scope == feed scope). `chartTargets` does
      // not pre-filter excluded connections out of `connections`, so this is the
      // only place the exclusion is applied to the bucket scan.
      excludeConnections: req.excludeConnections,
      excludeStreams: req.excludeStreams,
      granularity: "auto",
      since: req.since || undefined,
      streams: req.streams,
      timeZone: BUCKET_TIME_ZONE,
      until: req.until || undefined,
    });
    // `partial` is false here exactly as the old inline load reported it: the
    // single index-backed call either counts the in-scope set exactly or fails
    // (→ null), so a returned series is never a silent undercount.
    return mapBucketsResponseToSeries(response, false);
  } catch {
    // Chart degrades to null; the feed (already rendered) is untouched.
    return null;
  }
}
