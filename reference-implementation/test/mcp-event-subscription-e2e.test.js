/**
 * Regression guard for the normal hosted MCP surface.
 *
 * Event-subscription management remains a reference-implementation capability,
 * but it is no longer exposed through the recommended `/mcp` agent entrypoint.
 */

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { canonicalConnectorKeyFromManifest } from '../server/connector-key.js';
import { startServer } from '../server/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');

async function closeServer(server) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
}

function startTestServer() {
  return startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    ownerAuthPassword: '',
  });
}

async function fetchJson(url, opts = {}) {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  const body = text ? JSON.parse(text) : null;
  return { resp, status: resp.status, body };
}

function pkceChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function registerSpotify(asUrl) {
  const raw = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'));
  const canonical = canonicalConnectorKeyFromManifest(raw);
  const manifest = canonical && canonical !== raw.connector_id ? { ...raw, connector_id: canonical } : raw;
  const { status } = await fetchJson(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  assert.equal(status, 201);
  return manifest;
}

async function registerAuthCodeClient(asUrl) {
  const { status, body } = await fetchJson(`${asUrl}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Hosted MCP surface test client',
      redirect_uris: ['https://client.example/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      application_type: 'web',
      token_endpoint_auth_method: 'none',
    }),
  });
  assert.equal(status, 201);
  return body;
}

async function completeOauthCodeFlow({ asUrl, client, manifest }) {
  const verifier = randomBytes(32).toString('base64url');
  const authorizationDetails = [
    {
      type: 'https://pdpp.org/data-access',
      source: { kind: 'connector', id: manifest.connector_id },
      purpose_code: 'https://pdpp.org/purpose/personal_ai_assistant',
      purpose_description: 'Use PDPP data through hosted MCP.',
      access_mode: 'continuous',
      streams: [{ name: '*' }],
    },
  ];
  const authorizeUrl = new URL(`${asUrl}/oauth/authorize`);
  authorizeUrl.searchParams.set('client_id', client.client_id);
  authorizeUrl.searchParams.set('redirect_uri', 'https://client.example/callback');
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('state', 'state-123');
  authorizeUrl.searchParams.set('code_challenge', pkceChallenge(verifier));
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('authorization_details', JSON.stringify(authorizationDetails));

  const authorizeResp = await fetch(authorizeUrl, { redirect: 'manual' });
  assert.equal(authorizeResp.status, 302);
  const consentUrl = new URL(authorizeResp.headers.get('location'), asUrl);
  const requestUri = consentUrl.searchParams.get('request_uri');
  assert.ok(requestUri);

  const approveResp = await fetch(`${asUrl}/consent/approve`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request_uri: requestUri, subject_id: 'owner_local' }).toString(),
  });
  assert.equal(approveResp.status, 302);
  const callback = new URL(approveResp.headers.get('location'));
  const code = callback.searchParams.get('code');
  assert.ok(code);

  const { status, body } = await fetchJson(`${asUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: client.client_id,
      redirect_uri: 'https://client.example/callback',
      code_verifier: verifier,
    }).toString(),
  });
  assert.equal(status, 200);
  return body.access_token;
}

async function postMcpJson(rsUrl, token, message) {
  const { status, body } = await fetchJson(`${rsUrl}/mcp`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(message),
  });
  return { status, body };
}

test('hosted MCP does not expose event-subscription management tools', async () => {
  const server = await startTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const manifest = await registerSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const accessToken = await completeOauthCodeFlow({ asUrl, client, manifest });

    const tools = await postMcpJson(rsUrl, accessToken, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });
    assert.equal(tools.status, 200);
    const toolNames = tools.body.result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(toolNames, ['aggregate', 'fetch', 'query_records', 'read_record_field', 'schema', 'search']);
    assert.equal(toolNames.some((name) => name.includes('event_subscription')), false);
    assert.equal(toolNames.includes('send_test_event'), false);

    const removedTool = await postMcpJson(rsUrl, accessToken, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'create_event_subscription', arguments: { callback_url: 'http://localhost:9999/hook' } },
    });
    assert.equal(removedTool.status, 200);
    assert.match(JSON.stringify(removedTool.body), /Tool not found|not found|unknown/i);
  } finally {
    await closeServer(server);
  }
});
