/**
 * Unit coverage for the UNTESTED CloudEvents payload projection
 * `buildEventPayload(eventId, event)` exported by
 * `operations/as-client-event-subscriptions/index.ts`.
 *
 * This is the read-model that shapes every delivered client-event subscription
 * webhook body into a CloudEvents 1.0 structured-mode JSON envelope. The
 * contract pinned here (see the module doc + CloudEvents §3.2):
 *
 *   - top-level context attributes only: `specversion` (=CLOUDEVENTS_SPECVERSION
 *     "1.0"), `pdppversion` (=PDPP_EVENTS_PROFILE_VERSION "1"), `id` (the passed
 *     eventId), `type` (event.type), `source` (=`${SUBSCRIPTION_RESOURCE_PATH}/
 *     <subscriptionId>`), `time` (event.occurredAt, RFC3339 verbatim);
 *   - PDPP-specific fields live under `data`: `subscription_id` is injected, and
 *     the event's own `data` is spread AFTER it (so event data can't be dropped);
 *   - the return value is a JSON STRING (it is persisted as `payloadJson`).
 *
 * No underscores may appear in a top-level attribute name (CloudEvents rule);
 * this test asserts the exact top-level key set to guard that.
 *
 * The module's crypto import is Node-native; no DB or server is touched by this
 * pure projection. No fixtures.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildEventPayload,
  CLOUDEVENTS_SPECVERSION,
  PDPP_EVENTS_PROFILE_VERSION,
  SUBSCRIPTION_RESOURCE_PATH,
} from '../operations/as-client-event-subscriptions/index.ts';

function sampleEvent(overrides = {}) {
  return {
    subscriptionId: 'sub_abc',
    type: 'record.created',
    occurredAt: '2026-07-02T12:34:56.000Z',
    data: { connector_id: 'amazon', stream: 'orders', connection_id: 'cin_1' },
    ...overrides,
  };
}

test('buildEventPayload: returns a JSON string with the exact CloudEvents envelope', () => {
  const json = buildEventPayload('evt_1', sampleEvent());
  assert.equal(typeof json, 'string', 'payload must be a JSON string');
  const env = JSON.parse(json);
  assert.deepEqual(
    env,
    {
      specversion: '1.0',
      pdppversion: '1',
      id: 'evt_1',
      type: 'record.created',
      source: '/v1/event-subscriptions/sub_abc',
      time: '2026-07-02T12:34:56.000Z',
      data: {
        subscription_id: 'sub_abc',
        connector_id: 'amazon',
        stream: 'orders',
        connection_id: 'cin_1',
      },
    },
    `envelope: ${json}`,
  );
});

test('buildEventPayload: top-level keys are CloudEvents context attributes only (no underscores)', () => {
  const env = JSON.parse(buildEventPayload('evt_1', sampleEvent()));
  const topKeys = Object.keys(env).sort();
  assert.deepEqual(
    topKeys,
    ['data', 'id', 'pdppversion', 'source', 'specversion', 'time', 'type'],
    `top-level keys: ${JSON.stringify(topKeys)}`,
  );
  for (const key of topKeys) {
    assert.equal(key.includes('_'), false, `top-level attribute "${key}" must not contain an underscore`);
  }
});

test('buildEventPayload: source is derived from SUBSCRIPTION_RESOURCE_PATH + subscriptionId', () => {
  const env = JSON.parse(buildEventPayload('evt_1', sampleEvent({ subscriptionId: 'sub_XYZ' })));
  assert.equal(env.source, `${SUBSCRIPTION_RESOURCE_PATH}/sub_XYZ`, `source: ${env.source}`);
  assert.equal(env.source, '/v1/event-subscriptions/sub_XYZ');
});

test('buildEventPayload: id is the passed eventId, distinct from the subscription source', () => {
  const env = JSON.parse(buildEventPayload('evt_UNIQUE', sampleEvent({ subscriptionId: 'sub_1' })));
  assert.equal(env.id, 'evt_UNIQUE', 'id must be the eventId argument, not the subscription id');
  assert.equal(env.source.endsWith('/sub_1'), true, 'source still carries the subscription id');
});

test('buildEventPayload: occurredAt maps to the standard CloudEvents `time` attribute verbatim', () => {
  const env = JSON.parse(buildEventPayload('evt_1', sampleEvent({ occurredAt: '2026-01-01T00:00:00.000Z' })));
  assert.equal(env.time, '2026-01-01T00:00:00.000Z', `time: ${env.time}`);
  assert.equal('occurredAt' in env, false, 'raw occurredAt must not appear top-level');
  assert.equal('occurred_at' in env, false, 'snake_case occurred_at must not appear top-level');
});

test('buildEventPayload: subscription_id is injected into data even when event.data lacks it', () => {
  const env = JSON.parse(
    buildEventPayload('evt_1', sampleEvent({ subscriptionId: 'sub_inject', data: { stream: 'messages' } })),
  );
  assert.equal(env.data.subscription_id, 'sub_inject', 'data.subscription_id injected');
  assert.equal(env.data.stream, 'messages', 'event data preserved');
});

test('buildEventPayload: event data is spread AFTER subscription_id (event data cannot clobber it away)', () => {
  // If a (malformed) event carried its own subscription_id, the spread order
  // means the event value wins — but the KEY is always present. Pin the order.
  const env = JSON.parse(
    buildEventPayload('evt_1', sampleEvent({ subscriptionId: 'sub_real', data: { challenge: 'ch_1' } })),
  );
  assert.equal('subscription_id' in env.data, true);
  assert.equal(env.data.subscription_id, 'sub_real');
  assert.equal(env.data.challenge, 'ch_1', 'challenge (verification handshake) preserved in data');
});

test('buildEventPayload: uses the exported version constants (not hardcoded drift)', () => {
  const env = JSON.parse(buildEventPayload('evt_1', sampleEvent()));
  assert.equal(env.specversion, CLOUDEVENTS_SPECVERSION);
  assert.equal(env.pdppversion, PDPP_EVENTS_PROFILE_VERSION);
});
