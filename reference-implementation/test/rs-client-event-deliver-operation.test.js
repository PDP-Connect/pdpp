import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import test from 'node:test';

import {
  DELIVERY_CONTENT_TYPE,
  decodeWebhookSecret,
  executeDelivery,
  signEvent,
  verifySignatureHeader,
} from '../operations/rs-client-event-deliver/index.ts';
import { defaultHttpTransport } from '../server/client-event-delivery-worker.ts';

const NOW_MS = Date.parse('2026-05-27T00:00:00.000Z');
const SECRET = `whsec_${randomBytes(32).toString('base64')}`;

function fixedDeps(overrides = {}) {
  return {
    nowSeconds: () => Math.floor(NOW_MS / 1000),
    nowIso: () => new Date(NOW_MS).toISOString(),
    randomJitterFactor: () => 1,
    ...overrides,
  };
}

test('Standard Webhooks signing matches the canonical {id}.{ts}.{body} construction', () => {
  const body = '{"hello":"world"}';
  const timestamp = Math.floor(NOW_MS / 1000);
  const eventId = 'evt_round_trip';
  const signature = signEvent(SECRET, eventId, timestamp, body);
  assert.match(signature, /^v1,[A-Za-z0-9+/=]+$/);
  const expected = `v1,${createHmac('sha256', decodeWebhookSecret(SECRET))
    .update(`${eventId}.${timestamp}.${body}`)
    .digest('base64')}`;
  assert.equal(signature, expected);
  assert.equal(verifySignatureHeader(SECRET, eventId, timestamp, body, signature), true);
  // Rotation: header carrying multiple `v1,` tokens still verifies if any match.
  assert.equal(
    verifySignatureHeader(SECRET, eventId, timestamp, body, `v1,DEADBEEF ${signature}`),
    true,
  );
  // Tampered signature is rejected.
  assert.equal(verifySignatureHeader(SECRET, eventId, timestamp, body, 'v1,DEADBEEF'), false);
  // Mismatched id changes the signed string and must not verify.
  assert.equal(verifySignatureHeader(SECRET, 'evt_other', timestamp, body, signature), false);
});

test('delivery records.changed treats 2xx as delivered', async () => {
  const payloadJson = '{"id":"evt_x"}';
  const result = await executeDelivery(
    {
      queueId: 1,
      subscriptionId: 'sub_x',
      eventId: 'evt_x',
      eventType: 'pdpp.records.changed',
      payloadJson,
      attemptCount: 0,
      callbackUrl: 'https://callback.example/hook',
      secret: SECRET,
    },
    {
      ...fixedDeps(),
      request: async (req) => {
        assert.equal(req.headers['webhook-id'], 'evt_x');
        assert.equal(req.headers['webhook-timestamp'], String(Math.floor(NOW_MS / 1000)));
        assert.match(req.headers['webhook-signature'], /^v1,[A-Za-z0-9+/=]+$/);
        assert.equal(req.headers['PDPP-Event-Id'], undefined);
        assert.equal(req.headers['PDPP-Event-Signature'], undefined);
        // CloudEvents JSON structured mode requires the cloudevents+json media type.
        assert.equal(req.headers['content-type'], DELIVERY_CONTENT_TYPE);
        assert.equal(req.headers['content-type'], 'application/cloudevents+json; charset=utf-8');
        // The signed `{body}` SHALL be the exact raw bytes the receiver sees.
        assert.equal(req.body, payloadJson);
        assert.equal(
          verifySignatureHeader(
            SECRET,
            'evt_x',
            Math.floor(NOW_MS / 1000),
            req.body,
            req.headers['webhook-signature'],
          ),
          true,
          'Standard Webhooks signature verifies against the exact raw structured-mode body',
        );
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
