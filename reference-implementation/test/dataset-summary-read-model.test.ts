// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  __setDatasetSummaryProjectionFaultHookForTest,
  applyDatasetSummaryBlobDelta,
  applyDatasetSummaryRecordDelta,
  getDatasetSummaryProjection,
  listStreamProjections,
  markDatasetSummaryProjectionStale,
  rebuildDatasetSummaryProjection,
  reconcileDirtyDatasetSummaryRecordTimeBounds,
} from "../server/dataset-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  deleteAllRecords,
  deleteAllRecordsForConnector,
  deleteRecord,
  getDatasetBlobBytes,
  getDatasetRecordChangesBytes,
  getDatasetRecordsAggregate,
  getDatasetRecordTimeBounds,
  getDatasetSummaryStreamRecordTimeBounds,
  ingestRecord,
  listDatasetSummaryStreamProjectionSeeds,
  listDatasetTopConnectorCandidates,
} from "../server/records.ts";

const BULK_CONNECTOR_DELETE_ERROR = /bulk connector record delete/;
const BULK_STREAM_DELETE_ERROR = /bulk stream record delete/;
const DIRTY_BOUNDS_ERROR = /could not be safely reconciled/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T/;
const REBUILT_HIGH_WATERMARK = /^rebuilt:/;
const SECRET_TOKEN_ERROR = /secret-token/;

/**
 * `server/records.js` remains an untyped JS boundary. This test derives
 * the projection metadata shape from `getDatasetSummaryProjection()` so
 * its nullable-field assertions stay aligned with the read model.
 */
type DatasetSummaryMetadata = ReturnType<typeof getDatasetSummaryProjection>["metadata"];

/**
 * `getDatasetRecordsAggregate` is declared as a plain (non-async)
 * function in `records.js`, but its SQLite branch returns a value while
 * its Postgres branch delegates to an `async` helper — so TypeScript
 * infers the return type as `Promise<Aggregate> | Aggregate`. This test
 * only ever runs against the SQLite temp-db branch, so a boundary cast
 * to the concrete SQLite shape is correct here.
 */
interface DatasetRecordsAggregate {
  connector_count: number;
  earliest_ingested_at: string | null;
  latest_ingested_at: string | null;
  record_count: number;
  record_json_bytes: number;
  stream_count: number;
}

function getSqliteDatasetRecordsAggregate(): DatasetRecordsAggregate {
  return getDatasetRecordsAggregate() as unknown as DatasetRecordsAggregate;
}

interface DatasetTopConnectorCandidate {
  connector_id: string;
  record_count: number;
}

function getSqliteDatasetTopConnectorCandidates(): DatasetTopConnectorCandidate[] {
  return listDatasetTopConnectorCandidates() as unknown as DatasetTopConnectorCandidate[];
}

/**
 * Boundary type for `listStreamProjections`' per-`(connector_id, stream)`
 * rows, matching the shape it builds in `dataset-summary-read-model.js`.
 */
interface StreamProjectionRow {
  computed_at: string | null;
  connector_id: string;
  consent_time_field: string | null;
  dirty_record_time_bounds: boolean;
  earliest_ingested_at: string | null;
  earliest_record_time: string | null;
  latest_ingested_at: string | null;
  latest_record_time: string | null;
  record_count: number;
  record_json_bytes: number;
  stream: string;
}

function listSqliteStreamProjections(filter?: { connectorId: string }): StreamProjectionRow[] {
  return (filter ? listStreamProjections(filter) : listStreamProjections()) as unknown as StreamProjectionRow[];
}

async function withTempDb<T>(fn: () => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-summary-projection-"));
  try {
    initDb(join(dir, "pdpp.sqlite"));
    return await fn();
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
}

test("dataset summary projection reports rebuilding metadata when rows are missing", () =>
  withTempDb(() => {
    const projection = getDatasetSummaryProjection();

    assert.equal(projection.counts.record_count, 0);
    assert.equal(projection.metadata.computed_at, null);
    assert.equal(projection.metadata.state, "rebuilding");
    assert.equal(projection.metadata.rebuild_status, "running");
    assert.ok(projection.metadata.stale_since);
    assert.match(projection.metadata.stale_since, ISO_TIMESTAMP);
  }));

test("dataset summary projection rebuild persists bounded rows from canonical dependencies", async () =>
  withTempDb(async () => {
    await rebuildDatasetSummaryProjection({
      getCounts: () => ({ connector_count: 2, record_count: 8, stream_count: 3 }),
      getIngestedTimeBounds: () => ({
        earliest: "2026-01-02T00:00:00Z",
        latest: "2026-05-02T00:00:00Z",
      }),
      getRecordTimeBounds: () => ({
        earliest: "2026-01-01T00:00:00Z",
        latest: "2026-05-01T00:00:00Z",
      }),
      getRetainedBytes: () => ({
        blob_bytes: 75,
        record_changes_json_bytes: 25,
        record_json_bytes: 100,
      }),
      listTopConnectorCandidates: () => [
        { connector_id: "gmail", record_count: 5 },
        { connector_id: "calendar", record_count: 3 },
      ],
    });

    const projection = getDatasetSummaryProjection();
    assert.deepEqual(projection.counts, {
      connector_count: 2,
      record_count: 8,
      stream_count: 3,
    });
    assert.equal(projection.retained_bytes.blob_bytes, 75);
    assert.equal(projection.record_time_bounds.earliest, "2026-01-01T00:00:00Z");
    assert.equal(projection.metadata.state, "fresh");
    assert.equal(projection.metadata.rebuild_status, "idle");
    assert.ok(projection.metadata.source_high_watermark);
    assert.match(projection.metadata.source_high_watermark, REBUILT_HIGH_WATERMARK);
  }));

test("dataset summary projection rebuild keeps last-known rows and marks failure", async () =>
  withTempDb(async () => {
    await rebuildDatasetSummaryProjection({
      getCounts: () => ({ connector_count: 1, record_count: 1, stream_count: 1 }),
      getIngestedTimeBounds: () => ({ earliest: "2026-01-02", latest: "2026-01-02" }),
      getRecordTimeBounds: () => ({ earliest: "2026-01-01", latest: "2026-01-01" }),
      getRetainedBytes: () => ({
        blob_bytes: 0,
        record_changes_json_bytes: 0,
        record_json_bytes: 10,
      }),
      listTopConnectorCandidates: () => [{ connector_id: "gmail", record_count: 1 }],
    });

    await assert.rejects(
      () =>
        rebuildDatasetSummaryProjection({
          getCounts: () => {
            throw new Error("secret-token-abcdefghijklmnopqrstuvwxyz123456 failed");
          },
          getIngestedTimeBounds: () => ({ earliest: null, latest: null }),
          getRecordTimeBounds: () => ({ earliest: null, latest: null }),
          getRetainedBytes: () => {
            throw new Error("should not matter");
          },
          listTopConnectorCandidates: () => [],
        }),
      SECRET_TOKEN_ERROR
    );

    const projection = getDatasetSummaryProjection();
    assert.equal(projection.counts.record_count, 1);
    assert.equal(projection.metadata.state, "failed");
    assert.equal(projection.metadata.rebuild_status, "failed");
    assert.ok(projection.metadata.last_error);
    assert.equal(projection.metadata.last_error.includes("abcdefghijklmnopqrstuvwxyz123456"), false);
  }));

test("record no-op ingest does not change dataset summary projection", async () =>
  withTempDb(async () => {
    await rebuildEmptyProjection();
    await ingestRecord("gmail", {
      data: { id: "m1", subject: "hello" },
      emitted_at: "2026-01-01T00:00:00.000Z",
      key: "m1",
      stream: "messages",
    });
    const afterFirst = getDatasetSummaryProjection();

    await ingestRecord("gmail", {
      data: { id: "m1", subject: "hello" },
      emitted_at: "2026-01-02T00:00:00.000Z",
      key: "m1",
      stream: "messages",
    });

    assert.deepEqual(getDatasetSummaryProjection(), afterFirst);
  }));

test("record upsert deltas update counts bytes ingest bounds and top connectors", async () =>
  withTempDb(async () => {
    await rebuildEmptyProjection();
    await ingestRecord("gmail", {
      data: { id: "m1", subject: "hello" },
      emitted_at: "2026-01-02T00:00:00.000Z",
      key: "m1",
      stream: "messages",
    });
    await ingestRecord("calendar", {
      data: { id: "e1", title: "standup" },
      emitted_at: "2026-01-01T00:00:00.000Z",
      key: "e1",
      stream: "events",
    });
    await ingestRecord("gmail", {
      data: { id: "m1", subject: "hello world" },
      emitted_at: "2026-01-03T00:00:00.000Z",
      key: "m1",
      stream: "messages",
    });

    const projection = getDatasetSummaryProjection();
    assert.deepEqual(projection.counts, {
      connector_count: 2,
      record_count: 2,
      stream_count: 2,
    });
    assert.equal(projection.ingested_time_bounds.earliest, "2026-01-01T00:00:00.000Z");
    assert.equal(projection.ingested_time_bounds.latest, "2026-01-03T00:00:00.000Z");
    assert.deepEqual(projection.top_connector_candidates, [
      { connector_id: "calendar", record_count: 1 },
      { connector_id: "gmail", record_count: 1 },
    ]);
    assert.equal(projection.retained_bytes.record_json_bytes, liveRecordJsonBytes());
    assert.equal(projection.retained_bytes.record_changes_json_bytes, recordChangeJsonBytes());
    assert.equal(projection.metadata.state, "fresh");
  }));

test("record-change pruning subtracts the inclusive retention boundary", async () =>
  withTempDb(async () => {
    const previousLimit = process.env.PDPP_CHANGE_HISTORY_LIMIT;
    process.env.PDPP_CHANGE_HISTORY_LIMIT = "1";
    try {
      await rebuildEmptyProjection();
      await ingestRecord("gmail", {
        data: { id: "m1", subject: "v1" },
        emitted_at: "2026-01-01T00:00:00.000Z",
        key: "m1",
        stream: "messages",
      });
      await ingestRecord("gmail", {
        data: { id: "m1", subject: "v2" },
        emitted_at: "2026-01-02T00:00:00.000Z",
        key: "m1",
        stream: "messages",
      });

      const projection = getDatasetSummaryProjection();
      assert.equal(projection.retained_bytes.record_changes_json_bytes, recordChangeJsonBytes());
      assert.equal(
        requireRow(
          getDb().prepare("SELECT COUNT(*) AS n FROM record_changes").get<{ n: number }>(),
          "record change count row must exist"
        ).n,
        1
      );
    } finally {
      if (previousLimit === undefined) {
        delete process.env.PDPP_CHANGE_HISTORY_LIMIT;
      } else {
        process.env.PDPP_CHANGE_HISTORY_LIMIT = previousLimit;
      }
    }
  }));

test("record delete deltas decrement live counts without staling non-time streams", async () =>
  withTempDb(async () => {
    await rebuildEmptyProjection();
    await ingestRecord("gmail", {
      data: { id: "m1", subject: "hello" },
      emitted_at: "2026-01-01T00:00:00.000Z",
      key: "m1",
      stream: "messages",
    });
    await ingestRecord("gmail", {
      data: { id: "m2", subject: "later" },
      emitted_at: "2026-01-02T00:00:00.000Z",
      key: "m2",
      stream: "messages",
    });

    assert.equal(await deleteRecord("gmail", "messages", "m1"), 1);
    const projection = getDatasetSummaryProjection();

    assert.equal(projection.counts.record_count, 1);
    assert.equal(projection.counts.connector_count, 1);
    assert.equal(projection.counts.stream_count, 1);
    assert.equal(projection.retained_bytes.record_json_bytes, liveRecordJsonBytes());
    assert.equal(projection.retained_bytes.record_changes_json_bytes, recordChangeJsonBytes());
    assert.equal(projection.metadata.state, "fresh");
    assert.equal(projection.metadata.stale_since, null);
  }));

test("blob insert delta updates retained blob bytes and duplicate content is a no-op", async () =>
  withTempDb(async () => {
    await rebuildEmptyProjection();

    applyDatasetSummaryBlobDelta({ blobBytesDelta: Buffer.byteLength("hello blob") });
    applyDatasetSummaryBlobDelta({ blobBytesDelta: 0 });

    const projection = getDatasetSummaryProjection();
    assert.equal(projection.retained_bytes.blob_bytes, Buffer.byteLength("hello blob"));
  }));

test("blob and non-repair deltas preserve existing stale metadata", async () =>
  withTempDb(async () => {
    await rebuildEmptyProjection();
    await ingestRecord("gmail", {
      data: { id: "m1", subject: "hello" },
      emitted_at: "2026-01-01T00:00:00.000Z",
      key: "m1",
      stream: "messages",
    });
    markDatasetSummaryProjectionStale("test stale metadata");
    const staleProjection = getDatasetSummaryProjection();
    assert.equal(staleProjection.metadata.state, "stale");

    applyDatasetSummaryBlobDelta({ blobBytesDelta: 10 });
    const afterBlob = getDatasetSummaryProjection();
    assert.equal(afterBlob.metadata.state, "stale");
    assert.equal(afterBlob.metadata.stale_since, staleProjection.metadata.stale_since);

    await ingestRecord("gmail", {
      data: { id: "m2", subject: "later" },
      emitted_at: "2026-01-02T00:00:00.000Z",
      key: "m2",
      stream: "messages",
    });
    const afterRecord = getDatasetSummaryProjection();
    assert.equal(afterRecord.metadata.state, "stale");
    assert.equal(afterRecord.metadata.stale_since, staleProjection.metadata.stale_since);
  }));

test("projection hook failure marks sanitized stale failure metadata without blocking canonical write", async () =>
  withTempDb(async () => {
    await rebuildEmptyProjection();
    __setDatasetSummaryProjectionFaultHookForTest(() => {
      throw new Error("projection-token-abcdefghijklmnopqrstuvwxyz123456 failed");
    });
    try {
      const outcome = await ingestRecord("gmail", {
        data: { id: "m1", subject: "hello" },
        emitted_at: "2026-01-01T00:00:00.000Z",
        key: "m1",
        stream: "messages",
      });
      assert.equal(outcome.changed, true);
    } finally {
      __setDatasetSummaryProjectionFaultHookForTest(null);
    }

    assert.equal(
      requireRow(
        getDb().prepare("SELECT COUNT(*) AS n FROM records").get<{ n: number }>(),
        "record count row must exist"
      ).n,
      1
    );
    const projection = getDatasetSummaryProjection();
    assert.equal(projection.metadata.state, "failed");
    assert.equal(projection.metadata.rebuild_status, "failed");
    assert.ok(projection.metadata.last_error);
    assert.equal(projection.metadata.last_error.includes("abcdefghijklmnopqrstuvwxyz123456"), false);

    applyDatasetSummaryBlobDelta({ blobBytesDelta: 5 });
    const afterBlob = getDatasetSummaryProjection();
    assert.equal(afterBlob.metadata.state, "failed");
    assert.equal(afterBlob.metadata.last_error, projection.metadata.last_error);
  }));

test("bulk stream delete marks projection stale instead of applying unsafe exact deltas", async () =>
  withTempDb(async () => {
    await rebuildEmptyProjection();
    await ingestRecord("gmail", {
      data: { id: "m1", subject: "hello" },
      emitted_at: "2026-01-01T00:00:00.000Z",
      key: "m1",
      stream: "messages",
    });
    await rebuildFromCurrentDb();

    assert.equal(await deleteAllRecords("gmail", "messages"), 1);
    const projection = getDatasetSummaryProjection();
    assert.equal(projection.metadata.state, "stale");
    assert.ok(projection.metadata.last_error);
    assert.match(projection.metadata.last_error, BULK_STREAM_DELETE_ERROR);
  }));

test("bulk connector delete marks projection stale instead of applying unsafe exact deltas", async () =>
  withTempDb(async () => {
    await rebuildEmptyProjection();
    await ingestRecord("gmail", {
      data: { id: "m1", subject: "hello" },
      emitted_at: "2026-01-01T00:00:00.000Z",
      key: "m1",
      stream: "messages",
    });
    await rebuildFromCurrentDb();

    const result = await deleteAllRecordsForConnector("gmail");
    assert.equal(result.deletedCount, 1);
    const projection = getDatasetSummaryProjection();
    assert.equal(projection.metadata.state, "stale");
    assert.ok(projection.metadata.last_error);
    assert.match(projection.metadata.last_error, BULK_CONNECTOR_DELETE_ERROR);
  }));

test("non-empty rebuild seeds stream projections so later deltas do not fail", async () =>
  withTempDb(async () => {
    await rebuildEmptyProjection();
    await ingestRecord("gmail", {
      data: { id: "m1", subject: "hello" },
      emitted_at: "2026-01-01T00:00:00.000Z",
      key: "m1",
      stream: "messages",
    });
    await rebuildFromCurrentDb();
    assert.equal(getDatasetSummaryProjection().metadata.state, "fresh");

    await ingestRecord("gmail", {
      data: { id: "m2", subject: "later" },
      emitted_at: "2026-01-02T00:00:00.000Z",
      key: "m2",
      stream: "messages",
    });
    const projection = getDatasetSummaryProjection();
    assert.equal(projection.counts.record_count, 2);
    assert.equal(projection.metadata.state, "fresh");
    assert.notEqual(projection.metadata.state, "failed");
  }));

test("dirty record-time bounds reconcile from durable records for one stream", async () =>
  withTempDb(async () => {
    await rebuildEmptyProjection();
    await ingestRecord("gmail", {
      data: { created_at: "2025-01-01T00:00:00.000Z", id: "m1", subject: "old" },
      emitted_at: "2026-01-01T00:00:00.000Z",
      key: "m1",
      stream: "messages",
    });
    await ingestRecord("gmail", {
      data: { created_at: "2025-02-01T00:00:00.000Z", id: "m2", subject: "new" },
      emitted_at: "2026-01-02T00:00:00.000Z",
      key: "m2",
      stream: "messages",
    });
    registerConnectorManifest("gmail", {
      connector_id: "gmail",
      streams: [{ consent_time_field: "created_at", name: "messages" }],
    });
    await rebuildFromCurrentDb();

    assert.equal(await deleteRecord("gmail", "messages", "m1"), 1);
    assert.equal(getDatasetSummaryProjection().metadata.state, "stale");

    const result = await reconcileDirtyDatasetSummaryRecordTimeBounds({
      getStreamRecordTimeBounds: getDatasetSummaryStreamRecordTimeBounds,
    });
    const projection = getDatasetSummaryProjection();

    assert.deepEqual(result, { deferred: 0, reconciled: 1, residual: 0 });
    assert.equal(projection.metadata.state, "fresh");
    assert.equal(projection.record_time_bounds.earliest, "2025-02-01T00:00:00.000Z");
    assert.equal(projection.record_time_bounds.latest, "2025-02-01T00:00:00.000Z");
    assert.equal(getStreamDirtyFlag("gmail", "messages"), 0);
  }));

test("dirty record-time reconciliation defers unsafe rows instead of clearing stale state", async () =>
  withTempDb(async () => {
    await rebuildEmptyProjection();
    getDb()
      .prepare(
        `INSERT INTO dataset_summary_stream_projection(
           connector_id,
           stream,
           record_count,
           record_json_bytes,
           dirty_record_time_bounds,
           computed_at
         )
         VALUES('gmail', 'messages', 1, 1, 1, '2026-01-01T00:00:00.000Z')`
      )
      .run();

    const result = await reconcileDirtyDatasetSummaryRecordTimeBounds({
      getStreamRecordTimeBounds: () => {
        throw new Error("should not scan without a safe consent_time_field");
      },
    });
    const projection = getDatasetSummaryProjection();

    assert.deepEqual(result, { deferred: 1, reconciled: 0, residual: 0 });
    assert.equal(projection.metadata.state, "stale");
    assert.ok(projection.metadata.last_error);
    assert.match(projection.metadata.last_error, DIRTY_BOUNDS_ERROR);
    assert.equal(getStreamDirtyFlag("gmail", "messages"), 1);
  }));

test("record delta during running rebuild does not silently overwrite the rebuild result", async () =>
  withTempDb(async () => {
    await rebuildFromCurrentDb();
    await ingestRecord("gmail", {
      data: { id: "m1", subject: "pre-rebuild" },
      emitted_at: "2026-01-01T00:00:00.000Z",
      key: "m1",
      stream: "messages",
    });

    let deltaArrivedDuringRebuild = false;
    await rebuildDatasetSummaryProjection({
      getCounts: async () => {
        // Simulate a live record delta arriving mid-rebuild, after the
        // rebuild has stamped rebuild_status='running' but before it
        // commits its final summary.
        await ingestRecord("gmail", {
          data: { id: "m2", subject: "mid-rebuild" },
          emitted_at: "2026-01-02T00:00:00.000Z",
          key: "m2",
          stream: "messages",
        });
        deltaArrivedDuringRebuild = true;
        // Rebuild's seed query — return a deliberately stale snapshot
        // (count=1) to prove the rebuild's final write cannot win.
        return { connector_count: 1, record_count: 1, stream_count: 1 };
      },
      getIngestedTimeBounds: () => ({
        earliest: "2026-01-01T00:00:00.000Z",
        latest: "2026-01-01T00:00:00.000Z",
      }),
      getRecordTimeBounds: () => ({ earliest: null, latest: null }),
      getRetainedBytes: () => ({
        blob_bytes: 0,
        record_changes_json_bytes: 0,
        record_json_bytes: 10,
      }),
      listStreamProjectionSeeds: () => [
        {
          connector_id: "gmail",
          record_count: 1,
          record_json_bytes: 10,
          stream: "messages",
        },
      ],
      listTopConnectorCandidates: () => [{ connector_id: "gmail", record_count: 1 }],
    });

    assert.equal(deltaArrivedDuringRebuild, true);
    const projection = getDatasetSummaryProjection();
    // The mid-rebuild delta bumped the generation; the rebuild's final
    // write must NOT have claimed fresh, and the projection must not
    // report the rebuild's stale count of 1.
    assert.notEqual(projection.metadata.state, "fresh");
    assert.ok(
      projection.metadata.state === "stale" || projection.metadata.state === "failed",
      `expected stale or failed, got ${projection.metadata.state}`
    );
    assert.equal(projection.metadata.rebuild_status, "idle");
  }));

test("reconcile concurrent with a delta leaves the row dirty for the next pass", async () =>
  withTempDb(async () => {
    await rebuildEmptyProjection();
    await ingestRecord("gmail", {
      data: { created_at: "2025-01-01T00:00:00.000Z", id: "m1", subject: "old" },
      emitted_at: "2026-01-01T00:00:00.000Z",
      key: "m1",
      stream: "messages",
    });
    registerConnectorManifest("gmail", {
      connector_id: "gmail",
      streams: [{ consent_time_field: "created_at", name: "messages" }],
    });
    await rebuildFromCurrentDb();

    // Mark the row dirty manually to mimic the post-delete state without
    // also bumping the projection's rebuild_status.
    getDb()
      .prepare(
        `UPDATE dataset_summary_stream_projection
            SET dirty_record_time_bounds = 1
          WHERE connector_id = 'gmail' AND stream = 'messages'`
      )
      .run();

    const result = await reconcileDirtyDatasetSummaryRecordTimeBounds({
      getStreamRecordTimeBounds: (connectorId: string, stream: string) => {
        // Simulate a concurrent delta arriving mid-reconcile: the row's
        // computed_at advances and dirty_record_time_bounds re-asserts
        // before reconcile gets to its transactional UPDATE.
        getDb()
          .prepare(
            `UPDATE dataset_summary_stream_projection
                SET computed_at = '2099-01-01T00:00:00.000Z',
                    dirty_record_time_bounds = 1
              WHERE connector_id = ? AND stream = ?`
          )
          .run(connectorId, stream);
        return getDatasetSummaryStreamRecordTimeBounds(connectorId, stream, "created_at");
      },
    });

    assert.deepEqual(result, { deferred: 1, reconciled: 0, residual: 0 });
    // The concurrent delta's dirty flag must survive the reconcile pass.
    assert.equal(getStreamDirtyFlag("gmail", "messages"), 1);
  }));

test("rebuild succeeds when no concurrent delta interferes", async () =>
  withTempDb(async () => {
    await rebuildEmptyProjection();
    await ingestRecord("gmail", {
      data: { id: "m1", subject: "hello" },
      emitted_at: "2026-01-01T00:00:00.000Z",
      key: "m1",
      stream: "messages",
    });
    await rebuildFromCurrentDb();
    const projection = getDatasetSummaryProjection();
    assert.equal(projection.metadata.state, "fresh");
    assert.equal(projection.metadata.rebuild_status, "idle");
    assert.equal(projection.counts.record_count, 1);
  }));

test("blob delta during running rebuild does not silently overwrite the rebuild result", async () =>
  withTempDb(async () => {
    await rebuildFromCurrentDb();
    await ingestRecord("gmail", {
      data: { id: "m1", subject: "hello" },
      emitted_at: "2026-01-01T00:00:00.000Z",
      key: "m1",
      stream: "messages",
    });
    await rebuildFromCurrentDb();

    await rebuildDatasetSummaryProjection({
      getCounts: () => {
        applyDatasetSummaryBlobDelta({ blobBytesDelta: 1234 });
        return { connector_count: 1, record_count: 1, stream_count: 1 };
      },
      getIngestedTimeBounds: () => ({ earliest: null, latest: null }),
      getRecordTimeBounds: () => ({ earliest: null, latest: null }),
      getRetainedBytes: () => ({
        blob_bytes: 0,
        record_changes_json_bytes: 0,
        record_json_bytes: 10,
      }),
      listStreamProjectionSeeds: () => [
        {
          connector_id: "gmail",
          record_count: 1,
          record_json_bytes: 10,
          stream: "messages",
        },
      ],
      listTopConnectorCandidates: () => [{ connector_id: "gmail", record_count: 1 }],
    });

    const projection = getDatasetSummaryProjection();
    assert.notEqual(projection.metadata.state, "fresh");
    assert.equal(projection.metadata.rebuild_status, "idle");
  }));

test("record delta during first-ever rebuild stays stale instead of failing on null computed_at", () =>
  withTempDb(async () => {
    // No prior rebuild has run, so the projection's computed_at is null.
    // The rebuild below stamps rebuild_status='running' while keeping
    // computed_at=null (markDatasetSummaryProjectionRebuilding preserves
    // the prior computed_at). A delta arriving inside this window must
    // be treated as a fence-mark-stale, NOT as a hard "projection has
    // not been rebuilt" failure.
    let deltaArrived = false;
    let metadataDuringRebuild: DatasetSummaryMetadata | undefined;
    await rebuildDatasetSummaryProjection({
      getCounts: () => {
        applyDatasetSummaryRecordDelta({
          connectorId: "gmail",
          consentTimeField: null,
          dirtyRecordTimeBounds: false,
          emittedAt: "2026-01-01T00:00:00.000Z",
          recordChangesJsonBytesDelta: 0,
          recordCountDelta: 1,
          recordJsonBytesDelta: 10,
          stream: "messages",
        });
        deltaArrived = true;
        metadataDuringRebuild = getDatasetSummaryProjection().metadata;
        return { connector_count: 0, record_count: 0, stream_count: 0 };
      },
      getIngestedTimeBounds: () => ({ earliest: null, latest: null }),
      getRecordTimeBounds: () => ({ earliest: null, latest: null }),
      getRetainedBytes: () => ({
        blob_bytes: 0,
        record_changes_json_bytes: 0,
        record_json_bytes: 0,
      }),
      listStreamProjectionSeeds: () => [],
      listTopConnectorCandidates: () => [],
    });

    assert.equal(deltaArrived, true);
    assert.ok(metadataDuringRebuild, "expected getCounts to have captured mid-rebuild metadata");
    // Mid-rebuild snapshot: the delta must NOT have marked the
    // projection failed simply because computed_at was null.
    assert.notEqual(metadataDuringRebuild.state, "failed");
    assert.notEqual(metadataDuringRebuild.rebuild_status, "failed");
    assert.equal(
      (metadataDuringRebuild.last_error || "").includes("projection has not been rebuilt"),
      false,
      `expected no "not been rebuilt" error, got ${metadataDuringRebuild.last_error}`
    );

    const projection = getDatasetSummaryProjection();
    // After the rebuild's guarded commit detects the bumped generation,
    // the projection must NOT report a false-fresh state.
    assert.notEqual(projection.metadata.state, "fresh");
    assert.equal(projection.metadata.rebuild_status, "idle");
  }));

test("blob delta during first-ever rebuild stays stale instead of failing on null computed_at", () =>
  withTempDb(async () => {
    let deltaArrived = false;
    let metadataDuringRebuild: DatasetSummaryMetadata | undefined;
    await rebuildDatasetSummaryProjection({
      getCounts: () => {
        applyDatasetSummaryBlobDelta({ blobBytesDelta: 1234 });
        deltaArrived = true;
        metadataDuringRebuild = getDatasetSummaryProjection().metadata;
        return { connector_count: 0, record_count: 0, stream_count: 0 };
      },
      getIngestedTimeBounds: () => ({ earliest: null, latest: null }),
      getRecordTimeBounds: () => ({ earliest: null, latest: null }),
      getRetainedBytes: () => ({
        blob_bytes: 0,
        record_changes_json_bytes: 0,
        record_json_bytes: 0,
      }),
      listStreamProjectionSeeds: () => [],
      listTopConnectorCandidates: () => [],
    });

    assert.equal(deltaArrived, true);
    assert.ok(metadataDuringRebuild, "expected getCounts to have captured mid-rebuild metadata");
    assert.notEqual(metadataDuringRebuild.state, "failed");
    assert.notEqual(metadataDuringRebuild.rebuild_status, "failed");
    assert.equal(
      (metadataDuringRebuild.last_error || "").includes("projection has not been rebuilt"),
      false,
      `expected no "not been rebuilt" error, got ${metadataDuringRebuild.last_error}`
    );

    const projection = getDatasetSummaryProjection();
    assert.notEqual(projection.metadata.state, "fresh");
    assert.equal(projection.metadata.rebuild_status, "idle");
  }));

test("rebuild caps persisted top connector candidates without losing the true top entries", async () =>
  withTempDb(async () => {
    // Adapter returns 200 candidates in arbitrary order. The persisted
    // projection must drop the tail but keep the highest-count entries
    // — proving the cap is enforced and the sort is correct.
    const adapterCandidates: { connector_id: string; record_count: number }[] = [];
    for (let i = 0; i < 200; i += 1) {
      adapterCandidates.push({
        connector_id: `c${String(i).padStart(3, "0")}`,
        // Inverted so the lowest-numbered ids have the highest counts;
        // confirms the cap does not silently slice by adapter order.
        record_count: 1000 - i,
      });
    }
    await rebuildDatasetSummaryProjection({
      getCounts: () => ({ connector_count: 200, record_count: 100_000, stream_count: 200 }),
      getIngestedTimeBounds: () => ({ earliest: null, latest: null }),
      getRecordTimeBounds: () => ({ earliest: null, latest: null }),
      getRetainedBytes: () => ({
        blob_bytes: 0,
        record_changes_json_bytes: 0,
        record_json_bytes: 0,
      }),
      listTopConnectorCandidates: () => adapterCandidates,
    });

    const projection = getDatasetSummaryProjection();
    assert.ok(
      projection.top_connector_candidates.length <= 32,
      `expected top candidates to be capped, got ${projection.top_connector_candidates.length}`
    );
    const [topCandidate] = projection.top_connector_candidates;
    assert.ok(topCandidate);
    assert.equal(topCandidate.connector_id, "c000");
    assert.equal(topCandidate.record_count, 1000);
    // The persisted JSON must not silently include the long tail.
    const row = requireRow(
      getDb()
        .prepare(`SELECT summary_json FROM dataset_summary_projection WHERE projection_key = 'global'`)
        .get<{ summary_json: string }>(),
      "dataset summary projection row must exist"
    );
    const parsed = JSON.parse(row.summary_json);
    assert.ok(parsed.top_connector_candidates.length <= 32);
  }));

test("rebuild cancellation leaves canonical records intact and projection stale", async () =>
  withTempDb(async () => {
    await rebuildEmptyProjection();
    await ingestRecord("gmail", {
      data: { id: "m1", subject: "hello" },
      emitted_at: "2026-01-01T00:00:00.000Z",
      key: "m1",
      stream: "messages",
    });
    await rebuildFromCurrentDb();
    const beforeFresh = getDatasetSummaryProjection();
    assert.equal(beforeFresh.metadata.state, "fresh");
    const beforeRecordCount = requireRow(
      getDb().prepare("SELECT COUNT(*) AS n FROM records").get<{ n: number }>(),
      "record count row must exist"
    ).n;

    const controller = new AbortController();
    await assert.rejects(
      () =>
        rebuildDatasetSummaryProjection(
          {
            getCounts: () => {
              controller.abort();
              return { connector_count: 1, record_count: 1, stream_count: 1 };
            },
            getIngestedTimeBounds: () => ({ earliest: null, latest: null }),
            getRecordTimeBounds: () => ({ earliest: null, latest: null }),
            getRetainedBytes: () => ({
              blob_bytes: 0,
              record_changes_json_bytes: 0,
              record_json_bytes: 0,
            }),
            listStreamProjectionSeeds: () => [],
            listTopConnectorCandidates: () => [],
          },
          { signal: controller.signal }
        ),
      (err: unknown) => err instanceof Error && err.name === "AbortError"
    );

    // Canonical record table must be untouched by the cancelled rebuild.
    assert.equal(
      requireRow(
        getDb().prepare("SELECT COUNT(*) AS n FROM records").get<{ n: number }>(),
        "record count row must exist"
      ).n,
      beforeRecordCount
    );

    const projection = getDatasetSummaryProjection();
    // Cancellation projects honestly as stale, not failed; the last-known
    // counts survive so the operator surface does not flash to zero.
    assert.notEqual(projection.metadata.state, "fresh");
    assert.notEqual(projection.metadata.state, "failed");
    assert.equal(projection.metadata.state, "stale");
    assert.equal(projection.metadata.rebuild_status, "idle");
    assert.equal(projection.counts.record_count, beforeFresh.counts.record_count);
  }));

test("reconcile bounds work per call and reports residual rows for the next pass", async () =>
  withTempDb(async () => {
    await rebuildEmptyProjection();

    // Seed 260 dirty stream projection rows directly — exceeds the
    // per-call cap of 256 so the call must leave at least four behind.
    const insert = getDb().prepare(
      `INSERT INTO dataset_summary_stream_projection(
         connector_id,
         stream,
         record_count,
         record_json_bytes,
         consent_time_field,
         dirty_record_time_bounds,
         computed_at
       )
       VALUES(?, ?, 1, 1, 'created_at', 1, '2026-01-01T00:00:00.000Z')`
    );
    for (let i = 0; i < 260; i += 1) {
      insert.run("gmail", `stream-${String(i).padStart(4, "0")}`);
    }

    let scanned = 0;
    const result = await reconcileDirtyDatasetSummaryRecordTimeBounds({
      getStreamRecordTimeBounds: () => {
        scanned += 1;
        return { earliest: "2025-01-01T00:00:00.000Z", latest: "2025-01-02T00:00:00.000Z" };
      },
    });

    assert.ok(scanned <= 256, `reconcile must not scan more than the per-call cap; scanned=${scanned}`);
    assert.equal(result.residual, 1);
    assert.equal(result.reconciled, 256);

    // Residual rows must remain dirty so a follow-up call still has work.
    const remainingDirty = requireRow(
      getDb()
        .prepare(
          `SELECT COUNT(*) AS n
           FROM dataset_summary_stream_projection
          WHERE dirty_record_time_bounds <> 0`
        )
        .get<{ n: number }>(),
      "dirty stream count row must exist"
    ).n;
    assert.equal(remainingDirty, 260 - 256);

    // Projection metadata must honestly reflect that work is unfinished.
    const projection = getDatasetSummaryProjection();
    assert.equal(projection.metadata.state, "stale");
  }));

test("reconcile cancellation leaves dirty rows untouched and marks projection stale", async () =>
  withTempDb(async () => {
    await rebuildEmptyProjection();
    getDb()
      .prepare(
        `INSERT INTO dataset_summary_stream_projection(
           connector_id,
           stream,
           record_count,
           record_json_bytes,
           consent_time_field,
           dirty_record_time_bounds,
           computed_at
         )
         VALUES('gmail', 'messages', 1, 1, 'created_at', 1, '2026-01-01T00:00:00.000Z')`
      )
      .run();

    const controller = new AbortController();
    await assert.rejects(
      () =>
        reconcileDirtyDatasetSummaryRecordTimeBounds(
          {
            getStreamRecordTimeBounds: () => {
              controller.abort();
              const err = new Error("cancelled");
              err.name = "AbortError";
              throw err;
            },
          },
          { signal: controller.signal }
        ),
      (err: unknown) => err instanceof Error && err.name === "AbortError"
    );

    // Cancelled reconcile must not have cleared the dirty bit.
    assert.equal(getStreamDirtyFlag("gmail", "messages"), 1);
    const projection = getDatasetSummaryProjection();
    assert.equal(projection.metadata.state, "stale");
    // Honest failure mode: cancellation is not a hard failure.
    assert.notEqual(projection.metadata.rebuild_status, "failed");
  }));

async function rebuildEmptyProjection() {
  await rebuildDatasetSummaryProjection({
    getCounts: () => ({ connector_count: 0, record_count: 0, stream_count: 0 }),
    getIngestedTimeBounds: () => ({ earliest: null, latest: null }),
    getRecordTimeBounds: () => ({ earliest: null, latest: null }),
    getRetainedBytes: () => ({
      blob_bytes: 0,
      record_changes_json_bytes: 0,
      record_json_bytes: 0,
    }),
    listTopConnectorCandidates: () => [],
  });
}

async function rebuildFromCurrentDb() {
  await rebuildDatasetSummaryProjection({
    getCounts: () => {
      const agg = getSqliteDatasetRecordsAggregate();
      return {
        connector_count: agg.connector_count,
        record_count: agg.record_count,
        stream_count: agg.stream_count,
      };
    },
    getIngestedTimeBounds: () => {
      const agg = getSqliteDatasetRecordsAggregate();
      return {
        earliest: agg.earliest_ingested_at,
        latest: agg.latest_ingested_at,
      };
    },
    getRecordTimeBounds: () => getDatasetRecordTimeBounds(),
    getRetainedBytes: async () => {
      const agg = getSqliteDatasetRecordsAggregate();
      return {
        blob_bytes: await getDatasetBlobBytes(),
        record_changes_json_bytes: await getDatasetRecordChangesBytes(),
        record_json_bytes: agg.record_json_bytes,
      };
    },
    listStreamProjectionSeeds: () => listDatasetSummaryStreamProjectionSeeds(),
    listTopConnectorCandidates: () => getSqliteDatasetTopConnectorCandidates(),
  });
}

interface ConnectorManifestFixture {
  connector_id: string;
  streams: { name: string; consent_time_field: string }[];
}

function registerConnectorManifest(connectorId: string, manifest: ConnectorManifestFixture) {
  getDb()
    .prepare(
      `INSERT INTO connectors(connector_id, manifest, created_at)
       VALUES(?, ?, ?)
       ON CONFLICT(connector_id) DO UPDATE SET
         manifest = excluded.manifest`
    )
    .run(connectorId, JSON.stringify(manifest), "2026-01-01T00:00:00.000Z");
}

function getStreamDirtyFlag(connectorId: string, stream: string): number {
  const row = requireRow(
    getDb()
      .prepare(
        `SELECT dirty_record_time_bounds
           FROM dataset_summary_stream_projection
          WHERE connector_id = ? AND stream = ?`
      )
      .get<{ dirty_record_time_bounds: number }>(connectorId, stream),
    "stream projection row must exist"
  );
  return Number(row.dirty_record_time_bounds);
}

function liveRecordJsonBytes() {
  return Number(
    requireRow(
      getDb()
        .prepare(
          `SELECT COALESCE(SUM(LENGTH(CAST(record_json AS BLOB))), 0) AS bytes
           FROM records
          WHERE deleted = 0`
        )
        .get<{ bytes: number }>(),
      "live record byte total row must exist"
    ).bytes || 0
  );
}

function recordChangeJsonBytes() {
  return Number(
    requireRow(
      getDb()
        .prepare(
          `SELECT COALESCE(SUM(LENGTH(CAST(record_json AS BLOB))), 0) AS bytes
           FROM record_changes`
        )
        .get<{ bytes: number }>(),
      "record change byte total row must exist"
    ).bytes || 0
  );
}

function seedStreamProjectionRow({
  connectorId,
  stream,
  recordCount = 1,
  recordJsonBytes = 64,
  earliestIngestedAt = "2026-01-01T00:00:00.000Z",
  latestIngestedAt = "2026-05-01T00:00:00.000Z",
  earliestRecordTime = null,
  latestRecordTime = null,
  consentTimeField = null,
  dirty = 0,
  computedAt = "2026-05-19T12:00:00.000Z",
}: {
  connectorId: string;
  stream: string;
  recordCount?: number;
  recordJsonBytes?: number;
  earliestIngestedAt?: string;
  latestIngestedAt?: string;
  earliestRecordTime?: string | null;
  latestRecordTime?: string | null;
  consentTimeField?: string | null;
  dirty?: number;
  computedAt?: string;
}) {
  getDb()
    .prepare(
      `INSERT INTO dataset_summary_stream_projection(
         connector_id,
         stream,
         record_count,
         record_json_bytes,
         earliest_ingested_at,
         latest_ingested_at,
         earliest_record_time,
         latest_record_time,
         consent_time_field,
         dirty_record_time_bounds,
         computed_at
       )
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      connectorId,
      stream,
      recordCount,
      recordJsonBytes,
      earliestIngestedAt,
      latestIngestedAt,
      earliestRecordTime,
      latestRecordTime,
      consentTimeField,
      dirty,
      computedAt
    );
}

test("listStreamProjections returns every projection row sorted by (connector_id, stream)", () =>
  withTempDb(() => {
    seedStreamProjectionRow({ connectorId: "gmail", stream: "threads" });
    seedStreamProjectionRow({ connectorId: "gmail", stream: "messages" });
    seedStreamProjectionRow({ connectorId: "calendar", stream: "events" });

    const rows = listSqliteStreamProjections();

    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => [r.connector_id, r.stream]),
      [
        ["calendar", "events"],
        ["gmail", "messages"],
        ["gmail", "threads"],
      ]
    );
    const [firstRow] = rows;
    assert.ok(firstRow, "expected at least one projection row");
    assert.equal(firstRow.record_count, 1);
    assert.equal(firstRow.record_json_bytes, 64);
    assert.equal(firstRow.computed_at, "2026-05-19T12:00:00.000Z");
  }));

test("listStreamProjections filters to the supplied connector_id", () =>
  withTempDb(() => {
    seedStreamProjectionRow({ connectorId: "gmail", stream: "threads" });
    seedStreamProjectionRow({ connectorId: "gmail", stream: "messages" });
    seedStreamProjectionRow({ connectorId: "calendar", stream: "events" });

    const rows = listSqliteStreamProjections({ connectorId: "gmail" });

    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => r.stream),
      ["messages", "threads"]
    );
    assert.equal(
      rows.every((r) => r.connector_id === "gmail"),
      true
    );
  }));

test("listStreamProjections passes NULL record-time bounds through honestly", () =>
  withTempDb(() => {
    seedStreamProjectionRow({
      connectorId: "gmail",
      consentTimeField: null,
      dirty: 0,
      earliestRecordTime: null,
      latestRecordTime: null,
      stream: "no_consent_time_field",
    });
    seedStreamProjectionRow({
      connectorId: "gmail",
      consentTimeField: "created_at",
      dirty: 0,
      earliestRecordTime: "2025-12-01T00:00:00.000Z",
      latestRecordTime: "2026-04-30T00:00:00.000Z",
      stream: "reconciled",
    });

    const rows = listSqliteStreamProjections({ connectorId: "gmail" });

    const noField = rows.find((r) => r.stream === "no_consent_time_field");
    const reconciled = rows.find((r) => r.stream === "reconciled");

    assert.ok(noField, "expected a row for no_consent_time_field");
    assert.ok(reconciled, "expected a row for reconciled");
    assert.equal(noField.earliest_record_time, null);
    assert.equal(noField.latest_record_time, null);
    assert.equal(noField.consent_time_field, null);

    assert.equal(reconciled.earliest_record_time, "2025-12-01T00:00:00.000Z");
    assert.equal(reconciled.latest_record_time, "2026-04-30T00:00:00.000Z");
    assert.equal(reconciled.consent_time_field, "created_at");
  }));

test("listStreamProjections exposes dirty_record_time_bounds as a boolean", () =>
  withTempDb(() => {
    seedStreamProjectionRow({
      connectorId: "gmail",
      consentTimeField: "created_at",
      dirty: 0,
      stream: "fresh",
    });
    seedStreamProjectionRow({
      connectorId: "gmail",
      consentTimeField: "created_at",
      dirty: 1,
      stream: "dirty",
    });

    const rows = listSqliteStreamProjections({ connectorId: "gmail" });

    const fresh = rows.find((r) => r.stream === "fresh");
    const dirty = rows.find((r) => r.stream === "dirty");

    assert.ok(fresh, "expected a row for fresh");
    assert.ok(dirty, "expected a row for dirty");
    assert.equal(fresh.dirty_record_time_bounds, false);
    assert.equal(dirty.dirty_record_time_bounds, true);
    assert.equal(typeof fresh.dirty_record_time_bounds, "boolean");
    assert.equal(typeof dirty.dirty_record_time_bounds, "boolean");
  }));

test("listStreamProjections returns an empty array when no projection rows exist", () =>
  withTempDb(() => {
    assert.deepEqual(listSqliteStreamProjections(), []);
    assert.deepEqual(listSqliteStreamProjections({ connectorId: "gmail" }), []);
  }));
function requireRow<T extends object>(row: T | undefined, description: string): T {
  assert.ok(row, description);
  return row;
}
