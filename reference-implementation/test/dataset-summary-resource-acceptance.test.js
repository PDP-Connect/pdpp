// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Acceptance coverage for RI operator-console task 7.5.
 *
 * The resource risk that previously destabilized the host is not "can a
 * synthetic benchmark allocate a lot of rows"; it is whether operator-summary
 * maintenance has a hard unit-of-work bound when local backfills dirty many
 * stream projections at once. This test exercises the real dirty-bound
 * reconciler and proves one pass processes at most the production batch size,
 * reports residual work, and leaves the projection honestly stale for a later
 * pass instead of trying to repair everything in memory.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { closeDb, getDb, initDb } from '../server/db.js';
import {
  getDatasetSummaryProjection,
  reconcileDirtyDatasetSummaryRecordTimeBounds,
} from '../server/dataset-summary-read-model.js';

const STREAMS_OVER_ONE_BATCH = 300;
const MAX_RECONCILE_BATCH = 256;

function withTempDb(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdpp-resource-acceptance-'));
    try {
      initDb(join(dir, 'pdpp.sqlite'));
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function seedDirtyStreamProjections(count) {
  const insert = getDb().prepare(
    `INSERT INTO dataset_summary_stream_projection(
       connector_id,
       stream,
       record_count,
       record_json_bytes,
       consent_time_field,
       dirty_record_time_bounds,
       computed_at
     ) VALUES (?, ?, ?, ?, ?, 1, ?)`,
  );
  const tx = getDb().transaction(() => {
    for (let i = 0; i < count; i += 1) {
      insert.run('local_device', `stream_${String(i).padStart(4, '0')}`, 1, 128, 'created_at', 'seed');
    }
  });
  tx();
}

test(
  'acceptance 7.5: dirty summary reconciliation is bounded and reports residual backfill work',
  withTempDb(async () => {
    seedDirtyStreamProjections(STREAMS_OVER_ONE_BATCH);
    const seen = [];

    const result = await reconcileDirtyDatasetSummaryRecordTimeBounds({
      async getStreamRecordTimeBounds(connectorId, stream, field) {
        seen.push({ connectorId, stream, field });
        return {
          earliest: '2026-05-01T00:00:00.000Z',
          latest: '2026-05-19T00:00:00.000Z',
        };
      },
    });

    assert.equal(seen.length, MAX_RECONCILE_BATCH, 'one pass must not process the whole dirty backlog');
    assert.deepEqual(result, {
      reconciled: MAX_RECONCILE_BATCH,
      deferred: 0,
      residual: 1,
    });

    const remainingDirty = getDb()
      .prepare('SELECT COUNT(*) AS count FROM dataset_summary_stream_projection WHERE dirty_record_time_bounds <> 0')
      .get().count;
    assert.equal(remainingDirty, STREAMS_OVER_ONE_BATCH - MAX_RECONCILE_BATCH);

    const projection = getDatasetSummaryProjection();
    assert.equal(projection.metadata.state, 'stale');
    assert.match(projection.metadata.last_error, /dirty record-time bounds/);
  }),
);
