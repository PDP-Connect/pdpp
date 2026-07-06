/**
 * Mutation-killing coverage for the `web_push_unavailable` typed-error code
 * (server/routes/web-push.ts).
 *
 * The operator-only Web Push surface (`POST /_ref/web-push/subscriptions` and
 * `POST /_ref/web-push/test`) requires VAPID to be configured. When the web
 * push config is disabled (no VAPID keypair), each of those endpoints refuses
 * with HTTP 503 and code `web_push_unavailable`, surfacing the config's
 * `unavailableReason` as the message rather than silently 500-ing on a missing
 * keypair or accepting a subscription that can never receive a push.
 *
 * The existing web-push test suite exercises the owner-session gate and the
 * happy path, but never the disabled-config guard; no `test/` file asserted
 * `web_push_unavailable` by name. This test pins both guarded endpoints (503 +
 * code + reason) and a control proving an enabled config does NOT 503.
 *
 * Owner auth is left disabled so the owner session auto-passes and the ONLY
 * thing under test is the VAPID-availability guard.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../server/index.js';
import { createMemoryWebPushSubscriptionStore } from '../server/web-push-notifications.js';

const UNAVAILABLE_REASON = 'VAPID public/private keys are not configured';

async function closeServer(server) {
  const closeOne = (httpServer) =>
    new Promise((resolve) => {
      if (!httpServer) return resolve();
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      }, 2000);
      httpServer.closeAllConnections?.();
      httpServer.close(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      });
    });
  await Promise.allSettled([closeOne(server.asServer), closeOne(server.rsServer)]);
}

function sampleSubscription() {
  return { endpoint: 'https://push.example.invalid/sub/one', keys: { p256dh: 'p', auth: 'a' } };
}

test('web push endpoints refuse with web_push_unavailable (503) when VAPID is not configured', async () => {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    webPushSubscriptionStore: createMemoryWebPushSubscriptionStore(),
    webPushConfig: { enabled: false, unavailableReason: UNAVAILABLE_REASON },
  });
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    // POST /subscriptions
    const create = await fetch(`${asUrl}/_ref/web-push/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ subscription: sampleSubscription() }),
      redirect: 'manual',
    });
    assert.equal(create.status, 503, 'create SHALL 503 when web push is unavailable');
    const createBody = await create.json();
    assert.equal(createBody.error.code, 'web_push_unavailable');
    assert.equal(createBody.error.message, UNAVAILABLE_REASON, 'unavailableReason SHALL be surfaced');

    // POST /test
    const ping = await fetch(`${asUrl}/_ref/web-push/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({}),
      redirect: 'manual',
    });
    assert.equal(ping.status, 503, 'test SHALL 503 when web push is unavailable');
    const pingBody = await ping.json();
    assert.equal(pingBody.error.code, 'web_push_unavailable');

    // The rejected create SHALL persist no subscription.
    const list = await fetch(`${asUrl}/_ref/web-push/subscriptions`, {
      headers: { Accept: 'application/json' },
      redirect: 'manual',
    });
    assert.equal(list.status, 200);
    const listBody = await list.json();
    assert.equal(listBody.data.length, 0, 'no subscription is persisted while unavailable');
  } finally {
    await closeServer(server);
  }
});

test('an enabled web push config does NOT 503 the create endpoint (control)', async () => {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    webPushSubscriptionStore: createMemoryWebPushSubscriptionStore(),
    webPushConfig: {
      enabled: true,
      publicKey: 'BAabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcd',
      privateKey: 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz',
      subject: 'mailto:test@example.invalid',
      unavailableReason: null,
    },
  });
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const create = await fetch(`${asUrl}/_ref/web-push/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ subscription: sampleSubscription() }),
      redirect: 'manual',
    });
    assert.notEqual(create.status, 503, 'an enabled config SHALL NOT report web_push_unavailable');
    assert.equal(create.status, 201, 'a valid subscription is created when web push is available');
  } finally {
    await closeServer(server);
  }
});
