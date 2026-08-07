// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Focused throughput oracle for the common ingest capability.
 *
 * The fake Postgres lock pool is enabled while storage remains SQLite. That
 * isolates coordinator lifecycle calls from record-storage work: the old
 * one-record path performs one advisory acquire and release per record, while
 * `ingestRecords` must perform exactly one pair for the whole batch. The two
 * stream shapes also prove the optimization is not connector-specific.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  __setConnectorInstancePostgresLockPoolForTest,
  withConnectorInstanceWrite,
} from "../server/connector-instance-write-coordinator.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  __setIngestFaultHookForTest,
  ingestRecord,
  ingestRecords,
  recordIndexWorkStatsForTests,
  withRecordIndexWorkForTests,
} from "../server/records.ts";

interface TestPostgresLockClient {
  query: (
    sql: string,
    params: readonly unknown[]
  ) => Promise<{ rows: Array<{ acquired?: boolean; unlocked?: boolean }> }>;
  release: (error?: boolean) => void;
}

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
  let lockQueries = 0;
  let clientReleases = 0;
  const client: TestPostgresLockClient = {
    query: (sql) => {
      lockQueries += 1;
      return Promise.resolve(sql.includes("unlock") ? { rows: [{ unlocked: true }] } : { rows: [{ acquired: true }] });
    },
    release: () => {
      clientReleases += 1;
    },
  };
  __setConnectorInstancePostgresLockPoolForTest({
    capacity: 8,
    pool: { connect: async () => client },
  });

  try {
    const beforeConnector = "https://probe.example/connectors/before";
    for (const record of records("messages", "before")) {
      // biome-ignore lint/performance/noAwaitInLoops: This is the serial baseline the oracle intentionally measures.
      await ingestRecord(beforeConnector, record);
    }
    assert.equal(lockQueries, 6, "the pre-fix single-record path acquires and releases per record");
    assert.equal(countChanges(beforeConnector, "messages"), 3);

    const afterConnector = "https://probe.example/connectors/after";
    const messages = await ingestRecords(afterConnector, records("messages", "message"));
    const timelinePoints = await ingestRecords(afterConnector, records("timeline_points", "point"));
    assert.equal(messages.filter((outcome) => outcome.accepted).length, 3);
    assert.equal(timelinePoints.filter((outcome) => outcome.accepted).length, 3);
    assert.equal(lockQueries, 10, "two batches should add one acquire/release pair each");
    assert.equal(clientReleases, 5);
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
        { accepted: false, error: "injected batch fault" },
        { accepted: true, error: null },
      ]
    );
    assert.deepEqual(changeRows(failureConnector, "timeline_points"), [
      { record_key: "fault-0", version: 1 },
      { record_key: "fault-2", version: 2 },
    ]);
  } finally {
    __setIngestFaultHookForTest(null);
    __setConnectorInstancePostgresLockPoolForTest(null);
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
