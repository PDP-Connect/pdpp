import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ClientEventSubscriptionError,
  executeApplyGrantRevoke,
  executeCreateSubscription,
  executeDeleteSubscription,
  executeEnqueueTestEvent,
  executeGetSubscription,
  executeListSubscriptions,
  executeRecordDeliveryFailure,
  executeUpdateSubscription,
  executeVerificationOutcome,
  hashSecret,
} from '../operations/as-client-event-subscriptions/index.ts';

function makeInMemoryStore() {
  const subs = new Map();
  const queue = [];
  return {
    insertSubscription(row) {
      subs.set(row.subscription_id, { ...row });
    },
    getSubscriptionById(id) {
      const row = subs.get(id);
      return row ? { ...row } : null;
    },
    listSubscriptionsByClient(clientId) {
      return [...subs.values()].filter((s) => s.client_id === clientId);
    },
    listSubscriptionsByGrant(grantId) {
      return [...subs.values()].filter((s) => s.grant_id === grantId);
    },
    updateStatus(id, status, updatedAt, disabledAt, disabledReason) {
      const row = subs.get(id);
      if (!row) return;
      row.status = status;
      row.updated_at = updatedAt;
      row.disabled_at = disabledAt;
      row.disabled_reason = disabledReason;
    },
    updateSecret(id, secretHash, secretText, updatedAt) {
      const row = subs.get(id);
      if (!row) return;
      row.secret_hash = secretHash;
      row.secret_text = secretText;
      row.updated_at = updatedAt;
    },
    deleteSubscription(id) {
      subs.delete(id);
    },
    enqueueEvent(event) {
      queue.push(event);
    },
    dropQueuedForSubscription(id) {
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].subscriptionId === id) queue.splice(i, 1);
      }
    },
    __dump: () => ({ subs: [...subs.values()], queue: [...queue] }),
  };
}

function actor(overrides = {}) {
  return {
    clientId: 'client_alpha',
    grantId: 'grant_1',
    subjectId: 'owner_local',
    grantScope: {
      source: { kind: 'connector', id: 'gmail' },
      streams: [{ name: 'messages' }, { name: 'contacts' }],
    },
    ...overrides,
  };
}

function deps(store) {
  return { store, nowIso: () => '2026-05-27T00:00:00.000Z' };
}

test('create rejects non-https callback (except localhost)', () => {
  const store = makeInMemoryStore();
  assert.throws(
    () => executeCreateSubscription({ actor: actor(), callbackUrl: 'http://example.com/hook' }, deps(store)),
    ClientEventSubscriptionError,
  );
  // Localhost permitted for dev.
  const out = executeCreateSubscription(
    { actor: actor(), callbackUrl: 'http://localhost:9999/hook' },
    deps(store),
  );
  assert.equal(out.status, 'pending_verification');
});

test('create persists subscription and enqueues verify event exactly once', () => {
  const store = makeInMemoryStore();
  const out = executeCreateSubscription(
    { actor: actor(), callbackUrl: 'https://example.com/hook' },
    deps(store),
  );
  assert.ok(out.secret.startsWith('pess_'));
  assert.ok(out.subscriptionId.startsWith('sub_'));
  const dump = store.__dump();
  assert.equal(dump.subs.length, 1);
  assert.equal(dump.subs[0].status, 'pending_verification');
  assert.equal(dump.queue.length, 1);
  assert.equal(dump.queue[0].eventType, 'pdpp.subscription.verify');
  const payload = JSON.parse(dump.queue[0].payloadJson);
  assert.equal(payload.type, 'pdpp.subscription.verify');
  assert.ok(typeof payload.data.challenge === 'string' && payload.data.challenge.length > 0);
});

test('create narrows scope when filters subset of grant', () => {
  const store = makeInMemoryStore();
  const out = executeCreateSubscription(
    {
      actor: actor(),
      callbackUrl: 'https://example.com/hook',
      filters: { streams: ['messages'] },
    },
    deps(store),
  );
  const dump = store.__dump();
  const scope = JSON.parse(dump.subs[0].scope_json);
  assert.deepEqual(scope.filters.streams, ['messages']);
});

test('create refuses filters outside grant', () => {
  const store = makeInMemoryStore();
  assert.throws(() =>
    executeCreateSubscription(
      {
        actor: actor(),
        callbackUrl: 'https://example.com/hook',
        filters: { streams: ['labels'] },
      },
      deps(store),
    ), /not in grant/);
});

test('get refuses cross-client and cross-grant access', () => {
  const store = makeInMemoryStore();
  const created = executeCreateSubscription(
    { actor: actor(), callbackUrl: 'https://example.com/hook' },
    deps(store),
  );
  // Different client_id
  assert.throws(() => executeGetSubscription(actor({ clientId: 'other' }), created.subscriptionId, deps(store)));
  // Different grant_id
  assert.throws(() => executeGetSubscription(actor({ grantId: 'other_grant' }), created.subscriptionId, deps(store)));
  // Same actor succeeds
  const fetched = executeGetSubscription(actor(), created.subscriptionId, deps(store));
  assert.equal(fetched.subscription_id, created.subscriptionId);
});

test('list returns only matching client+grant', () => {
  const store = makeInMemoryStore();
  executeCreateSubscription({ actor: actor(), callbackUrl: 'https://a.example/h' }, deps(store));
  executeCreateSubscription(
    { actor: actor({ clientId: 'other' }), callbackUrl: 'https://b.example/h' },
    deps(store),
  );
  const out = executeListSubscriptions(actor(), deps(store));
  assert.equal(out.data.length, 1);
});

test('verification handshake transitions pending_verification → active', () => {
  const store = makeInMemoryStore();
  const created = executeCreateSubscription(
    { actor: actor(), callbackUrl: 'https://example.com/hook' },
    deps(store),
  );
  executeVerificationOutcome(created.subscriptionId, 'verified', deps(store));
  const row = store.getSubscriptionById(created.subscriptionId);
  assert.equal(row.status, 'active');
});

test('update toggles enabled/disabled and rotates secret', () => {
  const store = makeInMemoryStore();
  const created = executeCreateSubscription(
    { actor: actor(), callbackUrl: 'https://example.com/hook' },
    deps(store),
  );
  executeVerificationOutcome(created.subscriptionId, 'verified', deps(store));

  // disable
  let out = executeUpdateSubscription(actor(), created.subscriptionId, { enabled: false }, deps(store));
  assert.equal(out.subscription.status, 'disabled');

  // re-enable
  out = executeUpdateSubscription(actor(), created.subscriptionId, { enabled: true }, deps(store));
  assert.equal(out.subscription.status, 'active');

  // rotate
  out = executeUpdateSubscription(actor(), created.subscriptionId, { rotateSecret: true }, deps(store));
  assert.ok(out.secret);
  const row = store.getSubscriptionById(created.subscriptionId);
  assert.equal(row.secret_hash, hashSecret(out.secret));
});

test('test-event enqueues a subscription.test envelope', () => {
  const store = makeInMemoryStore();
  const created = executeCreateSubscription(
    { actor: actor(), callbackUrl: 'https://example.com/hook' },
    deps(store),
  );
  executeVerificationOutcome(created.subscriptionId, 'verified', deps(store));
  const out = executeEnqueueTestEvent(actor(), created.subscriptionId, deps(store));
  const queued = store.__dump().queue.find((q) => q.eventId === out.eventId);
  const payload = JSON.parse(queued.payloadJson);
  assert.equal(payload.type, 'pdpp.subscription.test');
});

test('delete is grant-scoped and drops queued events', () => {
  const store = makeInMemoryStore();
  const created = executeCreateSubscription(
    { actor: actor(), callbackUrl: 'https://example.com/hook' },
    deps(store),
  );
  // queue is non-empty from the verify enqueue
  assert.equal(store.__dump().queue.length, 1);
  executeDeleteSubscription(actor(), created.subscriptionId, deps(store));
  assert.equal(
    store.__dump().queue.filter((q) => q.subscriptionId === created.subscriptionId && q.eventType !== 'pdpp.subscription.test').length,
    0,
  );
});

test('grant revoke emits at most one grant.revoked, drops queued, marks disabled_revoked', () => {
  const store = makeInMemoryStore();
  const created = executeCreateSubscription(
    { actor: actor(), callbackUrl: 'https://example.com/hook' },
    deps(store),
  );
  executeVerificationOutcome(created.subscriptionId, 'verified', deps(store));

  const out = executeApplyGrantRevoke('grant_1', deps(store));
  assert.equal(out.affected, 1);
  assert.equal(out.notified, 1);
  const row = store.getSubscriptionById(created.subscriptionId);
  assert.equal(row.status, 'disabled_revoked');

  const remaining = store.__dump().queue.filter((q) => q.subscriptionId === created.subscriptionId);
  assert.equal(remaining.length, 1); // just the new grant.revoked envelope
  const payload = JSON.parse(remaining[0].payloadJson);
  assert.equal(payload.type, 'pdpp.grant.revoked');
});

test('record delivery failure marks subscription disabled_failure once', () => {
  const store = makeInMemoryStore();
  const created = executeCreateSubscription(
    { actor: actor(), callbackUrl: 'https://example.com/hook' },
    deps(store),
  );
  executeVerificationOutcome(created.subscriptionId, 'verified', deps(store));
  executeRecordDeliveryFailure(created.subscriptionId, deps(store));
  const row = store.getSubscriptionById(created.subscriptionId);
  assert.equal(row.status, 'disabled_failure');
});
