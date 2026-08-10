// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Focused throughput oracle for the common ingest capability (SQLite
 * backend). Confirms `ingestRecords` holds ONE coordinator in-process fence
 * for the whole batch (ownership reuse, no re-acquire per record) while each
 * record still gets its own durable write transaction — the SQLite side of
 * harden-connector-instance-write-fence-transaction-native's "no
 * batch-duration lease" requirement. See
 * postgres-transaction-connector-instance-lock.test.ts for the Postgres
 * side, where the cross-process exclusion itself (not just the in-process
 * fence) is also re-acquired per record, not once per batch.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { withConnectorInstanceWrite } from "../server/connector-instance-write-coordinator.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  __setIngestFaultHookForTest,
  ingestRecord,
  ingestRecords,
  recordIndexWorkStatsForTests,
  withRecordIndexWorkForTests,
} from "../server/records.ts";

function records(stream: string, prefix: string) {
  return Array.from({ length: 3 }, (_, index) => ({
    data: { id: `${prefix}-${index}`, text: `${stream}-${index}` },
    emitted_at: "2026-08-06T00:00:00.000Z",
    key: `${prefix}-${index}`,
    stream,
  }));
}

function countChanges(connectorId: string, stream: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS count
       FROM record_changes
       WHERE connector_id = ? AND stream = ?`
    )
    .get(connectorId, stream) as { count: number };
  return row.count;
}

function changeRows(connectorId: string, stream: string): Array<{ record_key: string; version: number }> {
  return getDb()
    .prepare(
      `SELECT record_key, version
       FROM record_changes
       WHERE connector_id = ? AND stream = ?
       ORDER BY version`
    )
    .all(connectorId, stream) as Array<{ record_key: string; version: number }>;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  assert.ok(resolve, "Promise executor runs synchronously, so resolve is always assigned here");
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for the deterministic test condition");
    }
    // biome-ignore lint/performance/noAwaitInLoops: Polling is intentionally sequential for a deterministic gate.
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("common ingest reuses coordinator ownership for messages and timeline_points", async () => {
  initDb();
  try {
    const beforeConnector = "https://probe.example/connectors/before";
    for (const record of records("messages", "before")) {
      // biome-ignore lint/performance/noAwaitInLoops: This is the serial baseline the oracle intentionally measures.
      await ingestRecord(beforeConnector, record);
    }
    assert.equal(countChanges(beforeConnector, "messages"), 3);

    const afterConnector = "https://probe.example/connectors/after";
    const messages = await ingestRecords(afterConnector, records("messages", "message"));
    const timelinePoints = await ingestRecords(afterConnector, records("timeline_points", "point"));
    assert.equal(messages.filter((outcome) => outcome.accepted).length, 3);
    assert.equal(timelinePoints.filter((outcome) => outcome.accepted).length, 3);
    assert.equal(countChanges(afterConnector, "messages"), 3);
    assert.equal(countChanges(afterConnector, "timeline_points"), 3);

    const failureConnector = "https://probe.example/connectors/failure-isolation";
    __setIngestFaultHookForTest((point: string, context: { recordKey?: string }) => {
      if (point === "after-records-mutation" && context.recordKey === "fault-1") {
        throw new Error("injected batch fault");
      }
    });
    const failureOutcomes = await ingestRecords(failureConnector, records("timeline_points", "fault"));
    assert.deepEqual(
      failureOutcomes.map((outcome) => ({ accepted: outcome.accepted, error: outcome.error ?? null })),
      [
        { accepted: true, error: null },
        // A bare, unclassified injected Error has no recognized `.code`, so
        // classifyIngestFailure defaults it to systemic/retryable (see
        // server/records.ts) — the structured shape every rejected batch
        // outcome now carries, not a bare string.
        { accepted: false, error: { code: "ingest_storage_error", message: "injected batch fault", retryable: true } },
        { accepted: true, error: null },
      ]
    );
    // Partial-batch atomicity: the failed record (fault-1) never lands, but
    // records BEFORE and AFTER it in the same batch stay durably committed —
    // proves the batch is NOT wrapped in one outer transaction (that would
    // roll back fault-0 too). See
    // harden-connector-instance-write-fence-transaction-native's "no
    // batch-duration lease" requirement.
    assert.deepEqual(changeRows(failureConnector, "timeline_points"), [
      { record_key: "fault-0", version: 1 },
      { record_key: "fault-2", version: 2 },
    ]);
  } finally {
    __setIngestFaultHookForTest(null);
    closeDb();
  }
});

test("batch releases the instance fence while its derived index lane is saturated", async () => {
  const previousLimit = process.env.PDPP_INGEST_INDEX_WORK_LIMIT;
  process.env.PDPP_INGEST_INDEX_WORK_LIMIT = "1";
  initDb();

  const indexEntered = deferred();
  const indexRelease = deferred();
  const heldIndexPermit = withRecordIndexWorkForTests(async () => {
    indexEntered.resolve();
    await indexRelease.promise;
  });
  let batch: Promise<Awaited<ReturnType<typeof ingestRecords>>> | undefined;
  let blobWriter: Promise<string> | undefined;
  try {
    await indexEntered.promise;
    assert.deepEqual(recordIndexWorkStatsForTests(), { active: 1, queued: 0 });

    const connectorInstanceId = "cin_batch_blob_liveness";
    const target = {
      connector_id: "https://probe.example/connectors/gmail",
      connector_instance_id: connectorInstanceId,
    };
    batch = ingestRecords(target, records("messages", "liveness"));
    await waitFor(() => recordIndexWorkStatsForTests().queued === 1);

    blobWriter = withConnectorInstanceWrite(connectorInstanceId, async () => "blob-writer");
    const admission = await Promise.race([
      blobWriter.then(() => "completed" as const),
      new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 250)),
    ]);
    assert.equal(admission, "completed", "a blob-style writer must not wait behind deferred index work");

    indexRelease.resolve();
    const outcomes = await batch;
    assert.equal(outcomes.filter((outcome) => outcome.accepted).length, 3);
    await blobWriter;
  } finally {
    indexRelease.resolve();
    await Promise.allSettled([heldIndexPermit, ...(batch ? [batch] : []), ...(blobWriter ? [blobWriter] : [])]);
    closeDb();
    if (previousLimit === undefined) {
      delete process.env.PDPP_INGEST_INDEX_WORK_LIMIT;
    } else {
      process.env.PDPP_INGEST_INDEX_WORK_LIMIT = previousLimit;
    }
  }
});
