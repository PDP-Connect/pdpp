/**
 * Lexical recall-window honesty (Codex Explore HOLD regression).
 *
 * The server discloses recall on lexical search responses (per
 * `disclose-lexical-recall-windows`): `count` / `count_accuracy` and a
 * `recall: { ranking_scope, complete, ... }`. When the ranking scope is a
 * bounded `candidate_window` (recall NOT complete, count is a `lower_bound`),
 * the result is a ranked SAMPLE — there may be matching records the ranker
 * never scored, so the cursor cannot page to the true end.
 *
 * THE BUG (Codex HOLD): the branch promoted EVERY non-hybrid lexical
 * Most-relevant page to a `keyword_pageable` descriptor (completeness
 * "pageable"), which the canvas reads as exhaustive — it offers a deep cursor
 * Load-more and an exhaustive "Browse all matching records" door. Over a bounded
 * candidate window that is a lie: it promises records the ranker never saw.
 *
 * THE FIX (structural, via the set-descriptor): a bounded candidate window is
 * classified `relevance_bounded` — a bounded sample with NO sound deep
 * pagination (`has_more: false`, `cursor: null`, `completeness:
 * "bounded_sample"`). The canvas's exhaustive copy is unreachable for that kind.
 *
 * This suite pins BOTH directions: a bounded window must NOT be pageable, and a
 * proven full-corpus window still IS pageable (the fix is targeted, not a
 * blanket downgrade).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DashboardDataSource } from "../lib/data-source.ts";
import type { ListResponse, RefConnectorSummary } from "../lib/ref-client.ts";
import type { ConnectorManifest, RecordsPage, SearchResultHit, SearchResultPage } from "../lib/rs-client.ts";
import { assembleExplorerData } from "./explore-data-assembler.ts";

/** A bounded-window summary must never claim completeness. */
const CLAIMS_COMPLETENESS_RE = /all matching|complete|every match/i;

function summary(): RefConnectorSummary {
  return {
    connector_display_name: "YNAB",
    connector_id: "ynab",
    connection_id: "ynab-1",
    connector_instance_id: "ynab-1",
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

function manifest(): ConnectorManifest {
  return {
    connector_id: "ynab",
    streams: [{ name: "transactions", schema: { properties: { title: { type: "string" } } } }],
  };
}

function hit(recordKey: string): SearchResultHit {
  return {
    connector_id: "ynab",
    connection_id: "ynab-1",
    stream: "transactions",
    record_key: recordKey,
    emitted_at: "2026-01-01T00:00:00Z",
    matched_fields: [],
    object: "search_result",
  };
}

/** A lexical page whose recall is a BOUNDED candidate window (not exhaustive). */
function boundedCandidateWindowPage(hits: SearchResultHit[]): SearchResultPage {
  return {
    object: "list",
    data: hits,
    has_more: true,
    next_cursor: "cand-window-next",
    // The recall disclosure that makes this a SAMPLE, not a complete set.
    count: hits.length,
    count_accuracy: "lower_bound",
    recall: {
      complete: false,
      ranking_scope: "candidate_window",
      candidate_window_limit: hits.length,
      ranked_candidate_count: hits.length,
    },
  };
}

/** A lexical page whose recall is PROVEN over the full corpus (exhaustive). */
function fullCorpusPage(hits: SearchResultHit[]): SearchResultPage {
  return {
    object: "list",
    data: hits,
    has_more: true,
    next_cursor: "full-corpus-next",
    count: hits.length,
    count_accuracy: "exact",
    recall: { complete: true, ranking_scope: "all_matches" },
  };
}

function dataSource(page: SearchResultPage): DashboardDataSource {
  const summaries = [summary()];
  const unused = (): never => {
    throw new Error("not used in the search-lens recall-window suite");
  };
  return {
    kind: "live",
    aggregateRecordsByTime: unused,
    listExploreRecordBuckets: unused,
    listConnectorSummaries: (): Promise<ListResponse<RefConnectorSummary>> =>
      Promise.resolve({ object: "list", data: summaries, has_more: false }),
    listConnectorManifests: () => Promise.resolve([manifest()]),
    listExploreTimeline: () => Promise.reject(new Error("not used in search lens")),
    getStreamMetadata: (_c, stream) =>
      Promise.resolve({ name: stream, object: "stream_metadata", field_capabilities: {} }),
    queryRecords: (): Promise<RecordsPage> => Promise.resolve({ data: [], has_more: false, object: "list" }),
    getConnectorOverview: () => Promise.resolve(unused()),
    getDatasetSummary: () => Promise.resolve(unused()),
    getDeploymentDiagnostics: () => Promise.resolve(unused()),
    getGrantTimeline: () => Promise.resolve(null),
    getRecord: () => Promise.resolve(unused()),
    getRunTimeline: () => Promise.resolve(null),
    getTraceTimeline: () => Promise.resolve(null),
    isHybridRetrievalAdvertised: () => Promise.resolve(false),
    isSemanticRetrievalAdvertised: () => Promise.resolve(false),
    listGrants: () => Promise.resolve({ object: "list", data: [], has_more: false }),
    listPendingApprovals: () => Promise.resolve({ object: "list", data: [], has_more: false }),
    listRuns: () => Promise.resolve({ object: "list", data: [], has_more: false }),
    listStreams: () => Promise.resolve([]),
    listTraces: () => Promise.resolve({ object: "list", data: [], has_more: false }),
    refSearch: () => Promise.resolve({ object: "search_result", traces: [], grants: [], runs: [], exact: null }),
    searchRecordsHybrid: () => Promise.resolve({ object: "list", data: [], has_more: false, warnings: [] }),
    searchRecordsLexical: () => Promise.resolve(page),
    searchRecordsSemantic: () => Promise.resolve({ object: "list", data: [], has_more: false, warnings: [] }),
  } satisfies DashboardDataSource;
}

test("bounded lexical candidate window is relevance_bounded, NOT pageable-exhaustive", async () => {
  const ds = dataSource(boundedCandidateWindowPage([hit("r1"), hit("r2")]));
  const data = await assembleExplorerData({ q: "coffee" }, ds, "https://rs.test");

  // The descriptor MUST be a bounded sample — never the exhaustive keyword
  // descriptor. This is the structural close of the HOLD: the canvas's
  // "Browse all matching records" / deep Load-more are unreachable for this kind.
  assert.equal(data.descriptor.kind, "relevance_bounded", "candidate-window recall must be a bounded sample");
  assert.equal(data.descriptor.completeness, "bounded_sample");
  assert.equal(data.descriptor.has_more, false, "a bounded sample has no sound deep pagination");
  assert.equal(data.descriptor.cursor, null, "a bounded sample exposes no exhaustive cursor");

  // The feed must NOT advertise an exhaustive cursor: no searchNextCursor, and
  // searchHasMore false — so the canvas cannot promise more matching records.
  assert.equal(data.searchHasMore, false, "candidate-window recall must not claim more pageable results");
  assert.equal(data.searchNextCursor, null, "candidate-window recall must not forward a deep cursor");

  // And the activity summary must not imply a complete count — it is a sample
  // line that points to the per-stream escape, never "N records returned" as a
  // total.
  assert.equal(data.activitySummary?.source, "bounded_sample");
  assert.doesNotMatch(
    data.activitySummary?.text ?? "",
    CLAIMS_COMPLETENESS_RE,
    "the bounded-window summary must not claim completeness"
  );
});

test("proven full-corpus lexical recall stays keyword_pageable (fix is targeted, not a blanket downgrade)", async () => {
  const ds = dataSource(fullCorpusPage([hit("r1"), hit("r2")]));
  const data = await assembleExplorerData({ q: "coffee" }, ds, "https://rs.test");

  // When the server proves full-corpus recall the cursor pages to the true end,
  // so the exhaustive descriptor (and "Browse all matching records") is honest.
  assert.equal(data.descriptor.kind, "keyword_pageable", "full-corpus recall is exhaustively pageable");
  assert.equal(data.descriptor.completeness, "pageable");
  assert.equal(data.descriptor.has_more, true);
  assert.equal(data.descriptor.cursor, "full-corpus-next");
  assert.equal(data.searchHasMore, true);
  assert.equal(data.searchNextCursor, "full-corpus-next");
});
