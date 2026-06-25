/**
 * Over-time chart SCOPE honesty — through the real `assembleExplorerData` path.
 *
 * The chart's bars come from the index-backed bucket endpoint
 * (`listExploreRecordBuckets` → `GET /_ref/explore/records/buckets`), ONE call
 * that structurally CANNOT receive a free-text query. That call is now DEFERRED:
 * `assembleExplorerData` no longer awaits the 3.6s aggregate on the server
 * critical path — it returns the COMPUTED `bucketRequest` (the scope the deferred
 * client-side `loadExploreBuckets` action will use) and the canvas loads the band
 * post-mount. So these tests assert the assembler:
 *
 *  - NEVER calls `listExploreRecordBuckets` inline (the whole perf win), and
 *  - returns a `bucketRequest` carrying the SAME structural (connection, stream)
 *    scope the feed shows — so the deferred bars reconcile with the feed. The
 *    suppression contract is unchanged, just moved off the await path:
 *
 *  1. SEARCH: a search result-set (keyword_pageable) is not an honest
 *     time-distribution. FIX: `bucketRequest` is null when `fromSearch` ⇒ no
 *     request, no chart.
 *  2. The bucket scope IS the SAME structural (connection, stream) targets the
 *     feed shows — these tests prove the assembler COMPUTES that scope onto
 *     `bucketRequest` (so the deferred call reconciles with the feed).
 *
 * The companion `loadExploreBuckets` action maps the response → `BucketSeries`
 * using the shared mapping; the mapping itself is unit-tested in
 * over-time-chart-bucket-mapping.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DashboardDataSource } from "../lib/data-source.ts";
import type { ExploreTimelinePage, ListResponse, RefConnectorSummary } from "../lib/ref-client.ts";
import type { ConnectorManifest, SearchResultHit, SearchResultPage } from "../lib/rs-client.ts";
import { assembleExplorerData } from "./explore-data-assembler.ts";

// ── Fixtures: two connections, each with a stream that DECLARES a time field ──
// (the manifest `consent_time_field` is what makes a stream a chart target).

function makeSummary(over: { connection_id: string; connector_id: string; streams?: string[] }): RefConnectorSummary {
  return {
    connection_health: {} as RefConnectorSummary["connection_health"],
    connection_id: over.connection_id,
    connector_id: over.connector_id,
    connector_instance_id: over.connection_id,
    display_name: over.connection_id,
    freshness: {},
    last_run: null,
    last_successful_run: null,
    manifest_version: null,
    next_action: null,
    schedule: null,
    streams: over.streams ?? ["transactions"],
    total_records: 0,
  } as RefConnectorSummary;
}

function summaryListResponse(summaries: RefConnectorSummary[]): ListResponse<RefConnectorSummary> {
  return { data: summaries, has_more: false, object: "list" };
}

/** A manifest whose streams DECLARE a `consent_time_field` (drives chart targets). */
function timeManifest(connectorId: string, streams: string[]): ConnectorManifest {
  return {
    connector_id: connectorId,
    streams: streams.map((name) => ({ name, consent_time_field: "occurred_at" })),
  } as ConnectorManifest;
}

const rec = (connector: string, instance: string, stream: string, key: string, day: number) => ({
  object: "timeline_record" as const,
  connector_id: connector,
  connector_instance_id: instance,
  stream,
  record_key: key,
  emitted_at: `2026-06-0${day}T00:00:00Z`,
  data: {},
});

const PAST = [rec("ynab", "cin_ynab", "transactions", "y1", 5), rec("chase", "cin_chase", "transactions", "c1", 3)];

function browsePage(): ExploreTimelinePage {
  return {
    object: "list",
    data: PAST,
    has_more: false,
    next_cursor: null,
    snapshot_at: "2026-06-19T00:00:00Z",
    new_since_snapshot: 0,
    upcoming: [],
    upcoming_total: 0,
    upcoming_has_more: false,
    upcoming_next_cursor: null,
  } as ExploreTimelinePage;
}

const notStubbed = () => Promise.reject(new Error("not stubbed"));

/**
 * A data source whose `listExploreRecordBuckets` FAILS the test if ever called.
 * The whole point of the decouple is that `assembleExplorerData` never awaits the
 * aggregate inline — it computes a `bucketRequest` instead. (The deferred call is
 * exercised by the `loadExploreBuckets` action, not the assembler.)
 */
function chartDs(opts?: {
  inlineBucketCallCount?: { value: number };
  manifests?: ConnectorManifest[];
  searchHits?: SearchResultHit[];
}): DashboardDataSource {
  return {
    kind: "sandbox" as const,
    aggregateRecordsByTime: notStubbed,
    listExploreRecordBuckets: () => {
      if (opts?.inlineBucketCallCount) {
        opts.inlineBucketCallCount.value += 1;
      }
      return Promise.reject(new Error("assembleExplorerData must NOT call listExploreRecordBuckets inline"));
    },
    isHybridRetrievalAdvertised: () => Promise.resolve(false),
    isSemanticRetrievalAdvertised: () => Promise.resolve(false),
    listConnectorSummaries: async () =>
      summaryListResponse([
        makeSummary({ connection_id: "cin_ynab", connector_id: "ynab", streams: ["transactions"] }),
        makeSummary({ connection_id: "cin_chase", connector_id: "chase", streams: ["transactions"] }),
      ]),
    listConnectorManifests: async () =>
      opts?.manifests ?? [timeManifest("ynab", ["transactions"]), timeManifest("chase", ["transactions"])],
    searchRecordsLexical: () =>
      Promise.resolve({ data: opts?.searchHits ?? [], has_more: false, object: "list" } as SearchResultPage),
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
    listExploreTimeline: () => Promise.resolve(browsePage()),
  } as DashboardDataSource;
}

// ── The decouple: the assembler NEVER awaits the bucket aggregate inline ──────

test("DECOUPLE: assembleExplorerData never calls listExploreRecordBuckets inline (it returns a bucketRequest instead)", async () => {
  const inlineBucketCallCount = { value: 0 };
  const result = await assembleExplorerData({}, chartDs({ inlineBucketCallCount }), "https://rs.test");

  assert.equal(
    inlineBucketCallCount.value,
    0,
    "the 3.6s bucket aggregate must NOT be on the first-paint critical path — the chart is loaded post-mount"
  );
  // The chart is not pre-rendered server-side anymore; the band loads client-side.
  assert.equal(result.bucketSeries, null, "bucketSeries is null from the assembler (the canvas fills it post-mount)");
  assert.ok(result.bucketRequest, "a non-search browse feed yields a deferred bucketRequest");
});

// ── (b) Non-search browse feed: bucketRequest carries the STRUCTURAL scope ──

test("BROWSE feed: bucketRequest carries the in-scope (connection, stream) targets the feed shows", async () => {
  const result = await assembleExplorerData({}, chartDs(), "https://rs.test");

  assert.equal(result.fromSearch, false, "this is the browse lens, not search");
  const request = result.bucketRequest;
  assert.ok(request, "the chart request is computed over a non-search exhaustive feed");
  // Scoped to the SAME structural (connection, stream) targets the feed shows.
  assert.deepEqual(
    [...request.connections].sort(),
    ["cin_chase", "cin_ynab"],
    "bucketRequest is scoped to the feed's connection targets (structural filter passed)"
  );
  assert.deepEqual([...request.streams].sort(), ["transactions"], "bucketRequest carries the in-scope streams");
  assert.equal(request.fromSearch, false, "the request records the browse lens");
  assert.equal(request.descriptorKind, result.descriptor.kind, "the request carries the set-descriptor kind");
});

test("BROWSE feed: bucketRequest is computed on default complete_chronological browse even when manifests are unavailable", async () => {
  const result = await assembleExplorerData({}, chartDs({ manifests: [] }), "https://rs.test");

  assert.equal(result.fromSearch, false);
  assert.equal(result.descriptor.kind, "complete_chronological");
  const request = result.bucketRequest;
  assert.ok(request, "default browse still computes the chart request without client manifest metadata");
  assert.deepEqual([...request.connections].sort(), ["cin_chase", "cin_ynab"]);
  assert.deepEqual([...request.streams].sort(), ["transactions"]);
});

test("CONNECTION-FILTERED feed: the bucketRequest scope NARROWS to the selected connection (matches the feed)", async () => {
  // Selecting only cin_ynab must scope the request to ynab too — the chart's bars
  // reconcile with the feed's structural scope (no all-corpus leak).
  const result = await assembleExplorerData({ connection: "cin_ynab" }, chartDs(), "https://rs.test");

  const request = result.bucketRequest;
  assert.ok(request, "request still computed on a structurally-filtered feed");
  assert.deepEqual(
    [...request.connections].sort(),
    ["cin_ynab"],
    "bucket scope NARROWS to the selected connection — never the all-corpus union"
  );
});

test("DATE-FILTERED feed: bucketRequest is computed and carries the window (kind stays non-relevance_bounded)", async () => {
  // A date window (since/until) only picks granularity; it does NOT scope the
  // aggregate. So the request is the broader structural distribution you brush —
  // and the descriptor must NOT be relevance_bounded.
  const result = await assembleExplorerData({ since: "2026-06-01", until: "2026-06-10" }, chartDs(), "https://rs.test");
  const request = result.bucketRequest;
  assert.ok(request, "request computed on a date-filtered (filtered_exact) feed");
  assert.equal(request.since, "2026-06-01", "the request carries the since window");
  assert.equal(request.until, "2026-06-10", "the request carries the until window");
  assert.notEqual(result.descriptor.kind, "relevance_bounded");
});

// ── (a) SEARCH suppresses the chart — bucketRequest null, no inline call ──────

const SEARCH_HITS: SearchResultHit[] = [
  {
    connection_id: "cin_ynab",
    connector_id: "ynab",
    emitted_at: "2026-06-05T00:00:00Z",
    matched_fields: [],
    object: "search_result",
    record_key: "y-tx-1",
    stream: "transactions",
  },
];

test("SEARCH feed: the chart is SUPPRESSED (bucketRequest null) — no request can scope to the query", async () => {
  const inlineBucketCallCount = { value: 0 };
  const result = await assembleExplorerData(
    { q: "invoice" },
    chartDs({ inlineBucketCallCount, searchHits: SEARCH_HITS }),
    "https://rs.test"
  );

  assert.equal(result.fromSearch, true, "this exercises the SEARCH lens");
  assert.equal(result.bucketRequest, null, "chart suppressed during search (no honest time-distribution)");
  assert.equal(result.bucketSeries, null, "no series either");
  assert.equal(inlineBucketCallCount.value, 0, "the bucket aggregate is never fired during search");
});

test("NEGATIVE CONTROL: the SAME data source WITHOUT a query computes the bucketRequest", async () => {
  // Proves the suppression is caused by the SEARCH lens, not by a broken fixture:
  // dropping `q` (same ds shape) flips bucketRequest from null to a real request.
  const result = await assembleExplorerData({}, chartDs({ searchHits: SEARCH_HITS }), "https://rs.test");

  assert.equal(result.fromSearch, false);
  assert.ok(result.bucketRequest, "without a query the chart request is computed");
});
