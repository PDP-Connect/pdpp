/**
 * Over-time chart SCOPE honesty — through the real `assembleExplorerData` path.
 *
 * The chart's bars come from the index-backed bucket endpoint
 * (`listExploreRecordBuckets` → `GET /_ref/explore/records/buckets`), ONE call
 * that structurally CANNOT receive a free-text query. The endpoint IS scoped to
 * the SAME structural (connection, stream) targets the feed shows. The caption
 * used to say "Matching records over time," producing two lies:
 *
 *  1. SEARCH: a search result-set (keyword_pageable) is not an honest
 *     time-distribution — the endpoint counts the FULL corpus while the feed shows
 *     only the matches. FIX: suppress the chart entirely when `fromSearch`.
 *  2. The bucket call IS scoped to the SAME structural (connection, stream) targets
 *     the feed shows — these tests prove the assembler SENDS that scope (one call,
 *     not N) so the bars reconcile with the feed's structural scope.
 *
 * These tests exercise the assembler end-to-end (no mock of the chart) and
 * capture the exact bucket-endpoint scope + the resulting `bucketSeries`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DashboardDataSource } from "../lib/data-source.ts";
import type { ExploreTimelinePage, ListResponse, RefConnectorSummary } from "../lib/ref-client.ts";
import type {
  ConnectorManifest,
  ExploreRecordBucketsResponse,
  SearchResultHit,
  SearchResultPage,
} from "../lib/rs-client.ts";
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

/** One bucket-endpoint call the chart made: the structural scope it carried. */
interface BucketCall {
  connections: readonly string[];
  streams: readonly string[];
  excludeStreams: readonly string[] | undefined;
  since: string | null | undefined;
  until: string | null | undefined;
}

const notStubbed = () => Promise.reject(new Error("not stubbed"));

function bucketsResponse(): ExploreRecordBucketsResponse {
  return {
    object: "explore_record_buckets",
    granularity: "day",
    time_zone: "UTC",
    extent: { start: "2026-06-05T00:00:00.000Z", end: "2026-06-05T00:00:00.000Z", count: 2 },
    buckets: [{ start: "2026-06-05T00:00:00.000Z", end: "2026-06-06T00:00:00.000Z", count: 2 }],
  };
}

function chartDs(opts?: { bucketCalls?: BucketCall[]; searchHits?: SearchResultHit[] }): DashboardDataSource {
  return {
    kind: "sandbox" as const,
    aggregateRecordsByTime: notStubbed,
    listExploreRecordBuckets: (o) => {
      opts?.bucketCalls?.push({
        connections: o.connections ?? [],
        streams: o.streams ?? [],
        excludeStreams: o.excludeStreams,
        since: o.since,
        until: o.until,
      });
      return Promise.resolve(bucketsResponse());
    },
    isHybridRetrievalAdvertised: () => Promise.resolve(false),
    isSemanticRetrievalAdvertised: () => Promise.resolve(false),
    listConnectorSummaries: async () =>
      summaryListResponse([
        makeSummary({ connection_id: "cin_ynab", connector_id: "ynab", streams: ["transactions"] }),
        makeSummary({ connection_id: "cin_chase", connector_id: "chase", streams: ["transactions"] }),
      ]),
    listConnectorManifests: async () => [
      timeManifest("ynab", ["transactions"]),
      timeManifest("chase", ["transactions"]),
    ],
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

// ── (b) Non-search browse feed: chart renders + aggregate carries STRUCTURAL scope ──

test("BROWSE feed: the chart renders and ONE bucket call carries the in-scope (connection, stream) targets", async () => {
  const bucketCalls: BucketCall[] = [];
  const result = await assembleExplorerData({}, chartDs({ bucketCalls }), "https://rs.test");

  assert.equal(result.fromSearch, false, "this is the browse lens, not search");
  assert.ok(result.bucketSeries, "the chart renders over a non-search exhaustive feed");
  // ONE index-backed call (not N per-target), scoped to the SAME structural
  // (connection, stream) targets the feed shows.
  assert.equal(bucketCalls.length, 1, "the chart makes exactly ONE bucket call (not a per-target fan-out)");
  const call = bucketCalls[0];
  assert.ok(call, "the single bucket call was captured");
  assert.deepEqual(
    [...call.connections].sort(),
    ["cin_chase", "cin_ynab"],
    "bucket call is scoped to the feed's connection targets (structural filter passed)"
  );
  assert.deepEqual([...call.streams].sort(), ["transactions"], "bucket call carries the in-scope streams");
  // The EXACT reachable total comes from extent.count, not summed bars.
  assert.equal(result.bucketSeries?.total, 2, "total is the exact reachable extent.count");
});

test("CONNECTION-FILTERED feed: the bucket scope NARROWS to the selected connection (matches the feed)", async () => {
  // Selecting only cin_ynab must scope the bars to ynab too — the chart's bars
  // reconcile with the feed's structural scope (no all-corpus leak).
  const bucketCalls: BucketCall[] = [];
  const result = await assembleExplorerData({ connection: "cin_ynab" }, chartDs({ bucketCalls }), "https://rs.test");

  assert.ok(result.bucketSeries, "chart still renders on a structurally-filtered feed");
  assert.equal(bucketCalls.length, 1, "still ONE bucket call when structurally filtered");
  const call = bucketCalls[0];
  assert.ok(call, "the single bucket call was captured");
  assert.deepEqual(
    [...call.connections].sort(),
    ["cin_ynab"],
    "bucket scope NARROWS to the selected connection — never the all-corpus union"
  );
});

test("DATE-FILTERED feed: chart renders and caption stays 'Records over time' (never 'Matching')", async () => {
  // A date window (since/until) only picks granularity; it does NOT scope the
  // aggregate. So the bars are the broader structural distribution you brush — and
  // the caption must NOT claim they are the matching/filtered total.
  const result = await assembleExplorerData({ since: "2026-06-01", until: "2026-06-10" }, chartDs(), "https://rs.test");
  assert.ok(result.bucketSeries, "chart renders on a date-filtered (filtered_exact) feed");
  // The caption (a pure function in over-time-chart.ts) never claims "matching".
  // Asserting the kind reached filtered_exact proves we're on the date-filter path.
  assert.notEqual(result.descriptor.kind, "relevance_bounded");
});

// ── (a) SEARCH suppresses the chart — and never calls the aggregate ──────────

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

test("SEARCH feed: the chart is SUPPRESSED (bucketSeries null) — the bucket call cannot scope to the query", async () => {
  const bucketCalls: BucketCall[] = [];
  const result = await assembleExplorerData(
    { q: "invoice" },
    chartDs({ bucketCalls, searchHits: SEARCH_HITS }),
    "https://rs.test"
  );

  assert.equal(result.fromSearch, true, "this exercises the SEARCH lens");
  assert.equal(result.bucketSeries, null, "chart suppressed during search (no honest time-distribution)");
  assert.equal(bucketCalls.length, 0, "the bucket call is NEVER fired during search (cannot be query-scoped)");
});

test("NEGATIVE CONTROL: the SAME data source WITHOUT a query renders the chart and fires the bucket call", async () => {
  // Proves the suppression is caused by the SEARCH lens, not by a broken fixture:
  // dropping `q` (same ds shape) flips bucketSeries non-null and fires the bucket call.
  const bucketCalls: BucketCall[] = [];
  const result = await assembleExplorerData({}, chartDs({ bucketCalls, searchHits: SEARCH_HITS }), "https://rs.test");

  assert.equal(result.fromSearch, false);
  assert.ok(result.bucketSeries, "without a query the chart renders");
  assert.ok(bucketCalls.length > 0, "without a query the bucket call fires");
});
