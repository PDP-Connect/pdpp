import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  getDatasetSummaryProjection,
  rebuildDatasetSummaryProjection,
} from '../server/dataset-summary-read-model.js';
import { closeDb, initDb } from '../server/db.js';

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
