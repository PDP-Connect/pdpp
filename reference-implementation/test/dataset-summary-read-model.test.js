import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  __setDatasetSummaryProjectionFaultHookForTest,
  applyDatasetSummaryBlobDelta,
  applyDatasetSummaryRecordDelta,
  getDatasetSummaryProjection,
  listStreamProjections,
  markDatasetSummaryProjectionStale,
  reconcileDirtyDatasetSummaryRecordTimeBounds,
  rebuildDatasetSummaryProjection,
} from '../server/dataset-summary-read-model.js';
import { closeDb, getDb, initDb } from '../server/db.js';
import {
  deleteAllRecords,
  deleteAllRecordsForConnector,
  deleteRecord,
  getDatasetBlobBytes,
  getDatasetRecordChangesBytes,
  getDatasetRecordsAggregate,
  getDatasetSummaryStreamRecordTimeBounds,
  getDatasetRecordTimeBounds,
  ingestRecord,
  listDatasetSummaryStreamProjectionSeeds,
  listDatasetTopConnectorCandidates,
} from '../server/records.js';

async function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'pdpp-summary-projection-'));
  try {
    initDb(join(dir, 'pdpp.sqlite'));
    return await fn();
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('dataset summary projection reports rebuilding metadata when rows are missing', () =>
  withTempDb(() => {
    const projection = getDatasetSummaryProjection();

    assert.equal(projection.counts.record_count, 0);
    assert.equal(projection.metadata.computed_at, null);
    assert.equal(projection.metadata.state, 'rebuilding');
    assert.equal(projection.metadata.rebuild_status, 'running');
    assert.match(projection.metadata.stale_since, /^\d{4}-\d{2}-\d{2}T/);
  }));

test('dataset summary projection rebuild persists bounded rows from canonical dependencies', async () =>
  withTempDb(async () => {
    await rebuildDatasetSummaryProjection({
      getCounts: () => ({ connector_count: 2, stream_count: 3, record_count: 8 }),
      getRetainedBytes: () => ({
        record_json_bytes: 100,
        record_changes_json_bytes: 25,
        blob_bytes: 75,
      }),
      getRecordTimeBounds: () => ({
        earliest: '2026-01-01T00:00:00Z',
        latest: '2026-05-01T00:00:00Z',
      }),
      getIngestedTimeBounds: () => ({
        earliest: '2026-01-02T00:00:00Z',
        latest: '2026-05-02T00:00:00Z',
      }),
      listTopConnectorCandidates: () => [
        { connector_id: 'gmail', record_count: 5 },
        { connector_id: 'calendar', record_count: 3 },
      ],
    });

    const projection = getDatasetSummaryProjection();
    assert.deepEqual(projection.counts, {
      connector_count: 2,
      stream_count: 3,
      record_count: 8,
    });
    assert.equal(projection.retained_bytes.blob_bytes, 75);
    assert.equal(projection.record_time_bounds.earliest, '2026-01-01T00:00:00Z');
    assert.equal(projection.metadata.state, 'fresh');
    assert.equal(projection.metadata.rebuild_status, 'idle');
    assert.match(projection.metadata.source_high_watermark, /^rebuilt:/);
  }));

test('dataset summary projection rebuild keeps last-known rows and marks failure', async () =>
  withTempDb(async () => {
    await rebuildDatasetSummaryProjection({
      getCounts: () => ({ connector_count: 1, stream_count: 1, record_count: 1 }),
      getRetainedBytes: () => ({
        record_json_bytes: 10,
        record_changes_json_bytes: 0,
        blob_bytes: 0,
      }),
      getRecordTimeBounds: () => ({ earliest: '2026-01-01', latest: '2026-01-01' }),
      getIngestedTimeBounds: () => ({ earliest: '2026-01-02', latest: '2026-01-02' }),
      listTopConnectorCandidates: () => [{ connector_id: 'gmail', record_count: 1 }],
    });

    await assert.rejects(
      () =>
        rebuildDatasetSummaryProjection({
          getCounts: () => {
            throw new Error('secret-token-abcdefghijklmnopqrstuvwxyz123456 failed');
          },
          getRetainedBytes: () => {
            throw new Error('should not matter');
          },
          getRecordTimeBounds: () => ({ earliest: null, latest: null }),
          getIngestedTimeBounds: () => ({ earliest: null, latest: null }),
          listTopConnectorCandidates: () => [],
        }),
      /secret-token/,
    );

    const projection = getDatasetSummaryProjection();
    assert.equal(projection.counts.record_count, 1);
    assert.equal(projection.metadata.state, 'failed');
    assert.equal(projection.metadata.rebuild_status, 'failed');
    assert.equal(
      projection.metadata.last_error.includes('abcdefghijklmnopqrstuvwxyz123456'),
      false,
    );
  }));

test('record no-op ingest does not change dataset summary projection', async () =>
  withTempDb(async () => {
    await rebuildEmptyProjection();
    await ingestRecord('gmail', {
      stream: 'messages',
      key: 'm1',
      emitted_at: '2026-01-01T00:00:00.000Z',
      data: { id: 'm1', subject: 'hello' },
    });
    const afterFirst = getDatasetSummaryProjection();

    await ingestRecord('gmail', {
      stream: 'messages',
      key: 'm1',
      emitted_at: '2026-01-02T00:00:00.000Z',
      data: { id: 'm1', subject: 'hello' },
    });

    assert.deepEqual(getDatasetSummaryProjection(), afterFirst);
  }));

test('record upsert deltas update counts bytes ingest bounds and top connectors', async () =>
  withTempDb(async () => {
    await rebuildEmptyProjection();
    await ingestRecord('gmail', {
      stream: 'messages',
      key: 'm1',
      emitted_at: '2026-01-02T00:00:00.000Z',
      data: { id: 'm1', subject: 'hello' },
    });
    await ingestRecord('calendar', {
      stream: 'events',
      key: 'e1',
      emitted_at: '2026-01-01T00:00:00.000Z',
      data: { id: 'e1', title: 'standup' },
    });
    await ingestRecord('gmail', {
      stream: 'messages',
      key: 'm1',
      emitted_at: '2026-01-03T00:00:00.000Z',
      data: { id: 'm1', subject: 'hello world' },
    });

    const projection = getDatasetSummaryProjection();
    assert.deepEqual(projection.counts, {
      connector_count: 2,
      stream_count: 2,
      record_count: 2,
    });
    assert.equal(projection.ingested_time_bounds.earliest, '2026-01-01T00:00:00.000Z');
    assert.equal(projection.ingested_time_bounds.latest, '2026-01-03T00:00:00.000Z');
    assert.deepEqual(projection.top_connector_candidates, [
      { connector_id: 'calendar', record_count: 1 },
      { connector_id: 'gmail', record_count: 1 },
    ]);
    assert.equal(projection.retained_bytes.record_json_bytes, liveRecordJsonBytes());
    assert.equal(projection.retained_bytes.record_changes_json_bytes, recordChangeJsonBytes());
    assert.equal(projection.metadata.state, 'fresh');
  }));

test('record-change pruning subtracts the inclusive retention boundary', async () =>
  withTempDb(async () => {
    const previousLimit = process.env.PDPP_CHANGE_HISTORY_LIMIT;
    process.env.PDPP_CHANGE_HISTORY_LIMIT = '1';
    try {
      await rebuildEmptyProjection();
      await ingestRecord('gmail', {
        stream: 'messages',
        key: 'm1',
        emitted_at: '2026-01-01T00:00:00.000Z',
        data: { id: 'm1', subject: 'v1' },
      });
      await ingestRecord('gmail', {
        stream: 'messages',
        key: 'm1',
        emitted_at: '2026-01-02T00:00:00.000Z',
        data: { id: 'm1', subject: 'v2' },
      });

      const projection = getDatasetSummaryProjection();
      assert.equal(projection.retained_bytes.record_changes_json_bytes, recordChangeJsonBytes());
      assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM record_changes').get().n, 1);
    } finally {
      if (previousLimit === undefined) {
        delete process.env.PDPP_CHANGE_HISTORY_LIMIT;
      } else {
        process.env.PDPP_CHANGE_HISTORY_LIMIT = previousLimit;
      }
    }
  }));

test('record delete deltas decrement live counts without staling non-time streams', async () =>
  withTempDb(async () => {
    await rebuildEmptyProjection();
    await ingestRecord('gmail', {
      stream: 'messages',
      key: 'm1',
      emitted_at: '2026-01-01T00:00:00.000Z',
      data: { id: 'm1', subject: 'hello' },
    });
    await ingestRecord('gmail', {
      stream: 'messages',
      key: 'm2',
      emitted_at: '2026-01-02T00:00:00.000Z',
      data: { id: 'm2', subject: 'later' },
    });

    assert.equal(await deleteRecord('gmail', 'messages', 'm1'), 1);
    const projection = getDatasetSummaryProjection();

    assert.equal(projection.counts.record_count, 1);
    assert.equal(projection.counts.connector_count, 1);
    assert.equal(projection.counts.stream_count, 1);
    assert.equal(projection.retained_bytes.record_json_bytes, liveRecordJsonBytes());
    assert.equal(projection.retained_bytes.record_changes_json_bytes, recordChangeJsonBytes());
    assert.equal(projection.metadata.state, 'fresh');
    assert.equal(projection.metadata.stale_since, null);
  }));

test('blob insert delta updates retained blob bytes and duplicate content is a no-op', async () =>
  withTempDb(async () => {
    await rebuildEmptyProjection();

    applyDatasetSummaryBlobDelta({ blobBytesDelta: Buffer.byteLength('hello blob') });
    applyDatasetSummaryBlobDelta({ blobBytesDelta: 0 });

    const projection = getDatasetSummaryProjection();
    assert.equal(projection.retained_bytes.blob_bytes, Buffer.byteLength('hello blob'));
  }));

test('blob and non-repair deltas preserve existing stale metadata', async () =>
  withTempDb(async () => {
    await rebuildEmptyProjection();
    await ingestRecord('gmail', {
      stream: 'messages',
      key: 'm1',
      emitted_at: '2026-01-01T00:00:00.000Z',
      data: { id: 'm1', subject: 'hello' },
    });
    markDatasetSummaryProjectionStale('test stale metadata');
    const staleProjection = getDatasetSummaryProjection();
    assert.equal(staleProjection.metadata.state, 'stale');

    applyDatasetSummaryBlobDelta({ blobBytesDelta: 10 });
    const afterBlob = getDatasetSummaryProjection();
    assert.equal(afterBlob.metadata.state, 'stale');
    assert.equal(afterBlob.metadata.stale_since, staleProjection.metadata.stale_since);

    await ingestRecord('gmail', {
      stream: 'messages',
      key: 'm2',
      emitted_at: '2026-01-02T00:00:00.000Z',
      data: { id: 'm2', subject: 'later' },
    });
    const afterRecord = getDatasetSummaryProjection();
    assert.equal(afterRecord.metadata.state, 'stale');
    assert.equal(afterRecord.metadata.stale_since, staleProjection.metadata.stale_since);
  }));

test('projection hook failure marks sanitized stale failure metadata without blocking canonical write', async () =>
  withTempDb(async () => {
    await rebuildEmptyProjection();
    __setDatasetSummaryProjectionFaultHookForTest(() => {
      throw new Error('projection-token-abcdefghijklmnopqrstuvwxyz123456 failed');
    });
    try {
      const outcome = await ingestRecord('gmail', {
        stream: 'messages',
        key: 'm1',
        emitted_at: '2026-01-01T00:00:00.000Z',
        data: { id: 'm1', subject: 'hello' },
      });
      assert.equal(outcome.changed, true);
    } finally {
      __setDatasetSummaryProjectionFaultHookForTest(null);
    }

    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM records').get().n, 1);
    const projection = getDatasetSummaryProjection();
    assert.equal(projection.metadata.state, 'failed');
    assert.equal(projection.metadata.rebuild_status, 'failed');
    assert.equal(
      projection.metadata.last_error.includes('abcdefghijklmnopqrstuvwxyz123456'),
      false,
    );

    applyDatasetSummaryBlobDelta({ blobBytesDelta: 5 });
    const afterBlob = getDatasetSummaryProjection();
    assert.equal(afterBlob.metadata.state, 'failed');
    assert.equal(afterBlob.metadata.last_error, projection.metadata.last_error);
  }));

test('bulk stream delete marks projection stale instead of applying unsafe exact deltas', async () =>
  withTempDb(async () => {
    await rebuildEmptyProjection();
    await ingestRecord('gmail', {
      stream: 'messages',
      key: 'm1',
      emitted_at: '2026-01-01T00:00:00.000Z',
      data: { id: 'm1', subject: 'hello' },
    });
    await rebuildFromCurrentDb();

    assert.equal(await deleteAllRecords('gmail', 'messages'), 1);
    const projection = getDatasetSummaryProjection();
    assert.equal(projection.metadata.state, 'stale');
    assert.match(projection.metadata.last_error, /bulk stream record delete/);
  }));

test('bulk connector delete marks projection stale instead of applying unsafe exact deltas', async () =>
  withTempDb(async () => {
    await rebuildEmptyProjection();
    await ingestRecord('gmail', {
      stream: 'messages',
      key: 'm1',
      emitted_at: '2026-01-01T00:00:00.000Z',
      data: { id: 'm1', subject: 'hello' },
    });
    await rebuildFromCurrentDb();

    const result = await deleteAllRecordsForConnector('gmail');
    assert.equal(result.deletedCount, 1);
    const projection = getDatasetSummaryProjection();
    assert.equal(projection.metadata.state, 'stale');
    assert.match(projection.metadata.last_error, /bulk connector record delete/);
  }));

test('non-empty rebuild seeds stream projections so later deltas do not fail', async () =>
  withTempDb(async () => {
    await rebuildEmptyProjection();
    await ingestRecord('gmail', {
      stream: 'messages',
      key: 'm1',
      emitted_at: '2026-01-01T00:00:00.000Z',
      data: { id: 'm1', subject: 'hello' },
    });
    await rebuildFromCurrentDb();
    assert.equal(getDatasetSummaryProjection().metadata.state, 'fresh');

    await ingestRecord('gmail', {
      stream: 'messages',
      key: 'm2',
      emitted_at: '2026-01-02T00:00:00.000Z',
      data: { id: 'm2', subject: 'later' },
    });
    const projection = getDatasetSummaryProjection();
    assert.equal(projection.counts.record_count, 2);
    assert.equal(projection.metadata.state, 'fresh');
    assert.notEqual(projection.metadata.state, 'failed');
  }));

test('dirty record-time bounds reconcile from durable records for one stream', async () =>
  withTempDb(async () => {
    await rebuildEmptyProjection();
    await ingestRecord('gmail', {
      stream: 'messages',
      key: 'm1',
      emitted_at: '2026-01-01T00:00:00.000Z',
      data: { id: 'm1', created_at: '2025-01-01T00:00:00.000Z', subject: 'old' },
    });
    await ingestRecord('gmail', {
      stream: 'messages',
      key: 'm2',
      emitted_at: '2026-01-02T00:00:00.000Z',
      data: { id: 'm2', created_at: '2025-02-01T00:00:00.000Z', subject: 'new' },
    });
    registerConnectorManifest('gmail', {
      connector_id: 'gmail',
      streams: [{ name: 'messages', consent_time_field: 'created_at' }],
    });
    await rebuildFromCurrentDb();

    assert.equal(await deleteRecord('gmail', 'messages', 'm1'), 1);
    assert.equal(getDatasetSummaryProjection().metadata.state, 'stale');

    const result = await reconcileDirtyDatasetSummaryRecordTimeBounds({
      getStreamRecordTimeBounds: getDatasetSummaryStreamRecordTimeBounds,
    });
    const projection = getDatasetSummaryProjection();

    assert.deepEqual(result, { reconciled: 1, deferred: 0, residual: 0 });
    assert.equal(projection.metadata.state, 'fresh');
    assert.equal(projection.record_time_bounds.earliest, '2025-02-01T00:00:00.000Z');
    assert.equal(projection.record_time_bounds.latest, '2025-02-01T00:00:00.000Z');
    assert.equal(getStreamDirtyFlag('gmail', 'messages'), 0);
  }));

test('dirty record-time reconciliation defers unsafe rows instead of clearing stale state', async () =>
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
         VALUES('gmail', 'messages', 1, 1, 1, '2026-01-01T00:00:00.000Z')`,
      )
      .run();

    const result = await reconcileDirtyDatasetSummaryRecordTimeBounds({
      getStreamRecordTimeBounds: () => {
        throw new Error('should not scan without a safe consent_time_field');
      },
    });
    const projection = getDatasetSummaryProjection();

    assert.deepEqual(result, { reconciled: 0, deferred: 1, residual: 0 });
    assert.equal(projection.metadata.state, 'stale');
    assert.match(projection.metadata.last_error, /could not be safely reconciled/);
    assert.equal(getStreamDirtyFlag('gmail', 'messages'), 1);
  }));

test('record delta during running rebuild does not silently overwrite the rebuild result', async () =>
  withTempDb(async () => {
    await rebuildFromCurrentDb();
    await ingestRecord('gmail', {
      stream: 'messages',
      key: 'm1',
      emitted_at: '2026-01-01T00:00:00.000Z',
      data: { id: 'm1', subject: 'pre-rebuild' },
    });

    let deltaArrivedDuringRebuild = false;
    await rebuildDatasetSummaryProjection({
      getCounts: async () => {
        // Simulate a live record delta arriving mid-rebuild, after the
        // rebuild has stamped rebuild_status='running' but before it
        // commits its final summary.
        await ingestRecord('gmail', {
          stream: 'messages',
          key: 'm2',
          emitted_at: '2026-01-02T00:00:00.000Z',
          data: { id: 'm2', subject: 'mid-rebuild' },
        });
        deltaArrivedDuringRebuild = true;
        // Rebuild's seed query — return a deliberately stale snapshot
        // (count=1) to prove the rebuild's final write cannot win.
        return { connector_count: 1, stream_count: 1, record_count: 1 };
      },
      getRetainedBytes: () => ({
        record_json_bytes: 10,
        record_changes_json_bytes: 0,
        blob_bytes: 0,
      }),
      getRecordTimeBounds: () => ({ earliest: null, latest: null }),
      getIngestedTimeBounds: () => ({
        earliest: '2026-01-01T00:00:00.000Z',
        latest: '2026-01-01T00:00:00.000Z',
      }),
      listTopConnectorCandidates: () => [{ connector_id: 'gmail', record_count: 1 }],
      listStreamProjectionSeeds: () => [
        {
          connector_id: 'gmail',
          stream: 'messages',
          record_count: 1,
          record_json_bytes: 10,
        },
      ],
    });

    assert.equal(deltaArrivedDuringRebuild, true);
    const projection = getDatasetSummaryProjection();
    // The mid-rebuild delta bumped the generation; the rebuild's final
    // write must NOT have claimed fresh, and the projection must not
    // report the rebuild's stale count of 1.
    assert.notEqual(projection.metadata.state, 'fresh');
    assert.ok(
      projection.metadata.state === 'stale' || projection.metadata.state === 'failed',
      `expected stale or failed, got ${projection.metadata.state}`,
    );
    assert.equal(projection.metadata.rebuild_status, 'idle');
  }));

test('reconcile concurrent with a delta leaves the row dirty for the next pass', async () =>
  withTempDb(async () => {
    await rebuildEmptyProjection();
    await ingestRecord('gmail', {
      stream: 'messages',
      key: 'm1',
      emitted_at: '2026-01-01T00:00:00.000Z',
      data: { id: 'm1', created_at: '2025-01-01T00:00:00.000Z', subject: 'old' },
    });
    registerConnectorManifest('gmail', {
      connector_id: 'gmail',
      streams: [{ name: 'messages', consent_time_field: 'created_at' }],
    });
    await rebuildFromCurrentDb();

    // Mark the row dirty manually to mimic the post-delete state without
    // also bumping the projection's rebuild_status.
    getDb()
      .prepare(
        `UPDATE dataset_summary_stream_projection
            SET dirty_record_time_bounds = 1
          WHERE connector_id = 'gmail' AND stream = 'messages'`,
      )
      .run();

    const result = await reconcileDirtyDatasetSummaryRecordTimeBounds({
      getStreamRecordTimeBounds: async (connectorId, stream) => {
        // Simulate a concurrent delta arriving mid-reconcile: the row's
        // computed_at advances and dirty_record_time_bounds re-asserts
        // before reconcile gets to its transactional UPDATE.
        getDb()
          .prepare(
            `UPDATE dataset_summary_stream_projection
                SET computed_at = '2099-01-01T00:00:00.000Z',
                    dirty_record_time_bounds = 1
              WHERE connector_id = ? AND stream = ?`,
          )
          .run(connectorId, stream);
        return getDatasetSummaryStreamRecordTimeBounds(connectorId, stream, 'created_at');
      },
    });

    assert.deepEqual(result, { reconciled: 0, deferred: 1, residual: 0 });
    // The concurrent delta's dirty flag must survive the reconcile pass.
    assert.equal(getStreamDirtyFlag('gmail', 'messages'), 1);
  }));

test('rebuild succeeds when no concurrent delta interferes', async () =>
  withTempDb(async () => {
    await rebuildEmptyProjection();
    await ingestRecord('gmail', {
      stream: 'messages',
      key: 'm1',
      emitted_at: '2026-01-01T00:00:00.000Z',
      data: { id: 'm1', subject: 'hello' },
    });
    await rebuildFromCurrentDb();
    const projection = getDatasetSummaryProjection();
    assert.equal(projection.metadata.state, 'fresh');
    assert.equal(projection.metadata.rebuild_status, 'idle');
    assert.equal(projection.counts.record_count, 1);
  }));

test('blob delta during running rebuild does not silently overwrite the rebuild result', async () =>
  withTempDb(async () => {
    await rebuildFromCurrentDb();
    await ingestRecord('gmail', {
      stream: 'messages',
      key: 'm1',
      emitted_at: '2026-01-01T00:00:00.000Z',
      data: { id: 'm1', subject: 'hello' },
    });
    await rebuildFromCurrentDb();

    await rebuildDatasetSummaryProjection({
      getCounts: () => {
        applyDatasetSummaryBlobDelta({ blobBytesDelta: 1234 });
        return { connector_count: 1, stream_count: 1, record_count: 1 };
      },
      getRetainedBytes: () => ({
        record_json_bytes: 10,
        record_changes_json_bytes: 0,
        blob_bytes: 0,
      }),
      getRecordTimeBounds: () => ({ earliest: null, latest: null }),
      getIngestedTimeBounds: () => ({ earliest: null, latest: null }),
      listTopConnectorCandidates: () => [{ connector_id: 'gmail', record_count: 1 }],
      listStreamProjectionSeeds: () => [
        {
          connector_id: 'gmail',
          stream: 'messages',
          record_count: 1,
          record_json_bytes: 10,
        },
      ],
    });

    const projection = getDatasetSummaryProjection();
    assert.notEqual(projection.metadata.state, 'fresh');
    assert.equal(projection.metadata.rebuild_status, 'idle');
  }));

test('record delta during first-ever rebuild stays stale instead of failing on null computed_at', () =>
  withTempDb(async () => {
    // No prior rebuild has run, so the projection's computed_at is null.
    // The rebuild below stamps rebuild_status='running' while keeping
    // computed_at=null (markDatasetSummaryProjectionRebuilding preserves
    // the prior computed_at). A delta arriving inside this window must
    // be treated as a fence-mark-stale, NOT as a hard "projection has
    // not been rebuilt" failure.
    let deltaArrived = false;
    let metadataDuringRebuild = null;
    await rebuildDatasetSummaryProjection({
      getCounts: () => {
        applyDatasetSummaryRecordDelta({
          connectorId: 'gmail',
          stream: 'messages',
          recordCountDelta: 1,
          recordJsonBytesDelta: 10,
          recordChangesJsonBytesDelta: 0,
          emittedAt: '2026-01-01T00:00:00.000Z',
          consentTimeField: null,
          dirtyRecordTimeBounds: false,
        });
        deltaArrived = true;
        metadataDuringRebuild = getDatasetSummaryProjection().metadata;
        return { connector_count: 0, stream_count: 0, record_count: 0 };
      },
      getRetainedBytes: () => ({
        record_json_bytes: 0,
        record_changes_json_bytes: 0,
        blob_bytes: 0,
      }),
      getRecordTimeBounds: () => ({ earliest: null, latest: null }),
      getIngestedTimeBounds: () => ({ earliest: null, latest: null }),
      listTopConnectorCandidates: () => [],
      listStreamProjectionSeeds: () => [],
    });

    assert.equal(deltaArrived, true);
    // Mid-rebuild snapshot: the delta must NOT have marked the
    // projection failed simply because computed_at was null.
    assert.notEqual(metadataDuringRebuild.state, 'failed');
    assert.notEqual(metadataDuringRebuild.rebuild_status, 'failed');
    assert.equal(
      (metadataDuringRebuild.last_error || '').includes(
        'projection has not been rebuilt',
      ),
      false,
      `expected no "not been rebuilt" error, got ${metadataDuringRebuild.last_error}`,
    );

    const projection = getDatasetSummaryProjection();
    // After the rebuild's guarded commit detects the bumped generation,
    // the projection must NOT report a false-fresh state.
    assert.notEqual(projection.metadata.state, 'fresh');
    assert.equal(projection.metadata.rebuild_status, 'idle');
  }));

test('blob delta during first-ever rebuild stays stale instead of failing on null computed_at', () =>
  withTempDb(async () => {
    let deltaArrived = false;
    let metadataDuringRebuild = null;
    await rebuildDatasetSummaryProjection({
      getCounts: () => {
        applyDatasetSummaryBlobDelta({ blobBytesDelta: 1234 });
        deltaArrived = true;
        metadataDuringRebuild = getDatasetSummaryProjection().metadata;
        return { connector_count: 0, stream_count: 0, record_count: 0 };
      },
      getRetainedBytes: () => ({
        record_json_bytes: 0,
        record_changes_json_bytes: 0,
        blob_bytes: 0,
      }),
      getRecordTimeBounds: () => ({ earliest: null, latest: null }),
      getIngestedTimeBounds: () => ({ earliest: null, latest: null }),
      listTopConnectorCandidates: () => [],
      listStreamProjectionSeeds: () => [],
    });

    assert.equal(deltaArrived, true);
    assert.notEqual(metadataDuringRebuild.state, 'failed');
    assert.notEqual(metadataDuringRebuild.rebuild_status, 'failed');
    assert.equal(
      (metadataDuringRebuild.last_error || '').includes(
        'projection has not been rebuilt',
      ),
      false,
      `expected no "not been rebuilt" error, got ${metadataDuringRebuild.last_error}`,
    );

    const projection = getDatasetSummaryProjection();
    assert.notEqual(projection.metadata.state, 'fresh');
    assert.equal(projection.metadata.rebuild_status, 'idle');
  }));

test('rebuild caps persisted top connector candidates without losing the true top entries', async () =>
  withTempDb(async () => {
    // Adapter returns 200 candidates in arbitrary order. The persisted
    // projection must drop the tail but keep the highest-count entries
    // — proving the cap is enforced and the sort is correct.
    const adapterCandidates = [];
    for (let i = 0; i < 200; i += 1) {
      adapterCandidates.push({
        connector_id: `c${String(i).padStart(3, '0')}`,
        // Inverted so the lowest-numbered ids have the highest counts;
        // confirms the cap does not silently slice by adapter order.
        record_count: 1000 - i,
      });
    }
    await rebuildDatasetSummaryProjection({
      getCounts: () => ({ connector_count: 200, stream_count: 200, record_count: 100000 }),
      getRetainedBytes: () => ({
        record_json_bytes: 0,
        record_changes_json_bytes: 0,
        blob_bytes: 0,
      }),
      getRecordTimeBounds: () => ({ earliest: null, latest: null }),
      getIngestedTimeBounds: () => ({ earliest: null, latest: null }),
      listTopConnectorCandidates: () => adapterCandidates,
    });

    const projection = getDatasetSummaryProjection();
    assert.ok(
      projection.top_connector_candidates.length <= 32,
      `expected top candidates to be capped, got ${projection.top_connector_candidates.length}`,
    );
    assert.equal(projection.top_connector_candidates[0].connector_id, 'c000');
    assert.equal(projection.top_connector_candidates[0].record_count, 1000);
    // The persisted JSON must not silently include the long tail.
    const row = getDb()
      .prepare(`SELECT summary_json FROM dataset_summary_projection WHERE projection_key = 'global'`)
      .get();
    const parsed = JSON.parse(row.summary_json);
    assert.ok(parsed.top_connector_candidates.length <= 32);
  }));

test('rebuild cancellation leaves canonical records intact and projection stale', async () =>
  withTempDb(async () => {
    await rebuildEmptyProjection();
    await ingestRecord('gmail', {
      stream: 'messages',
      key: 'm1',
      emitted_at: '2026-01-01T00:00:00.000Z',
      data: { id: 'm1', subject: 'hello' },
    });
    await rebuildFromCurrentDb();
    const beforeFresh = getDatasetSummaryProjection();
    assert.equal(beforeFresh.metadata.state, 'fresh');
    const beforeRecordCount = getDb()
      .prepare('SELECT COUNT(*) AS n FROM records')
      .get().n;

    const controller = new AbortController();
    await assert.rejects(
      () =>
        rebuildDatasetSummaryProjection(
          {
            getCounts: async () => {
              controller.abort();
              return { connector_count: 1, stream_count: 1, record_count: 1 };
            },
            getRetainedBytes: () => ({
              record_json_bytes: 0,
              record_changes_json_bytes: 0,
              blob_bytes: 0,
            }),
            getRecordTimeBounds: () => ({ earliest: null, latest: null }),
            getIngestedTimeBounds: () => ({ earliest: null, latest: null }),
            listTopConnectorCandidates: () => [],
            listStreamProjectionSeeds: () => [],
          },
          { signal: controller.signal },
        ),
      (err) => err.name === 'AbortError',
    );

    // Canonical record table must be untouched by the cancelled rebuild.
    assert.equal(
      getDb().prepare('SELECT COUNT(*) AS n FROM records').get().n,
      beforeRecordCount,
    );

    const projection = getDatasetSummaryProjection();
    // Cancellation projects honestly as stale, not failed; the last-known
    // counts survive so the operator surface does not flash to zero.
    assert.notEqual(projection.metadata.state, 'fresh');
    assert.notEqual(projection.metadata.state, 'failed');
    assert.equal(projection.metadata.state, 'stale');
    assert.equal(projection.metadata.rebuild_status, 'idle');
    assert.equal(projection.counts.record_count, beforeFresh.counts.record_count);
  }));

test('reconcile bounds work per call and reports residual rows for the next pass', async () =>
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
       VALUES(?, ?, 1, 1, 'created_at', 1, '2026-01-01T00:00:00.000Z')`,
    );
    for (let i = 0; i < 260; i += 1) {
      insert.run('gmail', `stream-${String(i).padStart(4, '0')}`);
    }

    let scanned = 0;
    const result = await reconcileDirtyDatasetSummaryRecordTimeBounds({
      getStreamRecordTimeBounds: () => {
        scanned += 1;
        return { earliest: '2025-01-01T00:00:00.000Z', latest: '2025-01-02T00:00:00.000Z' };
      },
    });

    assert.ok(
      scanned <= 256,
      `reconcile must not scan more than the per-call cap; scanned=${scanned}`,
    );
    assert.equal(result.residual, 1);
    assert.equal(result.reconciled, 256);

    // Residual rows must remain dirty so a follow-up call still has work.
    const remainingDirty = getDb()
      .prepare(
        `SELECT COUNT(*) AS n
           FROM dataset_summary_stream_projection
          WHERE dirty_record_time_bounds <> 0`,
      )
      .get().n;
    assert.equal(remainingDirty, 260 - 256);

    // Projection metadata must honestly reflect that work is unfinished.
    const projection = getDatasetSummaryProjection();
    assert.equal(projection.metadata.state, 'stale');
  }));

test('reconcile cancellation leaves dirty rows untouched and marks projection stale', async () =>
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
         VALUES('gmail', 'messages', 1, 1, 'created_at', 1, '2026-01-01T00:00:00.000Z')`,
      )
      .run();

    const controller = new AbortController();
    await assert.rejects(
      () =>
        reconcileDirtyDatasetSummaryRecordTimeBounds(
          {
            getStreamRecordTimeBounds: () => {
              controller.abort();
              const err = new Error('cancelled');
              err.name = 'AbortError';
              throw err;
            },
          },
          { signal: controller.signal },
        ),
      (err) => err.name === 'AbortError',
    );

    // Cancelled reconcile must not have cleared the dirty bit.
    assert.equal(getStreamDirtyFlag('gmail', 'messages'), 1);
    const projection = getDatasetSummaryProjection();
    assert.equal(projection.metadata.state, 'stale');
    // Honest failure mode: cancellation is not a hard failure.
    assert.notEqual(projection.metadata.rebuild_status, 'failed');
  }));

async function rebuildEmptyProjection() {
  await rebuildDatasetSummaryProjection({
    getCounts: () => ({ connector_count: 0, stream_count: 0, record_count: 0 }),
    getRetainedBytes: () => ({
      record_json_bytes: 0,
      record_changes_json_bytes: 0,
      blob_bytes: 0,
    }),
    getRecordTimeBounds: () => ({ earliest: null, latest: null }),
    getIngestedTimeBounds: () => ({ earliest: null, latest: null }),
    listTopConnectorCandidates: () => [],
  });
}

async function rebuildFromCurrentDb() {
  await rebuildDatasetSummaryProjection({
    getCounts: async () => {
      const agg = getDatasetRecordsAggregate();
      return {
        connector_count: agg.connector_count,
        stream_count: agg.stream_count,
        record_count: agg.record_count,
      };
    },
    getRetainedBytes: async () => {
      const agg = getDatasetRecordsAggregate();
      return {
        record_json_bytes: agg.record_json_bytes,
        record_changes_json_bytes: getDatasetRecordChangesBytes(),
        blob_bytes: getDatasetBlobBytes(),
      };
    },
    getRecordTimeBounds: () => getDatasetRecordTimeBounds(),
    getIngestedTimeBounds: async () => {
      const agg = getDatasetRecordsAggregate();
      return {
        earliest: agg.earliest_ingested_at,
        latest: agg.latest_ingested_at,
      };
    },
    listTopConnectorCandidates: () => listDatasetTopConnectorCandidates(),
    listStreamProjectionSeeds: () => listDatasetSummaryStreamProjectionSeeds(),
  });
}

function registerConnectorManifest(connectorId, manifest) {
  getDb()
    .prepare(
      `INSERT INTO connectors(connector_id, manifest, created_at)
       VALUES(?, ?, ?)
       ON CONFLICT(connector_id) DO UPDATE SET
         manifest = excluded.manifest`,
    )
    .run(connectorId, JSON.stringify(manifest), '2026-01-01T00:00:00.000Z');
}

function getStreamDirtyFlag(connectorId, stream) {
  return Number(
    getDb()
      .prepare(
        `SELECT dirty_record_time_bounds
           FROM dataset_summary_stream_projection
          WHERE connector_id = ? AND stream = ?`,
      )
      .get(connectorId, stream).dirty_record_time_bounds,
  );
}

function liveRecordJsonBytes() {
  return Number(
    getDb()
      .prepare(
        `SELECT COALESCE(SUM(LENGTH(CAST(record_json AS BLOB))), 0) AS bytes
           FROM records
          WHERE deleted = 0`,
      )
      .get().bytes || 0,
  );
}

function recordChangeJsonBytes() {
  return Number(
    getDb()
      .prepare(
        `SELECT COALESCE(SUM(LENGTH(CAST(record_json AS BLOB))), 0) AS bytes
           FROM record_changes`,
      )
      .get().bytes || 0,
  );
}

function seedStreamProjectionRow({
  connectorId,
  stream,
  recordCount = 1,
  recordJsonBytes = 64,
  earliestIngestedAt = '2026-01-01T00:00:00.000Z',
  latestIngestedAt = '2026-05-01T00:00:00.000Z',
  earliestRecordTime = null,
  latestRecordTime = null,
  consentTimeField = null,
  dirty = 0,
  computedAt = '2026-05-19T12:00:00.000Z',
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
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      computedAt,
    );
}

test('listStreamProjections returns every projection row sorted by (connector_id, stream)', () =>
  withTempDb(() => {
    seedStreamProjectionRow({ connectorId: 'gmail', stream: 'threads' });
    seedStreamProjectionRow({ connectorId: 'gmail', stream: 'messages' });
    seedStreamProjectionRow({ connectorId: 'calendar', stream: 'events' });

    const rows = listStreamProjections();

    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => [r.connector_id, r.stream]),
      [
        ['calendar', 'events'],
        ['gmail', 'messages'],
        ['gmail', 'threads'],
      ],
    );
    assert.equal(rows[0].record_count, 1);
    assert.equal(rows[0].record_json_bytes, 64);
    assert.equal(rows[0].computed_at, '2026-05-19T12:00:00.000Z');
  }));

test('listStreamProjections filters to the supplied connector_id', () =>
  withTempDb(() => {
    seedStreamProjectionRow({ connectorId: 'gmail', stream: 'threads' });
    seedStreamProjectionRow({ connectorId: 'gmail', stream: 'messages' });
    seedStreamProjectionRow({ connectorId: 'calendar', stream: 'events' });

    const rows = listStreamProjections({ connectorId: 'gmail' });

    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => r.stream),
      ['messages', 'threads'],
    );
    assert.equal(
      rows.every((r) => r.connector_id === 'gmail'),
      true,
    );
  }));

test('listStreamProjections passes NULL record-time bounds through honestly', () =>
  withTempDb(() => {
    seedStreamProjectionRow({
      connectorId: 'gmail',
      stream: 'no_consent_time_field',
      earliestRecordTime: null,
      latestRecordTime: null,
      consentTimeField: null,
      dirty: 0,
    });
    seedStreamProjectionRow({
      connectorId: 'gmail',
      stream: 'reconciled',
      earliestRecordTime: '2025-12-01T00:00:00.000Z',
      latestRecordTime: '2026-04-30T00:00:00.000Z',
      consentTimeField: 'created_at',
      dirty: 0,
    });

    const rows = listStreamProjections({ connectorId: 'gmail' });

    const noField = rows.find((r) => r.stream === 'no_consent_time_field');
    const reconciled = rows.find((r) => r.stream === 'reconciled');

    assert.equal(noField.earliest_record_time, null);
    assert.equal(noField.latest_record_time, null);
    assert.equal(noField.consent_time_field, null);

    assert.equal(reconciled.earliest_record_time, '2025-12-01T00:00:00.000Z');
    assert.equal(reconciled.latest_record_time, '2026-04-30T00:00:00.000Z');
    assert.equal(reconciled.consent_time_field, 'created_at');
  }));

test('listStreamProjections exposes dirty_record_time_bounds as a boolean', () =>
  withTempDb(() => {
    seedStreamProjectionRow({
      connectorId: 'gmail',
      stream: 'fresh',
      consentTimeField: 'created_at',
      dirty: 0,
    });
    seedStreamProjectionRow({
      connectorId: 'gmail',
      stream: 'dirty',
      consentTimeField: 'created_at',
      dirty: 1,
    });

    const rows = listStreamProjections({ connectorId: 'gmail' });

    const fresh = rows.find((r) => r.stream === 'fresh');
    const dirty = rows.find((r) => r.stream === 'dirty');

    assert.equal(fresh.dirty_record_time_bounds, false);
    assert.equal(dirty.dirty_record_time_bounds, true);
    assert.equal(typeof fresh.dirty_record_time_bounds, 'boolean');
    assert.equal(typeof dirty.dirty_record_time_bounds, 'boolean');
  }));

test('listStreamProjections returns an empty array when no projection rows exist', () =>
  withTempDb(() => {
    assert.deepEqual(listStreamProjections(), []);
    assert.deepEqual(listStreamProjections({ connectorId: 'gmail' }), []);
  }));
