// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Default Explore feed performance contract.
 *
 * The empty-query Explore page is a first-paint overview, not an exhaustive
 * export. It must remain bounded even when the owner has many connections and
 * streams; explicit query/filter/time-window interactions are the deep-read
 * paths. This test pins the first-paint budget so the live page cannot regress
 * to per-stream reads before rendering.
 *
 * Architecture note: the empty-query "recent" lens was previously a client-side
 * fan-out (loadEmptyQueryFeed, one queryRecords call per stream). It is now a
 * single merged-timeline endpoint call (listExploreTimeline) with a bounded
 * limit. The old fan-out function and its cursor helpers were deleted. This test
 * has been updated to assert the NEW correct first-paint property: one
 * listExploreTimeline call with limit <= FEED_TOTAL_CAP (32), zero per-stream
 * queryRecords calls, and no getStreamMetadata calls.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DashboardDataSource } from "../lib/data-source.ts";
import type { ExploreTimelinePage, RefConnectorIdentitySummary } from "../lib/ref-client.ts";
import type { ConnectorManifest, RecordsPage, StreamMetadata } from "../lib/rs-client.ts";
import { assembleExplorerData } from "./explore-data-assembler.ts";

function summary(index: number): RefConnectorIdentitySummary {
  const connectorId = `connector_${index}`;
  return {
    connection_id: `cin_${index}`,
    connector_display_name: `Connector ${index}`,
    connector_id: connectorId,
    connector_instance_id: `cin_${index}`,
    display_name: `Source ${index}`,
    membership_state: "complete",
    streams: ["alpha", "beta", "gamma"],
  };
}

function manifest(index: number): ConnectorManifest {
  return {
    connector_id: `connector_${index}`,
    streams: [
      {
        name: "alpha",
        schema: {
          properties: {
            attachment: { type: "object", x_pdpp_type: "blob" },
            title: { type: "string" },
          },
        },
      },
      { name: "beta", schema: { properties: { title: { type: "string" } } } },
      { name: "gamma", schema: { properties: { title: { type: "string" } } } },
    ],
  };
}

test("empty-query Explore keeps first-paint endpoint call bounded", async () => {
  // The recent lens is now a single merged-timeline endpoint (listExploreTimeline),
  // not a per-stream fan-out. First-paint must make exactly ONE call to that
  // endpoint with a bounded limit (FEED_TOTAL_CAP = 32) and zero per-stream
  // queryRecords or getStreamMetadata calls.
  const summaries = Array.from({ length: 10 }, (_, i) => summary(i));
  const timelineCalls: Array<{ limit: number | undefined; cursor: string | null | undefined }> = [];
  const queryCalls: Array<{ connectorId: string; stream: string }> = [];
  const metadataCalls: Array<{ connectorId: string; stream: string }> = [];

  const dataSource = {
    // biome-ignore lint/suspicious/useAwait: Async test callback contract is intentional; changing it would alter node:test completion semantics.
    aggregateRecordsByTime: async () => {
      throw new Error("aggregateRecordsByTime not stubbed");
    },
    // biome-ignore lint/suspicious/useAwait: Async test callback contract is intentional; changing it would alter node:test completion semantics.
    getConnectorOverview: async () => {
      throw new Error("not used");
    },
    // biome-ignore lint/suspicious/useAwait: Async test callback contract is intentional; changing it would alter node:test completion semantics.
    getDatasetSummary: async () => {
      throw new Error("not used");
    },
    // biome-ignore lint/suspicious/useAwait: Async test callback contract is intentional; changing it would alter node:test completion semantics.
    getDeploymentDiagnostics: async () => {
      throw new Error("not used");
    },
    getGrantTimeline: async () => null,
    // biome-ignore lint/suspicious/useAwait: Async test callback contract is intentional; changing it would alter node:test completion semantics.
    getRecord: async () => {
      throw new Error("not used");
    },
    getRunTimeline: async () => null,
    // biome-ignore lint/suspicious/useAwait: Async test callback contract is intentional; changing it would alter node:test completion semantics.
    getStreamMetadata: async (connectorId: string, stream: string): Promise<StreamMetadata> => {
      metadataCalls.push({ connectorId, stream });
      return { field_capabilities: {}, name: stream, object: "stream_metadata" };
    },
    getTraceTimeline: async () => null,
    isHybridRetrievalAdvertised: async () => false,
    isSemanticRetrievalAdvertised: async () => false,
    kind: "live",
    listConnectorManifests: async () => summaries.map((_, i) => manifest(i)),
    listConnectorSummaries: (async () => ({
      data: summaries,
      has_more: false,
      object: "list",
    })) as unknown as DashboardDataSource["listConnectorSummaries"],
    // biome-ignore lint/suspicious/useAwait: Async test callback contract is intentional; changing it would alter node:test completion semantics.
    listExploreRecordBuckets: async () => {
      throw new Error("listExploreRecordBuckets not stubbed");
    },
    // biome-ignore lint/suspicious/useAwait: Async test callback contract is intentional; changing it would alter node:test completion semantics.
    listExploreTimeline: async (opts): Promise<ExploreTimelinePage> => {
      timelineCalls.push({ cursor: opts?.cursor, limit: opts?.limit });
      // Return a handful of records from two different connectors/streams so the
      // assembler has real entries to process.
      return {
        data: [
          {
            connector_id: "connector_0",
            connector_instance_id: "cin_0",
            data: { title: "one" },
            emitted_at: "2026-01-01T00:00:00Z",
            object: "timeline_record" as const,
            record_key: "r1",
            stream: "alpha",
          },
          {
            connector_id: "connector_1",
            connector_instance_id: "cin_1",
            data: { title: "two" },
            emitted_at: "2026-01-02T00:00:00Z",
            object: "timeline_record" as const,
            record_key: "r2",
            stream: "beta",
          },
        ],
        has_more: false,
        new_since_snapshot: 0,
        next_cursor: null,
        object: "list",
        snapshot_at: "2026-06-19T00:00:00Z",
      };
    },
    listGrants: async () => ({ data: [], has_more: false, object: "list" }),
    listPendingApprovals: async () => ({ data: [], has_more: false, object: "list" }),
    listRuns: async () => ({ data: [], has_more: false, object: "list" }),
    listStreams: async () => [],
    listTraces: async () => ({ data: [], has_more: false, object: "list" }),
    // biome-ignore lint/suspicious/useAwait: Async test callback contract is intentional; changing it would alter node:test completion semantics.
    queryRecords: async (connectorId: string, stream: string): Promise<RecordsPage> => {
      queryCalls.push({ connectorId, stream });
      return { data: [], has_more: false, object: "list" };
    },
    refSearch: async () => ({ exact: null, grants: [], object: "search_result", runs: [], traces: [] }),
    searchRecordsHybrid: async () => ({ data: [], has_more: false, object: "list", warnings: [] }),
    searchRecordsLexical: async () => ({ data: [], has_more: false, object: "list", warnings: [] }),
    searchRecordsSemantic: async () => ({ data: [], has_more: false, object: "list", warnings: [] }),
  } satisfies DashboardDataSource;

  const data = await assembleExplorerData({}, dataSource, "https://pdpp.example.test");

  // One call to the merged endpoint -- not N per-stream calls.
  assert.equal(timelineCalls.length, 1, "recent lens must make exactly one listExploreTimeline call");
  // The limit must be bounded (FEED_TOTAL_CAP = 32).
  assert.ok(
    (timelineCalls[0]?.limit ?? 0) <= 32,
    "listExploreTimeline limit must be <= 32 (FEED_TOTAL_CAP) to keep first-paint bounded"
  );
  // No per-stream fan-out calls -- these are the performance regression we are guarding against.
  assert.equal(queryCalls.length, 0, "recent lens must not make any per-stream queryRecords calls");
  assert.equal(metadataCalls.length, 0, "recent lens must not make any getStreamMetadata calls at first paint");
  // Feed must contain the records returned by the endpoint.
  assert.ok(data.feed.length <= 32, "feed must not exceed FEED_TOTAL_CAP");
  assert.equal(data.feed.length, 2, "feed must contain the 2 records returned by the endpoint");
});
