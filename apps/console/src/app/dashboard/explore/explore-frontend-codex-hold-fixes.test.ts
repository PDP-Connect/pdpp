/**
 * Reproduce-the-bug tests for the FRONTEND Codex HOLD findings:
 *
 *   F1 (P1) - Selected-source filtering broken on recent lens
 *   F2 (P0) - "Browse all matching records, newest first" returns non-matching records
 *   F3 (P1) - Identity shape: connector_instance_id not used; raw cin_... labels possible
 *
 * Each test is written so it FAILS on the pre-fix behavior and PASSES after the fix.
 * Failure mode for each test is documented inline.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleExplorerData } from "@pdpp/operator-ui/explore/explore-data-assembler";
import type { DashboardDataSource } from "@pdpp/operator-ui/lib/data-source";
import type {
  ExploreTimelinePage,
  ExploreTimelineRecord,
  ListResponse,
  RefConnectorSummary,
} from "@pdpp/operator-ui/lib/ref-client";
import type { ConnectorManifest, SearchResultHit, SearchResultPage } from "@pdpp/operator-ui/lib/rs-client";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeSummary(over: {
  connection_id: string;
  connector_id: string;
  connector_instance_id?: string;
  streams?: string[];
  display_name?: string;
}): RefConnectorSummary {
  return {
    connection_health: {} as RefConnectorSummary["connection_health"],
    connection_id: over.connection_id,
    connector_id: over.connector_id,
    connector_instance_id: over.connector_instance_id ?? over.connection_id,
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

function makeTimelineRecord(over: {
  connector_id: string;
  connector_instance_id: string;
  stream?: string;
  record_key?: string;
  emitted_at?: string;
}): ExploreTimelineRecord {
  return {
    object: "timeline_record",
    connector_id: over.connector_id,
    connector_instance_id: over.connector_instance_id,
    stream: over.stream ?? "records",
    record_key: over.record_key ?? "rec-1",
    emitted_at: over.emitted_at ?? "2026-01-01T00:00:00Z",
    data: { title: "test" },
  };
}

function makeTimelinePage(
  records: ExploreTimelineRecord[],
  opts?: {
    has_more?: boolean;
    next_cursor?: string | null;
  }
): ExploreTimelinePage {
  return {
    object: "list",
    data: records,
    has_more: opts?.has_more ?? false,
    next_cursor: opts?.next_cursor ?? null,
    snapshot_at: "2026-06-19T00:00:00Z",
    new_since_snapshot: 0,
  };
}

function makeHit(over: {
  connector_id: string;
  stream?: string;
  record_key?: string;
  connection_id?: string;
  emitted_at?: string;
}): SearchResultHit {
  return {
    connector_id: over.connector_id,
    connection_id: over.connection_id,
    stream: over.stream ?? "records",
    record_key: over.record_key ?? "rec-1",
    emitted_at: over.emitted_at ?? "2026-01-01T00:00:00Z",
    matched_fields: [],
    object: "search_result",
  };
}

function makeLexicalPage(
  hits: SearchResultHit[],
  opts?: { has_more?: boolean; next_cursor?: string }
): SearchResultPage {
  return {
    data: hits,
    has_more: opts?.has_more ?? false,
    ...(opts?.next_cursor ? { next_cursor: opts.next_cursor } : {}),
    object: "list",
  };
}

function summaryListResponse(summaries: RefConnectorSummary[]): ListResponse<RefConnectorSummary> {
  return { data: summaries, has_more: false, object: "list" };
}

function makeManifest(connectorId: string, streams: string[] = ["records"]): ConnectorManifest {
  return {
    connector_id: connectorId,
    streams: streams.map((name) => ({ name })),
  };
}

function makeDataSource(overrides: Partial<DashboardDataSource>): DashboardDataSource {
  const stub: DashboardDataSource = {
    kind: "sandbox" as const,
    aggregateRecordsByTime: async () => {
      throw new Error("aggregateRecordsByTime not stubbed");
    },
    listExploreRecordBuckets: async () => {
      throw new Error("listExploreRecordBuckets not stubbed");
    },
    isHybridRetrievalAdvertised: async () => false,
    isSemanticRetrievalAdvertised: async () => false,
    listConnectorSummaries: async () => {
      throw new Error("listConnectorSummaries not stubbed");
    },
    listConnectorManifests: async () => {
      throw new Error("listConnectorManifests not stubbed");
    },
    searchRecordsLexical: async () => {
      throw new Error("searchRecordsLexical not stubbed");
    },
    searchRecordsHybrid: async () => {
      throw new Error("searchRecordsHybrid not stubbed");
    },
    searchRecordsSemantic: async () => {
      throw new Error("searchRecordsSemantic not stubbed");
    },
    queryRecords: async () => {
      throw new Error("queryRecords not stubbed");
    },
    getRecord: async () => {
      throw new Error("getRecord not stubbed");
    },
    getConnectorOverview: async () => {
      throw new Error("getConnectorOverview not stubbed");
    },
    getStreamMetadata: async () => {
      throw new Error("getStreamMetadata not stubbed");
    },
    getTraceTimeline: async () => {
      throw new Error("getTraceTimeline not stubbed");
    },
    listGrants: async () => {
      throw new Error("listGrants not stubbed");
    },
    listPendingApprovals: async () => {
      throw new Error("listPendingApprovals not stubbed");
    },
    listRuns: async () => {
      throw new Error("listRuns not stubbed");
    },
    listStreams: async () => {
      throw new Error("listStreams not stubbed");
    },
    listTraces: async () => {
      throw new Error("listTraces not stubbed");
    },
    refSearch: async () => {
      throw new Error("refSearch not stubbed");
    },
    listExploreTimeline: async () => makeTimelinePage([]),
    getDatasetSummary: async () => {
      throw new Error("getDatasetSummary not stubbed");
    },
    getDeploymentDiagnostics: async () => {
      throw new Error("getDeploymentDiagnostics not stubbed");
    },
    getGrantTimeline: async () => {
      throw new Error("getGrantTimeline not stubbed");
    },
    getRunTimeline: async () => {
      throw new Error("getRunTimeline not stubbed");
    },
    ...overrides,
  };
  return stub;
}

// ─── F1: Selected-source filtering broken on recent lens ─────────────────────
//
// BUG (pre-fix): selecting "Amazon" connection still showed YNAB records because
// `loadMergedTimelineFeed` filtered by stream name only and ignored filterConnectionSet.
// The endpoint returns ALL owner-visible records; cross-source leakage happened when
// the selected connection's records and a different connection's records landed in the
// same merged page.
//
// FIX: client-side filter on connector_instance_id against the set of instance ids
// belonging to the selected connections.
//
// PRE-FIX FAILURE: `result.feed` contained a record with connectionId "cin_ynab_1"
// even though the user selected "cin_amazon_1". After fix: only Amazon records appear.

test("F1 (P1): recent lens filters by selected connection — YNAB records do not appear when Amazon is selected", async () => {
  const amazonSummary = makeSummary({
    connection_id: "cin_amazon_1",
    connector_id: "amazon",
    connector_instance_id: "cin_amazon_1",
    streams: ["orders"],
    display_name: "Amazon",
  });
  const ynabSummary = makeSummary({
    connection_id: "cin_ynab_1",
    connector_id: "ynab",
    connector_instance_id: "cin_ynab_1",
    streams: ["transactions"],
    display_name: "YNAB",
  });

  // The endpoint returns records from BOTH connections (cross-source leak scenario).
  const amazonRecord = makeTimelineRecord({
    connector_id: "amazon",
    connector_instance_id: "cin_amazon_1",
    stream: "orders",
    record_key: "order-1",
  });
  const ynabRecord = makeTimelineRecord({
    connector_id: "ynab",
    connector_instance_id: "cin_ynab_1",
    stream: "transactions",
    record_key: "txn-1",
  });

  const ds = makeDataSource({
    listConnectorSummaries: async () => summaryListResponse([amazonSummary, ynabSummary]),
    listConnectorManifests: async () => [makeManifest("amazon", ["orders"]), makeManifest("ynab", ["transactions"])],
    listExploreTimeline: async (opts) => {
      assert.deepEqual(
        opts?.connectionIds,
        ["cin_amazon_1"],
        "selected connection must be pushed into /_ref/explore/records so pagination is scoped, not sparse"
      );
      return makeTimelinePage([amazonRecord, ynabRecord]);
    },
  });

  // User selects Amazon only — YNAB records must not appear.
  const result = await assembleExplorerData({ connection: "cin_amazon_1" }, ds, "https://rs.test");

  // PRE-FIX: result.feed.length === 2 (YNAB record leaked through).
  // POST-FIX: result.feed.length === 1 (only Amazon record).
  assert.equal(
    result.feed.length,
    1,
    `Expected only 1 Amazon record; got ${result.feed.length}. YNAB record leaked through the connection filter (F1 bug)`
  );
  assert.equal(result.feed[0]?.recordId, "order-1", "Only the Amazon record must be in the feed");
  assert.equal(result.feed[0]?.connectionId, "cin_amazon_1", "connectionId must be the Amazon instance");

  // Verify the YNAB record is absent.
  const ynabInFeed = result.feed.find((e) => e.connectionId === "cin_ynab_1");
  assert.equal(ynabInFeed, undefined, "YNAB record must not appear when Amazon is selected (F1 fix)");
});

// ─── F2: Most-recent search_sort returns non-matching records (single-stream) ──
//
// BUG (pre-fix): single-stream Most-recent used `queryRecords` without a query,
// so the "Browse all matching records, newest first" path returned ALL records in
// the stream, not just the ones matching the query.
//
// FIX: use `searchRecordsLexical` scoped to the stream with the query applied so
// only MATCHING records are returned.
//
// PRE-FIX FAILURE: the test stubs queryRecords to throw, and expects lexical to be
// called. Pre-fix the assembler called queryRecords (non-matching records returned);
// post-fix it calls lexical (only matching records returned).

test("F2 (P0): single-stream Most-recent calls lexical (not queryRecords) — only matching records returned", async () => {
  const summary = makeSummary({
    connection_id: "cin_amazon_1",
    connector_id: "amazon",
    connector_instance_id: "cin_amazon_1",
    streams: ["orders"],
    display_name: "Amazon",
  });
  // Only one matching hit (connector+stream all same so streamDoor fires).
  const matchingHit = makeHit({
    connector_id: "amazon",
    stream: "orders",
    record_key: "matching-order",
    connection_id: "cin_amazon_1",
  });

  let queryRecordsCalled = false;
  let lexicalCalledWithStream = false;

  const ds = makeDataSource({
    listConnectorSummaries: async () => summaryListResponse([summary]),
    listConnectorManifests: async () => [makeManifest("amazon", ["orders"])],
    // Lexical must be called for BOTH stream-door probe AND the display results.
    searchRecordsLexical: async (_q, opts) => {
      if (opts?.streams?.includes("orders")) {
        lexicalCalledWithStream = true;
      }
      return makeLexicalPage([matchingHit], { has_more: false });
    },
    // PRE-FIX: assembler called queryRecords here. If we stub it to NOT throw,
    // all records (matching or not) would be returned. We stub it to throw so
    // the pre-fix behavior is caught as a test failure.
    queryRecords: async () => {
      queryRecordsCalled = true;
      throw new Error("queryRecords must not be called for Most-recent single-stream (F2 reproduce bug)");
    },
  });

  const result = await assembleExplorerData({ q: "hdmi cable", search_sort: "recent" }, ds, "https://rs.test");

  // PRE-FIX: queryRecordsCalled=true (assembler called queryRecords, returning ALL records).
  // POST-FIX: queryRecordsCalled=false (assembler calls lexical, returning only matching records).
  assert.equal(
    queryRecordsCalled,
    false,
    "queryRecords must NOT be called for Most-recent single-stream (F2 fix: lexical is the matching-records path)"
  );
  assert.ok(
    lexicalCalledWithStream,
    "searchRecordsLexical must be called with streams=['orders'] to scope the query (F2 fix)"
  );
  assert.equal(result.fromSearch, true);
  // Only the matching record must appear (not the whole stream).
  assert.equal(result.feed.length, 1);
  assert.equal(result.feed[0]?.recordId, "matching-order");
});

// ─── F2: Most-recent search_sort returns non-matching records (multi-stream) ──
//
// BUG (pre-fix): multi-stream Most-recent set searchHasMore=false and searchNextCursor=null
// unconditionally, so the "Browse all matching records" escape ramp was not actually
// exhaustible — the user was stuck after page 1.
//
// FIX: wire the lexical cursor so searchHasMore/searchNextCursor reflect the real
// pagination state and subsequent pages advance through MATCHING records.
//
// PRE-FIX FAILURE: result.searchHasMore === false even though the stub returns has_more=true.
// POST-FIX: result.searchHasMore === true and searchNextCursor carries the cursor.

test("F2 (P0): multi-stream Most-recent wires lexical cursor — searchHasMore reflects actual has_more", async () => {
  const summaryA = makeSummary({ connection_id: "cin_ynab_1", connector_id: "ynab", streams: ["transactions"] });
  const summaryB = makeSummary({ connection_id: "cin_amazon_1", connector_id: "amazon", streams: ["orders"] });
  const hitA = makeHit({
    connector_id: "ynab",
    stream: "transactions",
    connection_id: "cin_ynab_1",
    record_key: "ynab-rec",
  });
  const hitB = makeHit({
    connector_id: "amazon",
    stream: "orders",
    connection_id: "cin_amazon_1",
    record_key: "amz-rec",
  });

  const ds = makeDataSource({
    listConnectorSummaries: async () => summaryListResponse([summaryA, summaryB]),
    listConnectorManifests: async () => [makeManifest("ynab", ["transactions"]), makeManifest("amazon", ["orders"])],
    // Lexical returns has_more=true with a cursor to simulate a deep result set.
    searchRecordsLexical: async () => makeLexicalPage([hitA, hitB], { has_more: true, next_cursor: "lex-cursor-99" }),
    queryRecords: async () => {
      throw new Error("queryRecords must not be called for multi-stream Most-recent");
    },
  });

  const result = await assembleExplorerData({ q: "payment", search_sort: "recent" }, ds, "https://rs.test");

  // PRE-FIX: result.searchHasMore === false, result.searchNextCursor === null
  //          (cursor was hardcoded as false/null regardless of lexical response).
  // POST-FIX: result.searchHasMore === true, result.searchNextCursor === "lex-cursor-99".
  assert.equal(
    result.searchHasMore,
    true,
    "searchHasMore must be true when lexical has_more=true (F2 fix: was hardcoded false pre-fix)"
  );
  assert.equal(
    result.searchNextCursor,
    "lex-cursor-99",
    "searchNextCursor must carry the lexical cursor (F2 fix: was hardcoded null pre-fix)"
  );
  assert.equal(result.fromSearch, true);
  assert.ok(result.feed.length > 0, "feed must contain matching records");
});

// ─── F3: connector_instance_id not used — wrong connection identity resolved ──
//
// BUG (pre-fix): `timelineRecordToEntry` resolved the connection summary by
// `s.connector_id === rec.connector_id` (connector TYPE). When a record carries
// connector_instance_id (connection INSTANCE), the correct summary must be found
// by connector_instance_id so the right connectionId, displayName, and peek URLs
// are used — not just "the first connection of the same type".
//
// Example: two YNAB connections (cin_ynab_personal, cin_ynab_work). A record from
// cin_ynab_work resolved to cin_ynab_personal pre-fix because both share connector_id="ynab".
//
// FIX: match by connector_instance_id first; fall back to connector_id only when
// connector_instance_id is absent or unrecognized.
//
// PRE-FIX FAILURE: result.feed[0].connectionId === "cin_ynab_personal" (wrong instance).
// POST-FIX: result.feed[0].connectionId === "cin_ynab_work" (correct instance).

test("F3 (P1): timelineRecordToEntry uses connector_instance_id to resolve correct connection identity", async () => {
  // Two YNAB connections — same connector type, different instances.
  const personalSummary = makeSummary({
    connection_id: "cin_ynab_personal",
    connector_id: "ynab",
    connector_instance_id: "cin_ynab_personal",
    streams: ["transactions"],
    display_name: "YNAB Personal",
  });
  const workSummary = makeSummary({
    connection_id: "cin_ynab_work",
    connector_id: "ynab",
    connector_instance_id: "cin_ynab_work",
    streams: ["transactions"],
    display_name: "YNAB Work",
  });

  // Record belongs to the WORK instance.
  const workRecord = makeTimelineRecord({
    connector_id: "ynab", // type: "ynab"
    connector_instance_id: "cin_ynab_work", // instance: work
    stream: "transactions",
    record_key: "work-txn-1",
  });

  const ds = makeDataSource({
    listConnectorSummaries: async () => summaryListResponse([personalSummary, workSummary]),
    listConnectorManifests: async () => [makeManifest("ynab", ["transactions"])],
    // The endpoint returns a record whose connector_instance_id = "cin_ynab_work".
    listExploreTimeline: async () => makeTimelinePage([workRecord]),
  });

  const result = await assembleExplorerData({}, ds, "https://rs.test");

  assert.equal(result.feed.length, 1);
  const entry = result.feed[0];
  assert.ok(entry, "Feed must have one entry");

  // PRE-FIX: entry.connectionId === "cin_ynab_personal" (wrong — first type match wins).
  // POST-FIX: entry.connectionId === "cin_ynab_work" (correct — instance match wins).
  assert.equal(
    entry.connectionId,
    "cin_ynab_work",
    `connectionId must be cin_ynab_work (the actual instance); got ${entry.connectionId} — (F3 fix: was matching by connector_id type, not connector_instance_id)`
  );

  // connector_id must still be the TYPE ("ynab") for display labeling.
  assert.equal(
    entry.connectorId,
    "ynab",
    "connectorId must be the connector type 'ynab' (for display labels and manifest lookup)"
  );

  // connectionDisplayName must resolve from the WORK summary, not personal.
  assert.ok(
    entry.connectionDisplayName?.includes("Work") || entry.connectionDisplayName?.includes("YNAB Work"),
    `connectionDisplayName must come from the work summary; got "${entry.connectionDisplayName}"`
  );
});

// ─── F3: connectionId must not fall back to the connector_id TYPE string ──────
//
// BUG (pre-fix): when no summary matched AT ALL (no instance match, no type match),
// `connectionId` fell back to `rec.connector_id` — the connector TYPE string (e.g.
// "twitter") — rather than `rec.connector_instance_id` (the actual instance id). This
// caused connectionId to carry a type label instead of an instance identifier.
//
// FIX: when no summary matches, `connectionId` falls back to `rec.connector_instance_id`
// so the entry's connectionId is always an INSTANCE identifier, never the TYPE.
//
// PRE-FIX FAILURE: entry.connectionId === "twitter" (the type).
// POST-FIX: entry.connectionId === "cin_twitter_unknown" (the instance id).

test("F3 (P1): connectionId falls back to connector_instance_id (not connector_id type) when no summary matches at all", async () => {
  // A single Amazon summary exists, but the record is from "twitter" — completely different type,
  // so NO fallback-by-type match is possible either.
  const amazonSummary = makeSummary({
    connection_id: "cin_amazon_1",
    connector_id: "amazon",
    connector_instance_id: "cin_amazon_1",
    streams: ["orders"],
    display_name: "Amazon",
  });

  // Record from "twitter" — no twitter summary exists in the owner's connections.
  const twitterRecord = makeTimelineRecord({
    connector_id: "twitter",
    connector_instance_id: "cin_twitter_unknown",
    stream: "tweets",
    record_key: "tweet-999",
  });

  const ds = makeDataSource({
    listConnectorSummaries: async () => summaryListResponse([amazonSummary]),
    listConnectorManifests: async () => [makeManifest("amazon", ["orders"])],
    listExploreTimeline: async () => makeTimelinePage([twitterRecord]),
  });

  const result = await assembleExplorerData({}, ds, "https://rs.test");

  // The record still appears (we do not drop records whose connection is unknown).
  assert.equal(result.feed.length, 1);
  const entry = result.feed[0];
  assert.ok(entry, "Feed must have one entry");

  // PRE-FIX: entry.connectionId === "twitter" (the connector_id TYPE was used as fallback,
  //          because the old code was: `const connectionId = summary?.connection_id ?? rec.connector_id`).
  // POST-FIX: entry.connectionId === "cin_twitter_unknown" (connector_instance_id is the fallback).
  assert.notEqual(
    entry.connectionId,
    "twitter",
    "connectionId must not be the connector_id TYPE 'twitter' — it must be an instance id (F3 fix)"
  );
  assert.equal(
    entry.connectionId,
    "cin_twitter_unknown",
    `connectionId must be the connector_instance_id; got "${entry.connectionId}" (F3 fix: was rec.connector_id pre-fix)`
  );

  // connector_id must still be the TYPE for display/manifest lookup.
  assert.equal(entry.connectorId, "twitter");
});
