import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import {
  executeDelivery,
  signEvent,
  verifySignatureHeader,
} from '../operations/rs-client-event-deliver/index.ts';
import { defaultHttpTransport } from '../server/client-event-delivery-worker.ts';

const NOW_MS = Date.parse('2026-05-27T00:00:00.000Z');
const SECRET = 'pess_test_secret_value';

function fixedDeps(overrides = {}) {
  return {
    nowSeconds: () => Math.floor(NOW_MS / 1000),
    nowIso: () => new Date(NOW_MS).toISOString(),
    randomJitterFactor: () => 1,
    ...overrides,
  };
}

test('signEvent / verifySignatureHeader round-trip', () => {
  const body = '{"hello":"world"}';
  const timestamp = Math.floor(NOW_MS / 1000);
  const signature = signEvent(SECRET, timestamp, body);
  assert.ok(signature.startsWith('sha256='));
  // explicit recompute matches
  const expected = `sha256=${createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex')}`;
  assert.equal(signature, expected);
  assert.equal(verifySignatureHeader(SECRET, timestamp, body, signature), true);
  assert.equal(verifySignatureHeader(SECRET, timestamp, body, 'sha256=deadbeef'), false);
});

test('delivery records.changed treats 2xx as delivered', async () => {
  const result = await executeDelivery(
    {
      queueId: 1,
      subscriptionId: 'sub_x',
      eventId: 'evt_x',
      eventType: 'pdpp.records.changed',
      payloadJson: '{"id":"evt_x"}',
      attemptCount: 0,
      callbackUrl: 'https://callback.example/hook',
      secret: SECRET,
    },
    {
      ...fixedDeps(),
      request: async (req) => {
        assert.equal(req.headers['PDPP-Event-Id'], 'evt_x');
        assert.equal(req.headers['PDPP-Subscription-Id'], 'sub_x');
        assert.ok(req.headers['PDPP-Event-Signature'].startsWith('sha256='));
        return { statusCode: 200, bodyText: 'ok', errorMessage: null, latencyMs: 12 };
      },
    },
  );
  assert.equal(result.kind, 'delivered');
});

test('delivery verify event matches challenge → verified', async () => {
  const result = await executeDelivery(
    {
      queueId: 1,
      subscriptionId: 'sub_x',
      eventId: 'evt_v',
      eventType: 'pdpp.subscription.verify',
      payloadJson: '{"id":"evt_v","data":{"challenge":"abc"}}',
      attemptCount: 0,
      callbackUrl: 'https://callback.example/hook',
      secret: SECRET,
      verificationChallenge: 'abc',
    },
    {
      ...fixedDeps(),
      request: async () => ({ statusCode: 200, bodyText: '{"challenge":"abc"}', errorMessage: null, latencyMs: 5 }),
    },
  );
  assert.equal(result.kind, 'verified');
});

test('delivery verify event wrong challenge → retry', async () => {
  const result = await executeDelivery(
    {
      queueId: 1,
      subscriptionId: 'sub_x',
      eventId: 'evt_v',
      eventType: 'pdpp.subscription.verify',
      payloadJson: '{}',
      attemptCount: 0,
      callbackUrl: 'https://callback.example/hook',
      secret: SECRET,
      verificationChallenge: 'abc',
    },
    {
      ...fixedDeps(),
      request: async () => ({ statusCode: 200, bodyText: '{"challenge":"WRONG"}', errorMessage: null, latencyMs: 5 }),
    },
  );
  assert.equal(result.kind, 'retry');
});

test('delivery non-2xx → retry until attempts exhausted, then final_failure', async () => {
  let kind;
  let attempts = 0;
  for (let i = 0; i < 7; i++) {
    const result = await executeDelivery(
      {
        queueId: 1,
        subscriptionId: 'sub_x',
        eventId: 'evt_x',
        eventType: 'pdpp.records.changed',
        payloadJson: '{}',
        attemptCount: i,
        callbackUrl: 'https://callback.example/hook',
        secret: SECRET,
      },
      {
        ...fixedDeps(),
        request: async () => ({ statusCode: 500, bodyText: 'oops', errorMessage: null, latencyMs: 5 }),
      },
    );
    kind = result.kind;
    attempts = i + 1;
    if (kind === 'final_failure') break;
  }
  assert.equal(kind, 'final_failure');
  assert.ok(attempts >= 6);
});

test('delivery network error → retry with error captured', async () => {
  const result = await executeDelivery(
    {
      queueId: 1,
      subscriptionId: 'sub_x',
      eventId: 'evt_x',
      eventType: 'pdpp.records.changed',
      payloadJson: '{}',
      attemptCount: 0,
      callbackUrl: 'https://callback.example/hook',
      secret: SECRET,
    },
    {
      ...fixedDeps(),
      request: async () => ({ statusCode: null, bodyText: null, errorMessage: 'ECONNREFUSED', latencyMs: 5 }),
    },
  );
  assert.equal(result.kind, 'retry');
  assert.equal(result.error, 'ECONNREFUSED');
});

test('default transport attaches a bounded response-window abort signal', async () => {
  const originalFetch = globalThis.fetch;
  let sawSignal = false;
  try {
    globalThis.fetch = async (_url, init = {}) => {
      sawSignal = init.signal instanceof AbortSignal && !init.signal.aborted;
      throw new Error('test transport stop');
    };
    const result = await defaultHttpTransport({
      url: 'https://callback.example/hook',
      method: 'POST',
      headers: {},
      body: '{}',
    });
    assert.equal(result.statusCode, null);
    assert.equal(result.errorMessage, 'test transport stop');
    assert.equal(sawSignal, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
