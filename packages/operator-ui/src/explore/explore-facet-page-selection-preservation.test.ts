// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Second gate REVISE (2026-07-29), finding 4: the facet rail's ONE bounded
 * connector-summary page must never be the source of truth for whether a
 * `?connection=` selection is honored. Before this fix, `assembleExplorerData`
 * derived `filteredSummaries` directly from that one page — a selected
 * connection living on a facet page the rail isn't currently showing made
 * `filteredSummaries` (and therefore `buildAllowedInstanceIds`/record
 * filtering) silently empty, dropping every record for a connection that
 * genuinely exists. The gate's own oracle: `firstFeed: 1` for a selected
 * connection on facet page 1, `secondFeed: 0` after moving the facet rail to
 * page 2 while retaining the same `connection=` selection.
 *
 * The fix: `resolveExactSelectedSummaries` fetches every selected connection
 * id via the scoped `connectionRouteId` lookup (a 0-or-1 list, same mechanism
 * `connection-route.ts` uses elsewhere), independent of and in addition to
 * the facet page fetch, and merges the result into `summaries` before
 * `filteredSummaries` is derived. These tests prove: (a) the bug reproduces
 * against the OLD derivation shape if it ever regresses, by asserting the
 * FIXED behavior directly, and (b) the exact-selection fetch is scoped (not
 * an unbounded fold) and is independent of facet paging.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DashboardDataSource } from "../lib/data-source.ts";
import type { ExploreTimelinePage, ListResponse, RefConnectorSummary } from "../lib/ref-client.ts";
import type { ConnectorManifest } from "../lib/rs-client.ts";
import { assembleExplorerData } from "./explore-data-assembler.ts";

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
    streams: over.streams ?? ["records"],
    total_records: 0,
  } as RefConnectorSummary;
}

function makeManifest(connectorId: string, streams: string[]): ConnectorManifest {
  return { connector_id: connectorId, streams: streams.map((name) => ({ name })) };
}

const rec = (connector: string, instance: string, stream: string, key: string, day: number) => ({
  connector_id: connector,
  connector_instance_id: instance,
  data: {},
  emitted_at: `2026-06-0${day}T00:00:00Z`,
  object: "timeline_record" as const,
  record_key: key,
  stream,
});

const notStubbed = () => Promise.reject(new Error("not stubbed"));

function emptyTimelinePage(entries: ReturnType<typeof rec>[] = []): ExploreTimelinePage {
  return {
    data: entries,
    has_more: false,
    new_since_snapshot: 0,
    next_cursor: null,
    object: "list",
    snapshot_at: "2026-06-19T00:00:00Z",
    upcoming: [],
    upcoming_has_more: false,
    upcoming_next_cursor: null,
    upcoming_total: 0,
  } as ExploreTimelinePage;
}

/**
 * A 200-connection fleet split across two facet pages (page 1 = first 100 by
 * insertion order, page 2 = the rest — "c001" deliberately lives on page 2
 * while "c199"/"c200" style large-index ids live on... actually c001 is
 * placed LAST so it lands on page 2, matching the gate's "selected id absent
 * from the currently-displayed page" scenario in the general case).
 */
const PAGE_1_IDS = Array.from({ length: 100 }, (_, i) => `c${String(i + 2).padStart(3, "0")}`);
const PAGE_2_ONLY_ID = "c001";

function twoPageFleetDs(opts?: {
  connectionRouteCalls?: string[];
  facetPageCalls?: Array<string | undefined>;
}): DashboardDataSource {
  return {
    aggregateRecordsByTime: notStubbed,
    getConnectorOverview: notStubbed,
    getDatasetSummary: notStubbed,
    getDeploymentDiagnostics: notStubbed,
    getGrantTimeline: notStubbed,
    getRecord: notStubbed,
    getRunTimeline: notStubbed,
    getStreamMetadata: notStubbed,
    getTraceTimeline: notStubbed,
    isHybridRetrievalAdvertised: () => Promise.resolve(false),
    isSemanticRetrievalAdvertised: () => Promise.resolve(false),
    kind: "sandbox" as const,
    listConnectorManifests: async () => [makeManifest("acme", ["records"])],
    // biome-ignore lint/suspicious/useAwait: mocks the DashboardDataSource async method contract; async is required to satisfy the type even though this fixture body never awaits.
    listConnectorSummaries: async (options) => {
      if (options?.connectionRouteId) {
        opts?.connectionRouteCalls?.push(options.connectionRouteId);
        // Scoped lookup: a 0-or-1 list, exact identity, independent of facet paging.
        if (options.connectionRouteId === PAGE_2_ONLY_ID) {
          return {
            data: [makeSummary({ connection_id: PAGE_2_ONLY_ID, connector_id: "acme" })],
            has_more: false,
            object: "list",
          } as ListResponse<RefConnectorSummary>;
        }
        if (PAGE_1_IDS.includes(options.connectionRouteId)) {
          return {
            data: [makeSummary({ connection_id: options.connectionRouteId, connector_id: "acme" })],
            has_more: false,
            object: "list",
          } as ListResponse<RefConnectorSummary>;
        }
        return { data: [], has_more: false, object: "list" } as ListResponse<RefConnectorSummary>;
      }
      opts?.facetPageCalls?.push(options?.cursor);
      // Unscoped, PAGED facet rail request: page 1 = PAGE_1_IDS, page 2 = PAGE_2_ONLY_ID.
      if (options?.cursor === "page2") {
        return {
          data: [makeSummary({ connection_id: PAGE_2_ONLY_ID, connector_id: "acme" })],
          has_more: false,
          object: "list",
        } as ListResponse<RefConnectorSummary>;
      }
      return {
        data: PAGE_1_IDS.map((id) => makeSummary({ connection_id: id, connector_id: "acme" })),
        has_more: true,
        next_cursor: "page2",
        object: "list",
      } as ListResponse<RefConnectorSummary>;
    },
    listExploreRecordBuckets: notStubbed,
    listExploreTimeline: (o) => {
      // Server-side honors connectionIds scope; only PAGE_2_ONLY_ID has a record.
      const ids = new Set(o?.connectionIds ?? []);
      if (ids.size > 0 && !ids.has(PAGE_2_ONLY_ID)) {
        return Promise.resolve(emptyTimelinePage());
      }
      return Promise.resolve(emptyTimelinePage([rec("acme", PAGE_2_ONLY_ID, "records", "r1", 5)]));
    },
    listGrants: notStubbed,
    listPendingApprovals: notStubbed,
    listRuns: notStubbed,
    listStreams: notStubbed,
    listTraces: notStubbed,
    queryRecords: notStubbed,
    refSearch: notStubbed,
    searchRecordsHybrid: notStubbed,
    searchRecordsLexical: notStubbed,
    searchRecordsSemantic: notStubbed,
  } as DashboardDataSource;
}

test("GATE COUNTEREXAMPLE FIXED: a selected connection on facet page 2 still yields its record while the rail shows facet page 1", async () => {
  // Rail is on facet page 1 (no connections_page_cursor); the URL nonetheless
  // selects a connection that only exists on facet page 2.
  const result = await assembleExplorerData({ connection: PAGE_2_ONLY_ID }, twoPageFleetDs(), "https://rs.test");

  assert.equal(result.connections.length, 100, "facet rail still shows only page 1's 100 options");
  assert.ok(
    !result.connections.some((c) => c.connectionId === PAGE_2_ONLY_ID),
    "the selected connection is genuinely absent from the CURRENT facet page's chip list"
  );
  assert.equal(
    result.feed.length,
    1,
    "GATE FIX: the selected connection's record is present even though it is not on the displayed facet page"
  );
  assert.equal(result.feed[0]?.connectionId, PAGE_2_ONLY_ID);
});

test("GATE COUNTEREXAMPLE FIXED: paging the facet rail forward does not change which records a retained selection matches", async () => {
  const dsPage1 = twoPageFleetDs();
  const firstFeed = await assembleExplorerData({ connection: PAGE_2_ONLY_ID }, dsPage1, "https://rs.test");

  const dsPage2 = twoPageFleetDs();
  const secondFeed = await assembleExplorerData(
    { connection: PAGE_2_ONLY_ID, connections_page_cursor: "page2" },
    dsPage2,
    "https://rs.test"
  );

  assert.equal(firstFeed.feed.length, 1, "firstFeed: selection honored on facet page 1 (gate's exact scenario)");
  assert.equal(
    secondFeed.feed.length,
    1,
    "secondFeed: selection STILL honored after paging the rail — the gate's regression (`secondFeed: 0`) does not reproduce"
  );
});

test("exact-selection lookup is SCOPED (connectionRouteId), not an unbounded fold — one call per selected id", async () => {
  const connectionRouteCalls: string[] = [];
  await assembleExplorerData(
    { connection: [PAGE_2_ONLY_ID, "c002"] },
    twoPageFleetDs({ connectionRouteCalls }),
    "https://rs.test"
  );
  assert.deepEqual(
    [...connectionRouteCalls].sort(),
    [PAGE_2_ONLY_ID, "c002"].sort(),
    "exactly one scoped connectionRouteId call per selected connection id — never a page-following fold"
  );
});

test("no selection: the exact-selection lookup makes zero calls (it only exists to preserve explicit selections)", async () => {
  const connectionRouteCalls: string[] = [];
  await assembleExplorerData({}, twoPageFleetDs({ connectionRouteCalls }), "https://rs.test");
  assert.deepEqual(connectionRouteCalls, [], "no ?connection= selection means nothing to preserve across facet pages");
});

test("a selected connection that does not exist anywhere yields zero exact-selection results, not an error", async () => {
  const result = await assembleExplorerData({ connection: "does-not-exist" }, twoPageFleetDs(), "https://rs.test");
  assert.equal(result.feed.length, 0, "a nonexistent selected connection filters to an honestly empty feed");
  assert.equal(result.connectionsPageError, null, "an unknown selected id is not itself a facet-page error");
});
