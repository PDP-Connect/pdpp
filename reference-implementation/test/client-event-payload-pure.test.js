// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit test for buildEventPayload in
// operations/as-client-event-subscriptions/index.ts. No test imports it by name.
// This builds the CloudEvents 1.0 envelope delivered to a client's webhook for a
// subscribed event — an external wire contract, so a regression breaks every
// subscriber's parsing.
//
// Mutation surface:
//   - specversion = CloudEvents "1.0", pdppversion = the profile version.
//   - id from the event id; type/time from the derived event.
//   - source = `${SUBSCRIPTION_RESOURCE_PATH}/${subscriptionId}`.
//   - data merges { subscription_id } with the event's own data payload.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLOUDEVENTS_SPECVERSION,
  PDPP_EVENTS_PROFILE_VERSION,
  SUBSCRIPTION_RESOURCE_PATH,
  buildEventPayload,
} from '../operations/as-client-event-subscriptions/index.ts';

const derivedEvent = {
  type: 'record.created',
  subscriptionId: 'sub_abc',
  occurredAt: '2024-01-02T03:04:05Z',
  data: { record_id: 'r1', stream: 'orders' },
};

test('buildEventPayload: emits a CloudEvents 1.0 envelope with the PDPP profile version', () => {
  const payload = JSON.parse(buildEventPayload('evt_123', derivedEvent));
  assert.equal(payload.specversion, CLOUDEVENTS_SPECVERSION, 'CloudEvents specversion');
  assert.equal(payload.specversion, '1.0');
  assert.equal(payload.pdppversion, PDPP_EVENTS_PROFILE_VERSION);
});

test('buildEventPayload: id/type/time come from the event id and the derived event', () => {
  const payload = JSON.parse(buildEventPayload('evt_123', derivedEvent));
  assert.equal(payload.id, 'evt_123', 'envelope id is the event id');
  assert.equal(payload.type, 'record.created');
  assert.equal(payload.time, '2024-01-02T03:04:05Z', 'time is the event occurredAt');
});

test('buildEventPayload: source is the subscription resource path + subscription id', () => {
  const payload = JSON.parse(buildEventPayload('evt_123', derivedEvent));
  assert.equal(payload.source, `${SUBSCRIPTION_RESOURCE_PATH}/sub_abc`);
  assert.equal(payload.source, '/v1/event-subscriptions/sub_abc');
});

test('buildEventPayload: data merges subscription_id with the event data', () => {
  const payload = JSON.parse(buildEventPayload('evt_123', derivedEvent));
  assert.equal(payload.data.subscription_id, 'sub_abc', 'subscription_id injected into data');
  assert.equal(payload.data.record_id, 'r1', 'event data preserved');
  assert.equal(payload.data.stream, 'orders');
});

test('buildEventPayload: distinct subscriptions produce distinct sources (id is load-bearing)', () => {
  const a = JSON.parse(buildEventPayload('e', { ...derivedEvent, subscriptionId: 'sub_a' }));
  const b = JSON.parse(buildEventPayload('e', { ...derivedEvent, subscriptionId: 'sub_b' }));
  assert.notEqual(a.source, b.source, 'source tracks the subscription id');
  assert.notEqual(a.data.subscription_id, b.data.subscription_id);
});

test('buildEventPayload: returns a JSON STRING (not an object)', () => {
  assert.equal(typeof buildEventPayload('e', derivedEvent), 'string', 'payload is serialized for the store/wire');
});
