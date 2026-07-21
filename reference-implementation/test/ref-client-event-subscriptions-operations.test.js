// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator-side oversight operations for client event subscriptions.
 *
 * Covers `ref.client-event-subscriptions.list`, `.get`, and `.disable`.
 * These tests use a plain in-memory store rather than the real SQLite /
 * Postgres backed store — the operation contract is what's normative; the
 * store-backed integration is exercised by the existing
 * `as-client-event-subscriptions-operation.test.js` and the e2e suite.
 *
 * Spec: openspec/changes/add-client-event-subscription-management/
 *       specs/reference-implementation-architecture/spec.md
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { executeRefClientEventSubscriptionsList } from '../operations/ref-client-event-subscriptions-list/index.ts';
import {
  executeRefClientEventSubscriptionsGet,
  REF_CLIENT_EVENT_SUBSCRIPTIONS_ATTEMPT_CAP,
  RefClientEventSubscriptionsNotFoundError,
} from '../operations/ref-client-event-subscriptions-get/index.ts';
import {
  executeRefClientEventSubscriptionsDisable,
  RefClientEventSubscriptionsDisableInvalidRequestError,
  RefClientEventSubscriptionsDisableNotFoundError,
} from '../operations/ref-client-event-subscriptions-disable/index.ts';

function makeStore() {
  const subs = new Map();
  const queue = [];
  const attempts = [];
  let attemptSeq = 0;
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
    updateSecret() { /* unused */ },
    deleteSubscription(id) { subs.delete(id); },
    enqueueEvent(event) { queue.push({ ...event }); },
    dropQueuedForSubscription(id) {
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].subscriptionId === id) queue.splice(i, 1);
      }
    },
    // helpers for the operator-side helpers:
    listAllSubscriptions({ clientId, grantId, status } = {}) {
      return [...subs.values()].filter((s) => {
        if (s.status === 'deleted') return false;
        if (clientId && s.client_id !== clientId) return false;
        if (grantId && s.grant_id !== grantId) return false;
        if (status && s.status !== status) return false;
        return true;
      });
    },
    getSubscriptionSummary(id) {
      const row = subs.get(id);
      if (!row || row.status === 'deleted') return null;
      const pending = queue.filter((q) => q.subscriptionId === id).length;
      const subscriptionAttempts = attempts.filter((a) => a._subscription_id === id);
      const last = subscriptionAttempts[subscriptionAttempts.length - 1] ?? null;
      return {
        subscription_id: row.subscription_id,
        authority_kind: row.authority_kind,
        grant_id: row.grant_id,
        client_id: row.client_id,
        subject_id: row.subject_id,
        callback_url: row.callback_url,
        scope_json: row.scope_json,
        status: row.status,
        created_at: row.created_at,
        updated_at: row.updated_at,
        disabled_at: row.disabled_at,
        disabled_reason: row.disabled_reason,
        pending_queue_count: pending,
        final_failure_count: 0,
        last_attempted_at: last?.attempted_at ?? null,
        last_attempt_ok: last ? (last.ok ? 1 : 0) : null,
        last_attempt_status_code: last?.status_code ?? null,
      };
    },
    listAttemptsForSubscription(id, limit) {
      return attempts
        .filter((a) => a._subscription_id === id)
        .slice(-limit)
        .reverse()
        .map(({ _subscription_id, ...rest }) => rest);
    },
    // test helpers:
    _addAttempt(subscriptionId, attempt) {
      attempts.push({
        _subscription_id: subscriptionId,
        attempt_id: ++attemptSeq,
        queue_id: 1,
        event_id: `evt_${attemptSeq}`,
        event_type: 'pdpp.records.changed',
        ...attempt,
      });
    },
  };
}

function seedSubscription(store, overrides = {}) {
  const id = overrides.subscription_id ?? `sub_${Math.random().toString(36).slice(2, 10)}`;
  store.insertSubscription({
    subscription_id: id,
    authority_kind: 'client_grant',
    grant_id: 'grant_1',
    client_id: 'client_alpha',
    subject_id: 'owner_local',
    callback_url: 'https://client.example/hook',
    secret_hash: 'h',
    secret_text: 'pess_secret',
    scope_json: JSON.stringify({ streams: [{ name: 'messages' }] }),
    status: 'active',
    verification_challenge: null,
    created_at: '2026-05-27T00:00:00.000Z',
    updated_at: '2026-05-27T00:00:00.000Z',
    disabled_at: null,
    disabled_reason: null,
    ...overrides,
  });
  return id;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

test('list returns operator projection without secret material', async () => {
  const store = makeStore();
  const id = seedSubscription(store);
  const env = await executeRefClientEventSubscriptionsList({}, store);
  assert.equal(env.object, 'list');
  assert.equal(env.data.length, 1);
  const row = env.data[0];
  assert.equal(row.subscription_id, id);
  assert.equal(row.callback_host, 'client.example');
  // Defensive: projection must not include secret fields.
  for (const banned of ['secret', 'secret_hash', 'secret_text']) {
    assert.equal(banned in row, false, `${banned} leaked into operator projection`);
  }
});

test('list filters by client, grant, and status combined', async () => {
  const store = makeStore();
  seedSubscription(store, { subscription_id: 'sub_a', client_id: 'client_alpha', grant_id: 'g_a', status: 'active' });
  seedSubscription(store, { subscription_id: 'sub_b', client_id: 'client_beta', grant_id: 'g_b', status: 'disabled', disabled_reason: 'client_disabled' });
  seedSubscription(store, { subscription_id: 'sub_c', client_id: 'client_alpha', grant_id: 'g_a', status: 'disabled', disabled_reason: 'operator_disabled' });

  const onlyAlpha = await executeRefClientEventSubscriptionsList({ clientId: 'client_alpha' }, store);
  assert.deepEqual(onlyAlpha.data.map((r) => r.subscription_id).sort(), ['sub_a', 'sub_c']);

  const onlyDisabled = await executeRefClientEventSubscriptionsList({ status: 'disabled' }, store);
  assert.deepEqual(onlyDisabled.data.map((r) => r.subscription_id).sort(), ['sub_b', 'sub_c']);

  const combined = await executeRefClientEventSubscriptionsList(
    { clientId: 'client_alpha', grantId: 'g_a', status: 'disabled' },
    store,
  );
  assert.deepEqual(combined.data.map((r) => r.subscription_id), ['sub_c']);
});

test('list ignores deleted subscriptions', async () => {
  const store = makeStore();
  seedSubscription(store, { subscription_id: 'sub_live', status: 'active' });
  seedSubscription(store, { subscription_id: 'sub_dead', status: 'deleted' });
  const env = await executeRefClientEventSubscriptionsList({}, store);
  assert.deepEqual(env.data.map((r) => r.subscription_id), ['sub_live']);
});

test('list with unknown status returns empty list (not 4xx)', async () => {
  const store = makeStore();
  seedSubscription(store);
  const env = await executeRefClientEventSubscriptionsList({ status: 'gibberish' }, store);
  assert.equal(env.data.length, 0);
});

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

test('get returns detail with bounded attempt list and no secrets', async () => {
  const store = makeStore();
  const id = seedSubscription(store);
  for (let i = 0; i < 30; i++) {
    store._addAttempt(id, {
      attempted_at: `2026-05-27T00:00:${String(i).padStart(2, '0')}.000Z`,
      status_code: 200,
      ok: 1,
      latency_ms: 12,
      error: null,
      response_snippet: null,
    });
  }
  const detail = await executeRefClientEventSubscriptionsGet(id, store);
  assert.equal(detail.subscription_id, id);
  assert.equal(detail.callback_url, 'https://client.example/hook');
  assert.equal(detail.callback_host, 'client.example');
  assert.equal(detail.recent_attempts.length, REF_CLIENT_EVENT_SUBSCRIPTIONS_ATTEMPT_CAP);
  for (const banned of ['secret', 'secret_hash', 'secret_text']) {
    assert.equal(banned in detail, false);
  }
  assert.equal(detail.last_attempt_ok, true);
});

test('get on unknown subscription throws not_found', async () => {
  const store = makeStore();
  await assert.rejects(
    () => executeRefClientEventSubscriptionsGet('sub_missing', store),
    RefClientEventSubscriptionsNotFoundError,
  );
});

test('get on deleted subscription throws not_found', async () => {
  const store = makeStore();
  seedSubscription(store, { subscription_id: 'sub_x', status: 'deleted' });
  await assert.rejects(
    () => executeRefClientEventSubscriptionsGet('sub_x', store),
    RefClientEventSubscriptionsNotFoundError,
  );
});

// ---------------------------------------------------------------------------
// disable
// ---------------------------------------------------------------------------

function disableDeps(store, now = '2026-05-27T01:00:00.000Z') {
  return { store, nowIso: () => now };
}

test('disable transitions active to disabled with default reason and drops queue', async () => {
  const store = makeStore();
  const id = seedSubscription(store);
  store.enqueueEvent({ subscriptionId: id, eventId: 'evt_x', eventType: 'pdpp.records.changed', payloadJson: '{}', enqueuedAt: '', nextAttemptAt: '' });
  const out = await executeRefClientEventSubscriptionsDisable({ subscriptionId: id }, disableDeps(store));
  assert.equal(out.status, 'disabled');
  assert.equal(out.disabledReason, 'operator_disabled');
  assert.equal(out.wasAlreadyDisabled, false);
  assert.equal(store.getSubscriptionSummary(id).pending_queue_count, 0);
});

test('disable uses operator-supplied reason when provided', async () => {
  const store = makeStore();
  const id = seedSubscription(store);
  const out = await executeRefClientEventSubscriptionsDisable(
    { subscriptionId: id, reason: 'loop_suspected' },
    disableDeps(store),
  );
  assert.equal(out.disabledReason, 'loop_suspected');
});

test('disable is idempotent on already-disabled subscriptions', async () => {
  const store = makeStore();
  const id = seedSubscription(store, { status: 'disabled', disabled_reason: 'client_disabled', disabled_at: '2026-05-26T00:00:00.000Z' });
  const out = await executeRefClientEventSubscriptionsDisable({ subscriptionId: id, reason: 'should_be_ignored' }, disableDeps(store));
  assert.equal(out.wasAlreadyDisabled, true);
  assert.equal(out.disabledReason, 'client_disabled', 'reason must not be overwritten on already-disabled rows');
});

test('disable is idempotent on disabled_failure and disabled_revoked', async () => {
  const store = makeStore();
  const fid = seedSubscription(store, { subscription_id: 'sub_f', status: 'disabled_failure', disabled_reason: 'delivery_failed' });
  const rid = seedSubscription(store, { subscription_id: 'sub_r', status: 'disabled_revoked', disabled_reason: 'grant_revoked' });
  const out1 = await executeRefClientEventSubscriptionsDisable({ subscriptionId: fid }, disableDeps(store));
  const out2 = await executeRefClientEventSubscriptionsDisable({ subscriptionId: rid }, disableDeps(store));
  assert.equal(out1.wasAlreadyDisabled, true);
  assert.equal(out1.status, 'disabled_failure');
  assert.equal(out2.wasAlreadyDisabled, true);
  assert.equal(out2.status, 'disabled_revoked');
});

test('disable rejects deleted and missing subscriptions', async () => {
  const store = makeStore();
  seedSubscription(store, { subscription_id: 'sub_dead', status: 'deleted' });
  await assert.rejects(
    () => executeRefClientEventSubscriptionsDisable({ subscriptionId: 'sub_dead' }, disableDeps(store)),
    RefClientEventSubscriptionsDisableNotFoundError,
  );
  await assert.rejects(
    () => executeRefClientEventSubscriptionsDisable({ subscriptionId: 'sub_missing' }, disableDeps(store)),
    RefClientEventSubscriptionsDisableNotFoundError,
  );
});

test('disable rejects oversize reason', async () => {
  const store = makeStore();
  const id = seedSubscription(store);
  await assert.rejects(
    () =>
      executeRefClientEventSubscriptionsDisable(
        { subscriptionId: id, reason: 'x'.repeat(300) },
        disableDeps(store),
      ),
    RefClientEventSubscriptionsDisableInvalidRequestError,
  );
});

test('disable from pending_verification also transitions to disabled', async () => {
  const store = makeStore();
  const id = seedSubscription(store, { status: 'pending_verification' });
  const out = await executeRefClientEventSubscriptionsDisable({ subscriptionId: id }, disableDeps(store));
  assert.equal(out.status, 'disabled');
});
