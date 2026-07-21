/**
 * Operation-level tests for `ref.dataset.summary`.
 *
 * Exercises the operation in isolation with stub dependencies, asserting
 * that:
 *   - the response envelope carries `object: 'dataset_summary'` and every
 *     dataset-summary field;
 *   - `total_retained_bytes` is the sum of the three byte fields;
 *   - top-connector candidates are sorted by `record_count` desc with a
 *     `connector_id` asc tiebreak and capped at three;
 *   - each top-connector entry is wrapped as
 *     `{object: 'dataset_connector_summary', connector_id, record_count}`;
 *   - `record_count === 0` collapses every time-bound field to `null` and
 *     the operation skips the time-bound dependency calls;
 *   - dependencies may return promises (operation awaits them).
 *
 * Native and sandbox host parity are covered by the existing native
 * server tests and the sandbox `routes.test.ts` dataset-summary case;
 * those remain the regression baselines for envelope shape parity.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { executeRefDatasetSummary } from '../operations/ref-dataset-summary/index.ts';

function baselineDeps(overrides = {}) {
  return {
    getCounts: () => ({ connector_count: 2, stream_count: 4, record_count: 7 }),
    getRetainedBytes: () => ({
      record_json_bytes: 100,
      record_changes_json_bytes: 25,
      blob_bytes: 50,
    }),
    getRecordTimeBounds: () => ({
      earliest: '2026-01-01T00:00:00Z',
      latest: '2026-04-29T00:00:00Z',
    }),
    getIngestedTimeBounds: () => ({
      earliest: '2026-01-02T00:00:00Z',
      latest: '2026-04-29T12:00:00Z',
    }),
    listTopConnectorCandidates: () => [
      { connector_id: 'a', record_count: 3 },
      { connector_id: 'b', record_count: 2 },
    ],
    ...overrides,
  };
}

test('ref.dataset.summary returns the full dataset_summary envelope', async () => {
  const summary = await executeRefDatasetSummary(baselineDeps());

  assert.equal(summary.object, 'dataset_summary');
  assert.equal(summary.connector_count, 2);
  assert.equal(summary.stream_count, 4);
  assert.equal(summary.record_count, 7);
  assert.equal(summary.record_json_bytes, 100);
  assert.equal(summary.record_changes_json_bytes, 25);
  assert.equal(summary.blob_bytes, 50);
  assert.equal(summary.total_retained_bytes, 175);
  assert.equal(summary.earliest_record_time, '2026-01-01T00:00:00Z');
  assert.equal(summary.latest_record_time, '2026-04-29T00:00:00Z');
  assert.equal(summary.earliest_ingested_at, '2026-01-02T00:00:00Z');
  assert.equal(summary.latest_ingested_at, '2026-04-29T12:00:00Z');
  assert.deepEqual(summary.top_connectors, [
    { object: 'dataset_connector_summary', connector_id: 'a', record_count: 3 },
    { object: 'dataset_connector_summary', connector_id: 'b', record_count: 2 },
  ]);
  assert.deepEqual(summary.projection, {
    computed_at: null,
    state: 'fresh',
    stale_since: null,
    rebuild_status: 'idle',
    last_error: null,
    source_high_watermark: null,
  });
});

test('ref.dataset.summary uses projection hot path without raw aggregate dependencies', async () => {
  const forbidden = () => {
    throw new Error('raw aggregate dependency must not be called');
  };

  const summary = await executeRefDatasetSummary({
    getProjection: () => ({
      counts: { connector_count: 3, stream_count: 5, record_count: 11 },
      retained_bytes: {
        record_json_bytes: 200,
        record_changes_json_bytes: 30,
        blob_bytes: 40,
      },
      record_time_bounds: {
        earliest: '2026-01-01T00:00:00Z',
        latest: '2026-05-01T00:00:00Z',
      },
      ingested_time_bounds: {
        earliest: '2026-01-02T00:00:00Z',
        latest: '2026-05-02T00:00:00Z',
      },
      top_connector_candidates: [
        { connector_id: 'b', record_count: 4 },
        { connector_id: 'a', record_count: 7 },
      ],
      metadata: {
        computed_at: '2026-05-19T12:00:00.000Z',
        state: 'fresh',
        stale_since: null,
        rebuild_status: 'idle',
        last_error: null,
        source_high_watermark: 'records:42',
      },
    }),
    getCounts: forbidden,
    getRetainedBytes: forbidden,
    getRecordTimeBounds: forbidden,
    getIngestedTimeBounds: forbidden,
    listTopConnectorCandidates: forbidden,
  });

  assert.equal(summary.record_count, 11);
  assert.equal(summary.total_retained_bytes, 270);
  assert.deepEqual(
    summary.top_connectors.map((entry) => entry.connector_id),
    ['a', 'b'],
  );
  assert.deepEqual(summary.projection, {
    computed_at: '2026-05-19T12:00:00.000Z',
    state: 'fresh',
    stale_since: null,
    rebuild_status: 'idle',
    last_error: null,
    source_high_watermark: 'records:42',
  });
});

test('ref.dataset.summary exposes rebuilding metadata for missing projection rows', async () => {
  const summary = await executeRefDatasetSummary({
    getProjection: () => ({
      counts: { connector_count: 0, stream_count: 0, record_count: 0 },
      retained_bytes: {
        record_json_bytes: 0,
        record_changes_json_bytes: 0,
        blob_bytes: 0,
      },
      record_time_bounds: { earliest: null, latest: null },
      ingested_time_bounds: { earliest: null, latest: null },
      top_connector_candidates: [],
      metadata: {
        computed_at: null,
        state: 'rebuilding',
        stale_since: '2026-05-19T12:05:00.000Z',
        rebuild_status: 'running',
        last_error: null,
      },
    }),
    getCounts: () => {
      throw new Error('raw fallback must not run when rebuilding projection is returned');
    },
    getRetainedBytes: () => {
      throw new Error('raw fallback must not run when rebuilding projection is returned');
    },
    getRecordTimeBounds: () => {
      throw new Error('raw fallback must not run when rebuilding projection is returned');
    },
    getIngestedTimeBounds: () => {
      throw new Error('raw fallback must not run when rebuilding projection is returned');
    },
    listTopConnectorCandidates: () => {
      throw new Error('raw fallback must not run when rebuilding projection is returned');
    },
  });

  assert.equal(summary.record_count, 0);
  assert.equal(summary.projection.state, 'rebuilding');
  assert.equal(summary.projection.rebuild_status, 'running');
  assert.equal(summary.projection.computed_at, null);
});

test('ref.dataset.summary derives total_retained_bytes from the three byte fields', async () => {
  const summary = await executeRefDatasetSummary(
    baselineDeps({
      getRetainedBytes: () => ({
        record_json_bytes: 1024,
        record_changes_json_bytes: 512,
        blob_bytes: 0,
      }),
    }),
  );
  assert.equal(summary.total_retained_bytes, 1536);
});

test('ref.dataset.summary sorts top connectors by record_count desc with connector_id asc tiebreak', async () => {
  const summary = await executeRefDatasetSummary(
    baselineDeps({
      listTopConnectorCandidates: () => [
        { connector_id: 'zeta', record_count: 5 },
        { connector_id: 'alpha', record_count: 5 },
        { connector_id: 'mu', record_count: 8 },
      ],
    }),
  );
  assert.deepEqual(
    summary.top_connectors.map((c) => c.connector_id),
    ['mu', 'alpha', 'zeta'],
  );
});

test('ref.dataset.summary caps top connectors at three entries', async () => {
  const summary = await executeRefDatasetSummary(
    baselineDeps({
      listTopConnectorCandidates: () => [
        { connector_id: 'a', record_count: 10 },
        { connector_id: 'b', record_count: 9 },
        { connector_id: 'c', record_count: 8 },
        { connector_id: 'd', record_count: 7 },
        { connector_id: 'e', record_count: 6 },
      ],
    }),
  );
  assert.equal(summary.top_connectors.length, 3);
  assert.deepEqual(
    summary.top_connectors.map((c) => c.connector_id),
    ['a', 'b', 'c'],
  );
});

test('ref.dataset.summary wraps each top connector as dataset_connector_summary', async () => {
  const summary = await executeRefDatasetSummary(
    baselineDeps({
      listTopConnectorCandidates: () => [
        { connector_id: 'only', record_count: 1 },
      ],
    }),
  );
  assert.deepEqual(summary.top_connectors, [
    { object: 'dataset_connector_summary', connector_id: 'only', record_count: 1 },
  ]);
});

test('ref.dataset.summary collapses every time-bound to null when record_count === 0', async () => {
  let recordTimeCalled = false;
  let ingestedTimeCalled = false;
  const summary = await executeRefDatasetSummary({
    getCounts: () => ({ connector_count: 0, stream_count: 0, record_count: 0 }),
    getRetainedBytes: () => ({
      record_json_bytes: 0,
      record_changes_json_bytes: 0,
      blob_bytes: 0,
    }),
    getRecordTimeBounds: () => {
      recordTimeCalled = true;
      return { earliest: 'should-not-appear', latest: 'should-not-appear' };
    },
    getIngestedTimeBounds: () => {
      ingestedTimeCalled = true;
      return { earliest: 'should-not-appear', latest: 'should-not-appear' };
    },
    listTopConnectorCandidates: () => [],
  });

  assert.equal(summary.record_count, 0);
  assert.equal(summary.earliest_record_time, null);
  assert.equal(summary.latest_record_time, null);
  assert.equal(summary.earliest_ingested_at, null);
  assert.equal(summary.latest_ingested_at, null);
  assert.deepEqual(summary.top_connectors, []);
  assert.equal(
    recordTimeCalled,
    false,
    'getRecordTimeBounds must not be called on an empty corpus',
  );
  assert.equal(
    ingestedTimeCalled,
    false,
    'getIngestedTimeBounds must not be called on an empty corpus',
  );
});

test('ref.dataset.summary awaits dependency promises', async () => {
  let countsResolved = false;
  let bytesResolved = false;
  let candidatesResolved = false;
  const summary = await executeRefDatasetSummary({
    getCounts: () =>
      new Promise((r) =>
        setImmediate(() => {
          countsResolved = true;
          r({ connector_count: 1, stream_count: 1, record_count: 1 });
        }),
      ),
    getRetainedBytes: () =>
      new Promise((r) =>
        setImmediate(() => {
          bytesResolved = true;
          r({ record_json_bytes: 1, record_changes_json_bytes: 0, blob_bytes: 0 });
        }),
      ),
    getRecordTimeBounds: () => Promise.resolve({ earliest: 'r-min', latest: 'r-max' }),
    getIngestedTimeBounds: () => Promise.resolve({ earliest: 'i-min', latest: 'i-max' }),
    listTopConnectorCandidates: () =>
      new Promise((r) =>
        setImmediate(() => {
          candidatesResolved = true;
          r([{ connector_id: 'lone', record_count: 1 }]);
        }),
      ),
  });

  assert.equal(countsResolved, true);
  assert.equal(bytesResolved, true);
  assert.equal(candidatesResolved, true);
  assert.equal(summary.record_count, 1);
  assert.equal(summary.earliest_record_time, 'r-min');
  assert.equal(summary.latest_record_time, 'r-max');
  assert.equal(summary.earliest_ingested_at, 'i-min');
  assert.equal(summary.latest_ingested_at, 'i-max');
  assert.deepEqual(summary.top_connectors, [
    { object: 'dataset_connector_summary', connector_id: 'lone', record_count: 1 },
  ]);
});
