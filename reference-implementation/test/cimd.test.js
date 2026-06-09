import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CIMD_MAX_BODY_BYTES,
  fetchCimdDocument,
  isCimdClientId,
  isForbiddenIp,
  validateCimdRedirectUris,
  validateCimdUrl,
} from '../server/cimd.js';

function publicDns() {
  return [{ address: '93.184.216.34', family: 4 }];
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    ...init,
  });
}

test('CIMD URL classification and prefetch validation reject unsafe client_ids', () => {
  assert.equal(isCimdClientId('https://client.example/.well-known/oauth-client'), true);
  assert.equal(isCimdClientId('http://client.example/metadata'), false);
  assert.equal(isCimdClientId('pdpp-cli'), false);

  assert.throws(() => validateCimdUrl('http://client.example/metadata'), /https scheme/);
  assert.throws(() => validateCimdUrl('https://user:pass@client.example/metadata'), /userinfo/);
  assert.throws(() => validateCimdUrl('https://client.example'), /non-empty path/);
  assert.throws(() => validateCimdUrl('https://client.example/a/../b'), /dot-segments/);
  assert.throws(() => validateCimdUrl('https://client.example/metadata#frag'), /fragment/);
});

test('CIMD IP guard blocks loopback private and link-local ranges', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.1.2', '192.168.1.3', '169.254.1.1', '::1', 'fe80::1', 'fd00::1']) {
    assert.equal(isForbiddenIp(ip), true, `${ip} should be forbidden`);
  }
  assert.equal(isForbiddenIp('93.184.216.34'), false);
  assert.equal(isForbiddenIp('2606:2800:220:1:248:1893:25c8:1946'), false);
});

test('CIMD redirect_uris must be same-origin except listed localhost development redirects', () => {
  const clientId = 'https://client.example/oauth/client.json';
  validateCimdRedirectUris(
    {
      redirect_uris: [
        'https://client.example/callback',
        'http://localhost:1455/callback',
        'http://127.0.0.1:1455/callback',
        'http://[::1]:1455/callback',
      ],
    },
    clientId,
  );
  assert.throws(
    () => validateCimdRedirectUris({ redirect_uris: ['https://evil.example/callback'] }, clientId),
    /does not share origin/,
  );
});

test('fetchCimdDocument enforces the CIMD-01 5 KB response cap before parsing', async () => {
  assert.equal(CIMD_MAX_BODY_BYTES, 5 * 1024);
  const clientId = 'https://client.example/oauth/client.json';
  await assert.rejects(
    () =>
      fetchCimdDocument(clientId, {
        dnsLookupImpl: publicDns,
        fetchImpl: async () =>
          new Response(' '.repeat(CIMD_MAX_BODY_BYTES + 1), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      }),
    /exceeds 5 KB size limit/,
  );
});

test('fetchCimdDocument validates and caches a public-client metadata document', async () => {
  const clientId = 'https://client.example/oauth/client-valid.json';
  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount += 1;
    return jsonResponse(
      {
        client_id: clientId,
        client_name: 'Claude Code',
        redirect_uris: ['https://client.example/callback', 'http://localhost:1455/callback'],
        token_endpoint_auth_method: 'none',
      },
      { headers: { 'Cache-Control': 'max-age=3600' } },
    );
  };

  const first = await fetchCimdDocument(clientId, { dnsLookupImpl: publicDns, fetchImpl });
  const second = await fetchCimdDocument(clientId, { dnsLookupImpl: publicDns, fetchImpl });

  assert.equal(fetchCount, 1);
  assert.equal(first.fromCache, false);
  assert.equal(second.fromCache, true);
  assert.equal(first.doc.client_name, 'Claude Code');
  assert.equal(first.securityHash, second.securityHash);
});

test('fetchCimdDocument blocks forbidden DNS resolutions before issuing HTTP', async () => {
  let called = false;
  await assert.rejects(
    () =>
      fetchCimdDocument('https://private.example/oauth/client.json', {
        dnsLookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
        fetchImpl: async () => {
          called = true;
          return jsonResponse({});
        },
      }),
    /resolves to private\/loopback/,
  );
  assert.equal(called, false);
});

test('fetchCimdDocument aborts slow metadata fetches', async () => {
  const clientId = 'https://client.example/oauth/client-timeout.json';
  await assert.rejects(
    () =>
      fetchCimdDocument(clientId, {
        dnsLookupImpl: publicDns,
        timeoutMs: 1,
        fetchImpl: async (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('aborted by test timeout')));
          }),
      }),
    /CIMD fetch failed.*aborted by test timeout/,
  );
});

test('fetchCimdDocument rejects redirects, malformed JSON, client_id mismatch, and unsupported auth', async () => {
  await assert.rejects(
    () =>
      fetchCimdDocument('https://client.example/oauth/client-redirect.json', {
        dnsLookupImpl: publicDns,
        fetchImpl: async () => new Response('', { status: 303, headers: { Location: 'https://client.example/next' } }),
      }),
    /rejected redirect/,
  );

  await assert.rejects(
    () =>
      fetchCimdDocument('https://client.example/oauth/client-malformed.json', {
        dnsLookupImpl: publicDns,
        fetchImpl: async () => new Response('{not json', { status: 200 }),
      }),
    /not valid JSON/,
  );

  await assert.rejects(
    () =>
      fetchCimdDocument('https://client.example/oauth/client-mismatch.json', {
        dnsLookupImpl: publicDns,
        fetchImpl: async () =>
          jsonResponse({
            client_id: 'https://client.example/oauth/other.json',
            redirect_uris: ['https://client.example/callback'],
            token_endpoint_auth_method: 'none',
          }),
      }),
    /client_id mismatch/,
  );

  await assert.rejects(
    () =>
      fetchCimdDocument('https://client.example/oauth/client-secret.json', {
        dnsLookupImpl: publicDns,
        fetchImpl: async () =>
          jsonResponse({
            client_id: 'https://client.example/oauth/client-secret.json',
            redirect_uris: ['https://client.example/callback'],
            token_endpoint_auth_method: 'client_secret_basic',
          }),
      }),
    /unsupported token_endpoint_auth_method/,
  );
});

test('fetchCimdDocument reports security-relevant metadata changes after cache expiry', async () => {
  const clientId = 'https://client.example/oauth/client-security-change.json';
  let body = {
    client_id: clientId,
    client_name: 'Codex',
    redirect_uris: ['https://client.example/callback'],
    token_endpoint_auth_method: 'none',
  };
  const changes = [];
  const fetchImpl = async () => jsonResponse(body, { headers: { 'Cache-Control': 'max-age=0' } });

  const first = await fetchCimdDocument(clientId, { dnsLookupImpl: publicDns, fetchImpl, nowMs: 0 });
  assert.equal(first.securityRelevantMetadataChanged, false);

  body = {
    ...body,
    redirect_uris: ['https://client.example/callback-v2'],
  };
  const second = await fetchCimdDocument(clientId, {
    dnsLookupImpl: publicDns,
    fetchImpl,
    nowMs: 60_001,
    onSecurityRelevantMetadataChange: (event) => {
      changes.push(event);
    },
  });

  assert.equal(second.securityRelevantMetadataChanged, true);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].clientId, clientId);
  assert.deepEqual(changes[0].previousDoc.redirect_uris, ['https://client.example/callback']);
  assert.deepEqual(changes[0].nextDoc.redirect_uris, ['https://client.example/callback-v2']);
});
