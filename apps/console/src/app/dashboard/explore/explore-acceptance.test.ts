/**
 * Explore acceptance invariants — P1 escape ramps, P2 Option D escape, P3 cursor.
 *
 * Three suites:
 *
 *  P1 invariants (source-code assertions on explore-canvas.tsx):
 *    (a) No "(window capped)" or silent-cap string anywhere in the canvas.
 *    (b) streamSeeAllLinks is read and rendered in the canvas (not silently dropped).
 *    (c) Each link goes to the per-stream records route (encodes connectionId + stream).
 *
 *  P3 invariants:
 *    (a) Day-group ("rr-x-day") and burst-collapse ("rr-x-burst") class names exist
 *        in the canvas source — they are the rendered grouping structure.
 *    (b) Feed Load-more cursor advances via the real endpoint: assembler returns a
 *        non-null nextCursor when the endpoint reports has_more=true, and null when
 *        the endpoint reports has_more=false (end of feed).
 *
 *  P2 invariants:
 *    (a) Sort toggle re-orders the same set — count identical across "relevance" and
 *        "recent" orderings.
 *    (b) The labeled escape "Browse all matching records, newest first" exists in the
 *        canvas source and links to the chronological surface (search_sort=recent).
 *    (c) Lexical Load-more forwards the cursor to the next assembler call.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assembleExplorerData } from "@pdpp/operator-ui/explore/explore-data-assembler";
import type { DashboardDataSource } from "@pdpp/operator-ui/lib/data-source";
import type { ExploreTimelinePage, ListResponse, RefConnectorSummary } from "@pdpp/operator-ui/lib/ref-client";
import type {
  ConnectorManifest,
  RecordsPage,
  SearchResultHit,
  SearchResultPage,
} from "@pdpp/operator-ui/lib/rs-client";

// ─── File paths ───────────────────────────────────────────────────────────────

const REPO_ROOT = new URL("../../../../../../", import.meta.url);
const CANVAS_FILE = fileURLToPath(new URL("apps/console/src/app/dashboard/explore/explore-canvas.tsx", REPO_ROOT));
// The pure href builders (`buildHref`, `buildNavigateHref`, …) live in the
// no-React navigation module; the canvas imports them. URL-shape assertions read
// from here, behavioral wiring (`buildSearchSortHref`) stays in the canvas.
const NAV_FILE = fileURLToPath(new URL("apps/console/src/app/dashboard/explore/explore-navigation.ts", REPO_ROOT));

// ─── Source-assertion patterns (top-level so they compile once) ─────────────────
const STREAM_SEE_ALL_LINKS_READ_RE = /data\.streamSeeAllLinks/;
const STREAM_SEE_ALL_COMPONENT_RE = /StreamSeeAllLink/;
const STREAM_SEE_ALL_VIA_HELPER_RE =
  /function StreamSeeAllLink\(\{[\s\S]*buildStreamRecordsHref\(recordsBasePath, \{[\s\S]*connectionId: link\.connectionId,[\s\S]*stream: link\.stream,/;
const ENCODES_ROUTE_ID_RE = /encodeURIComponent\(routeId\)/;
const ENCODES_STREAM_RE = /encodeURIComponent\(subject\.stream\)/;
const RECORDS_BASE_PATH_RE = /recordsBasePath/;
const DAY_GROUP_CLASS_RE = /rr-x-day/;
const BURST_CLASS_RE = /rr-x-burst/;
const BROWSE_ALL_MATCHING_RE = /Browse all matching records, newest first/;
const BUILD_SEARCH_SORT_HREF_RECENT_RE = /buildSearchSortHref\(["']recent["']\)/;
const SEARCH_SORT_THREADED_RE = /searchSort,\s*\}\),\s*\[/;
const SEARCH_SORT_PARAM_RE =
  /opts\.searchSort === ["']recent["'][\s\S]*params\.set\(["']search_sort["'], ["']recent["']\)/;

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeSummary(over: {
  connection_id: string;
  connector_id: string;
  streams?: string[];
  display_name?: string;
}): RefConnectorSummary {
  return {
    connection_health: {} as RefConnectorSummary["connection_health"],
    connection_id: over.connection_id,
    connector_id: over.connector_id,
    display_name: over.display_name ?? over.connection_id,
    freshness: {},
    last_run: null,
    last_successful_run: null,
    manifest_version: null,
    next_action: null,
    schedule: null,
    streams: over.streams ?? ["records"],
    total_records: 0,
  };
}

function makeManifest(connectorId: string, streams: string[] = ["records"]): ConnectorManifest {
  return {
    connector_id: connectorId,
    streams: streams.map((name) => ({ name })),
  };
}

function summaryListResponse(summaries: RefConnectorSummary[]): ListResponse<RefConnectorSummary> {
  return { data: summaries, has_more: false, object: "list" };
}

function makeHit(over: {
  connector_id: string;
  stream?: string;
  record_key?: string;
  connection_id?: string;
}): SearchResultHit {
  return {
    connector_id: over.connector_id,
    connection_id: over.connection_id,
    stream: over.stream ?? "records",
    record_key: over.record_key ?? "rec-1",
    emitted_at: "2026-01-01T00:00:00Z",
    matched_fields: [],
    object: "search_result",
  };
}

function makeLexicalPage(
  hits: SearchResultHit[],
  opts?: { has_more?: boolean; next_cursor?: string; recallComplete?: boolean }
): SearchResultPage {
  return {
    data: hits,
    has_more: opts?.has_more ?? false,
    ...(opts?.next_cursor ? { next_cursor: opts.next_cursor } : {}),
    // Recall disclosure (disclose-lexical-recall-windows): the exhaustive
    // keyword_pageable descriptor + deep cursor pagination are sound only when
    // the ranker proved full-corpus recall. Default (omitted) is a bounded
    // candidate window → honestly relevance_bounded (a sample).
    ...(opts?.recallComplete
      ? { count_accuracy: "exact" as const, recall: { complete: true, ranking_scope: "all_matches" as const } }
      : {}),
    object: "list",
  };
}

function makeRecordsPage(ids: string[], opts?: { has_more?: boolean; next_cursor?: string }): RecordsPage {
  return {
    data: ids.map((id) => ({
      id,
      object: "record" as const,
      stream: "transactions",
      emitted_at: "2026-01-01T00:00:00Z",
      data: {},
    })),
    has_more: opts?.has_more ?? false,
    ...(opts?.next_cursor ? { next_cursor: opts.next_cursor } : {}),
    object: "list",
  };
}

function makeTimelinePage(
  count: number,
  opts: { has_more: boolean; next_cursor?: string; snapshot_at?: string }
): ExploreTimelinePage {
  return {
    data: Array.from({ length: count }, (_, i) => ({
      object: "timeline_record" as const,
      connector_id: "ynab",
      connector_instance_id: `cin_ynab_stub_${i}`,
      stream: "transactions",
      record_key: `rec-${i}`,
      emitted_at: `2026-01-0${i + 1}T00:00:00Z`,
      data: {},
    })),
    has_more: opts.has_more,
    next_cursor: opts.next_cursor ?? null,
    object: "list",
    snapshot_at: opts.snapshot_at ?? "2026-06-19T00:00:00Z",
    new_since_snapshot: 0,
  };
}

const notStubbed = () => Promise.reject(new Error("not stubbed"));

function makeDataSource(overrides: Partial<DashboardDataSource>): DashboardDataSource {
  return {
    kind: "sandbox" as const,
    aggregateRecordsByTime: notStubbed,
    isHybridRetrievalAdvertised: () => Promise.resolve(false),
    isSemanticRetrievalAdvertised: () => Promise.resolve(false),
    listConnectorSummaries: notStubbed,
    listConnectorManifests: notStubbed,
    searchRecordsLexical: notStubbed,
    searchRecordsHybrid: notStubbed,
    searchRecordsSemantic: notStubbed,
    queryRecords: notStubbed,
    getRecord: notStubbed,
    getConnectorOverview: notStubbed,
    getStreamMetadata: notStubbed,
    getTraceTimeline: notStubbed,
    getGrantTimeline: notStubbed,
    getRunTimeline: notStubbed,
    getDatasetSummary: notStubbed,
    getDeploymentDiagnostics: notStubbed,
    listGrants: notStubbed,
    listPendingApprovals: notStubbed,
    listRuns: notStubbed,
    listStreams: notStubbed,
    listTraces: notStubbed,
    refSearch: notStubbed,
    listExploreTimeline: () =>
      Promise.resolve({
        object: "list" as const,
        data: [],
        has_more: false,
        next_cursor: null,
        snapshot_at: new Date(0).toISOString(),
        new_since_snapshot: 0,
      }),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// P1: Escape ramp invariants
// ═══════════════════════════════════════════════════════════════════════════════

test("P1 invariant: no '(window capped)' or silent-cap string in explore-canvas.tsx", async () => {
  const src = await readFile(CANVAS_FILE, "utf8");
  assert.ok(
    !src.includes("(window capped)"),
    "explore-canvas.tsx must not contain '(window capped)' — this is a spec-forbidden silent truncation message"
  );
  // Also verify no 'silently' qualification attached to a cap
  assert.ok(!src.includes("silently capped"), "explore-canvas.tsx must not describe truncation as silent to the owner");
});

test("P1 invariant: a burst does not present its loaded count as a complete day-total (count==reachability)", async () => {
  const src = await readFile(CANVAS_FILE, "utf8");
  // The burst expand affordance must NOT say "show all" — that implied the loaded
  // count was the complete (connection, stream, day) total. The honest label is
  // "in view" + "expand", since the true day-total needs a server per-burst count.
  assert.ok(
    !src.includes("show all ↓"),
    "burst row must not use 'show all ↓' — it falsely implies the loaded count is the complete group total"
  );
  assert.ok(
    src.includes("rr-x-burst__inview"),
    "burst row must qualify its count as loaded ('in view'), not a claimed day-total"
  );
});

test("P1 invariant: the Upcoming section paginates to exhaustion (the 188->32 reachability fix)", async () => {
  const src = await readFile(CANVAS_FILE, "utf8");
  // count==reachability: the future set is walked via a real "Load more upcoming"
  // wired to the upcoming cursor — NOT a capped head presented as complete.
  assert.ok(
    src.includes("onLoadMoreUpcoming") && src.includes("appendUpcomingCursor"),
    "Upcoming must offer a load-more wired to the upcoming cursor (reach all N, not a capped head)"
  );
  assert.ok(
    src.includes("upcomingNextCursor") && src.includes("upcomingHasMore"),
    "Upcoming reachability must be driven by the server's upcoming_next_cursor / has_more"
  );
});

test("P1 invariant: streamSeeAllLinks is read and rendered in explore-canvas.tsx", async () => {
  const src = await readFile(CANVAS_FILE, "utf8");
  // The data property must be accessed
  assert.match(
    src,
    STREAM_SEE_ALL_LINKS_READ_RE,
    "canvas must read data.streamSeeAllLinks (was unrendered in first build)"
  );
  // A render element for each link must exist (StreamSeeAllLink component or equivalent)
  assert.match(
    src,
    STREAM_SEE_ALL_COMPONENT_RE,
    "canvas must render a StreamSeeAllLink component for each bounded stream"
  );
});

test("P1 invariant: each See-all link routes through the shared complete-stream helper", async () => {
  const src = await readFile(CANVAS_FILE, "utf8");
  // The branch's inline See-all encoder was UNIFIED with main's complete-stream
  // link: StreamSeeAllLink now routes through `buildStreamRecordsHref`, the one
  // helper (over `buildCompleteStreamHref`) that every escape ramp shares. That
  // helper encodes the connectionId/connector route segment and the stream
  // segment internally — one escape ramp, never two competing encoders.
  assert.match(
    src,
    STREAM_SEE_ALL_VIA_HELPER_RE,
    "StreamSeeAllLink must build its href via the shared buildStreamRecordsHref helper from link identity"
  );
  // The shared helper resolves to the per-stream records path and encodes both
  // the route id (connection or connector) and the stream segment.
  const controlState = await readFile(new URL("./explore-control-state.ts", import.meta.url), "utf8");
  assert.match(
    controlState,
    ENCODES_ROUTE_ID_RE,
    "the complete-stream helper must encode the connection/connector route segment"
  );
  assert.match(controlState, ENCODES_STREAM_RE, "the complete-stream helper must encode the stream segment");
  // The link still bases on the per-stream records path (not the explore path).
  assert.match(src, RECORDS_BASE_PATH_RE, "StreamSeeAllLink must use recordsBasePath as its route base");
});

test("P1 assembler: streamSeeAllLinks is non-empty when the time-range fan-out has bounded streams", async () => {
  // The recent lens is now the exhaustive merged-timeline endpoint, so the
  // per-stream "See all" ramps live on the still-bounded TIME-RANGE lens. Drive
  // it by passing a since/until window; the fan-out streams with has_more=true
  // produce the ramps.
  const summary = makeSummary({ connection_id: "ynab-1", connector_id: "ynab", streams: ["transactions"] });
  const ds = makeDataSource({
    listConnectorSummaries: async () => summaryListResponse([summary]),
    // The time-range fan-out requires a consent_time_field on the stream so
    // timeRangeStreamTargets includes it. The base makeManifest helper does not
    // set this field; provide an explicit manifest here with it declared.
    listConnectorManifests: async () =>
      [
        {
          connector_id: "ynab",
          streams: [{ name: "transactions", consent_time_field: "date" }],
        },
      ] satisfies ConnectorManifest[],
    // Time-range fan-out: queryRecords returns has_more=true so the see-all ramp fires.
    queryRecords: async () =>
      makeRecordsPage(["rec-1", "rec-2", "rec-3", "rec-4", "rec-5", "rec-6"], { has_more: true }),
    // The recent lens would call this; it is irrelevant here (time-range lens),
    // but provide a valid empty page rather than throwing.
    listExploreTimeline: async () => ({
      object: "list" as const,
      data: [],
      has_more: false,
      next_cursor: null,
      snapshot_at: new Date(0).toISOString(),
      new_since_snapshot: 0,
    }),
  });

  const result = await assembleExplorerData(
    { since: "2026-01-01T00:00:00.000Z", until: "2026-12-31T23:59:59.000Z" },
    ds,
    "https://rs.test"
  );

  assert.ok(
    result.streamSeeAllLinks.length > 0,
    "streamSeeAllLinks must be non-empty when a time-range fan-out stream has has_more=true"
  );
  const link = result.streamSeeAllLinks[0];
  assert.equal(link?.connectionId, "ynab-1", "see-all link must carry the correct connectionId");
  assert.equal(link?.stream, "transactions", "see-all link must carry the correct stream");
});

// ═══════════════════════════════════════════════════════════════════════════════
// P3: Day-group render structure + cursor advance invariants
// ═══════════════════════════════════════════════════════════════════════════════

test("P3 invariant: day-group (rr-x-day) and burst-collapse (rr-x-burst) class names exist in canvas", async () => {
  const src = await readFile(CANVAS_FILE, "utf8");
  assert.match(src, DAY_GROUP_CLASS_RE, "canvas must render day-group elements with class 'rr-x-day'");
  assert.match(src, BURST_CLASS_RE, "canvas must render burst-collapse elements with class 'rr-x-burst'");
});

test("P3 Load-more cursor: assembler returns non-null nextCursor when real endpoint has_more=true", async () => {
  const summary = makeSummary({ connection_id: "ynab-1", connector_id: "ynab", streams: ["transactions"] });
  const ds = makeDataSource({
    listConnectorSummaries: async () => summaryListResponse([summary]),
    listConnectorManifests: async () => [makeManifest("ynab", ["transactions"])],
    // Real endpoint: returns has_more=true with a real composite cursor
    listExploreTimeline: async () => makeTimelinePage(32, { has_more: true, next_cursor: "composite-cursor-p2" }),
  });

  const result = await assembleExplorerData({}, ds, "https://rs.test");

  assert.equal(result.fromSearch, false);
  assert.ok(result.nextCursor !== null, "nextCursor must be non-null when endpoint reports has_more=true");
  assert.equal(result.nextCursor, "composite-cursor-p2", "nextCursor must equal the endpoint's next_cursor");
  assert.ok(result.feed.length > 0, "feed must be non-empty");
});

test("P3 Load-more cursor: assembler returns null nextCursor when real endpoint has_more=false (end of feed)", async () => {
  const summary = makeSummary({ connection_id: "ynab-1", connector_id: "ynab", streams: ["transactions"] });
  const ds = makeDataSource({
    listConnectorSummaries: async () => summaryListResponse([summary]),
    listConnectorManifests: async () => [makeManifest("ynab", ["transactions"])],
    listExploreTimeline: async () => makeTimelinePage(5, { has_more: false, snapshot_at: "2026-06-19T00:00:00Z" }),
  });

  const result = await assembleExplorerData({}, ds, "https://rs.test");

  assert.equal(result.nextCursor, null, "nextCursor must be null when feed is exhausted");
  assert.equal(result.snapshotAnchor, "2026-06-19T00:00:00Z", "snapshotAnchor must be the endpoint's snapshot_at");
});

test("P3 Load-more trail: second page ACCUMULATES (page 1 stays, page 2 appended, deduped, ordered)", async () => {
  // Load-more must APPEND, not REPLACE: the recent lens reads the `cursors` TRAIL
  // and concatenates page 1 with each trail cursor's page. Page 1 is RE-RENDERED via
  // REWIND of the trail head (cursor = the page-1 → page-2 cursor, rewindToFirstPage),
  // so it is pinned to the SAME original snapshot as page 2 (snapshotSeq, not
  // emitted_at). This is the fix for the "records above disappear" bug — the prior
  // single-`cursor` REPLACE is gone, and the corrected snapshot pin (Codex HOLD).
  const summary = makeSummary({ connection_id: "ynab-1", connector_id: "ynab", streams: ["transactions"] });
  // Distinct, non-overlapping, strictly-descending pages via absolute day offsets:
  // page 1 is the newest band, page 2 a strictly-older band (no calendar overflow).
  const baseMs = Date.parse("2026-06-01T00:00:00Z");
  const dayMs = 24 * 60 * 60 * 1000;
  // Snapshot newer than every record so the page-1 filter keeps the whole snapshot.
  const PAGE1_SNAPSHOT = "2026-12-31T00:00:00Z";
  const mkRecord = (page: string, i: number, dayOffset: number) => ({
    object: "timeline_record" as const,
    connector_id: "ynab",
    connector_instance_id: "ynab-1",
    stream: "transactions",
    record_key: `${page}-${i}`,
    emitted_at: new Date(baseMs - dayOffset * dayMs).toISOString(),
    data: {},
  });
  const page1Records = Array.from({ length: 32 }, (_, i) => mkRecord("p1", i, i));
  const page2Records = Array.from({ length: 3 }, (_, i) => mkRecord("p2", i, 100 + i));
  const page1: ExploreTimelinePage = {
    object: "list",
    data: page1Records,
    has_more: true,
    next_cursor: "composite-cursor-p2",
    snapshot_at: PAGE1_SNAPSHOT,
    new_since_snapshot: 0,
  };
  const page2: ExploreTimelinePage = {
    object: "list",
    data: page2Records,
    has_more: false,
    next_cursor: null,
    snapshot_at: PAGE1_SNAPSHOT,
    new_since_snapshot: 0,
  };
  // Capture each fetch as `${rewind ? "rewind:" : "cursor:"}${cursor}` so we can
  // assert the fetch plan distinguishes a REWIND of the trail head (page 1) from a
  // plain fetch of the same cursor (page 2).
  const capturedFetches: string[] = [];
  const ds = makeDataSource({
    listConnectorSummaries: async () => summaryListResponse([summary]),
    listConnectorManifests: async () => [makeManifest("ynab", ["transactions"])],
    listExploreTimeline: (opts) => {
      const cursor = opts?.cursor ?? null;
      const rewind = Boolean(opts?.rewindToFirstPage);
      capturedFetches.push(`${rewind ? "rewind:" : "cursor:"}${cursor ?? "<null>"}`);
      // Page 1 = REWIND(composite-cursor-p2) OR the very first load (cursor=null).
      // Page 2 = a plain (non-rewind) fetch of composite-cursor-p2.
      if (cursor === "composite-cursor-p2" && !rewind) {
        return Promise.resolve(page2);
      }
      return Promise.resolve(page1);
    },
  });

  // Page 1: no trail.
  const firstLoad = await assembleExplorerData({}, ds, "https://rs.test");
  assert.equal(firstLoad.nextCursor, "composite-cursor-p2");
  assert.equal(firstLoad.feed.length, 32, "first load shows page 1 only");
  const firstSnapshot = firstLoad.snapshotAnchor;
  assert.ok(firstSnapshot, "first load must establish a snapshot anchor");

  // Page 2: append the page-1 cursor to the trail (Load more), forwarding the anchor.
  const accumulated = await assembleExplorerData(
    { cursors: "composite-cursor-p2", anchor: firstSnapshot ?? undefined },
    ds,
    "https://rs.test"
  );
  // ACCUMULATE: both pages present (32 + 3), deduped, page 1 still on top.
  assert.equal(accumulated.feed.length, 35, "accumulated feed must contain BOTH pages (32 + 3)");
  assert.equal(accumulated.nextCursor, null, "trail's last page exhausted → nextCursor null");
  // Page 1 records still visible (the bug was that they disappeared).
  assert.ok(
    accumulated.feed.some((e) => e.recordId === "p1-0"),
    "page 1 records must STILL be present after Load more (append, not replace)"
  );
  assert.ok(
    accumulated.feed.some((e) => e.recordId === "p2-0"),
    "page 2 records must be appended below page 1"
  );
  // Non-increasing emitted_at across the concatenation; no duplicates.
  const times = accumulated.feed.map((e) => Date.parse(e.emittedAt));
  for (let i = 1; i < times.length; i++) {
    assert.ok((times[i] ?? 0) <= (times[i - 1] ?? 0), "feed must stay non-increasing emitted_at");
  }
  const ids = accumulated.feed.map((e) => `${e.connectionId} ${e.stream} ${e.recordId}`);
  assert.equal(new Set(ids).size, ids.length, "no duplicate records across pages");

  // Fetch plan: first load = cursor:null (fresh snapshot); accumulate = REWIND the
  // trail head for page 1 (original-snapshot pin), then the trail cursor for page 2.
  assert.equal(capturedFetches[0], "cursor:<null>", "first load: cursor=null, no rewind (fresh snapshot)");
  assert.equal(
    capturedFetches[1],
    "rewind:composite-cursor-p2",
    "accumulate: page 1 re-rendered by REWINDING the trail head (snapshotSeq pin, not cursor=null)"
  );
  assert.equal(
    capturedFetches[2],
    "cursor:composite-cursor-p2",
    "accumulate: trail cursor fetched verbatim for page 2"
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// P2 Option D: Sort toggle + labeled escape invariants
// ═══════════════════════════════════════════════════════════════════════════════

test("P2 Option D invariant: 'Browse all matching records, newest first' escape exists in canvas", async () => {
  const src = await readFile(CANVAS_FILE, "utf8");
  assert.match(src, BROWSE_ALL_MATCHING_RE, "canvas must contain the labeled chronological escape per Option D spec");
});

test("P2 Option D invariant: escape links to search_sort=recent in the URL builder", async () => {
  const src = await readFile(CANVAS_FILE, "utf8");
  // The chronological escape href is built by `buildSearchSortHref("recent")`,
  // which routes the recent sort into `buildHref({ searchSort })`. Assert both
  // the call (the escape ramps use it) and that the builder threads searchSort
  // through to the `search_sort=recent` URL param.
  assert.match(src, BUILD_SEARCH_SORT_HREF_RECENT_RE, "Option D escape must link via buildSearchSortHref('recent')");
  assert.match(src, SEARCH_SORT_THREADED_RE, "buildSearchSortHref must thread searchSort into the href builder");
  // buildHref now lives in the pure navigation module; assert the search_sort=recent
  // URL wiring there.
  const navSrc = await readFile(NAV_FILE, "utf8");
  assert.match(navSrc, SEARCH_SORT_PARAM_RE, "buildHref must emit search_sort=recent for the recent sort");
});

test("P2 sort toggle: lexical Most-relevant and Most-recent return same hit count (same pool)", async () => {
  const summary = makeSummary({ connection_id: "ynab-1", connector_id: "ynab", streams: ["transactions"] });
  const hit1 = makeHit({ connector_id: "ynab", stream: "transactions", record_key: "r1", connection_id: "ynab-1" });
  const hit2 = makeHit({ connector_id: "ynab", stream: "transactions", record_key: "r2", connection_id: "ynab-1" });

  // Both orderings use the same assembler data source with the same hits.
  // Most-relevant: lexical call returns the hits ranked by relevance.
  // Most-recent (single-stream): switches to queryRecords for the same stream.
  // The feed count must be the same (same pool, different ordering).
  const dsRelevance = makeDataSource({
    listConnectorSummaries: async () => summaryListResponse([summary]),
    listConnectorManifests: async () => [makeManifest("ynab", ["transactions"])],
    isHybridRetrievalAdvertised: async () => false,
    searchRecordsLexical: async () => makeLexicalPage([hit1, hit2], { has_more: false }),
  });

  const dsRecent = makeDataSource({
    listConnectorSummaries: async () => summaryListResponse([summary]),
    listConnectorManifests: async () => [makeManifest("ynab", ["transactions"])],
    isHybridRetrievalAdvertised: async () => false,
    // Most-recent detection path: lexical to find stream door
    searchRecordsLexical: async () => makeLexicalPage([hit1, hit2], { has_more: false }),
    // Then queryRecords for the same 2 records in time order
    queryRecords: async () => makeRecordsPage(["r1", "r2"], { has_more: false }),
  });

  const relevanceResult = await assembleExplorerData({ q: "rent" }, dsRelevance, "https://rs.test");
  const recentResult = await assembleExplorerData({ q: "rent", search_sort: "recent" }, dsRecent, "https://rs.test");

  assert.equal(
    relevanceResult.feed.length,
    recentResult.feed.length,
    "Most-relevant and Most-recent must return the same number of results (same pool)"
  );
  assert.equal(relevanceResult.feed.length, 2, "pool size must be 2");
});

test("P2 lexical Load-more forwards cursor (assembler advances, does not re-fetch from top)", async () => {
  const summary = makeSummary({ connection_id: "ynab-1", connector_id: "ynab", streams: ["transactions"] });
  const hit1 = makeHit({ connector_id: "ynab", stream: "transactions", record_key: "p1", connection_id: "ynab-1" });
  const hit2 = makeHit({ connector_id: "ynab", stream: "transactions", record_key: "p2", connection_id: "ynab-1" });

  const capturedCursors: (string | undefined)[] = [];
  const ds = makeDataSource({
    listConnectorSummaries: async () => summaryListResponse([summary]),
    listConnectorManifests: async () => [makeManifest("ynab", ["transactions"])],
    isHybridRetrievalAdvertised: () => Promise.resolve(false),
    searchRecordsLexical: (_q, opts) => {
      capturedCursors.push(opts?.cursor);
      // Recall proven complete: keyword_pageable, so the cursor pages exhaustively.
      return Promise.resolve(
        opts?.cursor === "lex-p2"
          ? makeLexicalPage([hit2], { has_more: false, recallComplete: true })
          : makeLexicalPage([hit1], { has_more: true, next_cursor: "lex-p2", recallComplete: true })
      );
    },
  });

  const page1 = await assembleExplorerData({ q: "coffee" }, ds, "https://rs.test");
  assert.equal(page1.searchNextCursor, "lex-p2");

  const page2 = await assembleExplorerData({ q: "coffee", cursor: "lex-p2" }, ds, "https://rs.test");
  assert.equal(page2.searchNextCursor, null, "page 2 must be exhausted");

  assert.equal(capturedCursors[0], undefined, "page 1: no cursor");
  assert.equal(capturedCursors[1], "lex-p2", "page 2: cursor must be forwarded");
});
