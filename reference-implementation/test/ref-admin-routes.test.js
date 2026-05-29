/**
 * Route regression tests for the `_ref/approvals`, `_ref/records/timeline`,
 * `_ref/schedules`, `_ref/deployment`, `_ref/clients`, and `_ref/search`
 * route family.
 *
 * Exercises the routes at the HTTP level to catch wiring regressions that
 * operation-level and auth-gate tests cannot reach. Server runs in open mode
 * (no owner password) so auth does not mask routing errors. Each test verifies
 * the response status code and the top-level `object` discriminator (or key
 * set) in the envelope.
 *
 * Extracted to `server/routes/ref-admin.ts` per
 * `split-reference-server-by-route-family` §2.5. Mirrors the structure of
 * `test/ref-dataset-routes.test.js`.
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

test('GET /_ref/approvals returns list envelope', async () => {
  await withServer(async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/_ref/approvals`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.object, 'list');
    assert.ok(Array.isArray(body.data));
  });
});

test('GET /_ref/records/timeline returns list envelope', async () => {
  await withServer(async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/_ref/records/timeline`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.object, 'list');
    assert.ok(Array.isArray(body.data));
    assert.ok(body.meta !== undefined);
  });
});

test('GET /_ref/schedules returns list envelope', async () => {
  await withServer(async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/_ref/schedules`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.object, 'list');
    assert.ok(Array.isArray(body.data));
  });
});

test('GET /_ref/deployment returns deployment report', async () => {
  await withServer(async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/_ref/deployment`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.ok(body !== null && typeof body === 'object');
    assert.ok('database' in body, 'deployment report should include database key');
    assert.ok('environment' in body, 'deployment report should include environment key');
  });
});

test('GET /_ref/clients without ?owner=true returns 400 invalid_request', async () => {
  await withServer(async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/_ref/clients`);
    assert.equal(resp.status, 400);
    const body = await resp.json();
    assert.equal(body?.error?.code, 'invalid_request');
  });
});

test('GET /_ref/clients?owner=true returns list envelope', async () => {
  await withServer(async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/_ref/clients?owner=true`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.object, 'list');
    assert.ok(Array.isArray(body.data));
  });
});

test('GET /_ref/search returns search_result envelope', async () => {
  await withServer(async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/_ref/search?q=test`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.object, 'search_result');
    assert.ok('traces' in body);
    assert.ok('grants' in body);
    assert.ok('runs' in body);
  });
});
