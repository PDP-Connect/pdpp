// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { closeDb, initDb } from "../server/db.ts";
import { createSqliteSchedulerStore } from "../server/stores/scheduler-store.ts";

function withTempDb(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-instance-freshness-diagnostics-"));
    try {
      initDb(join(dir, "pdpp.sqlite"));
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

test(
  "scheduler freshness gates are isolated by connector instance",
  withTempDb(async () => {
    const store = createSqliteSchedulerStore();
    store.upsertLastRunTime("cin_gmail_work", 1_776_000_001_000, "2026-05-01T00:00:01.000Z", "gmail");
    store.upsertLastRunTime("cin_gmail_personal", 1_776_000_002_000, "2026-05-01T00:00:02.000Z", "gmail");

    const rows = await store.listLastRunTimes();
    assert.deepEqual(
      rows.map((row) => [row.connector_instance_id, row.connector_id, row.last_run_time_ms]),
      [
        ["cin_gmail_personal", "gmail", 1_776_000_002_000],
        ["cin_gmail_work", "gmail", 1_776_000_001_000],
      ]
    );
  })
);

test(
  "scheduler diagnostic recovery state is isolated by connector instance",
  withTempDb(async () => {
    const store = createSqliteSchedulerStore();
    await store.appendRunHistory({
      attempt: 1,
      checkpointSummary: null,
      completedAt: "2026-05-01T00:00:02.000Z",
      connectorError: { message: "work failed" },
      connectorId: "gmail",
      connectorInstanceId: "cin_gmail_work",
      error: "work failed",
      failureReason: "connector_failed",
      knownGaps: [{ kind: "detail_gap", reason: "work_rate_limit", stream: "messages" }],
      recordsEmitted: 0,
      runId: "run_work",
      source: { id: "gmail", kind: "connector" },
      startedAt: "2026-05-01T00:00:01.000Z",
      status: "failed",
      terminalReason: "connector_exit_without_done",
      traceId: "trace_work",
    });
    await store.appendRunHistory({
      attempt: 1,
      checkpointSummary: null,
      completedAt: "2026-05-01T00:00:04.000Z",
      connectorError: null,
      connectorId: "gmail",
      connectorInstanceId: "cin_gmail_personal",
      knownGaps: [],
      recordsEmitted: 2,
      runId: "run_personal",
      source: { id: "gmail", kind: "connector" },
      startedAt: "2026-05-01T00:00:03.000Z",
      status: "succeeded",
      traceId: "trace_personal",
    });

    const history = await store.listRunHistory(10);
    const byInstance = new Map(history.map((row) => [row.connectorInstanceId, row]));
    const workRow = byInstance.get("cin_gmail_work");
    const personalRow = byInstance.get("cin_gmail_personal");
    assert.equal(workRow?.connectorError?.message, "work failed");
    assert.deepEqual(
      workRow?.knownGaps.map((gap) => gap.reason),
      ["work_rate_limit"]
    );
    assert.equal(personalRow?.connectorError, null);
    assert.deepEqual(personalRow?.knownGaps, []);
  })
);
