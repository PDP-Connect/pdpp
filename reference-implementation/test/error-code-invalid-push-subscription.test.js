/**
 * Mutation-killing coverage for the `invalid_push_subscription` typed-error
 * code (server/web-push-notifications.js).
 *
 * A Web Push subscription MUST carry a non-empty `endpoint` and both key
 * materials (`keys.p256dh`, `keys.auth`). When a subscription store `upsert`
 * receives an input missing any of these, `normalizeSubscription` throws an
 * error with `code: 'invalid_push_subscription'` and `status: 400` rather than
 * persisting a half-formed record (which would later fail to receive any push).
 *
 * The existing web-push test suite only upserts well-formed subscriptions, so
 * no `test/` file exercised `invalid_push_subscription` by name; a mutation
 * dropping a field check or corrupting the code/status went undetected. This
 * test pins the guard on the in-memory store (the store that shares the
 * `normalizeSubscription` gate with the SQLite/Postgres stores).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryWebPushSubscriptionStore } from '../server/web-push-notifications.js';

function validSubscription() {
  return {
    endpoint: 'https://push.example.invalid/sub/one',
    keys: { p256dh: 'public-key-material', auth: 'auth-secret' },
  };
}

test('a valid subscription upserts without error (control)', () => {
  const store = createMemoryWebPushSubscriptionStore();
  // `upsert` validates synchronously via `normalizeSubscription`.
  const record = store.upsert('owner_local', validSubscription(), {});
  assert.equal(record.endpoint, 'https://push.example.invalid/sub/one');
});

test('upsert rejects malformed subscriptions with invalid_push_subscription (400)', () => {
  const store = createMemoryWebPushSubscriptionStore();

  const cases = [
    { label: 'missing endpoint', sub: { keys: { p256dh: 'p', auth: 'a' } } },
    { label: 'empty endpoint', sub: { endpoint: '', keys: { p256dh: 'p', auth: 'a' } } },
    { label: 'missing keys object', sub: { endpoint: 'https://push.example.invalid/x' } },
    { label: 'missing p256dh', sub: { endpoint: 'https://push.example.invalid/x', keys: { auth: 'a' } } },
    { label: 'missing auth', sub: { endpoint: 'https://push.example.invalid/x', keys: { p256dh: 'p' } } },
    { label: 'empty auth', sub: { endpoint: 'https://push.example.invalid/x', keys: { p256dh: 'p', auth: '' } } },
  ];

  for (const { label, sub } of cases) {
    assert.throws(
      () => store.upsert('owner_local', sub, {}),
      (err) => {
        assert.equal(err.code, 'invalid_push_subscription', `${label}: expected invalid_push_subscription`);
        assert.equal(err.status, 400, `${label}: expected HTTP 400`);
        return true;
      },
      `${label}: SHALL be rejected`,
    );
  }

  // The rejected upserts SHALL leave no record behind.
  const stored = store.list('owner_local');
  assert.equal(stored.length, 0, 'no malformed subscription is persisted');
});
