/**
 * Explore "Load more" ACCUMULATES, and pins page 1 to the ORIGINAL snapshot via
 * server-side REWIND (reproduce-the-bug regression).
 *
 * THE FIRST BUG (docs/research/explore-loadmore-replace-bug-2026-06-20.md): the
 * recent merged-timeline lens used a SINGLE cursor and returned only `page.data` —
 * so "Load more" REPLACED the visible page with the next (older) slice and the
 * records above disappeared. FIX (Option A — server-side cursor TRAIL that
 * concatenates): the URL carries the trail of `next_cursor` values (`cursors=c1,c2,…`);
 * the assembler fetches page 1 + each trail cursor IN ORDER and CONCATENATES.
 *
 * THE SECOND BUG (docs/research/explore-loadmore-snapshot-pin-fix-2026-06-20.md,
 * caught in review): the trail accumulator re-fetched page 1 with `cursor=null` (a
 * FRESH snapshot) and pinned it with an `emitted_at <= anchor` proxy. But emitted_at
 * is display-only; membership is anchored by `snapshotSeq` (ingest id). An
 * after-snapshot BACKFILL whose emitted_at lands inside page 1's window PASSES the
 * timestamp filter and DISPLACES an original page-1 row → the record is hidden. FIX:
 * fetch page 1 by REWINDING the page-1 → page-2 cursor (`trail[0]`) with
 * `rewindToFirstPage: true`, so page 1 is pinned to the SAME original snapshot
 * (snapshotSeq) as pages 2..N and the backfill can never displace an original row.
 *
 * These tests pin both behaviors with a fake DashboardDataSource. The accumulation
 * tests assert every page's records are present, ordered, deduped. The rewind test
 * asserts the assembler uses the REWIND result for page 1 (original page 1, no
 * backfill) and would FAIL if it still used `cursor:null` + the emitted_at proxy.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DashboardDataSource } from "../lib/data-source.ts";
import type { ExploreTimelinePage, ExploreTimelineRecord, RefConnectorSummary } from "../lib/ref-client.ts";
import type { ConnectorManifest, RecordsPage, StreamMetadata } from "../lib/rs-client.ts";
import { assembleExplorerData } from "./explore-data-assembler.ts";

// Anchor newer than every page record so the page-1 snapshot filter keeps the
// whole original snapshot (no record is "after the snapshot" in these fixtures).
const SNAPSHOT_AT = "2026-12-31T00:00:00Z";

function ynabSummary(): RefConnectorSummary {
  return {
    connector_display_name: "YNAB",
    connector_id: "ynab",
    connection_id: "cin_ynab",
    connector_instance_id: "cin_ynab",
    display_name: "YNAB",
    freshness: {},
    last_run: null,
    last_successful_run: null,
    manifest_version: "test",
    schedule: null,
    stream_count: 1,
    streams: ["transactions"],
    total_records: 100,
  } as RefConnectorSummary;
}

function ynabManifest(): ConnectorManifest {
  return {
    connector_id: "ynab",
    streams: [{ name: "transactions", schema: { properties: { title: { type: "string" } } } }],
  };
}

// Page-1 records are the newest; each subsequent page is strictly older. We map a
// (pageRank, withinPage) pair to an absolute day offset descending from a base so
// every record across every page has a unique, strictly-descending emitted_at with
// no calendar overflow. pageRank 0 = newest page.
const BASE_MS = Date.parse("2026-06-01T00:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** Distinct records for one page: keys `${page}-0..n`, emitted_at strictly descending. */
function pageRecords(page: string, pageRank: number, count: number): ExploreTimelineRecord[] {
  // Reserve a wide, non-overlapping day band per page (100 days) so pages never
  // interleave in time: page 0 occupies the newest band, page 1 the next, etc.
  const bandStartDays = pageRank * 100;
  return Array.from({ length: count }, (_, i) => ({
    object: "timeline_record" as const,
    connector_id: "ynab",
    connector_instance_id: "cin_ynab",
    stream: "transactions",
    record_key: `${page}-${i}`,
    emitted_at: new Date(BASE_MS - (bandStartDays + i) * DAY_MS).toISOString(),
    data: { title: `${page}-${i}` },
  }));
}

function timelinePage(records: ExploreTimelineRecord[], nextCursor: string | null): ExploreTimelinePage {
  return {
    object: "list",
    data: records,
    has_more: nextCursor !== null,
    next_cursor: nextCursor,
    snapshot_at: SNAPSHOT_AT,
    new_since_snapshot: 0,
  };
}

/** A page-1 response carrying an Upcoming head + true total + the first upcoming cursor. */
function timelinePageWithUpcoming(
  records: ExploreTimelineRecord[],
  upcoming: ExploreTimelineRecord[],
  upcomingTotal: number,
  upcomingNextCursor: string | null
): ExploreTimelinePage {
  return {
    object: "list",
    data: records,
    has_more: false,
    next_cursor: null,
    snapshot_at: SNAPSHOT_AT,
    new_since_snapshot: 0,
    upcoming,
    upcoming_total: upcomingTotal,
    upcoming_next_cursor: upcomingNextCursor,
    upcoming_has_more: upcomingNextCursor !== null,
  };
}

/** An upcoming-only page (the route's response when `upcoming_cursor` is present). */
function upcomingPage(upcoming: ExploreTimelineRecord[], upcomingNextCursor: string | null): ExploreTimelinePage {
  return {
    object: "list",
    data: [],
    has_more: false,
    next_cursor: null,
    snapshot_at: SNAPSHOT_AT,
    new_since_snapshot: 0,
    upcoming,
    upcoming_total: 0,
    upcoming_next_cursor: upcomingNextCursor,
    upcoming_has_more: upcomingNextCursor !== null,
  };
}

/** Future-dated records (an Upcoming page): keys `${tag}-0..n`. */
function upcomingRecords(tag: string, count: number): ExploreTimelineRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    object: "timeline_record" as const,
    connector_id: "ynab",
    connector_instance_id: "cin_ynab",
    stream: "transactions",
    record_key: `${tag}-${i}`,
    emitted_at: new Date(BASE_MS + (1 + i) * DAY_MS).toISOString(), // future-side, ascending
    data: { title: `${tag}-${i}` },
  }));
}

/**
 * A fetch key distinguishes a REWIND fetch from a plain cursor fetch. The assembler
 * fetches page 1 of a non-empty trail via `{ cursor: trail[0], rewindToFirstPage:
 * true }`, and pages 2..N via `{ cursor: trail[i] }`. The fake keys on both so a
 * rewind of `c1` can return DIFFERENT data than a plain fetch of `c1` — that is the
 * crux of the rewind regression (rewind(c1) = page 1; plain c1 = page 2).
 */
function fetchKey(cursor: string | null, rewind: boolean): string {
  return `${rewind ? "rewind:" : "cursor:"}${cursor ?? "<null>"}`;
}

/** Distinct key for an upcoming-only fetch (the route's `upcoming_cursor` path). */
function upcomingFetchKey(upcomingCursor: string): string {
  return `upcoming:${upcomingCursor}`;
}

const notStubbed = () => Promise.reject(new Error("not stubbed"));

/**
 * Fake data source whose listExploreTimeline returns a distinct page per fetch key.
 * Records the keys it was called with so the test can assert the fetch plan order.
 */
function makeTrailDataSource(pages: Map<string, ExploreTimelinePage>, capturedKeys: string[]) {
  return {
    kind: "live",
    aggregateRecordsByTime: notStubbed,
    listExploreRecordBuckets: notStubbed,
    listConnectorSummaries: () => Promise.resolve({ object: "list" as const, data: [ynabSummary()], has_more: false }),
    listConnectorManifests: () => Promise.resolve([ynabManifest()]),
    listExploreTimeline: (opts): Promise<ExploreTimelinePage> => {
      // An upcoming-cursor fetch pages ONLY the future set; key it distinctly.
      const key = opts?.upcomingCursor
        ? upcomingFetchKey(opts.upcomingCursor)
        : fetchKey(opts?.cursor ?? null, Boolean(opts?.rewindToFirstPage));
      capturedKeys.push(key);
      const page = pages.get(key);
      if (!page) {
        return Promise.reject(new Error(`unexpected fetch: ${key}`));
      }
      return Promise.resolve(page);
    },
    getStreamMetadata: (_c: string, stream: string): Promise<StreamMetadata> =>
      Promise.resolve({ name: stream, object: "stream_metadata", field_capabilities: {} }),
    queryRecords: (): Promise<RecordsPage> => Promise.resolve({ data: [], has_more: false, object: "list" }),
    getConnectorOverview: notStubbed,
    getDatasetSummary: notStubbed,
    getDeploymentDiagnostics: notStubbed,
    getGrantTimeline: () => Promise.resolve(null),
    getRecord: notStubbed,
    getRunTimeline: () => Promise.resolve(null),
    getTraceTimeline: () => Promise.resolve(null),
    isHybridRetrievalAdvertised: () => Promise.resolve(false),
    isSemanticRetrievalAdvertised: () => Promise.resolve(false),
    listGrants: () => Promise.resolve({ object: "list" as const, data: [], has_more: false }),
    listPendingApprovals: () => Promise.resolve({ object: "list" as const, data: [], has_more: false }),
    listRuns: () => Promise.resolve({ object: "list" as const, data: [], has_more: false }),
    listStreams: () => Promise.resolve([]),
    listTraces: () => Promise.resolve({ object: "list" as const, data: [], has_more: false }),
    refSearch: () =>
      Promise.resolve({ object: "search_result" as const, traces: [], grants: [], runs: [], exact: null }),
    searchRecordsHybrid: () => Promise.resolve({ object: "list" as const, data: [], has_more: false, warnings: [] }),
    searchRecordsLexical: () => Promise.resolve({ object: "list" as const, data: [], has_more: false, warnings: [] }),
    searchRecordsSemantic: () => Promise.resolve({ object: "list" as const, data: [], has_more: false, warnings: [] }),
  } satisfies DashboardDataSource;
}

function assertNonIncreasing(feed: ReadonlyArray<{ emittedAt: string }>): void {
  const times = feed.map((e) => Date.parse(e.emittedAt));
  for (let i = 1; i < times.length; i++) {
    assert.ok((times[i] ?? 0) <= (times[i - 1] ?? 0), `feed must stay non-increasing emitted_at at index ${i}`);
  }
}

function assertNoDuplicates(
  feed: ReadonlyArray<{ connectionId: string | null; stream: string; recordId: string }>
): void {
  const keys = feed.map((e) => `${e.connectionId} ${e.stream} ${e.recordId}`);
  assert.equal(new Set(keys).size, keys.length, "feed must contain no duplicate records");
}

test("recent Load-more: single-cursor trail ACCUMULATES page 1 + page 2 (reproduce-the-bug)", async () => {
  // Page 1 is fetched via REWIND(cursor-p2); page 2 via cursor-p2 verbatim.
  const page1 = timelinePage(pageRecords("p1", 0, 32), "cursor-p2");
  const page2 = timelinePage(pageRecords("p2", 1, 5), null);
  const pages = new Map<string, ExploreTimelinePage>([
    [fetchKey("cursor-p2", true), page1],
    [fetchKey("cursor-p2", false), page2],
  ]);
  const capturedKeys: string[] = [];
  const ds = makeTrailDataSource(pages, capturedKeys);

  // Load-more appended `cursor-p2` to the trail. Anchor is the original snapshot.
  const data = await assembleExplorerData({ cursors: "cursor-p2", anchor: SNAPSHOT_AT }, ds, "https://rs.test");

  // BOTH pages present: 32 (page 1) + 5 (page 2) = 37. Pre-fix code returned only
  // the last page (5) — this assertion FAILS there.
  assert.equal(data.feed.length, 37, "accumulated feed must contain BOTH pages' records (32 + 5)");
  assert.ok(
    data.feed.some((e) => e.recordId === "p1-0"),
    "page 1 records MUST still be present (they disappeared in the bug)"
  );
  assert.ok(
    data.feed.some((e) => e.recordId === "p2-0"),
    "page 2 records must be appended"
  );
  assertNonIncreasing(data.feed);
  assertNoDuplicates(data.feed);
  // The new Load-more cursor is the LAST fetched page's next_cursor (null = end).
  assert.equal(data.nextCursor, null, "trail's last page exhausted → nextCursor null");
  // Fetch plan: page 1 = REWIND(cursor-p2), page 2 = cursor-p2.
  assert.deepEqual(
    capturedKeys,
    [fetchKey("cursor-p2", true), fetchKey("cursor-p2", false)],
    "page 1 rewinds the trail head; page 2 fetches the trail cursor"
  );
});

test("recent Load-more: 2-entry trail ACCUMULATES three pages, ordered and deduped", async () => {
  // Page 1 = REWIND(cursor-p2); page 2 = cursor-p2; page 3 = cursor-p3.
  const page1 = timelinePage(pageRecords("p1", 0, 32), "cursor-p2");
  const page2 = timelinePage(pageRecords("p2", 1, 8), "cursor-p3");
  const page3 = timelinePage(pageRecords("p3", 2, 4), null);
  const pages = new Map<string, ExploreTimelinePage>([
    [fetchKey("cursor-p2", true), page1],
    [fetchKey("cursor-p2", false), page2],
    [fetchKey("cursor-p3", false), page3],
  ]);
  const capturedKeys: string[] = [];
  const ds = makeTrailDataSource(pages, capturedKeys);

  const data = await assembleExplorerData(
    { cursors: "cursor-p2,cursor-p3", anchor: SNAPSHOT_AT },
    ds,
    "https://rs.test"
  );

  assert.equal(data.feed.length, 44, "accumulated feed must contain ALL three pages (32 + 8 + 4)");
  assert.ok(
    data.feed.some((e) => e.recordId === "p1-0"),
    "page 1 present"
  );
  assert.ok(
    data.feed.some((e) => e.recordId === "p2-0"),
    "page 2 present"
  );
  assert.ok(
    data.feed.some((e) => e.recordId === "p3-0"),
    "page 3 present"
  );
  assertNonIncreasing(data.feed);
  assertNoDuplicates(data.feed);
  assert.equal(data.nextCursor, null, "last trail page exhausted → nextCursor null");
  assert.deepEqual(
    capturedKeys,
    [fetchKey("cursor-p2", true), fetchKey("cursor-p2", false), fetchKey("cursor-p3", false)],
    "fetch plan: REWIND(cursor-p2), cursor-p2, cursor-p3"
  );
});

test("recent first load (empty trail): page 1 fetched with cursor=null, no rewind, captures fresh snapshot", async () => {
  // No trail, no anchor: this is the true first load. Page 1 MUST be fetched with
  // cursor:null and NO rewind so the endpoint captures a fresh snapshot.
  const page1 = timelinePage(pageRecords("p1", 0, 10), "cursor-p2");
  const pages = new Map<string, ExploreTimelinePage>([[fetchKey(null, false), page1]]);
  const capturedKeys: string[] = [];
  const ds = makeTrailDataSource(pages, capturedKeys);

  const data = await assembleExplorerData({}, ds, "https://rs.test");

  assert.equal(data.feed.length, 10, "first load shows page 1");
  assert.deepEqual(capturedKeys, [fetchKey(null, false)], "first load fetches cursor=null with no rewind");
  assert.equal(data.nextCursor, "cursor-p2", "page-1 next_cursor becomes the Load-more cursor");
});

test("recent Load-more: page 1 is REWOUND to the original snapshot — an after-snapshot backfill cannot displace an original row", async () => {
  // THE CORRECTED FIX (review HOLD). The page-1 → page-2 cursor `cursor-p2` encodes
  // the ORIGINAL snapshot. Two contrasting responses prove the assembler pins page 1
  // by snapshotSeq (rewind), NOT by the emitted_at proxy:
  //
  //   REWIND(cursor-p2) → the ORIGINAL page 1: [orig-newest, orig-tail]. No backfill.
  //   cursor:null       → a FRESH page-1 snapshot where an after-snapshot BACKFILL
  //                       (`backfill`, old emitted_at, INSIDE page 1's 2-row window)
  //                       has DISPLACED the original tail row `orig-tail`.
  //
  // The accumulated feed MUST equal the REWIND result for page 1: `orig-tail` present,
  // `backfill` absent. The pre-fix path (cursor:null + emitted_at <= anchor) would
  // instead inject `backfill` (its old emitted_at passes the timestamp filter) and
  // DROP `orig-tail` — the exact "Load more hides records above" displacement.
  const ORIG_NEWEST = "2026-06-10T12:00:00Z";
  const ORIG_TAIL = "2026-06-09T12:00:00Z";
  // Backfill authored BETWEEN the two originals: old enough to pass an emitted_at <=
  // anchor proxy, recent enough to land inside page 1's top-2 window and displace
  // the original tail. Ingested AFTER the snapshot → excluded by snapshotSeq.
  const BACKFILL_AT = "2026-06-09T18:00:00Z";
  const ANCHOR = "2026-06-10T12:00:00Z"; // original snapshot_at (>= every original)

  const rec = (key: string, emitted_at: string): ExploreTimelineRecord => ({
    object: "timeline_record",
    connector_id: "ynab",
    connector_instance_id: "cin_ynab",
    stream: "transactions",
    record_key: key,
    emitted_at,
    data: { title: key },
  });

  // REWIND(cursor-p2): the ORIGINAL page 1 of the snapshot — backfill correctly absent.
  const rewoundPage1: ExploreTimelinePage = {
    object: "list",
    data: [rec("orig-newest", ORIG_NEWEST), rec("orig-tail", ORIG_TAIL)],
    has_more: true,
    next_cursor: "cursor-p2",
    snapshot_at: ANCHOR,
    new_since_snapshot: 1,
  };
  // cursor:null would return THIS — a fresh snapshot where the backfill displaced the
  // original tail. If the assembler (wrongly) fetched cursor:null for page 1, this is
  // what it would see; the test must prove it does NOT use this.
  const freshDriftedPage1: ExploreTimelinePage = {
    object: "list",
    data: [rec("orig-newest", ORIG_NEWEST), rec("backfill", BACKFILL_AT)],
    has_more: true,
    next_cursor: "cursor-p2",
    snapshot_at: BACKFILL_AT,
    new_since_snapshot: 0,
  };
  // Page 2 (cursor-p2 verbatim): older originals, snapshotSeq-pinned.
  const page2: ExploreTimelinePage = {
    object: "list",
    data: [rec("orig-p2-a", "2026-06-08T12:00:00Z"), rec("orig-p2-b", "2026-06-07T12:00:00Z")],
    has_more: false,
    next_cursor: null,
    snapshot_at: ANCHOR,
    new_since_snapshot: 1,
  };

  const pages = new Map<string, ExploreTimelinePage>([
    [fetchKey("cursor-p2", true), rewoundPage1],
    [fetchKey(null, false), freshDriftedPage1],
    [fetchKey("cursor-p2", false), page2],
  ]);
  const capturedKeys: string[] = [];
  const ds = makeTrailDataSource(pages, capturedKeys);

  const data = await assembleExplorerData({ cursors: "cursor-p2", anchor: ANCHOR }, ds, "https://rs.test");

  // The original page-1 tail row is PRESENT (not displaced).
  assert.ok(
    data.feed.some((e) => e.recordId === "orig-tail"),
    "the original page-1 tail row must remain — it must NOT be displaced by an after-snapshot backfill"
  );
  // The after-snapshot backfill is ABSENT (it was never in the original snapshot).
  assert.ok(
    !data.feed.some((e) => e.recordId === "backfill"),
    "an after-snapshot backfill must NOT appear in the accumulated (snapshot-pinned) view"
  );
  // The assembler fetched page 1 via REWIND(cursor-p2) and NEVER via cursor:null.
  assert.ok(
    capturedKeys.includes(fetchKey("cursor-p2", true)),
    "page 1 must be fetched by rewinding the trail head (snapshotSeq pin)"
  );
  assert.ok(
    !capturedKeys.includes(fetchKey(null, false)),
    "page 1 must NOT be fetched with cursor:null (that captures a fresh, drifted snapshot)"
  );
  // Full feed: original page 1 (2) + page 2 (2) = 4, ordered, deduped.
  assert.equal(data.feed.length, 4, "original page 1 (2 rows) + page 2 (2 rows)");
  assertNonIncreasing(data.feed);
  assertNoDuplicates(data.feed);
});

// PERFORMANCE: the trail pages are fetched CONCURRENTLY, not serially. Each cursor
// is self-contained and snapshot-pinned, so the requests have no inter-dependency;
// serial `for await` made a deep Load-more cost N sequential 150-way merges (slower
// the further you page). This pins that they dispatch together via a barrier: the
// fake does not resolve any fetch until ALL expected fetches are in flight. Serial
// code would await the first fetch before dispatching the second -> the barrier
// never reaches 3 -> the test times out. Concurrent code dispatches all 3 at once.
test("recent Load-more: trail pages are fetched CONCURRENTLY (no serial waterfall)", async () => {
  const page1 = timelinePage(pageRecords("p1", 0, 32), "cursor-p2");
  const page2 = timelinePage(pageRecords("p2", 1, 8), "cursor-p3");
  const page3 = timelinePage(pageRecords("p3", 2, 4), null);
  const pages = new Map<string, ExploreTimelinePage>([
    [fetchKey("cursor-p2", true), page1],
    [fetchKey("cursor-p2", false), page2],
    [fetchKey("cursor-p3", false), page3],
  ]);
  const EXPECTED_FETCHES = 3;
  let inFlight = 0;
  let releaseBarrier: () => void = () => undefined;
  const barrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });

  const ds = {
    ...makeTrailDataSource(pages, []),
    listExploreTimeline: async (opts: { cursor?: string | null; rewindToFirstPage?: boolean }) => {
      inFlight += 1;
      if (inFlight >= EXPECTED_FETCHES) {
        // Last expected fetch dispatched: all are concurrently in flight. Release.
        releaseBarrier();
      }
      // Block until every expected fetch is in flight. Serial code never gets here
      // for the 2nd/3rd fetch (it awaits this one first) -> deadlock -> timeout.
      await barrier;
      const page = pages.get(fetchKey(opts?.cursor ?? null, Boolean(opts?.rewindToFirstPage)));
      if (!page) {
        throw new Error("unexpected fetch");
      }
      return page;
    },
  } as unknown as DashboardDataSource;

  // If the assembler fetched serially, this await would never resolve (the barrier
  // needs all 3 in flight, but fetch 1 blocks before fetch 2 is dispatched).
  const data = await assembleExplorerData(
    { cursors: "cursor-p2,cursor-p3", anchor: SNAPSHOT_AT },
    ds,
    "https://rs.test"
  );

  assert.equal(inFlight, EXPECTED_FETCHES, "all trail pages must be dispatched concurrently");
  assert.equal(data.feed.length, 44, "accumulated feed still has all three pages (32 + 8 + 4)");
  assertNonIncreasing(data.feed);
  assertNoDuplicates(data.feed);
});

// ─── Upcoming (future) trail: count==reachability ("188 upcoming, all reachable") ──

test("Upcoming first load: page 1 carries the head + true total + the first upcoming cursor", async () => {
  // Page 1 has a 4-row upcoming head, a TRUE total of 12, and more to reach.
  const page1 = timelinePageWithUpcoming(pageRecords("p1", 0, 5), upcomingRecords("u1", 4), 12, "ucursor-2");
  const pages = new Map<string, ExploreTimelinePage>([[fetchKey(null, false), page1]]);
  const ds = makeTrailDataSource(pages, []);

  const data = await assembleExplorerData({}, ds, "https://rs.test");

  assert.equal(data.upcomingTotal, 12, "the pill shows the TRUE upcoming total (not the 4-row head)");
  assert.equal(data.upcoming.length, 4, "only the head is loaded on first paint");
  assert.equal(data.upcomingNextCursor, "ucursor-2", "page 1 carries the first upcoming cursor");
  assert.equal(data.upcomingHasMore, true, "more upcoming records are reachable");
});

test("Upcoming Load-more: the ucursors trail CONCATENATES the future set toward exhaustion", async () => {
  // Head (page 1) = u1-0..3; trail page ucursor-2 = u2-0..3 (more); ucursor-3 = u3-0..1 (end).
  const page1 = timelinePageWithUpcoming(pageRecords("p1", 0, 5), upcomingRecords("u1", 4), 10, "ucursor-2");
  const up2 = upcomingPage(upcomingRecords("u2", 4), "ucursor-3");
  const up3 = upcomingPage(upcomingRecords("u3", 2), null);
  const pages = new Map<string, ExploreTimelinePage>([
    [fetchKey(null, false), page1],
    [upcomingFetchKey("ucursor-2"), up2],
    [upcomingFetchKey("ucursor-3"), up3],
  ]);
  const capturedKeys: string[] = [];
  const ds = makeTrailDataSource(pages, capturedKeys);

  // The owner clicked "Load more upcoming" twice → ucursors trail = [ucursor-2, ucursor-3].
  const data = await assembleExplorerData({ ucursors: "ucursor-2,ucursor-3" }, ds, "https://rs.test");

  // All 10 upcoming records reachable (4 head + 4 + 2), deduped, none lost.
  assert.equal(data.upcoming.length, 10, "the whole upcoming set is reachable across the trail (4+4+2)");
  for (const tag of ["u1-0", "u2-0", "u3-0", "u3-1"]) {
    assert.ok(
      data.upcoming.some((e) => e.recordId === tag),
      `upcoming record ${tag} must be reachable (the 188->32 fix)`
    );
  }
  const ids = data.upcoming.map((e) => `${e.connectionId} ${e.stream} ${e.recordId}`);
  assert.equal(new Set(ids).size, ids.length, "no duplicate upcoming records across the trail");
  // The reachability handle reflects the LAST page: exhausted → no further cursor.
  assert.equal(data.upcomingNextCursor, null, "the last upcoming page is exhausted → no next cursor");
  assert.equal(data.upcomingHasMore, false, "no more upcoming records after the final page");
  // The upcoming pages were fetched via the upcoming-cursor path (not the feed path).
  assert.ok(capturedKeys.includes(upcomingFetchKey("ucursor-2")), "fetched upcoming page ucursor-2");
  assert.ok(capturedKeys.includes(upcomingFetchKey("ucursor-3")), "fetched upcoming page ucursor-3");
});

test("Upcoming dedupe: space-containing keys that COLLIDE under a join are kept distinct (JSON.stringify identity)", async () => {
  // Genuine ambiguity for a space-join identity, both on the SAME registered
  // connection (cin_ynab) so the instance filter keeps both:
  //   A: stream "transactions",   key "x y"  → join " " = "cin_ynab transactions x y"
  //   B: stream "transactions x",  key "y"    → join " " = "cin_ynab transactions x y"
  // A single-space join smears these into ONE identity and DROPS one record;
  // JSON.stringify(["cin_ynab","transactions","x y"]) !=
  // JSON.stringify(["cin_ynab","transactions x","y"]) keeps both.
  const rec = (stream: string, key: string): ExploreTimelineRecord => ({
    object: "timeline_record",
    connector_id: "ynab",
    connector_instance_id: "cin_ynab",
    stream,
    record_key: key,
    emitted_at: new Date(BASE_MS + DAY_MS).toISOString(),
    data: { title: `${stream}/${key}` },
  });
  const page1 = timelinePageWithUpcoming(pageRecords("p1", 0, 1), [rec("transactions", "x y")], 2, "ucursor-2");
  const up2 = upcomingPage([rec("transactions x", "y")], null);
  const pages = new Map<string, ExploreTimelinePage>([
    [fetchKey(null, false), page1],
    [upcomingFetchKey("ucursor-2"), up2],
  ]);
  const ds = makeTrailDataSource(pages, []);

  const data = await assembleExplorerData({ ucursors: "ucursor-2" }, ds, "https://rs.test");

  // A join-by-space identity would have collided these and kept only one (length 1).
  assert.equal(data.upcoming.length, 2, "colliding space-delimited tuples must NOT smear into one (both kept)");
  assert.ok(
    data.upcoming.some((e) => e.stream === "transactions" && e.recordId === "x y"),
    "the (transactions, 'x y') record survives"
  );
  assert.ok(
    data.upcoming.some((e) => e.stream === "transactions x" && e.recordId === "y"),
    "the (transactions x, 'y') record survives — not dropped by a join collision"
  );
});

test("Upcoming first load: page 1 requests a LARGE upcoming head (not the 32-row feed cap)", async () => {
  // The bounded future set should be revealed on first expand, so page 1 must ask
  // for a large upcoming head via upcomingLimit — NOT the 32-row feed page size that
  // forced repeated load-more (the 32→64 tedium Tim hit).
  const page1 = timelinePageWithUpcoming(pageRecords("p1", 0, 5), upcomingRecords("u1", 50), 188, "ucursor-2");
  const captured: Array<number | undefined> = [];
  const ds = {
    ...makeTrailDataSource(new Map([[fetchKey(null, false), page1]]), []),
    listExploreTimeline: (opts: { upcomingLimit?: number; upcomingCursor?: string | null }) => {
      captured.push(opts?.upcomingLimit);
      return Promise.resolve(page1);
    },
  } as unknown as DashboardDataSource;

  const data = await assembleExplorerData({}, ds, "https://rs.test");

  // Page 1 was asked for a large upcoming head, well above the 32-row feed cap.
  assert.ok(
    captured.some((n) => typeof n === "number" && n >= 188),
    `page 1 must request a large upcomingLimit (>=188); got ${JSON.stringify(captured)}`
  );
  assert.equal(data.upcomingTotal, 188, "true total carried");
  assert.equal(data.upcoming.length, 50, "the large head is loaded on first paint");
});

test("Upcoming trail mid-walk: a non-null last cursor keeps Load-more available", async () => {
  // Head + one trail page that still has more → has_more stays true.
  const page1 = timelinePageWithUpcoming(pageRecords("p1", 0, 5), upcomingRecords("u1", 4), 50, "ucursor-2");
  const up2 = upcomingPage(upcomingRecords("u2", 4), "ucursor-3");
  const pages = new Map<string, ExploreTimelinePage>([
    [fetchKey(null, false), page1],
    [upcomingFetchKey("ucursor-2"), up2],
  ]);
  const ds = makeTrailDataSource(pages, []);

  const data = await assembleExplorerData({ ucursors: "ucursor-2" }, ds, "https://rs.test");

  assert.equal(data.upcoming.length, 8, "head + one trail page loaded (4 + 4)");
  assert.equal(data.upcomingTotal, 50, "the true total is carried from page 1, stable across the walk");
  assert.equal(data.upcomingNextCursor, "ucursor-3", "still more to reach → the next upcoming cursor is offered");
  assert.equal(data.upcomingHasMore, true, "Load-more upcoming stays available mid-walk");
});
