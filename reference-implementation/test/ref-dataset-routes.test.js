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
