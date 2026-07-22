// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  applyDatasetSummaryBlobDelta,
  getDatasetSummaryProjection,
  rebuildDatasetSummaryProjection,
} from '../server/dataset-summary-read-model.js';
import { closeDb, getDb, initDb } from '../server/db.js';

const SUPERSEDED_REBUILD_ERROR =
  'dataset summary projection rebuild superseded by concurrent delta';

async function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'pdpp-summary-rebuild-race-'));
  try {
    initDb(join(dir, 'pdpp.sqlite'));
    return await fn();
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('dataset summary rebuild reports superseded metadata after a concurrent delta wins the generation race', async () =>
  withTempDb(async () => {
    await seedRebuiltProjection();

    let deltaAdvancedGeneration = false;
    const returnedProjection = await rebuildDatasetSummaryProjection({
      getCounts: () => {
        applyDatasetSummaryBlobDelta({ blobBytesDelta: 1234 });
        clearDeltaSpecificLastError();
        deltaAdvancedGeneration = true;
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

    assert.equal(deltaAdvancedGeneration, true);
    assert.equal(returnedProjection.metadata.state, 'stale');
    assert.equal(returnedProjection.metadata.rebuild_status, 'idle');
    if (returnedProjection.metadata.last_error !== SUPERSEDED_REBUILD_ERROR) {
      console.log('BASELINE: dataset summary rebuild race oracle observed superseded error mismatch');
    }
    assert.equal(returnedProjection.metadata.last_error, SUPERSEDED_REBUILD_ERROR);
    assert.equal(returnedProjection.retained_bytes.blob_bytes, 0);

    const persistedProjection = getDatasetSummaryProjection();
    assert.equal(persistedProjection.metadata.state, 'stale');
    assert.equal(persistedProjection.metadata.rebuild_status, 'idle');
    if (persistedProjection.metadata.last_error !== SUPERSEDED_REBUILD_ERROR) {
      console.log('BASELINE: dataset summary rebuild race oracle observed persisted superseded error mismatch');
    }
    assert.equal(persistedProjection.metadata.last_error, SUPERSEDED_REBUILD_ERROR);
    assert.equal(persistedProjection.retained_bytes.blob_bytes, 0);
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

  const projection = getDatasetSummaryProjection();
  assert.equal(projection.metadata.state, 'fresh');
  assert.equal(projection.metadata.rebuild_status, 'idle');
  assert.equal(projection.metadata.last_error, null);
}

function clearDeltaSpecificLastError() {
  const row = getDb()
    .prepare(
      `SELECT metadata_json
         FROM dataset_summary_projection
        WHERE projection_key = 'global'`,
    )
    .get();
  const metadata = JSON.parse(row.metadata_json);
  assert.equal(metadata.last_error, 'blob delta arrived during projection rebuild');
  metadata.last_error = null;
  getDb()
    .prepare(
      `UPDATE dataset_summary_projection
          SET metadata_json = ?
        WHERE projection_key = 'global'`,
    )
    .run(JSON.stringify(metadata));
}
