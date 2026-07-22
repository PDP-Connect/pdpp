// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Route regression tests for the `_ref/dataset/*` and
 * `_ref/records/version-stats` route family.
 *
 * Exercises the routes at the HTTP level to catch wiring regressions
 * that operation-level and auth-gate tests cannot reach. Server runs in
 * open mode (no owner password) so auth does not mask routing errors.
 * Each test verifies the response status code and the top-level `object`
 * discriminator in the envelope.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { startServer } from '../server/index.js';
import {
  __resetRetainedSizeAutoReconcileThrottleForTest,
  __setRetainedSizeAutoReconcileNowForTest,
  mountRefDatasetSummary,
} from '../server/routes/ref-dataset.ts';

async function closeServer(server) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
}

async function withServer(fn) {
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await fn({ asUrl });
  } finally {
    await closeServer(server);
  }
}

test('GET /_ref/dataset/summary returns dataset_summary envelope', async () => {
  await withServer(async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/_ref/dataset/summary`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.object, 'dataset_summary');
    assert.equal(typeof body.record_count, 'number');
  });
});

function captureDatasetSummaryHandler(ctx) {
  let captured = null;
  mountRefDatasetSummary(
    {
      get(_path, ...args) {
        captured = args.at(-1);
        return this;
      },
    },
    ctx,
  );
  assert.equal(typeof captured, 'function');
  return captured;
}

function retainedSizeRouteContext(overrides = {}) {
  const freshGlobal = {
    blob_bytes: 0,
    computed_at: '2026-06-25T12:01:00.000Z',
    current_record_json_bytes: 11,
    dirty: false,
    metadata: {
      state: 'fresh',
      stale_since: null,
      rebuild_status: 'idle',
      last_error: null,
      source_high_watermark: 'reconcile:2026-06-25T12:01:00.000Z',
    },
    record_count: 1,
    record_history_json_bytes: 13,
  };
  const staleGlobal = {
    ...freshGlobal,
    computed_at: '2026-06-25T12:00:00.000Z',
    dirty: true,
    metadata: {
      state: 'stale',
      stale_since: '2026-06-25T12:00:00.000Z',
      rebuild_status: 'idle',
      last_error: 'bulk write on unknown connection',
      source_high_watermark: 'delta:2026-06-25T12:00:00.000Z',
    },
  };
  const state = {
    global: staleGlobal,
    reconcileCalls: 0,
  };
  return {
    state,
    ctx: {
      requireOwnerSession: (_req, _res, next) => next?.(),
      handleError(_res, err) {
        throw err;
      },
      createRequestAbortSignal: () => ({ signal: new AbortController().signal, cleanup() {} }),
      isPostgresStorageBackend: () => true,
      getDatasetRecordsAggregate: async () => ({
        connector_count: 1,
        earliest_ingested_at: null,
        latest_ingested_at: null,
        record_count: 1,
        record_json_bytes: 11,
        stream_count: 1,
      }),
      getDatasetRecordChangesBytes: async () => 13,
      getDatasetBlobBytes: async () => 0,
      getDatasetRecordTimeBounds: async () => ({ earliest: null, latest: null }),
      listDatasetTopConnectorCandidates: async () => [],
      listDatasetSummaryStreamProjectionSeeds: async () => [],
      getDatasetSummaryStreamRecordTimeBounds: async () => ({ earliest: null, latest: null }),
      getDatasetSummaryProjection: () => {
        throw new Error('SQLite dataset summary projection should not be used in retained-size mode');
      },
      listStreamProjections: async () => [],
      rebuildDatasetSummaryProjection: async () => {
        throw new Error('not used');
      },
      reconcileDirtyDatasetSummaryRecordTimeBounds: async () => ({ reconciled: 0, deferred: 0, residual: 0 }),
      getRetainedSizeGlobal: async () => state.global,
      listRetainedSizeConnections: async () => [
        {
          connector_id: 'test.connector',
          connector_instance_id: 'cin_test',
          record_count: 1,
        },
      ],
      listRetainedSizeStreams: async () => [
        {
          computed_at: state.global.computed_at,
          connector_id: 'test.connector',
          current_record_json_bytes: 11,
          dirty: false,
          record_count: 1,
          stream: 'messages',
        },
      ],
      listRetainedSizeTop: async () => [],
      rebuildRetainedSize: async () => {
        throw new Error('read path must not rebuild retained-size projection');
      },
      reconcileDirtyRetainedSize: async () => {
        state.reconcileCalls += 1;
        state.global = freshGlobal;
        return { streams: 0, connections: 0 };
      },
      buildRecordVersionStatsEnvelope: async () => ({}),
      createRequestConnectorInstanceStore: () => ({}),
      ...overrides,
    },
  };
}

test('GET /_ref/dataset/summary auto-reconciles stale retained-size projection metadata', async () => {
  __resetRetainedSizeAutoReconcileThrottleForTest();
  const { ctx, state } = retainedSizeRouteContext();
  const handler = captureDatasetSummaryHandler(ctx);
  let body = null;

  await handler({}, { json(value) { body = value; } });

  assert.equal(state.reconcileCalls, 1);
  assert.equal(body.object, 'dataset_summary');
  assert.equal(body.projection.state, 'fresh');
  assert.equal(body.projection.last_error, null);
  assert.equal(body.total_retained_bytes, 24);
});

test('GET /_ref/dataset/summary leaves retained-size projection stale when auto-reconcile fails', async () => {
  __resetRetainedSizeAutoReconcileThrottleForTest();
  const { ctx, state } = retainedSizeRouteContext();
  ctx.reconcileDirtyRetainedSize = async () => {
    state.reconcileCalls += 1;
    throw new Error('simulated reconcile failure');
  };
  const handler = captureDatasetSummaryHandler(ctx);
  let body = null;

  await handler({}, { json(value) { body = value; } });

  assert.equal(state.reconcileCalls, 1);
  assert.equal(body.object, 'dataset_summary');
  assert.equal(body.projection.state, 'stale');
  assert.equal(body.projection.last_error, 'bulk write on unknown connection');
});

test('GET /_ref/dataset/summary throttles repeated retained-size auto-reconcile failures', async () => {
  __resetRetainedSizeAutoReconcileThrottleForTest();
  __setRetainedSizeAutoReconcileNowForTest(() => 1_000);
  const { ctx, state } = retainedSizeRouteContext();
  ctx.reconcileDirtyRetainedSize = async () => {
    state.reconcileCalls += 1;
    throw new Error('simulated reconcile failure');
  };
  const handler = captureDatasetSummaryHandler(ctx);

  await handler({}, { json() {} });
  await handler({}, { json() {} });

  assert.equal(state.reconcileCalls, 1);
  __resetRetainedSizeAutoReconcileThrottleForTest();
});

test('GET /_ref/dataset/summary/streams returns dataset_summary_streams envelope', async () => {
  await withServer(async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/_ref/dataset/summary/streams`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.object, 'dataset_summary_streams');
    assert.ok(Array.isArray(body.streams));
  });
});

test('GET /_ref/dataset/size defaults to global grain', async () => {
  await withServer(async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/_ref/dataset/size`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.object, 'ref_dataset_size');
    assert.equal(body.grain, 'global');
    assert.ok(Array.isArray(body.rows));
  });
});

test('GET /_ref/dataset/size rejects unsupported grain with 400', async () => {
  await withServer(async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/_ref/dataset/size?grain=nonsense`);
    assert.equal(resp.status, 400);
    const body = await resp.json();
    assert.equal(body?.error?.code, 'invalid_request');
  });
});

test('GET /_ref/dataset/top returns ref_dataset_top envelope', async () => {
  await withServer(async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/_ref/dataset/top`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.object, 'ref_dataset_top');
    assert.ok(Array.isArray(body.rows));
  });
});

test('GET /_ref/records/version-stats returns envelope', async () => {
  await withServer(async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/_ref/records/version-stats`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.ok(body !== null && typeof body === 'object');
  });
});

test('POST /_ref/dataset/summary/rebuild returns dataset_summary envelope', async () => {
  await withServer(async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/_ref/dataset/summary/rebuild`, { method: 'POST' });
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.object, 'dataset_summary');
  });
});

test('POST /_ref/dataset/summary/reconcile returns dataset_summary_reconcile envelope', async () => {
  await withServer(async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/_ref/dataset/summary/reconcile`, { method: 'POST' });
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.object, 'dataset_summary_reconcile');
    assert.equal(typeof body.reconciled, 'number');
  });
});

test('POST /_ref/dataset/size/rebuild returns ref_dataset_size_rebuild envelope', async () => {
  await withServer(async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/_ref/dataset/size/rebuild`, { method: 'POST' });
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.object, 'ref_dataset_size_rebuild');
  });
});

test('POST /_ref/dataset/size/reconcile returns ref_dataset_size_reconcile envelope', async () => {
  await withServer(async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/_ref/dataset/size/reconcile`, { method: 'POST' });
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.object, 'ref_dataset_size_reconcile');
  });
});
