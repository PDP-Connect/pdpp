import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  reconcileDirtyDatasetSummaryRecordTimeBounds,
  rebuildDatasetSummaryProjection,
} from '../server/dataset-summary-read-model.js';
import { closeDb, getDb, initDb } from '../server/db.js';

const MAX_RECONCILE_BATCH = 256;
const DIRTY_STREAM_COUNT = MAX_RECONCILE_BATCH + 2;
const ORIGINAL_COMPUTED_AT = '2026-01-01T00:00:00.000Z';
const CONCURRENT_COMPUTED_AT = '2026-01-02T00:00:00.000Z';

async function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'pdpp-summary-reconcile-window-'));
  try {
    initDb(join(dir, 'pdpp.sqlite'));
    return await fn();
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('dirty time-bound reconcile reports deferred and residual rows while preserving dirty guards', async () =>
  withTempDb(async () => {
    await seedRebuiltProjection();
    seedDirtyStreamProjections(DIRTY_STREAM_COUNT);

    const deferredStream = 'stream-0000';
    const seen = [];
    const result = await reconcileDirtyDatasetSummaryRecordTimeBounds({
      getStreamRecordTimeBounds: async (connectorId, stream, field) => {
        seen.push(stream);
        if (stream === deferredStream) {
          getDb()
            .prepare(
              `UPDATE dataset_summary_stream_projection
                  SET computed_at = ?,
                      dirty_record_time_bounds = 1
                WHERE connector_id = ? AND stream = ?`,
            )
            .run(CONCURRENT_COMPUTED_AT, connectorId, stream);
        }
        assert.equal(field, 'created_at');
        return {
          earliest: '2026-05-01T00:00:00.000Z',
          latest: '2026-05-02T00:00:00.000Z',
        };
      },
    });

    assert.equal(seen.length, MAX_RECONCILE_BATCH);
    assert.deepEqual(result, {
      reconciled: MAX_RECONCILE_BATCH - 1,
      deferred: 1,
      residual: 1,
    });

    const rows = getDb()
      .prepare(
        `SELECT stream,
                dirty_record_time_bounds,
                computed_at
           FROM dataset_summary_stream_projection
          ORDER BY stream ASC`,
      )
      .all();
    const rowByStream = new Map(rows.map((row) => [row.stream, row]));

    assert.equal(Number(rowByStream.get(deferredStream).dirty_record_time_bounds), 1);
    assert.equal(rowByStream.get(deferredStream).computed_at, CONCURRENT_COMPUTED_AT);

    for (const stream of seen.filter((stream) => stream !== deferredStream)) {
      const row = rowByStream.get(stream);
      assert.equal(Number(row.dirty_record_time_bounds), 0, `${stream} should be clean`);
      assert.notEqual(row.computed_at, ORIGINAL_COMPUTED_AT, `${stream} should have been updated`);
    }

    const overflowStreams = rows
      .map((row) => row.stream)
      .filter((stream) => !seen.includes(stream));
    assert.deepEqual(overflowStreams, ['stream-0256', 'stream-0257']);
    for (const stream of overflowStreams) {
      const row = rowByStream.get(stream);
      assert.equal(Number(row.dirty_record_time_bounds), 1, `${stream} should remain dirty`);
      assert.equal(row.computed_at, ORIGINAL_COMPUTED_AT, `${stream} should not have been touched`);
    }

    const remainingDirty = rows.filter((row) => Number(row.dirty_record_time_bounds) !== 0);
    assert.deepEqual(
      remainingDirty.map((row) => row.stream),
      [deferredStream, ...overflowStreams],
    );
  }));

async function seedRebuiltProjection() {
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
    listStreamProjectionSeeds: () => [],
  });
}

function seedDirtyStreamProjections(count) {
  const insert = getDb().prepare(
    `INSERT INTO dataset_summary_stream_projection(
       connector_id,
       stream,
       record_count,
       record_json_bytes,
       earliest_ingested_at,
       latest_ingested_at,
       consent_time_field,
       dirty_record_time_bounds,
       computed_at
     ) VALUES (?, ?, 1, 16, ?, ?, 'created_at', 1, ?)`,
  );
  const insertAll = getDb().transaction(() => {
    for (let i = 0; i < count; i += 1) {
      insert.run(
        'gmail',
        `stream-${String(i).padStart(4, '0')}`,
        '2026-04-01T00:00:00.000Z',
        '2026-04-02T00:00:00.000Z',
        ORIGINAL_COMPUTED_AT,
      );
    }
  });
  insertAll();
}
