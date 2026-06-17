/**
 * Default Explore feed performance contract.
 *
 * The empty-query Explore page is a first-paint overview, not an exhaustive
 * export. It must remain bounded even when the owner has many connections and
 * streams; explicit query/filter/time-window interactions are the deep-read
 * paths. This test pins the fan-out budget so the live page cannot regress to
 * dozens of per-stream reads before rendering.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DashboardDataSource } from "../lib/data-source.ts";
import type { RefConnectorSummary } from "../lib/ref-client.ts";
import type { ConnectorManifest, RecordsPage, StreamMetadata, StreamRecord } from "../lib/rs-client.ts";
import { assembleExplorerData } from "./explore-data-assembler.ts";

function summary(index: number): RefConnectorSummary {
  const connectorId = `connector_${index}`;
  return {
    connector_display_name: `Connector ${index}`,
    connector_id: connectorId,
    connection_id: `cin_${index}`,
    connector_instance_id: `cin_${index}`,
    display_name: `Source ${index}`,
    freshness: {},
    last_run: null,
    last_successful_run: null,
    manifest_version: "test",
    schedule: null,
    stream_count: 3,
    streams: ["alpha", "beta", "gamma"],
    total_records: 100,
  } as RefConnectorSummary;
}

function manifest(index: number): ConnectorManifest {
  return {
    connector_id: `connector_${index}`,
    streams: [
      { name: "alpha", schema: { properties: { title: { type: "string" } } } },
      { name: "beta", schema: { properties: { title: { type: "string" } } } },
      { name: "gamma", schema: { properties: { title: { type: "string" } } } },
    ],
  };
}

function record(connectorId: string, stream: string, index: number): StreamRecord {
  return {
    data: { title: `${connectorId}/${stream}/${index}` },
    emitted_at: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    id: `${connectorId}_${stream}_${index}`,
    object: "record",
    stream,
  };
}

test("empty-query Explore keeps first-paint fan-out bounded", async () => {
  const summaries = Array.from({ length: 10 }, (_, i) => summary(i));
  const queryCalls: Array<{ connectorId: string; limit: number | undefined; stream: string }> = [];
  const metadataCalls: Array<{ connectorId: string; stream: string }> = [];

  const dataSource = {
    kind: "live",
    listConnectorSummaries: async () => ({ object: "list", data: summaries, has_more: false }),
    listConnectorManifests: async () => summaries.map((_, i) => manifest(i)),
    getStreamMetadata: async (connectorId: string, stream: string): Promise<StreamMetadata> => {
      metadataCalls.push({ connectorId, stream });
      return { name: stream, object: "stream_metadata", field_capabilities: {} };
    },
    queryRecords: async (connectorId: string, stream: string, opts): Promise<RecordsPage> => {
      queryCalls.push({ connectorId, stream, limit: opts?.limit });
      return {
        data: [record(connectorId, stream, queryCalls.length)],
        has_more: false,
        object: "list",
      };
    },
    getConnectorOverview: async () => {
      throw new Error("not used");
    },
    getDatasetSummary: async () => {
      throw new Error("not used");
    },
    getDeploymentDiagnostics: async () => {
      throw new Error("not used");
    },
    getGrantTimeline: async () => null,
    getRecord: async () => {
      throw new Error("not used");
    },
    getRunTimeline: async () => null,
    getTraceTimeline: async () => null,
    isHybridRetrievalAdvertised: async () => false,
    isSemanticRetrievalAdvertised: async () => false,
    listGrants: async () => ({ object: "list", data: [], has_more: false }),
    listPendingApprovals: async () => ({ object: "list", data: [], has_more: false }),
    listRuns: async () => ({ object: "list", data: [], has_more: false }),
    listStreams: async () => [],
    listTraces: async () => ({ object: "list", data: [], has_more: false }),
    refSearch: async () => ({ object: "search_result", traces: [], grants: [], runs: [], exact: null }),
    searchRecordsHybrid: async () => ({ object: "list", data: [], has_more: false, warnings: [] }),
    searchRecordsLexical: async () => ({ object: "list", data: [], has_more: false, warnings: [] }),
    searchRecordsSemantic: async () => ({ object: "list", data: [], has_more: false, warnings: [] }),
  } satisfies DashboardDataSource;

  const data = await assembleExplorerData({}, dataSource, "https://pdpp.example.test");

  assert.equal(queryCalls.length, 12);
  assert.equal(metadataCalls.length, 12);
  assert.deepEqual([...new Set(queryCalls.map((call) => call.limit))], [6]);
  assert.equal(data.feed.length, 12);
  assert.equal(data.activitySummary?.source, "bounded_sample");
  assert.ok(data.feed.length <= 32);
});
