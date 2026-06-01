import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RsClient } from '../src/rs-client.js';

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('attaches bearer token and forwards query params', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(200, { ok: true });
  };

  const rs = new RsClient({
    providerUrl: 'https://provider.test',
    accessToken: 'scoped-abc',
    fetch,
  });

  await rs.getJson('/v1/streams/orders/records', {
    query: { limit: 50, fields: ['id', 'amount'], filter: 'amount>100' },
  });

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.host, 'provider.test');
  assert.equal(url.pathname, '/v1/streams/orders/records');
  assert.equal(url.searchParams.get('limit'), '50');
  assert.deepEqual(url.searchParams.getAll('fields'), ['id', 'amount']);
  assert.equal(url.searchParams.get('filter'), 'amount>100');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer scoped-abc');
});

test('rejects object-valued query params instead of JSON-stringifying them', async () => {
  let called = false;
  const fetch = async () => {
    called = true;
    return jsonResponse(200, { ok: true });
  };

  const rs = new RsClient({
    providerUrl: 'https://provider.test',
    accessToken: 'scoped-abc',
    fetch,
  });

  await assert.rejects(
    () => rs.getJson('/v1/streams/orders/records', {
      query: { filter: { amount: { gte: 100 } } },
    }),
    /encode nested query shapes explicitly/,
  );
  assert.equal(called, false);
});

test('preserves RS error envelope on 401', async () => {
  const fetch = async () =>
    new Response(
      JSON.stringify({ error: { type: 'authentication', code: 'invalid_token', message: 'bad' } }),
      { status: 401, headers: { 'content-type': 'application/json', 'x-request-id': 'req-1' } }
    );

  const rs = new RsClient({ providerUrl: 'https://x', accessToken: 't', fetch });
  const result = await rs.getJson('/v1/schema');

  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.error.code, 'invalid_token');
  assert.equal(result.error.request_id, 'req-1');
});

test('synthesizes envelope for plain-text errors', async () => {
  const fetch = async () =>
    new Response('insufficient_scope', {
      status: 403,
      headers: { 'content-type': 'text/plain' },
    });

  const rs = new RsClient({ providerUrl: 'https://x', accessToken: 't', fetch });
  const result = await rs.getJson('/v1/schema');

  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.error.type, 'rs_error');
  assert.equal(result.error.code, 'http_403');
  assert.match(result.error.message, /insufficient_scope/);
});

test('getRaw returns a Buffer for binary payloads', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const fetch = async () =>
    new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } });

  const rs = new RsClient({ providerUrl: 'https://x', accessToken: 't', fetch });
  const result = await rs.getRaw('/v1/blobs/abc');

  assert.equal(result.ok, true);
  assert.ok(Buffer.isBuffer(result.body));
  assert.equal(result.body.length, 4);
  assert.deepEqual([...result.body], [1, 2, 3, 4]);
});
