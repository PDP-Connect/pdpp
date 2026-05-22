import assert from "node:assert/strict";
import test from "node:test";
import {
  hasRecordsListProgress,
  shouldShowInPrimaryConnections,
} from "./records-list-classification.ts";
import type { ConnectorOverview, ConnectorRunRef } from "./rs-client.ts";

function run(status: string): ConnectorRunRef {
  return {
    event_count: 1,
    failure_reason: null,
    first_at: "2026-05-22T10:00:00Z",
    known_gaps: [],
    last_at: "2026-05-22T10:00:10Z",
    run_id: `run_${status}`,
    status,
  };
}

function overview(overrides: Partial<ConnectorOverview> = {}): ConnectorOverview {
  return {
    connector: { connector_id: "demo", display_name: "Demo" },
    isRunning: false,
    lastRun: null,
    lastSuccessfulRun: null,
    streams: [],
    totalRecords: 0,
    ...overrides,
  };
}

test("successful zero-record scheduler rows are not primary record connections", () => {
  const row = overview({ lastRun: run("succeeded"), lastSuccessfulRun: run("succeeded") });
  assert.equal(hasRecordsListProgress(row), false);
  assert.equal(shouldShowInPrimaryConnections(row), false);
});

test("failed zero-record rows stay primary because they need operator attention", () => {
  assert.equal(shouldShowInPrimaryConnections(overview({ lastRun: run("failed") })), true);
});

test("retained records or trusted local-device progress make a primary connection", () => {
  assert.equal(shouldShowInPrimaryConnections(overview({ totalRecords: 1 })), true);
  assert.equal(
    shouldShowInPrimaryConnections(
      overview({
        localDeviceProgress: {
          last_heartbeat_at: "2026-05-22T10:00:00Z",
          last_heartbeat_status: "healthy",
          last_ingest_at: null,
          records_pending: 0,
          source_count: 1,
        },
      })
    ),
    true
  );
});
