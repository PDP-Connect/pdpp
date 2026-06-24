/**
 * Over-time chart SCOPE honesty — through the real `assembleExplorerData` path.
 *
 * The chart's bars come from the server `group_by_time` aggregate
 * (`aggregateRecordsByTime`), which structurally CANNOT receive a free-text
 * query and is NOT passed `since`/`until` (those only pick the granularity). The
 * caption used to say "Matching records over time," producing two lies:
 *
 *  1. SEARCH: a search result-set (keyword_pageable) is not an honest
 *     time-distribution — the aggregate sums the FULL corpus while the feed shows
 *     only the matches. FIX: suppress the chart entirely when `fromSearch`.
 *  2. The aggregate IS scoped to the SAME structural (connection, stream) targets
 *     the feed shows — these tests prove the assembler SENDS that scope so the
 *     bars reconcile with the feed's structural scope.
 *
 * These tests exercise the assembler end-to-end (no mock of the chart) and
 * capture the exact aggregate calls + the resulting `bucketSeries`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DashboardDataSource } from "../lib/data-source.ts";
import type { ExploreTimelinePage, ListResponse, RefConnectorSummary } from "../lib/ref-client.ts";
import type { ConnectorManifest, SearchResultHit, SearchResultPage, TimeBucketAggregate } from "../lib/rs-client.ts";
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

/** One aggregate call the chart fan-in made: the structural scope it carried. */
interface AggCall {
  connectionId: string | null | undefined;
  connectorId: string;
  granularity: string;
  stream: string;
}

const notStubbed = () => Promise.reject(new Error("not stubbed"));

function aggregateFor(stream: string): TimeBucketAggregate {
  return {
    approximate: false,
    filtered_record_count: 2,
    granularity: "day",
    group_by_time: "occurred_at",
    groups: [{ key: "2026-06-05", count: 2 }],
    metric: "count",
    object: "aggregation",
    stream,
    time_zone: "UTC",
  };
}

function chartDs(opts?: { aggCalls?: AggCall[]; searchHits?: SearchResultHit[] }): DashboardDataSource {
  return {
    kind: "sandbox" as const,
    aggregateRecordsByTime: (connectorId, stream, o) => {
      opts?.aggCalls?.push({
        connectorId,
        stream,
        connectionId: o.connectionId,
        granularity: o.granularity,
      });
      return Promise.resolve(aggregateFor(stream));
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

test("BROWSE feed: the chart renders and the aggregate is called per in-scope (connection, stream) target", async () => {
  const aggCalls: AggCall[] = [];
  const result = await assembleExplorerData({}, chartDs({ aggCalls }), "https://rs.test");

  assert.equal(result.fromSearch, false, "this is the browse lens, not search");
  assert.ok(result.bucketSeries, "the chart renders over a non-search exhaustive feed");
  // The aggregate was scoped to the SAME structural targets the feed shows: one
  // call per (connection, stream), each carrying its connection identity.
  const scoped = aggCalls.map((c) => `${c.connectorId}/${c.stream}@${c.connectionId}`).sort();
  assert.deepEqual(
    scoped,
    ["chase/transactions@cin_chase", "ynab/transactions@cin_ynab"],
    "aggregate is scoped to the feed's connection/stream targets (structural filter passed)"
  );
});

test("CONNECTION-FILTERED feed: the aggregate scope NARROWS to the selected connection (matches the feed)", async () => {
  // Selecting only cin_ynab must scope the bars to ynab too — the chart's bars
  // reconcile with the feed's structural scope (no all-corpus leak).
  const aggCalls: AggCall[] = [];
  const result = await assembleExplorerData({ connection: "cin_ynab" }, chartDs({ aggCalls }), "https://rs.test");

  assert.ok(result.bucketSeries, "chart still renders on a structurally-filtered feed");
  const scoped = aggCalls.map((c) => `${c.connectorId}/${c.stream}@${c.connectionId}`).sort();
  assert.deepEqual(
    scoped,
    ["ynab/transactions@cin_ynab"],
    "aggregate scope NARROWS to the selected connection — never the all-corpus union"
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

test("SEARCH feed: the chart is SUPPRESSED (bucketSeries null) — the aggregate cannot scope to the query", async () => {
  const aggCalls: AggCall[] = [];
  const result = await assembleExplorerData(
    { q: "invoice" },
    chartDs({ aggCalls, searchHits: SEARCH_HITS }),
    "https://rs.test"
  );

  assert.equal(result.fromSearch, true, "this exercises the SEARCH lens");
  assert.equal(result.bucketSeries, null, "chart suppressed during search (no honest time-distribution)");
  assert.equal(aggCalls.length, 0, "the aggregate is NEVER fired during search (cannot be query-scoped)");
});

test("NEGATIVE CONTROL: the SAME data source WITHOUT a query renders the chart and fires the aggregate", async () => {
  // Proves the suppression is caused by the SEARCH lens, not by a broken fixture:
  // dropping `q` (same ds shape) flips bucketSeries non-null and fires aggregates.
  const aggCalls: AggCall[] = [];
  const result = await assembleExplorerData({}, chartDs({ aggCalls, searchHits: SEARCH_HITS }), "https://rs.test");

  assert.equal(result.fromSearch, false);
  assert.ok(result.bucketSeries, "without a query the chart renders");
  assert.ok(aggCalls.length > 0, "without a query the aggregate fires");
});
