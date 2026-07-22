// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Explore SORT direction wiring (sort cell §1/§2 — T12).
 *
 * "oldest" must be a REAL server re-page ASCENDING, never a client `.reverse()`
 * of the loaded window (a window reverse can't reach the true earliest record).
 * This test pins the ASSEMBLER side of that contract: `order=oldest` makes
 * `assembleExplorerData` pass `direction:"asc"` to the merged-timeline endpoint on
 * EVERY page request, and the default (`order` absent / "newest") passes no
 * ascending direction (newest-first). The server-side ascending merge itself is
 * proven in reference-implementation/test/rs-explore-timeline-oldest-ascending.test.js.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DashboardDataSource } from "../lib/data-source.ts";
import type { ExploreTimelinePage, RefConnectorSummary } from "../lib/ref-client.ts";
import type { ConnectorManifest, RecordsPage, StreamMetadata } from "../lib/rs-client.ts";
import { assembleExplorerData } from "./explore-data-assembler.ts";

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
  } as ConnectorManifest;
}

function emptyTimelinePage(): ExploreTimelinePage {
  return {
    object: "list",
    data: [],
    has_more: false,
    next_cursor: null,
    snapshot_at: SNAPSHOT_AT,
    new_since_snapshot: 0,
  };
}

const notStubbed = () => Promise.reject(new Error("not stubbed"));

/** A fake source that records the `direction` opt of each listExploreTimeline call. */
function makeDirectionCapturingSource(
  captured: Array<"asc" | "desc" | undefined>,
  supportsTimelineDirection = true
): DashboardDataSource {
  return {
    kind: "live",
    aggregateRecordsByTime: notStubbed,
    listExploreRecordBuckets: notStubbed,
    supportsExploreTimelineDirection: async () => supportsTimelineDirection,
    listConnectorSummaries: () => Promise.resolve({ object: "list" as const, data: [ynabSummary()], has_more: false }),
    listConnectorManifests: () => Promise.resolve([ynabManifest()]),
    listExploreTimeline: (opts): Promise<ExploreTimelinePage> => {
      captured.push(opts?.direction);
      return Promise.resolve(emptyTimelinePage());
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

test("T12 order=oldest passes direction:'asc' to the merged-timeline endpoint (a server re-page, not a client reverse)", async () => {
  const captured: Array<"asc" | "desc" | undefined> = [];
  const ds = makeDirectionCapturingSource(captured);

  await assembleExplorerData({ order: "oldest" }, ds, "https://rs.test");

  assert.ok(captured.length >= 1, "the empty-query feed must hit listExploreTimeline");
  for (const dir of captured) {
    assert.equal(dir, "asc", "order=oldest must request the ASCENDING server keyset walk on every page");
  }
});

test("default order (newest) requests no ascending direction (newest-first browse)", async () => {
  const captured: Array<"asc" | "desc" | undefined> = [];
  const ds = makeDirectionCapturingSource(captured);

  await assembleExplorerData({}, ds, "https://rs.test");

  assert.ok(captured.length >= 1, "the empty-query feed must hit listExploreTimeline");
  for (const dir of captured) {
    assert.notEqual(dir, "asc", "the default browse feed must NOT request ascending (it is newest-first)");
  }
});

test("oldest re-page also threads through a multi-page Load-more trail (every page ascending)", async () => {
  const captured: Array<"asc" | "desc" | undefined> = [];
  const ds = makeDirectionCapturingSource(captured);

  // A 2-cursor trail → page 1 (rewind trail[0]) + trail[0] + trail[1] = 3 fetches,
  // all of which must carry direction:"asc" so the accumulated oldest-first view
  // stays a single ascending walk.
  await assembleExplorerData({ order: "oldest", cursors: "c1,c2", anchor: SNAPSHOT_AT }, ds, "https://rs.test");

  assert.ok(captured.length >= 3, "a 2-cursor trail fetches page 1 + 2 trail cursors");
  for (const dir of captured) {
    assert.equal(dir, "asc", "every page of an oldest-first trail must stay ascending");
  }
});

test("oldest no-ops to newest-first when the server direction substrate is not advertised", async () => {
  const captured: Array<"asc" | "desc" | undefined> = [];
  const ds = makeDirectionCapturingSource(captured, false);

  await assembleExplorerData({ order: "oldest", cursors: "c1,c2", anchor: SNAPSHOT_AT }, ds, "https://rs.test");

  assert.ok(captured.length >= 3, "the guarded feed still loads the requested trail");
  for (const dir of captured) {
    assert.notEqual(dir, "asc", "without advertised support, order=oldest must not request ascending");
  }
});
