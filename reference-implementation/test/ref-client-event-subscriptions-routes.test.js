/**
 * Route-level integration test for the operator `_ref/event-subscriptions`
 * routes. Stands up a real server with owner auth enabled and asserts that
 * the three routes require a valid owner session and refuse to disclose
 * subscription existence to an unauthenticated caller.
 *
 * The functional projection / disable behaviors are covered by the
 * operation-level test in `ref-client-event-subscriptions-operations.test.js`;
 * this file is the host-adapter contract only.
 *
 * Spec: openspec/changes/add-client-event-subscription-management/specs/
 *       reference-implementation-architecture/spec.md
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../server/index.js';

const TEST_PASSWORD = 'ref-event-subscriptions-owner-test-password';

async function closeServer(server) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((r) => server.asServer.close(r)),
    new Promise((r) => server.rsServer.close(r)),
  ]);
}

async function withServer(opts, fn) {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    ...opts,
  });
  try {
    await fn({ asUrl: `http://localhost:${server.asPort}` });
  } finally {
    await closeServer(server);
  }
}

test('_ref/event-subscriptions* routes require an owner session', async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const list = await fetch(`${asUrl}/_ref/event-subscriptions`, {
      headers: { Accept: 'application/json' },
      redirect: 'manual',
    });
    assert.equal(list.status, 401);

    const get = await fetch(`${asUrl}/_ref/event-subscriptions/sub_does_not_exist`, {
      headers: { Accept: 'application/json' },
      redirect: 'manual',
    });
    // Spec scenario "A request without an owner session is rejected":
    // SHALL respond 401 and SHALL NOT disclose whether the subscription exists.
    assert.equal(get.status, 401);

    const disable = await fetch(`${asUrl}/_ref/event-subscriptions/sub_does_not_exist/disable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ reason: 'unit_test' }),
      redirect: 'manual',
    });
    assert.equal(disable.status, 401);
  });
});

test('_ref/event-subscriptions* routes return JSON shape when owner auth is disabled (no session needed)', async () => {
  // When ownerAuthPassword is the empty string the requireOwnerSession
  // middleware is a no-op (this mirrors the dev-bootstrap configuration); the
  // routes should succeed without a session and return the expected envelope
  // shape. This confirms the host-adapter wiring at least reaches the
  // operation layer. We pass `''` explicitly so the test does not inherit
  // PDPP_OWNER_PASSWORD from the ambient environment — see other tests in
  // this folder (ref-read-owner-gate, provider-metadata, hosted-mcp-oauth)
  // for the same idiom.
  await withServer({ ownerAuthPassword: '' }, async ({ asUrl }) => {
    const list = await fetch(`${asUrl}/_ref/event-subscriptions`, {
      headers: { Accept: 'application/json' },
    });
    assert.equal(list.status, 200);
    const body = await list.json();
    assert.equal(body.object, 'list');
    assert.equal(Array.isArray(body.data), true);

    const get = await fetch(`${asUrl}/_ref/event-subscriptions/sub_does_not_exist`, {
      headers: { Accept: 'application/json' },
    });
    assert.equal(get.status, 404);

    const disable = await fetch(`${asUrl}/_ref/event-subscriptions/sub_does_not_exist/disable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(disable.status, 404);
  });
});
