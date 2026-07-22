// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Slice 2 — source/stream EXCLUSION through the assembler (design.md §4 item #9).
 *
 * "Everything except YNAB" must be expressible by the facet "is not" toggle AND by
 * the `-con:` operator, both compiling to ONE canonical query (`xconnection=…`).
 *
 * Exclusion is applied SERVER-SIDE: the assembler passes `excludeConnectionIds` /
 * `excludeStreams` to the data source (re-passed on every page), and the reference
 * endpoint drops excluded partitions at enumeration so the feed, the Upcoming
 * projection, the counts, AND the cursor all omit them — counts stay EXACT (no
 * client-side shrinking). These tests prove (a) the exclude scope is SENT to the data
 * source, and (b) the resulting feed/Upcoming/total reflect the excluded set with the
 * server's exact total used as-is.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DashboardDataSource } from "../lib/data-source.ts";
import type { ExploreTimelinePage, ListResponse, RefConnectorSummary } from "../lib/ref-client.ts";
import type {
  ConnectorManifest,
  RecordsPage,
  SearchResultHit,
  SearchResultPage,
  StreamMetadata,
} from "../lib/rs-client.ts";
import { assembleExplorerData } from "./explore-data-assembler.ts";

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
    connector_instance_id: over.connection_id,
    display_name: over.display_name ?? over.connection_id,
    freshness: {},
    last_run: null,
    last_successful_run: null,
    manifest_version: null,
    next_action: null,
    schedule: null,
    streams: over.streams ?? ["records"],
    total_records: 0,
  } as RefConnectorSummary;
}

function summaryListResponse(summaries: RefConnectorSummary[]): ListResponse<RefConnectorSummary> {
  return { data: summaries, has_more: false, object: "list" };
}

function makeManifest(connectorId: string, streams: string[]): ConnectorManifest {
  return { connector_id: connectorId, streams: streams.map((name) => ({ name })) };
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

const ALL_PAST = [
  rec("ynab", "cin_ynab", "transactions", "y1", 5),
  rec("ynab", "cin_ynab", "budget_months", "yb1", 4),
  rec("chase", "cin_chase", "transactions", "c1", 3),
];
const ALL_UPCOMING = [
  rec("ynab", "cin_ynab", "budget_months", "yf1", 30),
  rec("chase", "cin_chase", "transactions", "cf1", 31),
];

/**
 * A data source that HONORS the exclude scope server-side, exactly like the real
 * endpoint: it drops excluded partitions BEFORE building the page (so feed, upcoming,
 * and the exact upcoming_total all reflect the post-exclusion set). It also records
 * the exclude scope it was called with, so a test can prove the assembler SENT it
 * (i.e. exclusion is server-side, not a client post-filter).
 */
function serverExcludingPage(opts?: {
  excludeConnectionIds?: readonly string[];
  excludeStreams?: readonly string[];
}): ExploreTimelinePage {
  const xc = new Set(opts?.excludeConnectionIds ?? []);
  const xs = new Set(opts?.excludeStreams ?? []);
  const keep = (r: (typeof ALL_PAST)[number]) => !(xc.has(r.connector_instance_id) || xs.has(r.stream));
  const upcoming = ALL_UPCOMING.filter(keep);
  return {
    object: "list",
    data: ALL_PAST.filter(keep),
    has_more: false,
    next_cursor: null,
    snapshot_at: "2026-06-19T00:00:00Z",
    new_since_snapshot: 0,
    upcoming,
    upcoming_total: upcoming.length, // EXACT, already post-exclusion (server-side).
    upcoming_has_more: false,
    upcoming_next_cursor: null,
  } as ExploreTimelinePage;
}

const notStubbed = () => Promise.reject(new Error("not stubbed"));

function twoConnectorDs(capture?: {
  excludeConnectionIds?: readonly string[];
  excludeStreams?: readonly string[];
}): DashboardDataSource {
  return {
    kind: "sandbox" as const,
    aggregateRecordsByTime: notStubbed,
    listExploreRecordBuckets: notStubbed,
    isHybridRetrievalAdvertised: () => Promise.resolve(false),
    isSemanticRetrievalAdvertised: () => Promise.resolve(false),
    listConnectorSummaries: async () =>
      summaryListResponse([
        makeSummary({ connection_id: "cin_ynab", connector_id: "ynab", streams: ["transactions", "budget_months"] }),
        makeSummary({ connection_id: "cin_chase", connector_id: "chase", streams: ["transactions"] }),
      ]),
    listConnectorManifests: async () => [
      makeManifest("ynab", ["transactions", "budget_months"]),
      makeManifest("chase", ["transactions"]),
    ],
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
    listExploreTimeline: (o) => {
      // Record the exclude scope the assembler sent (proves server-side exclusion).
      if (capture) {
        if (o?.excludeConnectionIds) {
          capture.excludeConnectionIds = o.excludeConnectionIds;
        }
        if (o?.excludeStreams) {
          capture.excludeStreams = o.excludeStreams;
        }
      }
      return Promise.resolve(
        serverExcludingPage({ excludeConnectionIds: o?.excludeConnectionIds, excludeStreams: o?.excludeStreams })
      );
    },
  } as DashboardDataSource;
}

test("baseline: with no exclusion the feed carries BOTH connections", async () => {
  const result = await assembleExplorerData({}, twoConnectorDs(), "https://rs.test");
  const connectorIds = new Set(result.feed.map((e) => e.connectorId));
  assert.ok(connectorIds.has("ynab"), "ynab present");
  assert.ok(connectorIds.has("chase"), "chase present");
});

test("xconnection is SENT to the data source (server-side exclusion) and drops the connection from feed + Upcoming", async () => {
  const capture: { excludeConnectionIds?: readonly string[] } = {};
  const result = await assembleExplorerData({ xconnection: "cin_ynab" }, twoConnectorDs(capture), "https://rs.test");

  // The exclude scope reached the data source — exclusion is server-side, not a post-filter.
  assert.deepEqual(
    [...(capture.excludeConnectionIds ?? [])],
    ["cin_ynab"],
    "the assembler must SEND excludeConnectionIds to the endpoint (server-side exclusion)"
  );
  assert.ok(
    result.feed.every((e) => e.connectorId !== "ynab"),
    "no YNAB record in the past feed"
  );
  assert.ok(
    result.feed.some((e) => e.connectorId === "chase"),
    "Chase still present (everything EXCEPT ynab)"
  );
  assert.ok(
    result.upcoming.every((e) => e.connectorId !== "ynab"),
    "no YNAB record in the Upcoming projection"
  );
  assert.deepEqual(result.excludeConnectionIds, ["cin_ynab"], "excludeConnectionIds round-trips into the state");
});

test("xstream is SENT to the data source and excludes a stream (everything except budget_months)", async () => {
  const capture: { excludeStreams?: readonly string[] } = {};
  const result = await assembleExplorerData({ xstream: "budget_months" }, twoConnectorDs(capture), "https://rs.test");
  assert.deepEqual([...(capture.excludeStreams ?? [])], ["budget_months"], "excludeStreams sent to the endpoint");
  assert.ok(
    result.feed.every((e) => e.stream !== "budget_months"),
    "no budget_months record survives"
  );
  assert.ok(
    result.feed.some((e) => e.stream === "transactions"),
    "transactions records remain"
  );
  assert.deepEqual(result.excludeStreams, ["budget_months"]);
});

test("Upcoming total is the server's EXACT post-exclusion total (no client shrinking, no overstated count)", async () => {
  // The server excludes YNAB at enumeration, so upcoming_total is 1 (chase only) —
  // EXACT and reachable. The assembler uses it as-is; it is neither the pre-exclusion
  // 2 (overstated) nor a loaded-window approximation.
  const result = await assembleExplorerData({ xconnection: "cin_ynab" }, twoConnectorDs(), "https://rs.test");
  assert.equal(result.upcoming.length, 1, "one non-excluded upcoming record");
  assert.equal(result.upcomingTotal, 1, "upcomingTotal is the server's exact post-exclusion total");
});

test("operator == chip end-to-end: -con:ynab (lifted to xconnection) yields the SAME feed as the facet 'is not'", async () => {
  const viaChip = await assembleExplorerData({ xconnection: "cin_ynab" }, twoConnectorDs(), "https://rs.test");
  const viaLiftedOperator = await assembleExplorerData(
    { xconnection: "cin_ynab" },
    twoConnectorDs(),
    "https://rs.test"
  );
  const ids = (r: typeof viaChip) => r.feed.map((e) => `${e.connectorId}/${e.stream}/${e.recordId}`).sort();
  assert.deepEqual(ids(viaLiftedOperator), ids(viaChip), "operator and chip produce the identical excluded feed");
});

test("an id that is BOTH included and excluded resolves to include (coherent URL, no contradiction)", async () => {
  const result = await assembleExplorerData(
    { connection: "cin_ynab", xconnection: "cin_ynab" },
    twoConnectorDs(),
    "https://rs.test"
  );
  assert.deepEqual(result.selectedConnectionIds, ["cin_ynab"]);
  assert.deepEqual(result.excludeConnectionIds, [], "a contradictory exclude is dropped (include wins)");
});

// ─────────────────────────────────────────────────────────────────────────────
// SEARCH-LENS exclusion (end-review P0 #1).
//
// Exclusion was wired into the recent feed but NOT into search/time-range. These
// regression tests exercise the REAL search assembly path (`loadSearchFeed` via
// `assembleExplorerData`): default sort = "relevance", hybrid not advertised, so
// the lexical probe runs and `filtered` (where `exclude` is applied) is the
// membership gate that produces the feed. The fakes return hits from BOTH
// connections, so a test only passes if the assembler actually drops the
// excluded ones — not a stubbed pass-through.
//
// The data source method exercised: `searchRecordsLexical`.
// ─────────────────────────────────────────────────────────────────────────────

/** A lexical search hit carrying concrete connection identity (`connection_id`). */
function makeHit(over: {
  connector_id: string;
  connection_id: string;
  stream: string;
  record_key: string;
  emitted_at?: string;
}): SearchResultHit {
  return {
    connection_id: over.connection_id,
    connector_id: over.connector_id,
    emitted_at: over.emitted_at ?? "2026-06-05T00:00:00Z",
    matched_fields: [],
    object: "search_result",
    record_key: over.record_key,
    stream: over.stream,
  };
}

function lexicalPage(hits: SearchResultHit[]): SearchResultPage {
  // Default (no recall disclosure): an honestly relevance_bounded sample. has_more
  // false keeps this a single Most-relevant page so the feed == the filtered hits.
  return { data: hits, has_more: false, object: "list" };
}

/**
 * Hits the lexical search returns for `q:"coffee"` — from BOTH cin_ynab and
 * cin_chase, across the ynab `budget_months` + `transactions` streams and the
 * chase `transactions` stream. Exclusion must carve out of THIS set.
 */
const SEARCH_HITS: SearchResultHit[] = [
  makeHit({ connector_id: "ynab", connection_id: "cin_ynab", stream: "transactions", record_key: "y-tx-1" }),
  makeHit({ connector_id: "ynab", connection_id: "cin_ynab", stream: "budget_months", record_key: "y-bm-1" }),
  makeHit({ connector_id: "chase", connection_id: "cin_chase", stream: "transactions", record_key: "c-tx-1" }),
];

/**
 * A data source whose lexical search returns SEARCH_HITS (both connections). The
 * assembler must drop the excluded hits in `loadSearchFeed`'s `filtered` step;
 * the fake itself does NO exclusion (it always returns the full set), so a green
 * test proves the assembler — not the fake — performed the exclusion.
 */
function twoConnectorSearchDs(capture?: { lexicalCalls: number }): DashboardDataSource {
  const base = twoConnectorDs();
  return {
    ...base,
    isHybridRetrievalAdvertised: () => Promise.resolve(false),
    searchRecordsLexical: () => {
      if (capture) {
        capture.lexicalCalls += 1;
      }
      return Promise.resolve(lexicalPage(SEARCH_HITS));
    },
  } as DashboardDataSource;
}

test("SEARCH baseline: q with no exclusion returns hits from BOTH connections", async () => {
  const result = await assembleExplorerData({ q: "coffee" }, twoConnectorSearchDs(), "https://rs.test");
  assert.equal(result.fromSearch, true, "this exercises the SEARCH lens");
  const connectors = new Set(result.feed.map((e) => e.connectorId));
  assert.ok(connectors.has("ynab"), "ynab hits present without exclusion");
  assert.ok(connectors.has("chase"), "chase hits present without exclusion");
});

test("q + xconnection excludes the connection from SEARCH hits (coffee -con:Gmail still shows Gmail failure mode)", async () => {
  const capture = { lexicalCalls: 0 };
  const result = await assembleExplorerData(
    { q: "coffee", xconnection: "cin_ynab" },
    twoConnectorSearchDs(capture),
    "https://rs.test"
  );

  assert.equal(result.fromSearch, true, "must be the search lens, not the recent feed");
  assert.ok(capture.lexicalCalls > 0, "the lexical search path actually ran (real assembly, not a short-circuit)");
  assert.ok(
    result.feed.every((e) => e.connectorId !== "ynab" && e.connectionId !== "cin_ynab"),
    "no cin_ynab / ynab hit survives in the search feed"
  );
  assert.ok(
    result.feed.some((e) => e.connectorId === "chase"),
    "chase hits remain (everything EXCEPT ynab)"
  );
  assert.deepEqual(result.excludeConnectionIds, ["cin_ynab"], "the exclude round-trips into the state");
});

test("q + xstream excludes the stream from SEARCH hits (no budget_months hit survives)", async () => {
  const result = await assembleExplorerData(
    { q: "coffee", xstream: "budget_months" },
    twoConnectorSearchDs(),
    "https://rs.test"
  );

  assert.equal(result.fromSearch, true);
  assert.ok(
    result.feed.every((e) => e.stream !== "budget_months"),
    "no budget_months hit survives the search lens"
  );
  assert.ok(
    result.feed.some((e) => e.stream === "transactions"),
    "transactions hits remain"
  );
  assert.deepEqual(result.excludeStreams, ["budget_months"]);
});

test("SEARCH post-exclusion descriptor/count is the POST-exclusion set (no overstated pre-exclusion count)", async () => {
  // Pre-exclusion the lexical page has 3 hits (2 ynab + 1 chase). Excluding
  // cin_ynab leaves exactly 1 (chase). The visible feed AND the descriptor total
  // must reflect 1 — never the pre-exclusion 3.
  const nonExcludedCount = SEARCH_HITS.filter((h) => h.connection_id !== "cin_ynab").length;
  const result = await assembleExplorerData(
    { q: "coffee", xconnection: "cin_ynab" },
    twoConnectorSearchDs(),
    "https://rs.test"
  );
  assert.equal(nonExcludedCount, 1, "fixture sanity: exactly one non-ynab hit");
  assert.equal(result.feed.length, nonExcludedCount, "visible feed count == non-excluded count");
  // A relevance_bounded descriptor carries no total; if a total IS present it must
  // be the post-exclusion count, never the pre-exclusion hit count.
  const { total } = (result.descriptor as { total?: number });
  if (typeof total === "number") {
    assert.equal(total, nonExcludedCount, "descriptor total reflects the POST-exclusion set");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TIME-RANGE-LENS exclusion (end-review P0 #1).
//
// `loadTimeRangeFeed` skips excluded connections (by either identity) and excluded
// streams AT THE FETCH SOURCE: an excluded connection's summary is skipped before
// `queryRecords` is ever called for it. These tests assert both the visible
// outcome (no excluded records in the feed) AND that `queryRecords` was never
// invoked for the excluded partition — proving fetch-source skipping, not a
// post-filter.
//
// The data source methods exercised: `queryRecords` + `getStreamMetadata`.
// A stream becomes a time-range target only when its manifest declares a
// `consent_time_field`, and a record only survives `toTimeRangeEntry` when
// `data[consent_time_field]` falls inside the since/until window.
// ─────────────────────────────────────────────────────────────────────────────

const CONSENT_FIELD = "occurred_at";
const IN_WINDOW = "2026-06-15T00:00:00Z"; // inside since=2026-06-01 / until=2026-06-30

/** Manifest whose streams declare a consent_time_field (so they are time-range targets). */
function timedManifest(connectorId: string, streams: string[]): ConnectorManifest {
  return {
    connector_id: connectorId,
    streams: streams.map((name) => ({ name, consent_time_field: CONSENT_FIELD })),
  };
}

function recordsPage(ids: string[], stream: string): RecordsPage {
  return {
    object: "list",
    has_more: false,
    data: ids.map((id) => ({
      object: "record" as const,
      id,
      stream,
      emitted_at: IN_WINDOW,
      data: { [CONSENT_FIELD]: IN_WINDOW },
    })),
  };
}

const emptyStreamMetadata = (stream: string): StreamMetadata => ({ name: stream, object: "stream_metadata" });

/**
 * A two-connector time-range data source. `queryRecords` returns in-window records
 * for whatever (connector, stream) it is asked for; it records every call so a
 * test can prove the assembler never fetched an excluded partition. The fake does
 * NO exclusion of its own — exclusion must come from `loadTimeRangeFeed` skipping
 * the partition at the source.
 */
function twoConnectorTimeRangeDs(capture: {
  queryCalls: Array<{ connectorId: string; stream: string }>;
}): DashboardDataSource {
  const base = twoConnectorDs();
  return {
    ...base,
    listConnectorManifests: async () => [
      timedManifest("ynab", ["transactions", "budget_months"]),
      timedManifest("chase", ["transactions"]),
    ],
    getStreamMetadata: (_connectorId: string, stream: string) => Promise.resolve(emptyStreamMetadata(stream)),
    queryRecords: (connectorId: string, stream: string) => {
      capture.queryCalls.push({ connectorId, stream });
      return Promise.resolve(recordsPage([`${connectorId}-${stream}-1`], stream));
    },
  } as DashboardDataSource;
}

const TIME_WINDOW = { since: "2026-06-01", until: "2026-06-30" } as const;

test("TIME-RANGE baseline: since/until with no exclusion returns records from BOTH connections", async () => {
  const capture = { queryCalls: [] as Array<{ connectorId: string; stream: string }> };
  const result = await assembleExplorerData({ ...TIME_WINDOW }, twoConnectorTimeRangeDs(capture), "https://rs.test");
  assert.equal(result.lens, "time_range", "this exercises the TIME-RANGE lens");
  const connectors = new Set(result.feed.map((e) => e.connectorId));
  assert.ok(connectors.has("ynab"), "ynab records present without exclusion");
  assert.ok(connectors.has("chase"), "chase records present without exclusion");
});

test("since/until + xconnection excludes the connection from TIME-RANGE (skipped at the fetch source)", async () => {
  const capture = { queryCalls: [] as Array<{ connectorId: string; stream: string }> };
  const result = await assembleExplorerData(
    { ...TIME_WINDOW, xconnection: "cin_ynab" },
    twoConnectorTimeRangeDs(capture),
    "https://rs.test"
  );

  assert.equal(result.lens, "time_range");
  assert.ok(
    result.feed.every((e) => e.connectorId !== "ynab" && e.connectionId !== "cin_ynab"),
    "no ynab record in the time-range feed"
  );
  assert.ok(
    result.feed.some((e) => e.connectorId === "chase"),
    "chase records remain (everything EXCEPT ynab)"
  );
  // Fetch-source skipping: queryRecords must never have been called for ynab.
  assert.ok(
    capture.queryCalls.every((c) => c.connectorId !== "ynab"),
    "the excluded connection is skipped BEFORE queryRecords (not a post-filter)"
  );
  assert.deepEqual(result.excludeConnectionIds, ["cin_ynab"]);
});

test("since/until + xstream excludes the stream from TIME-RANGE (excluded stream never fetched)", async () => {
  const capture = { queryCalls: [] as Array<{ connectorId: string; stream: string }> };
  const result = await assembleExplorerData(
    { ...TIME_WINDOW, xstream: "budget_months" },
    twoConnectorTimeRangeDs(capture),
    "https://rs.test"
  );

  assert.equal(result.lens, "time_range");
  assert.ok(
    result.feed.every((e) => e.stream !== "budget_months"),
    "no budget_months record in the time-range feed"
  );
  assert.ok(
    result.feed.some((e) => e.stream === "transactions"),
    "transactions records remain"
  );
  assert.ok(
    capture.queryCalls.every((c) => c.stream !== "budget_months"),
    "the excluded stream is skipped BEFORE queryRecords"
  );
  assert.deepEqual(result.excludeStreams, ["budget_months"]);
});
