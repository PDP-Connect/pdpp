/**
 * Postgres-mode boundary regression for the SQLite dataset-summary read
 * model.
 *
 * Asserts the invariant required by `complete-postgres-runtime-boundary`:
 * with `PDPP_STORAGE_BACKEND=postgres` active, the SQLite
 * `dataset-summary-read-model` exports MUST fail fast with
 * `storage_backend_mismatch` rather than read or write stale SQLite
 * projection rows. The Postgres dashboard summary path uses the
 * retained-size projection instead (see
 * `getRetainedSizeDatasetSummaryProjection` in `server/index.js`).
 *
 * The historical bug this guards: a Postgres deployment served stale
 * dashboard totals because a reference-only read model still consulted
 * the SQLite database initialized by the runtime. After the boundary
 * guard, any future caller that drifts back to the SQLite read model in
 * Postgres mode fails immediately with a typed error instead of
 * silently emitting an empty/stale answer.
 *
 * The divergence subtest deliberately writes a SQLite projection row
 * with a hand-crafted summary, then switches to Postgres mode and
 * exercises each guarded entry point. The guard must trip; the stale
 * SQLite row must NOT be reachable.
 *
 * Env gate: PDPP_TEST_POSTGRES_URL must be set (Compose Postgres proof
 * service). When unset, the test skips.
 *
 * Spec: openspec/changes/complete-postgres-runtime-boundary/
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  applyDatasetSummaryBlobDelta,
  applyDatasetSummaryRecordDelta,
  getDatasetSummaryProjection,
  listStreamProjections,
  markDatasetSummaryProjectionStale,
  rebuildDatasetSummaryProjection,
  reconcileDirtyDatasetSummaryRecordTimeBounds,
} from '../server/dataset-summary-read-model.js';
import { closeDb, getDb, initDb } from '../server/db.js';
import {
  closePostgresStorage,
  initPostgresStorage,
  isPostgresStorageBackend,
} from '../server/postgres-storage.js';

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

if (!POSTGRES_URL) {
  test('dataset-summary SQLite boundary guard in Postgres mode (skipped: PDPP_TEST_POSTGRES_URL unset)', {
    skip: true,
  }, () => {});
} else {
  test('SQLite dataset-summary read model throws storage_backend_mismatch in Postgres mode', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pdpp-dssum-boundary-'));
    const dbPath = join(tmp, 'pdpp.sqlite');

    // Seed SQLite with a divergent projection row so an accidental SQLite
    // read in Postgres mode would surface obviously-wrong content. The
    // guard must reject the read BEFORE any of these rows are reachable.
    initDb(dbPath);
    const db = getDb();
    db.prepare(
      `INSERT INTO dataset_summary_projection(projection_key, summary_json, metadata_json, updated_at, generation)
       VALUES('global', ?, ?, ?, 0)`,
    ).run(
      JSON.stringify({
        counts: { connector_count: 99, stream_count: 99, record_count: 99 },
        retained_bytes: { record_json_bytes: 999_999, record_changes_json_bytes: 0, blob_bytes: 0 },
        record_time_bounds: { earliest: '1999-01-01T00:00:00Z', latest: '1999-01-01T00:00:00Z' },
        ingested_time_bounds: { earliest: '1999-01-01T00:00:00Z', latest: '1999-01-01T00:00:00Z' },
        top_connector_candidates: [{ connector_id: 'stale_sqlite_connector', record_count: 99 }],
      }),
      JSON.stringify({
        computed_at: '1999-01-01T00:00:00Z',
        state: 'fresh',
        stale_since: null,
        rebuild_status: 'idle',
        last_error: null,
        source_high_watermark: null,
      }),
      '1999-01-01T00:00:00Z',
    );
    db.prepare(
      `INSERT INTO dataset_summary_stream_projection(
         connector_id, stream, record_count, record_json_bytes,
         earliest_ingested_at, latest_ingested_at, consent_time_field,
         dirty_record_time_bounds, computed_at
       )
       VALUES('stale_sqlite_connector', 'items', 99, 999999, '1999-01-01T00:00:00Z',
              '1999-01-01T00:00:00Z', null, 0, '1999-01-01T00:00:00Z')`,
    ).run();

    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    assert.equal(
      isPostgresStorageBackend(),
      true,
      'precondition: Postgres backend must be active for this regression',
    );

    try {
      // Reads must fail-fast.
      assert.throws(
        () => getDatasetSummaryProjection(),
        (err) => err.code === 'storage_backend_mismatch'
          && /Postgres mode/.test(err.message)
          && /getDatasetSummaryProjection/.test(err.message),
        'getDatasetSummaryProjection must refuse to serve SQLite rows in Postgres mode',
      );

      assert.throws(
        () => listStreamProjections(),
        (err) => err.code === 'storage_backend_mismatch'
          && /listStreamProjections/.test(err.message),
        'listStreamProjections must refuse to serve SQLite rows in Postgres mode',
      );

      assert.throws(
        () => listStreamProjections({ connectorId: 'stale_sqlite_connector' }),
        (err) => err.code === 'storage_backend_mismatch',
        'listStreamProjections (filtered) must also refuse',
      );

      // Writes / deltas must fail-fast — silently dropping them was the
      // original failure mode where Postgres ingest would accumulate
      // canonical records without the SQLite projection ever advancing,
      // leaving stale data that the SQLite-only summary read would serve.
      assert.throws(
        () => applyDatasetSummaryRecordDelta({
          connectorId: 'pg_test',
          stream: 'items',
          emittedAt: new Date().toISOString(),
          consentTimeField: null,
          recordCountDelta: 1,
          recordJsonBytesDelta: 100,
          recordChangesJsonBytesDelta: 100,
          dirtyRecordTimeBounds: false,
        }),
        (err) => err.code === 'storage_backend_mismatch'
          && /applyDatasetSummaryRecordDelta/.test(err.message),
        'applyDatasetSummaryRecordDelta must refuse in Postgres mode',
      );

      assert.throws(
        () => applyDatasetSummaryBlobDelta({ blobBytesDelta: 100 }),
        (err) => err.code === 'storage_backend_mismatch'
          && /applyDatasetSummaryBlobDelta/.test(err.message),
        'applyDatasetSummaryBlobDelta must refuse in Postgres mode',
      );

      assert.throws(
        () => markDatasetSummaryProjectionStale('test reason'),
        (err) => err.code === 'storage_backend_mismatch'
          && /markDatasetSummaryProjectionStale/.test(err.message),
        'markDatasetSummaryProjectionStale must refuse in Postgres mode',
      );

      // Async entry points
      await assert.rejects(
        () => rebuildDatasetSummaryProjection({
          getCounts: () => ({ connector_count: 0, stream_count: 0, record_count: 0 }),
          getRetainedBytes: () => ({ record_json_bytes: 0, record_changes_json_bytes: 0, blob_bytes: 0 }),
          getRecordTimeBounds: () => ({ earliest: null, latest: null }),
          getIngestedTimeBounds: () => ({ earliest: null, latest: null }),
          listTopConnectorCandidates: () => [],
        }),
        (err) => err.code === 'storage_backend_mismatch'
          && /rebuildDatasetSummaryProjection/.test(err.message),
        'rebuildDatasetSummaryProjection must reject in Postgres mode',
      );

      await assert.rejects(
        () => reconcileDirtyDatasetSummaryRecordTimeBounds({
          getStreamRecordTimeBounds: () => ({ earliest: null, latest: null }),
        }),
        (err) => err.code === 'storage_backend_mismatch'
          && /reconcileDirtyDatasetSummaryRecordTimeBounds/.test(err.message),
        'reconcileDirtyDatasetSummaryRecordTimeBounds must reject in Postgres mode',
      );
    } finally {
      await closePostgresStorage();
      closeDb();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}
