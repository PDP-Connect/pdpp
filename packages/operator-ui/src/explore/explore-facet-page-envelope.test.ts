// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Second gate REVISE (2026-07-29), finding 4: the facet rail's page request
 * must validate its envelope the same way every other bounded pager in this
 * codebase does (`components/connector-summary-page.tsx`'s
 * `loadConnectorSummaryPage`) — reimplemented locally in
 * `explore-data-assembler.ts` (`validateFacetPageEnvelope`) because
 * `operator-ui` cannot import from `apps/console`. A malformed continuation
 * (`has_more: true` with no `next_cursor`, or a self-looping `next_cursor`)
 * must surface as `connectionsPageError`, never a silently-empty facet rail
 * that looks identical to a genuinely exhausted feed. A thrown fetch (e.g. an
 * expired/garbage `connections_page_cursor` the server rejects) must be
 * caught here too, never left to propagate to the route's generic error
 * boundary (`throw err` in explore/page.tsx).
 *
 * Fourth gate REVISE (2026-07-29): the facet rail's cross-request nav-token
 * visited-set (`explore-facet-navigation-session.ts`) was deleted — it was a
 * `globalThis`-backed store keyed by a caller-supplied token, forgeable and
 * unbounded. This surface talks to our own authenticated backend over an
 * already-signed, monotonic keyset cursor contract, so it only validates the
 * envelope strictly and rejects an IMMEDIATE self-loop (the one cycle a
 * single request/response pair can prove) — it does NOT track history across
 * requests. See connector-summary-page.tsx's module doc (apps/console) for
 * the full boundary rationale this mirrors.
 *
 * Critically: none of these failure modes may affect a `?connection=`
 * selection's records — that is resolved by a wholly separate scoped lookup
 * (see explore-facet-page-selection-preservation.test.ts).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DashboardDataSource } from "../lib/data-source.ts";
import type { ListResponse, RefConnectorSummary } from "../lib/ref-client.ts";
import type { ConnectorManifest } from "../lib/rs-client.ts";
import { assembleExplorerData } from "./explore-data-assembler.ts";

const MALFORMED_RE = /malformed connections page/i;
const SELF_LOOP_RE = /loops back to this same connections page/i;
const GLOBAL_THIS_USAGE_RE = /\bglobalThis\s*\[|\bglobalThis\s*\./;
const NAV_TOKEN_FIELD_RE = /connections_page_nav\??:|connectionsPageNavToken\??:/;

function makeSummary(over: { connection_id: string; connector_id: string }): RefConnectorSummary {
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
    streams: ["records"],
    total_records: 0,
  } as RefConnectorSummary;
}

function makeManifest(): ConnectorManifest {
  return { connector_id: "acme", streams: [{ name: "records" }] };
}

const notStubbed = () => Promise.reject(new Error("not stubbed"));

function facetDs(
  respond: (options?: {
    connectionRouteId?: string;
    cursor?: string;
    limit?: number;
  }) => Promise<ListResponse<RefConnectorSummary>>
): DashboardDataSource {
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
    listConnectorManifests: async () => [makeManifest()],
    listConnectorSummaries: respond,
    listExploreRecordBuckets: notStubbed,
    listExploreTimeline: () =>
      Promise.resolve({
        data: [],
        has_more: false,
        new_since_snapshot: 0,
        next_cursor: null,
        object: "list",
        snapshot_at: "2026-06-19T00:00:00Z",
        upcoming: [],
        upcoming_has_more: false,
        upcoming_next_cursor: null,
        upcoming_total: 0,
      }),
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

test("ADVERSARIAL: has_more:true with no next_cursor rejects with connectionsPageError, never a silent empty facet list", async () => {
  // biome-ignore lint/suspicious/useAwait: mocks the DashboardDataSource async method contract; async is required to satisfy the type even though this fixture body never awaits.
  const ds = facetDs(async (options) => {
    if (options?.connectionRouteId) {
      return { data: [], has_more: false, object: "list" };
    }
    return { data: [makeSummary({ connection_id: "c1", connector_id: "acme" })], has_more: true, object: "list" };
  });
  const result = await assembleExplorerData({}, ds, "https://rs.test");
  assert.ok(result.connectionsPageError, "malformed envelope (has_more with no next_cursor) must be rejected");
  assert.match(result.connectionsPageError ?? "", MALFORMED_RE);
  assert.equal(result.connections.length, 0, "no facet chips are rendered from a rejected page");
});

test("ADVERSARIAL: a self-looping next_cursor (equal to the requested cursor) rejects with connectionsPageError", async () => {
  // biome-ignore lint/suspicious/useAwait: mocks the DashboardDataSource async method contract; async is required to satisfy the type even though this fixture body never awaits.
  const ds = facetDs(async (options) => {
    if (options?.connectionRouteId) {
      return { data: [], has_more: false, object: "list" };
    }
    return {
      data: [makeSummary({ connection_id: "c1", connector_id: "acme" })],
      has_more: true,
      next_cursor: options?.cursor,
      object: "list",
    };
  });
  const result = await assembleExplorerData({ connections_page_cursor: "loop-cursor" }, ds, "https://rs.test");
  assert.ok(result.connectionsPageError, "a next_cursor identical to the requested cursor is a self-loop, rejected");
  assert.match(result.connectionsPageError ?? "", SELF_LOOP_RE);
});

test("ADVERSARIAL: a thrown fetch (malformed/expired connections_page_cursor) is caught, never propagated to the route", async () => {
  // biome-ignore lint/suspicious/useAwait: mocks the DashboardDataSource async method contract; async is required to satisfy the type even though this fixture body never awaits.
  const ds = facetDs(async (options) => {
    if (options?.connectionRouteId) {
      return { data: [], has_more: false, object: "list" };
    }
    throw new Error("garbage cursor rejected by reference server");
  });
  const result = await assembleExplorerData({ connections_page_cursor: "garbage" }, ds, "https://rs.test");
  assert.equal(
    result.connectionsPageError,
    "garbage cursor rejected by reference server",
    "the thrown error is caught and surfaced as connectionsPageError, not left to throw out of assembleExplorerData"
  );
});

test("connectionsPageIsPaged is true only when connections_page_cursor was present on the request", async () => {
  // biome-ignore lint/suspicious/useAwait: mocks the DashboardDataSource async method contract; async is required to satisfy the type even though this fixture body never awaits.
  const ds = facetDs(async (options) => {
    if (options?.connectionRouteId) {
      return { data: [], has_more: false, object: "list" };
    }
    return { data: [], has_more: false, object: "list" };
  });
  const page1 = await assembleExplorerData({}, ds, "https://rs.test");
  assert.equal(page1.connectionsPageIsPaged, false, "page 1 (no cursor) is not 'paged'");

  const page2 = await assembleExplorerData({ connections_page_cursor: "c2" }, ds, "https://rs.test");
  assert.equal(page2.connectionsPageIsPaged, true, "a request carrying connections_page_cursor is 'paged'");
});

test("a rejected facet page does not affect an independently-resolved ?connection= selection", async () => {
  // biome-ignore lint/suspicious/useAwait: mocks the DashboardDataSource async method contract; async is required to satisfy the type even though this fixture body never awaits.
  const ds = facetDs(async (options) => {
    if (options?.connectionRouteId === "cin_selected") {
      return {
        data: [makeSummary({ connection_id: "cin_selected", connector_id: "acme" })],
        has_more: false,
        object: "list",
      };
    }
    if (options?.connectionRouteId) {
      return { data: [], has_more: false, object: "list" };
    }
    // Facet page itself is malformed.
    return { data: [makeSummary({ connection_id: "c1", connector_id: "acme" })], has_more: true, object: "list" };
  });
  const result = await assembleExplorerData({ connection: "cin_selected" }, ds, "https://rs.test");
  assert.ok(result.connectionsPageError, "the facet page is still rejected");
  assert.equal(result.connections.length, 0, "the facet rail's chip list is empty (it depends on the rejected page)");
});

// ---- fourth gate REVISE (2026-07-29): no cross-request cycle history ----
//
// The forgeable/unbounded nav-token session store is gone. A non-adjacent
// cycle (a -> b -> a) is judged one render at a time and is NOT caught,
// because catching it would require exactly the client-held session state
// the gate rejected. Only an immediate self-loop (checkable from a single
// request/response pair) is rejected.

test("a non-adjacent facet-page cycle (undefined -> a -> b -> a) is NOT tracked across requests — each render is judged independently", async () => {
  // biome-ignore lint/suspicious/useAwait: mocks the DashboardDataSource async method contract; async is required to satisfy the type even though this fixture body never awaits.
  const ds = facetDs(async (options) => {
    if (options?.connectionRouteId) {
      return { data: [], has_more: false, object: "list" };
    }
    if (options?.cursor === "a") {
      return { data: [], has_more: true, next_cursor: "b", object: "list" };
    }
    if (options?.cursor === "b") {
      return { data: [], has_more: true, next_cursor: "a", object: "list" };
    }
    return { data: [], has_more: true, next_cursor: "a", object: "list" };
  });

  const first = await assembleExplorerData({}, ds, "https://rs.test");
  assert.equal(first.connectionsPageError, null, "page 1 succeeds");

  const second = await assembleExplorerData({ connections_page_cursor: "a" }, ds, "https://rs.test");
  assert.equal(second.connectionsPageError, null, "a -> b succeeds");

  // b -> a: not an immediate self-loop (requested cursor is "b", next_cursor
  // is "a"), so it succeeds — by design. There is no visited-set to consult;
  // only ref-control.ts's cursor contract can prevent a non-adjacent cycle.
  const third = await assembleExplorerData({ connections_page_cursor: "b" }, ds, "https://rs.test");
  assert.equal(
    third.connectionsPageError,
    null,
    "no cross-request cycle history is kept for the interactive facet rail"
  );
});

test("ADVERSARIAL: an immediate facet-page self-loop is rejected even on a FRESH arrival with no prior navigation", async () => {
  // Arriving directly at facet page 2 (e.g. a bookmark) with no prior state —
  // an immediate self-loop is still provable from this one request alone.
  // biome-ignore lint/suspicious/useAwait: mocks the DashboardDataSource async method contract; async is required to satisfy the type even though this fixture body never awaits.
  const ds = facetDs(async (options) => {
    if (options?.connectionRouteId) {
      return { data: [], has_more: false, object: "list" };
    }
    return { data: [], has_more: true, next_cursor: "c1", object: "list" };
  });
  const result = await assembleExplorerData({ connections_page_cursor: "c1" }, ds, "https://rs.test");
  assert.ok(result.connectionsPageError, "an immediate self-loop is rejected even with no navigation history");
  assert.match(result.connectionsPageError ?? "", SELF_LOOP_RE);
});

test("structural: no nav/session token field survives on ExplorerSearchParams or RecordsExplorerData", async () => {
  const fs = await import("node:fs/promises");
  const assemblerSrc = await fs.readFile(new URL("./explore-data-assembler.ts", import.meta.url), "utf8");
  assert.doesNotMatch(assemblerSrc, GLOBAL_THIS_USAGE_RE, "no globalThis-backed session store in use");
  assert.doesNotMatch(assemblerSrc, NAV_TOKEN_FIELD_RE, "no nav-token field declared anywhere");
});
