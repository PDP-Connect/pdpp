import assert from 'node:assert/strict';
import test from 'node:test';

import { readIngestResponse } from '../runtime/ingest-failure.ts';

function deps(buildHttpFailure = () => new Error('unexpected HTTP failure')) {
  return { buildHttpFailure };
}

test('readIngestResponse returns accepted and rejected counts from an ok JSON response', async () => {
  const resp = new Response(JSON.stringify({ records_accepted: 3, records_rejected: 1 }), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  });

  const result = await readIngestResponse(resp, 'orders', 4, deps());

  assert.deepEqual(result, { records_accepted: 3, records_rejected: 1 });
});

test('readIngestResponse annotates non-ok responses with HTTP ingest failure details', async () => {
  const bodyText = 'upstream rejected snowman \u2603';
  const calls = [];
  const httpFailure = new Error('ingest HTTP failure');
  const buildHttpFailure = (message, status, body) => {
    calls.push({ message, status, body });
    return httpFailure;
  };
  const resp = new Response(bodyText, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    status: 503,
  });

  await assert.rejects(readIngestResponse(resp, 'orders', 7, deps(buildHttpFailure)), (err) => {
    assert.equal(err, httpFailure);
    assert.equal(err.failure_reason, 'ingest_http_error');
    assert.deepEqual(err.ingest_failure, {
      stream: 'orders',
      batch_size: 7,
      http_status: 503,
      phase: 'http_response',
      response_content_type: 'text/plain; charset=utf-8',
      response_body_bytes: Buffer.byteLength(bodyText, 'utf8'),
    });
    return true;
  });
  assert.deepEqual(calls, [{ message: 'Ingest failed for orders', status: 503, body: bodyText }]);
});

test('readIngestResponse reports invalid JSON as a parse_response failure', async () => {
  const resp = new Response('{not json', {
    headers: { 'content-type': 'application/json' },
    status: 200,
  });

  await assert.rejects(readIngestResponse(resp, 'orders', 2, deps()), (err) => {
    assert.equal(err.failure_reason, 'ingest_response_invalid');
    assert.equal(err.ingest_failure.phase, 'parse_response');
    return true;
  });
});

test('readIngestResponse reports missing numeric counts as a validate_response failure', async () => {
  const resp = new Response(JSON.stringify({ records_accepted: '3', records_rejected: 0 }), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  });

  await assert.rejects(readIngestResponse(resp, 'orders', 2, deps()), (err) => {
    assert.equal(err.failure_reason, 'ingest_response_invalid');
    assert.equal(err.ingest_failure.phase, 'validate_response');
    return true;
  });
});
