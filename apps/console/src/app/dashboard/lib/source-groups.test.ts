/**
 * Unit tests for the per-source connection grouping used by the Sources page's
 * "Your sources" summary. These prove the rollup keeps existing-data facts and
 * attention facts distinct per source, and orders attention-needed sources
 * first — without re-deriving any health classification.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorOverview } from "./rs-client.ts";
import { groupSourcesByConnector } from "./source-groups.ts";

type ConnectionHealthState = NonNullable<ConnectorOverview["connectionHealth"]>["state"];

function overview(partial: Partial<ConnectorOverview>): ConnectorOverview {
  return {
    connector: { connector_id: "test", name: "Test", display_name: "Test" },
    streams: [],
    totalRecords: 0,
    isRunning: false,
    lastRun: null,
    lastSuccessfulRun: null,
    ...partial,
  };
}

function healthState(state: ConnectionHealthState): ConnectorOverview["connectionHealth"] {
  return {
    state,
    reason_code: null,
    last_success_at: null,
    next_attempt_at: null,
    axes: { freshness: "unknown", coverage: "unknown", attention: "none", outbox: "unknown", remote_surface: "none" },
    badges: { stale: false, syncing: false },
  } as ConnectorOverview["connectionHealth"];
}

function connection(connectorId: string, opts: Partial<ConnectorOverview> = {}): ConnectorOverview {
  return overview({
    connector: { connector_id: connectorId, name: connectorId, display_name: connectorId },
    connectionId: `${connectorId}-${Math.random().toString(36).slice(2, 8)}`,
    ...opts,
  });
}

/** Assert exactly one group exists and return it (strict-null-safe). */
function only(groups: ReturnType<typeof groupSourcesByConnector>) {
  assert.equal(groups.length, 1, "expected exactly one source group");
  const [group] = groups;
  assert.ok(group);
  return group;
}

test("two connections of one source roll up to a single group with the right counts", () => {
  const gmail = only(
    groupSourcesByConnector([connection("gmail", { totalRecords: 100 }), connection("gmail", { totalRecords: 0 })])
  );
  assert.equal(gmail.connectorId, "gmail");
  assert.equal(gmail.connectionCount, 2);
  assert.equal(gmail.withDataCount, 1, "only one of the two gmail connections has records");
});

test("existing-data count is distinct from connection count", () => {
  const group = only(
    groupSourcesByConnector([connection("ynab", { totalRecords: 0 }), connection("ynab", { totalRecords: 0 })])
  );
  assert.equal(group.connectionCount, 2);
  assert.equal(group.withDataCount, 0, "a registered-but-empty source has connections but no data — kept separate");
});

test("needs_attention and blocked connections drive the attention count and a repair route", () => {
  const group = only(
    groupSourcesByConnector([
      connection("chase", { totalRecords: 500, connectionHealth: healthState("healthy") }),
      connection("chase", {
        totalRecords: 10,
        connectionId: "chase-broken",
        connectionHealth: healthState("needs_attention"),
      }),
    ])
  );
  assert.equal(group.needsAttentionCount, 1);
  assert.equal(group.attentionRouteId, "chase-broken", "the repair route points at the unhealthy connection");
});

test("sources needing attention sort ahead of healthy sources", () => {
  const groups = groupSourcesByConnector([
    connection("aaa_healthy", { totalRecords: 1, connectionHealth: healthState("healthy") }),
    connection("zzz_broken", { totalRecords: 1, connectionHealth: healthState("blocked") }),
  ]);
  assert.equal(groups[0]?.connectorId, "zzz_broken", "attention-needed source leads despite later alphabetically");
  assert.equal(groups[1]?.connectorId, "aaa_healthy");
});

test("a healthy source carries no repair route", () => {
  const group = only(
    groupSourcesByConnector([connection("gmail", { totalRecords: 100, connectionHealth: healthState("healthy") })])
  );
  assert.equal(group.needsAttentionCount, 0);
  assert.equal(group.attentionRouteId, null);
});

test("empty input yields no groups", () => {
  assert.deepEqual(groupSourcesByConnector([]), []);
});
