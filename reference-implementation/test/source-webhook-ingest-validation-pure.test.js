// Pure, no-DB unit tests for the source-webhook ingestion validation in
// operations/ref-source-webhook-ingest/index.ts. No test imports it by name. This
// is a security-critical ingress: it enforces required headers, an HMAC signature,
// a timestamp replay window, idempotency, and payload validation before ingesting.
// The store/secret/clock dependencies are stubbed; the signature is computed with
// the real scheme so the happy path is exercised end-to-end.
//
// RED note: this is a credential-verifying ingress. Tests OBSERVE the accept/reject
// decisions with a stub secret; no real webhook credential is used.
//
// Mutation surface:
//   - missing source/event-id/timestamp/signature -> typed errors.
//   - unknown source (no secret) -> 404/unknown_source.
//   - a timestamp outside +/-5min -> 401/stale_timestamp (replay protection).
//   - a bad signature -> 401/invalid_signature.
//   - duplicate (claimEvent false) -> { accepted:true, duplicate:true }.
//   - ingest_records requires a stream + records array.
//   - an unsupported action -> invalid_payload.

import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';

import { executeSourceWebhook } from '../operations/ref-source-webhook-ingest/index.ts';

const SECRET = 'test-webhook-secret';
const NOW = 1_700_000_000_000; // fixed clock

function sign(timestamp, body) {
  return `sha256=${createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex')}`;
}

function makeDeps(overrides = {}) {
  return {
    resolveSecret: () => SECRET,
    resolveConnectorId: () => null,
    nowMs: () => NOW,
    claimEvent: async () => true,
    ingestRecords: async () => ({ count: 1 }),
    ...overrides,
  };
}

function freshInput(body, overrides = {}) {
  const timestamp = String(NOW / 1000);
  return {
    sourceId: 'my-source',
    eventId: 'evt-1',
    timestamp,
    signature: sign(timestamp, body),
    body,
    ...overrides,
  };
}

function expectCode(promise, code, status) {
  return assert.rejects(promise, (err) => {
    assert.equal(err.code, code, `expected ${code}, got ${err.code}`);
    if (status !== undefined) assert.equal(err.status, status);
    return true;
  });
}

test('source-webhook: missing required headers throw typed errors', async () => {
  await expectCode(executeSourceWebhook(freshInput('{}', { sourceId: '' }), makeDeps()), 'invalid_source');
  await expectCode(executeSourceWebhook(freshInput('{}', { eventId: '' }), makeDeps()), 'missing_event_id');
  await expectCode(executeSourceWebhook(freshInput('{}', { timestamp: '' }), makeDeps()), 'missing_timestamp');
  await expectCode(executeSourceWebhook(freshInput('{}', { signature: '' }), makeDeps()), 'missing_signature');
});

test('source-webhook: an unknown source (no configured secret) is a 404 unknown_source', async () => {
  await expectCode(
    executeSourceWebhook(freshInput('{}'), makeDeps({ resolveSecret: () => null })),
    'unknown_source',
    404,
  );
});

test('source-webhook: a timestamp outside the +/-5min window is a 401 stale_timestamp (replay protection)', async () => {
  const staleTs = String(NOW / 1000 - 10 * 60); // 10 minutes ago
  await expectCode(
    executeSourceWebhook({ ...freshInput('{}'), timestamp: staleTs, signature: sign(staleTs, '{}') }, makeDeps()),
    'stale_timestamp',
    401,
  );
});

test('source-webhook: a timestamp just inside the window is accepted', async () => {
  const nearTs = String(NOW / 1000 - 4 * 60); // 4 minutes ago, within 5min tolerance
  const body = JSON.stringify({ action: 'ingest_records', stream: 's', records: [{ id: 1 }] });
  const out = await executeSourceWebhook(
    { ...freshInput(body), timestamp: nearTs, signature: sign(nearTs, body) },
    makeDeps(),
  );
  assert.equal(out.accepted, true);
});

test('source-webhook: an invalid signature is a 401 invalid_signature', async () => {
  await expectCode(
    executeSourceWebhook({ ...freshInput('{}'), signature: 'sha256=deadbeef' }, makeDeps()),
    'invalid_signature',
    401,
  );
});

test('source-webhook: a duplicate event (claimEvent false) is accepted as a duplicate', async () => {
  const body = JSON.stringify({ action: 'ingest_records', stream: 's', records: [] });
  const out = await executeSourceWebhook(freshInput(body), makeDeps({ claimEvent: async () => false }));
  assert.deepEqual(out, { accepted: true, duplicate: true, source_id: 'my-source', event_id: 'evt-1' });
});

test('source-webhook: ingest_records requires a stream and a records array', async () => {
  const noStream = JSON.stringify({ action: 'ingest_records', records: [] });
  await expectCode(executeSourceWebhook(freshInput(noStream), makeDeps()), 'invalid_payload');

  const noArray = JSON.stringify({ action: 'ingest_records', stream: 's', records: 'not-an-array' });
  await expectCode(executeSourceWebhook(freshInput(noArray), makeDeps()), 'invalid_payload');
});

test('source-webhook: a valid ingest_records call ingests and reports the ingest result', async () => {
  const body = JSON.stringify({ action: 'ingest_records', stream: 'receipts', records: [{ id: 1 }, { id: 2 }] });
  let ingestArgs = null;
  const out = await executeSourceWebhook(
    freshInput(body),
    makeDeps({ ingestRecords: async (a) => { ingestArgs = a; return { count: 2 }; } }),
  );
  assert.equal(out.action, 'ingest_records');
  assert.equal(out.duplicate, false);
  assert.deepEqual(out.ingest, { count: 2 });
  assert.equal(ingestArgs.streamName, 'receipts');
  assert.equal(ingestArgs.body, '{"id":1}\n{"id":2}', 'records are newline-joined JSON');
});

test('source-webhook: an unsupported action is invalid_payload', async () => {
  const body = JSON.stringify({ action: 'do_something_weird' });
  await expectCode(executeSourceWebhook(freshInput(body), makeDeps()), 'invalid_payload');
});
