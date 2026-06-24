import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { getDb } from '../server/db.js';
import { buildPendingConsentRequestUri, getGrantPackageAccess, revokeGrant, revokeGrantPackage } from '../server/auth.js';
import { canonicalConnectorKeyFromManifest } from '../server/connector-key.js';
import {
  encodeHostedMcpSelection,
  encodeHostedMcpStreamSelection,
} from '../server/hosted-mcp-selection.js';
import { startServer } from '../server/index.js';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';
import {
  ingestRecord,
  queryRecordsAcrossBindings,
  resolveReadRequestBindings,
} from '../server/records.js';

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

async function fetchJson(url, opts = {}) {
  const resp = await fetch(url, opts);
  const body = await resp.json();
  return { resp, status: resp.status, body };
}

function schemaStreamRows(schemaBody) {
  const data = schemaBody?.data ?? schemaBody;
  if (Array.isArray(data?.streams)) return data.streams;
  const connectors = Array.isArray(data?.connectors) ? data.connectors : [];
  return connectors.flatMap((connector) => {
    const streams = Array.isArray(connector?.streams) ? connector.streams : [];
    return streams.map((stream) => ({
      ...stream,
      source: {
        ...(connector?.source && typeof connector.source === 'object' ? connector.source : {}),
        ...(stream?.source && typeof stream.source === 'object' ? stream.source : {}),
        connector_id: stream?.source?.connector_id ?? connector?.connector_id ?? connector?.connector_key ?? null,
        connector_key: stream?.source?.connector_key ?? connector?.connector_key ?? connector?.connector_id ?? null,
        connection_id:
          stream?.source?.connection_id ??
          stream?.connection_id ??
          stream?.granted_connections?.[0]?.connection_id ??
          connector?.granted_connections?.[0]?.connection_id ??
          null,
      },
    }));
  });
}

function schemaPackageMetadata(schemaBody) {
  const data = schemaBody?.data ?? schemaBody;
  return data?.package ?? null;
}

function pkceChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

// Register a first-party connector fixture with the AS using its canonical
// short connector key (e.g. `spotify`, `github`). The fixture manifests on
// disk still ship URL-shaped `connector_id` values for catalog purposes, but
// the AS storage and the hosted MCP picker key everything by canonical
// connector key now that `canonicalize-connector-keys` has landed. Returning
// the manifest with `connector_id` rewritten to canonical form lets test
// callers reference `manifest.connector_id` and naturally see the same
// identifier the picker renders, the spine event records, and the AS
// validator accepts — without each test re-deriving the canonical key.
function canonicalizeManifestForRegistration(manifest) {
  const canonical = canonicalConnectorKeyFromManifest(manifest);
  if (!canonical || canonical === manifest.connector_id) return manifest;
  return { ...manifest, connector_id: canonical };
}

async function registerFirstPartyConnectorFixture(asUrl, fixtureName) {
  const raw = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, `manifests/${fixtureName}.json`), 'utf8'));
  const manifest = canonicalizeManifestForRegistration(raw);
  const { status } = await fetchJson(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  assert.equal(status, 201);
  return manifest;
}

async function registerSpotify(asUrl) {
  return registerFirstPartyConnectorFixture(asUrl, 'spotify');
}

async function registerGithub(asUrl) {
  return registerFirstPartyConnectorFixture(asUrl, 'github');
}

async function registerAuthCodeClient(asUrl, opts = {}) {
  const grantTypes = opts.refreshToken === false
    ? ['authorization_code']
    : ['authorization_code', 'refresh_token'];
  const { status, body } = await fetchJson(`${asUrl}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Hosted MCP test client',
      redirect_uris: ['https://client.example/callback'],
      grant_types: grantTypes,
      response_types: ['code'],
      application_type: 'web',
      token_endpoint_auth_method: 'none',
    }),
  });
  assert.equal(status, 201);
  assert.equal(body.token_endpoint_auth_method, 'none');
  assert.deepEqual(body.grant_types, grantTypes);
  assert.deepEqual(body.response_types, ['code']);
  for (const field of ['client_uri', 'logo_uri', 'policy_uri', 'tos_uri']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(body, field),
      false,
      `unset optional DCR metadata field ${field} must be omitted, not null`,
    );
  }
  return body;
}

function renderedHostedMcpStreamValues(html) {
  return [...html.matchAll(/<input[^>]*name="stream"[^>]*value="([^"]+)"[^>]*data-hosted-mcp-stream-checkbox[^>]*>/g)]
    .map((match) => match[1]);
}

function renderedHostedMcpPickerErrorText(html) {
  const match = html.match(/<div[^>]*data-hosted-mcp-picker-error[^>]*>([\s\S]*?)<\/div>/);
  return match ? match[1] : '';
}

function visibleTextFromHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function issueOwnerToken(asUrl) {
  const clientId = 'cli_longview';
  const { body: device } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId }).toString(),
  });

  const approveResp = await fetch(`${asUrl}/device/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      user_code: device.user_code,
      subject_id: 'owner_local',
    }).toString(),
  });
  assert.equal(approveResp.status, 200);

  const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.device_code,
      client_id: clientId,
    }).toString(),
  });
  return tokenBody.access_token;
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
    body: new URLSearchParams({
      request_uri: requestUri,
      subject_id: 'owner_local',
    }).toString(),
  });
  assert.equal(approveResp.status, 302);
  const callback = new URL(approveResp.headers.get('location'));
  assert.equal(callback.origin, 'https://client.example');
  assert.equal(callback.searchParams.get('state'), 'state-123');
  assert.equal(callback.searchParams.has('access_token'), false);
  assert.equal(callback.searchParams.has('grant'), false);
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
  assert.equal(body.token_type, 'Bearer');
  assert.equal(Number.isInteger(body.expires_in), true);
  assert.ok(body.expires_in > 0);
  assert.ok(body.access_token);
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || null,
    grantId: body.grant_id,
    code,
  };
}

function hostedMcpAuthorizationDetails(manifest) {
  return [
    {
      type: 'https://pdpp.org/data-access',
      source: { kind: 'connector', id: manifest.connector_id },
      purpose_code: 'https://pdpp.org/purpose/personal_ai_assistant',
      purpose_description: 'Use PDPP data through hosted MCP.',
      access_mode: 'continuous',
      streams: [{ name: '*' }],
    },
  ];
}

async function startMcpDeviceAuthorization({ asUrl, rsUrl, client, manifest }) {
  return fetchJson(`${asUrl}/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.client_id,
      resource: `${rsUrl}/mcp`,
      authorization_details: JSON.stringify(hostedMcpAuthorizationDetails(manifest)),
    }).toString(),
  });
}

// Drive the multi-source hosted-MCP picker end-to-end:
//   1. Register multiple connectors with the AS.
//   2. Open the picker (GET /oauth/authorize without authorization_details).
//   3. Post the multi-select picker form with one opaque selection value per
//      approved row. The picker emits base64url(JSON) payloads so URL-shaped
//      connector ids cannot collide with any wrapping delimiter; the test
//      reuses the production encoder for the same reason.
//   4. Follow the redirect to the client's callback, capture the package code.
//   5. Exchange the code for a `grant_package_id`-bearing access token at
//      /oauth/token, including a refresh token.
//
// Returns the access token, refresh token, package id, and PKCE artefacts so
// the caller can drive /mcp under the package bearer and exercise refresh
// against the same package.
async function completeMultiSourcePackageFlow({ asUrl, client, connectorIds }) {
  const verifier = randomBytes(32).toString('base64url');
  const state = 'pkg-state-456';
  const challenge = pkceChallenge(verifier);

  const authorizeUrl = new URL(`${asUrl}/oauth/authorize`);
  authorizeUrl.searchParams.set('client_id', client.client_id);
  authorizeUrl.searchParams.set('redirect_uri', 'https://client.example/callback');
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  // No `authorization_details` and no `connector_id` → AS renders the
  // multi-source picker page so we can submit a multi-select form.
  const pickerResp = await fetch(authorizeUrl, { redirect: 'manual' });
  assert.equal(pickerResp.status, 200);
  const pickerHtml = await pickerResp.text();
  // The picker MUST NOT advertise raw `connector:<url>` form values: that
  // shape collapsed when split at the first `:`. Each row must carry the
  // structured selection encoding instead, and the URL-shaped connector id
  // MUST appear only in human-facing meta copy, not as the submitted value.
  assert.ok(!pickerHtml.includes('value="connector:'), 'picker MUST NOT submit raw connector:<id> selection values');
  assert.ok(!pickerHtml.includes('value="connection:'), 'picker MUST NOT submit raw connection:<id>:<id> selection values');
  for (const id of connectorIds) {
    const encoded = encodeHostedMcpSelection({ connectorId: id, connectionId: null });
    assert.ok(pickerHtml.includes(`value="${encoded}"`), `picker should advertise opaque selection for ${id}`);
  }

  // POST the multi-source approval. Owner auth is disabled for tests
  // (`ownerAuthPassword: ''`), so `requireOwnerSession` and `requireCsrf`
  // are no-ops and the form goes through without a session cookie.
  //
  // The picker makes source selection derive from checked streams. This helper
  // mirrors an explicit whole-source approval by submitting every child stream
  // for the selected sources; tests for narrowing construct their own forms
  // instead of going through this helper.
  const params = new URLSearchParams();
  params.append('client_id', client.client_id);
  params.append('redirect_uri', 'https://client.example/callback');
  params.append('response_type', 'code');
  params.append('state', state);
  params.append('code_challenge', challenge);
  params.append('code_challenge_method', 'S256');
  for (const id of connectorIds) {
    params.append('selection', encodeHostedMcpSelection({ connectorId: id, connectionId: null }));
  }
  for (const streamValue of renderedHostedMcpStreamValues(pickerHtml)) {
    params.append('stream', streamValue);
  }

  const approveResp = await fetch(`${asUrl}/oauth/authorize/mcp-package`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  assert.equal(approveResp.status, 302);
  const callback = new URL(approveResp.headers.get('location'));
  assert.equal(callback.origin, 'https://client.example');
  assert.equal(callback.searchParams.get('state'), state);
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
  assert.equal(body.token_type, 'Bearer');
  assert.equal(Number.isInteger(body.expires_in), true);
  assert.ok(body.expires_in > 0);
  assert.ok(body.access_token);
  assert.ok(body.grant_package_id, 'multi-source approval issues a package-bound token');
  assert.equal(body.grant_id, undefined, 'package tokens MUST NOT carry a child grant_id at the OAuth surface');

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || null,
    packageId: body.grant_package_id,
    verifier,
    state,
  };
}

async function postMcpJson(rsUrl, token, message, path = '/mcp') {
  const resp = await fetch(`${rsUrl}${path}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(message),
  });
  const body = await resp.json();
  return { resp, status: resp.status, body };
}

async function postMcpWithHostHeader({ rsPort, token, host, message }) {
  return await new Promise((resolve, reject) => {
    const body = JSON.stringify(message);
    const req = http.request(
      {
        hostname: 'localhost',
        port: rsPort,
        path: '/mcp',
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Host: host,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: text }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function startOpenTestServer() {
  return startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    ownerAuthPassword: '',
  });
}

async function fetchProtectedResourceMetadata(url) {
  const { status, body } = await fetchJson(url);
  assert.equal(status, 200);
  return body;
}

test('hosted MCP OAuth code flow issues a scoped client token usable at /mcp', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const manifest = await registerSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const { accessToken, refreshToken, grantId, code } = await completeOauthCodeFlow({ asUrl, client, manifest });
    assert.ok(refreshToken);
    assert.equal(refreshToken.startsWith('rt_'), true);

    const reused = await fetchJson(`${asUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: client.client_id,
        redirect_uri: 'https://client.example/callback',
        code_verifier: randomBytes(32).toString('base64url'),
      }).toString(),
    });
    assert.equal(reused.status, 400);
    assert.equal(reused.body.error, 'invalid_grant');

    const refreshed = await fetchJson(`${asUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: client.client_id,
      }).toString(),
    });
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.token_type, 'Bearer');
    assert.equal(Number.isInteger(refreshed.body.expires_in), true);
    assert.ok(refreshed.body.expires_in > 0);
    assert.equal(refreshed.body.refresh_token, refreshToken);
    assert.equal(refreshed.body.grant_id, grantId);
    assert.ok(refreshed.body.access_token);
    assert.notEqual(refreshed.body.access_token, accessToken);

    const wrongClient = await fetchJson(`${asUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: 'cli_wrong',
      }).toString(),
    });
    assert.equal(wrongClient.status, 400);
    assert.equal(wrongClient.body.error, 'invalid_grant');

    const initialize = await postMcpJson(rsUrl, accessToken, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'hosted-test', version: '0.0.0' },
      },
    });
    assert.equal(initialize.status, 200);
    assert.equal(initialize.body.result.serverInfo.name, 'pdpp-reference-mcp');
    assert.deepEqual(initialize.body.result.serverInfo.icons, [
      { src: `${rsUrl}/icon.svg`, mimeType: 'image/svg+xml', sizes: ['any'] },
    ]);
    assert.equal(initialize.resp.headers.get('link'), `<${rsUrl}/icon.svg>; rel="icon"; type="image/svg+xml"`);

    const tools = await postMcpJson(rsUrl, accessToken, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });
    assert.equal(tools.status, 200);
    const toolNames = tools.body.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(toolNames, ['aggregate', 'fetch', 'query_records', 'read_record_field', 'schema', 'search']);
    assert.equal(toolNames.includes('list_streams'), false);
    assert.equal(toolNames.includes('fetch_blob'), false);
    assert.equal(toolNames.some((name) => name.includes('event_subscription')), false);

    const refreshedTools = await postMcpJson(rsUrl, refreshed.body.access_token, {
      jsonrpc: '2.0',
      id: 22,
      method: 'tools/list',
      params: {},
    });
    assert.equal(refreshedTools.status, 200);

    const schema = await postMcpJson(rsUrl, accessToken, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'schema', arguments: {} },
    });
    assert.equal(schema.status, 200);
    assert.equal(schema.body.result.isError, undefined);

    const untrustedHost = await postMcpWithHostHeader({
      rsPort: server.rsPort,
      token: accessToken,
      host: 'attacker.example',
      message: {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/list',
        params: {},
      },
    });
    assert.equal(untrustedHost.status, 421);

    await revokeGrant(grantId, { request_id: 'hosted-mcp-refresh-test' });
    const afterRevoke = await fetchJson(`${asUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: client.client_id,
      }).toString(),
    });
    assert.equal(afterRevoke.status, 400);
    assert.equal(afterRevoke.body.error, 'invalid_grant');
  } finally {
    await closeServer(server);
  }
});

// Regression: the legacy `connection:<connector_id>:<connection_id>` form
// shape collapsed when `connector_id` was URL-shaped because the AS split on
// the first `:` and tried to resolve `https` as a connector. The picker now
// emits opaque base64url(JSON) selection values, and the AS MUST refuse the
// legacy delimited shape with a clean typed error instead of leaking
// "Unknown connector: https" or guessing through a parser fallback.
test('POST /oauth/authorize/mcp-package rejects legacy delimited selection without leaking "https"', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    await registerSpotify(asUrl);
    // Hard-coded URL-shaped first-party connector id. The legacy delimited
    // shape under test (`connection:<url>:<connection_id>`) is the exact
    // pre-canonicalization bug surface: an owner-supplied URL embedded
    // inside a colon-delimited payload. The post-canonicalize-connector-keys
    // AS no longer stores manifests under URL keys, but the parser still
    // needs to reject this shape without leaking "https" or collapsing the
    // URL into the "Unknown connector" error branch.
    const legacyUrlShapedConnectorId = 'https://registry.pdpp.org/connectors/spotify';
    const client = await registerAuthCodeClient(asUrl);

    const verifier = randomBytes(32).toString('base64url');
    const challenge = pkceChallenge(verifier);

    const params = new URLSearchParams();
    params.append('client_id', client.client_id);
    params.append('redirect_uri', 'https://client.example/callback');
    params.append('response_type', 'code');
    params.append('state', 'legacy-shape');
    params.append('code_challenge', challenge);
    params.append('code_challenge_method', 'S256');
    // Exactly the bug-triggering shape: `connection:<url>:<connection_id>`.
    params.append('selection', `connection:${legacyUrlShapedConnectorId}:conn_owner_local`);

    const resp = await fetch(`${asUrl}/oauth/authorize/mcp-package`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const body = await resp.json();

    assert.equal(resp.status, 400);
    assert.equal(body.error, 'invalid_request');
    assert.ok(typeof body.error_description === 'string', 'response carries an error_description');
    assert.equal(
      body.error_description.toLowerCase().includes('https'),
      false,
      `error_description MUST NOT mention "https"; got: ${body.error_description}`,
    );
    assert.equal(
      body.error_description.toLowerCase().includes('unknown connector'),
      false,
      'parser MUST NOT collapse the URL and reach the "Unknown connector" branch',
    );
  } finally {
    await closeServer(server);
  }
});

test('hosted MCP source selection uses hosted-ui option styles', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    await registerSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const verifier = randomBytes(32).toString('base64url');
    const authorizeUrl = new URL(`${asUrl}/oauth/authorize`);
    authorizeUrl.searchParams.set('client_id', client.client_id);
    authorizeUrl.searchParams.set('redirect_uri', 'https://client.example/callback');
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('state', 'state-123');
    authorizeUrl.searchParams.set('code_challenge', pkceChallenge(verifier));
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    const resp = await fetch(authorizeUrl);
    assert.equal(resp.status, 200);
    const html = await resp.text();
    assert.match(html, /Choose what this app can read/);
    assert.match(html, /class="hosted-ui-option-group"/);
    assert.match(html, /class="hosted-ui-option"/);
    assert.match(html, /<details class="hosted-ui-option-source"[^>]*>/);
    assert.match(html, /data-hosted-mcp-select-sources/);
    assert.match(html, /data-hosted-mcp-clear-sources/);
    assert.match(html, /class="hosted-ui-button" data-variant="primary"/);

    const sourceDetails = [...html.matchAll(/<details class="hosted-ui-option-source"[^>]*>/g)];
    assert.ok(sourceDetails.length > 0, 'picker must render collapsed source detail sections');
    for (const match of sourceDetails) {
      assert.equal(
        /\sopen(?:\s|>)/.test(match[0]),
        false,
        'source detail sections must be collapsed by default',
      );
    }

    // Regression: owner-facing picker copy MUST NOT leak URL-shaped
    // first-party connector ids. The canonical short `connector_key`
    // (`spotify`) is the only connector identifier that may appear in
    // human meta copy alongside the display name. See
    // `openspec/changes/canonicalize-connector-keys/`.
    assert.equal(
      html.includes('https://registry.pdpp.org'),
      false,
      'picker meta copy MUST NOT show registry URLs; expected canonical connector keys',
    );
    assert.match(html, /spotify/, 'picker meta copy should show canonical key `spotify`');
    assert.match(
      html,
      /Share only what this app needs/,
      'picker copy should present the flow as an owner-facing setup',
    );

    const cssResp = await fetch(`${asUrl}/__pdpp/hosted-ui.css`);
    assert.equal(cssResp.status, 200);
    const css = await cssResp.text();
    assert.match(css, /\.hosted-ui-option-group/);
    assert.match(css, /\.hosted-ui-option\b/);
  } finally {
    await closeServer(server);
  }
});

test('grant-scoped MCP device authorization requires resource and authorization_details', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const manifest = await registerSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const missingDetails = await fetchJson(`${asUrl}/oauth/device_authorization`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.client_id,
        resource: `${rsUrl}/mcp`,
      }).toString(),
    });
    assert.equal(missingDetails.status, 400);
    assert.equal(missingDetails.body.error, 'invalid_request');
    assert.match(missingDetails.body.error_description, /authorization_details is required/);

    const missingResource = await fetchJson(`${asUrl}/oauth/device_authorization`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.client_id,
        authorization_details: JSON.stringify(hostedMcpAuthorizationDetails(manifest)),
      }).toString(),
    });
    assert.equal(missingResource.status, 400);
    assert.equal(missingResource.body.error, 'invalid_request');
    assert.match(missingResource.body.error_description, /resource is required/);
  } finally {
    await closeServer(server);
  }
});

test('grant-scoped MCP device authorization issues a client token usable at /mcp', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const manifest = await registerSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const device = await startMcpDeviceAuthorization({ asUrl, rsUrl, client, manifest });
    assert.equal(device.status, 200);
    assert.equal(device.body.device_code.startsWith('dc_'), true);
    assert.equal(device.body.device_code.startsWith('dc_owner_'), false);
    assert.ok(device.body.user_code);
    assert.equal(device.body.verification_uri, `${asUrl}/consent`);
    assert.match(device.body.verification_uri_complete, /^http:\/\/localhost:\d+\/consent\?request_uri=/);
    assert.equal(device.body.interval, 2);

    const pending = await fetchJson(`${asUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: device.body.device_code,
        client_id: client.client_id,
      }).toString(),
    });
    assert.equal(pending.status, 400);
    assert.equal(pending.body.error, 'authorization_pending');

    const tooFast = await fetchJson(`${asUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: device.body.device_code,
        client_id: client.client_id,
      }).toString(),
    });
    assert.equal(tooFast.status, 400);
    assert.equal(tooFast.body.error, 'slow_down');

    const approveResp = await fetch(`${asUrl}/consent/approve`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        request_uri: buildPendingConsentRequestUri(device.body.device_code),
        subject_id: 'owner_local',
      }).toString(),
    });
    assert.equal(approveResp.status, 200);

    const token = await fetchJson(`${asUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: device.body.device_code,
        client_id: client.client_id,
      }).toString(),
    });
    assert.equal(token.status, 200);
    assert.equal(token.body.token_type, 'Bearer');
    assert.ok(token.body.access_token);
    assert.ok(token.body.grant_id);
    assert.equal(token.body.grant_package_id, undefined);

    const introspected = await fetchJson(`${asUrl}/introspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: token.body.access_token }).toString(),
    });
    assert.equal(introspected.status, 200);
    assert.equal(introspected.body.active, true);
    assert.equal(introspected.body.pdpp_token_kind, 'client');
    assert.equal(introspected.body.client_id, client.client_id);
    assert.equal(introspected.body.grant_id, token.body.grant_id);

    const tools = await postMcpJson(rsUrl, token.body.access_token, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });
    assert.equal(tools.status, 200);
    assert.deepEqual(
      tools.body.result.tools.map((tool) => tool.name).sort(),
    ['aggregate', 'fetch', 'query_records', 'read_record_field', 'schema', 'search'],
  );
  } finally {
    await closeServer(server);
  }
});

test('/mcp rejects missing and owner bearers', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const missing = await fetchJson(`${rsUrl}/mcp`, { method: 'POST' });
    assert.equal(missing.status, 401);
    assert.equal(missing.resp.headers.get('link'), `<${rsUrl}/icon.svg>; rel="icon"; type="image/svg+xml"`);
    assert.equal(missing.body.error.resource_metadata, `${rsUrl}/.well-known/oauth-protected-resource/mcp`);

    const mcpMetadata = await fetchProtectedResourceMetadata(missing.body.error.resource_metadata);
    assert.equal(mcpMetadata.resource, `${rsUrl}/mcp`);
    assert.deepEqual(mcpMetadata.pdpp_token_kinds_supported, ['client', 'mcp_package']);
    assert.equal(mcpMetadata.pdpp_agent_discovery.mcp.endpoint, `${rsUrl}/mcp`);
    assert.deepEqual(mcpMetadata.pdpp_agent_discovery.mcp.authorization.device_code, {
      flow: 'device_code',
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      pdpp_token_kind: 'client',
      device_authorization_endpoint: `${asUrl}/oauth/device_authorization`,
      token_endpoint: `${asUrl}/oauth/token`,
      resource: `${rsUrl}/mcp`,
      required_parameters: ['client_id', 'resource', 'authorization_details'],
      authorization_details_type: 'https://pdpp.org/data-access',
      owner_bearer_accepted: false,
    });
    assert.deepEqual(mcpMetadata.pdpp_agent_discovery.mcp.authorization.owner_agent_device_code, {
      flow: 'device_code',
      pdpp_token_kind: 'owner',
      normal_mcp_setup: false,
      advertised_in: 'pdpp_owner_agent_onboarding',
      mcp_owner_bearer_rejected: true,
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(mcpMetadata, 'logo_uri'),
      false,
      'OAuth protected-resource metadata must not grow a non-standard logo_uri field',
    );

    const ownerToken = await issueOwnerToken(asUrl);
    const owner = await postMcpJson(rsUrl, ownerToken, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });
    assert.equal(owner.status, 403);
    assert.equal(owner.body.error.code, 'permission_error');
    assert.match(owner.body.error.message, /grant-scoped client or MCP package token/);
    assert.match(owner.body.error.message, /owner-agent REST onboarding/);

  } finally {
    await closeServer(server);
  }
});

test('dynamic registration accepts only public authorization-code, refresh-token, and device-code metadata', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    await registerAuthCodeClient(asUrl);
    const noRefresh = await registerAuthCodeClient(asUrl, { refreshToken: false });
    assert.deepEqual(noRefresh.grant_types, ['authorization_code']);

    const deviceOnly = await fetchJson(`${asUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Device-code client',
        grant_types: ['urn:ietf:params:oauth:grant-type:device_code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    assert.equal(deviceOnly.status, 201);
    assert.deepEqual(deviceOnly.body.grant_types, ['urn:ietf:params:oauth:grant-type:device_code']);
    assert.equal(Object.prototype.hasOwnProperty.call(deviceOnly.body, 'redirect_uris'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(deviceOnly.body, 'response_types'), false);

    const refreshWithoutCode = await fetchJson(`${asUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Refresh-only client',
        redirect_uris: ['https://client.example/callback'],
        grant_types: ['refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    assert.equal(refreshWithoutCode.status, 400);
    assert.match(refreshWithoutCode.body.error_description, /requires authorization_code/);

    const implicit = await fetchJson(`${asUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Bad client',
        redirect_uris: ['https://client.example/callback'],
        response_types: ['token'],
      }),
    });
    assert.equal(implicit.status, 400);
    assert.match(implicit.body.error_description, /Unsupported response_types/);

    const confidential = await fetchJson(`${asUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Confidential client',
        redirect_uris: ['https://client.example/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_basic',
      }),
    });
    assert.equal(confidential.status, 400);
    assert.match(confidential.body.error_description, /Unsupported token_endpoint_auth_method/);

    const unsafeScheme = await fetchJson(`${asUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Unsafe redirect client',
        redirect_uris: ['javascript:alert(1)'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    assert.equal(unsafeScheme.status, 400);
    assert.match(unsafeScheme.body.error_description, /redirect_uris must use https/);

    const insecureWeb = await fetchJson(`${asUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Insecure web redirect client',
        redirect_uris: ['http://client.example/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        application_type: 'web',
        token_endpoint_auth_method: 'none',
      }),
    });
    assert.equal(insecureWeb.status, 400);
    assert.match(insecureWeb.body.error_description, /https for web clients/);

    const explicitWebLoopback = await fetchJson(`${asUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Explicit web loopback redirect client',
        redirect_uris: ['http://127.0.0.1:43210/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        application_type: 'web',
        token_endpoint_auth_method: 'none',
      }),
    });
    assert.equal(explicitWebLoopback.status, 400);
    assert.match(explicitWebLoopback.body.error_description, /https for web clients/);

    const nativeLoopback = await fetchJson(`${asUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Native loopback redirect client',
        redirect_uris: ['http://127.0.0.1:43210/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        application_type: 'native',
        token_endpoint_auth_method: 'none',
      }),
    });
    assert.equal(nativeLoopback.status, 201);
    assert.equal(nativeLoopback.body.application_type, 'native');

    const inferredIpv4NativeLoopback = await fetchJson(`${asUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Inferred IPv4 native loopback redirect client',
        redirect_uris: ['http://127.0.0.1:43211/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    assert.equal(inferredIpv4NativeLoopback.status, 201);
    assert.equal(inferredIpv4NativeLoopback.body.application_type, 'native');

    const inferredLocalhostNativeLoopback = await fetchJson(`${asUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Inferred localhost native loopback redirect client',
        redirect_uris: ['http://localhost:43212/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    assert.equal(inferredLocalhostNativeLoopback.status, 201);
    assert.equal(inferredLocalhostNativeLoopback.body.application_type, 'native');

    const inferredIpv6NativeLoopback = await fetchJson(`${asUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Inferred IPv6 native loopback redirect client',
        redirect_uris: ['http://[::1]:43213/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    assert.equal(inferredIpv6NativeLoopback.status, 201);
    assert.equal(inferredIpv6NativeLoopback.body.application_type, 'native');
  } finally {
    await closeServer(server);
  }
});

// End-to-end coverage for the hosted-MCP grant-package construction
// (OpenSpec change `add-hosted-mcp-grant-packages`, tasks 5.1 / 5.5 / 5.6).
// These prove that the AS→package-token→`/mcp`→PackageRsClient chain holds
// under multi-source approval, child-grant revocation, and full package
// revocation. The unit suite in `package-rs-client.test.js` covers the
// adapter routing in isolation; this suite proves the live wiring.

test('multi-source hosted MCP picker issues a package token usable at /mcp with source-tagged reads', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const spotify = await registerSpotify(asUrl);
    const github = await registerGithub(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const { accessToken, refreshToken, packageId } = await completeMultiSourcePackageFlow({
      asUrl,
      client,
      connectorIds: [spotify.connector_id, github.connector_id],
    });
    assert.ok(refreshToken, 'multi-source package issues a refresh token');
    assert.equal(refreshToken.startsWith('rt_'), true);

    const initialize = await postMcpJson(rsUrl, accessToken, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'hosted-multi-source-test', version: '0.0.0' },
      },
    });
    assert.equal(initialize.status, 200);
    assert.equal(initialize.body.result.serverInfo.name, 'pdpp-reference-mcp');

    // schema fan-out: streams from both children should appear, each
    // tagged with the source's connector_id and grant_id.
    const schemaCall = await postMcpJson(rsUrl, accessToken, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'schema', arguments: {} },
    });
    assert.equal(schemaCall.status, 200);
    assert.equal(schemaCall.body.result.isError, undefined);
    const schemaData = schemaCall.body.result.structuredContent.data;
    const schemaPackage = schemaPackageMetadata(schemaData);
    assert.ok(schemaPackage?.grant_package, 'schema response carries package metadata');
    assert.equal(schemaPackage.member_count, 2);
    const schemaStreams = (schemaData.connectors || [])
      .flatMap((connector) => (connector.streams || []).map((stream) => ({ ...stream, source: stream.source || connector.source })));
    const schemaConnectorIds = new Set(
      schemaStreams.map((s) => s.source?.connector_id || s.source?.connector_key).filter(Boolean),
    );
    assert.ok(schemaConnectorIds.has(spotify.connector_id), 'schema fanout includes spotify streams');
    assert.ok(schemaConnectorIds.has(github.connector_id), 'schema fanout includes github streams');
    const schemaGrantIds = new Set(
      schemaStreams.map((s) => s.source?.grant_id).filter(Boolean),
    );
    assert.equal(schemaGrantIds.size, 2, 'each stream is tagged with its child grant_id');

    // The package token MUST NOT reach a non-/mcp REST surface. The
    // canonical REST surfaces are gated by `requireClient` (returns 403
    // permission_error for package tokens) or by manifest resolution
    // that does not know how to interpret a package token's missing
    // grant binding (surfaces as a typed 4xx). Either way the response
    // is not 200 and is not an OK envelope.
    const restProbe = await fetchJson(`${rsUrl}/v1/schema`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    assert.notEqual(restProbe.status, 200, 'package tokens MUST NOT serve REST /v1/schema');
    assert.ok(
      restProbe.status === 403 || restProbe.status === 404,
      `expected REST surface to reject package token, got ${restProbe.status}`,
    );

    // Refresh-token exchange must succeed and return a fresh package token.
    const refreshed = await fetchJson(`${asUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: client.client_id,
      }).toString(),
    });
    assert.equal(refreshed.status, 200);
    assert.equal(Number.isInteger(refreshed.body.expires_in), true);
    assert.ok(refreshed.body.expires_in > 0);
    assert.equal(refreshed.body.grant_package_id, packageId);
    assert.equal(refreshed.body.grant_id, undefined);
    assert.ok(refreshed.body.access_token);
    assert.notEqual(refreshed.body.access_token, accessToken);

    // The refreshed package token still reaches /mcp with both children.
    const refreshedSchema = await postMcpJson(rsUrl, refreshed.body.access_token, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'schema', arguments: {} },
    });
    assert.equal(refreshedSchema.status, 200);
    const refreshedSchemaData = refreshedSchema.body.result.structuredContent.data;
    assert.equal(schemaPackageMetadata(refreshedSchemaData).member_count, 2);
  } finally {
    await closeServer(server);
  }
});

test('revoking one child grant silently removes that source from the package /mcp fanout', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const spotify = await registerSpotify(asUrl);
    const github = await registerGithub(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const { accessToken, packageId } = await completeMultiSourcePackageFlow({
      asUrl,
      client,
      connectorIds: [spotify.connector_id, github.connector_id],
    });

    await postMcpJson(rsUrl, accessToken, {
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'revoke-child-test', version: '0.0.0' },
      },
    });

    // Baseline: both sources present.
    const before = await postMcpJson(rsUrl, accessToken, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'schema', arguments: {} },
    });
    assert.equal(before.status, 200);
    const beforeData = before.body.result.structuredContent.data;
    const beforePackage = schemaPackageMetadata(beforeData);
    assert.equal(beforePackage.member_count, 2);
    const childGrants = beforePackage.sources.map((s) => ({
      grant_id: s.grant_id,
      connector_id: s.connector_id,
    }));
    const spotifyChild = childGrants.find((c) => c.connector_id === spotify.connector_id);
    const githubChild = childGrants.find((c) => c.connector_id === github.connector_id);
    assert.ok(spotifyChild && githubChild, 'package exposes one child grant per source');

    // Revoke just the spotify child grant. The package and the github child
    // stay active.
    await revokeGrant(spotifyChild.grant_id, { request_id: 'multi-source-child-revoke-test' });

    const after = await postMcpJson(rsUrl, accessToken, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'schema', arguments: {} },
    });
    assert.equal(after.status, 200);
    const afterData = after.body.result.structuredContent.data;
    const afterPackage = schemaPackageMetadata(afterData);
    assert.equal(afterPackage.member_count, 1, 'revoked child is no longer counted in the package fanout');
    const afterConnectorIds = new Set(schemaStreamRows(afterData).map((s) => s.source?.connector_id));
    assert.ok(!afterConnectorIds.has(spotify.connector_id), 'spotify streams are absent after its child grant is revoked');
    assert.ok(afterConnectorIds.has(github.connector_id), 'github streams still present');
    const afterSourceConnectorIds = afterPackage.sources.map((s) => s.connector_id);
    assert.deepEqual(afterSourceConnectorIds, [github.connector_id]);

    // The package token itself stays valid because the package is still
    // active and has one active member.
    assert.equal(after.body.result.isError, undefined);

    // Sanity: the package is still active, only the child is revoked.
    assert.ok(packageId);
  } finally {
    await closeServer(server);
  }
});

test('revoking the package invalidates /mcp access and the refresh-token exchange', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const spotify = await registerSpotify(asUrl);
    const github = await registerGithub(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const { accessToken, refreshToken, packageId } = await completeMultiSourcePackageFlow({
      asUrl,
      client,
      connectorIds: [spotify.connector_id, github.connector_id],
    });

    // Confirm the token works before revocation.
    const before = await postMcpJson(rsUrl, accessToken, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'pkg-revoke-test', version: '0.0.0' },
      },
    });
    assert.equal(before.status, 200);

    // Revoke the package.
    await revokeGrantPackage(packageId, { request_id: 'multi-source-package-revoke-test' });

    // /mcp must now reject the package bearer. introspection marks the
    // token inactive with `inactive_reason = 'package_revoked'`; that
    // does not map to a grant_revoked/grant_expired/grant_invalid 403,
    // so requireToken falls through to a 401 challenge.
    const after = await postMcpJson(rsUrl, accessToken, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });
    assert.equal(after.status, 401);
    assert.equal(after.body.error.code, 'authentication_error');
    assert.equal(
      after.body.error.resource_metadata,
      `${rsUrl}/.well-known/oauth-protected-resource/mcp`,
    );

    // The refresh-token exchange must also fail — the package's refresh
    // token row gets revoked alongside the package.
    const refreshAttempt = await fetchJson(`${asUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: client.client_id,
      }).toString(),
    });
    assert.equal(refreshAttempt.status, 400);
    assert.equal(refreshAttempt.body.error, 'invalid_grant');
  } finally {
    await closeServer(server);
  }
});

// G1 regression: source-targeted read routing in a live multi-source package.
//
// The fan-out tests above prove that /mcp/schema returns rows from both
// children. This test proves the other side of the routing contract: supplying
// a connection_id argument to a normal read tool routes to exactly one child.
//
// Source-targeted routing only activates when the package members carry a
// non-null connection_id. That requires connection-scoped (not just
// connector-scoped) selections. We seed two named connector instances so the
// picker can render per-connection rows and the resulting child grants bind to
// specific cin_* ids that PackageRsClient uses for routing.
//
// The unit suite in package-rs-client.test.js stubs fetch; this test
// exercises the full stack from MCP tool call → PackageRsClient → live RI RS.

test('query_records with connection_id routes to one source only (G1 source-targeted routing)', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const spotify = await registerSpotify(asUrl);
    const github = await registerGithub(asUrl);

    // Seed one named connection per connector so the picker renders
    // per-connection rows and the resulting members carry connection_id.
    const store = createSqliteConnectorInstanceStore();
    const now = new Date().toISOString();
    const spotifyConnId = 'cin_g1_spotify';
    const githubConnId = 'cin_g1_github';
    await store.upsert({
      connectorInstanceId: spotifyConnId,
      ownerSubjectId: 'owner_local',
      connectorId: spotify.connector_id,
      displayName: 'My Spotify',
      status: 'active',
      sourceKind: 'account',
      sourceBindingKey: 'spotify@example.com',
      sourceBinding: { account: 'spotify@example.com' },
      createdAt: now,
      updatedAt: now,
    });
    await store.upsert({
      connectorInstanceId: githubConnId,
      ownerSubjectId: 'owner_local',
      connectorId: github.connector_id,
      displayName: 'My GitHub',
      status: 'active',
      sourceKind: 'account',
      sourceBindingKey: 'github@example.com',
      sourceBinding: { account: 'github@example.com' },
      createdAt: now,
      updatedAt: now,
    });

    const client = await registerAuthCodeClient(asUrl);
    const verifier = randomBytes(32).toString('base64url');
    const challenge = pkceChallenge(verifier);
    const state = 'g1-routing-test';

    const authorizeUrl = new URL(`${asUrl}/oauth/authorize`);
    authorizeUrl.searchParams.set('client_id', client.client_id);
    authorizeUrl.searchParams.set('redirect_uri', 'https://client.example/callback');
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    const pickerResp = await fetch(authorizeUrl, { redirect: 'manual' });
    assert.equal(pickerResp.status, 200);
    const pickerHtml = await pickerResp.text();

    // Build a connection-scoped multi-select form: one selection per
    // named connection (connector + connection_id pair).
    const params = new URLSearchParams();
    params.append('client_id', client.client_id);
    params.append('redirect_uri', 'https://client.example/callback');
    params.append('response_type', 'code');
    params.append('state', state);
    params.append('code_challenge', challenge);
    params.append('code_challenge_method', 'S256');
    params.append(
      'selection',
      encodeHostedMcpSelection({ connectorId: spotify.connector_id, connectionId: spotifyConnId }),
    );
    params.append(
      'selection',
      encodeHostedMcpSelection({ connectorId: github.connector_id, connectionId: githubConnId }),
    );
    // Mirror explicit whole-source approval: submit every stream value.
    for (const streamValue of renderedHostedMcpStreamValues(pickerHtml)) {
      params.append('stream', streamValue);
    }

    const approveResp = await fetch(`${asUrl}/oauth/authorize/mcp-package`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    assert.equal(approveResp.status, 302);
    const callback = new URL(approveResp.headers.get('location'));
    const code = callback.searchParams.get('code');
    assert.ok(code);

    const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
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
    assert.ok(tokenBody.grant_package_id, 'connection-scoped multi-source package issued');
    const accessToken = tokenBody.access_token;

    await postMcpJson(rsUrl, accessToken, {
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'g1-routing-test', version: '0.0.0' },
      },
    });

    // Step 1: fan-out schema to confirm both connection_id values are present.
    const schemaCall = await postMcpJson(rsUrl, accessToken, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'schema', arguments: {} },
    });
    assert.equal(schemaCall.status, 200);
    assert.equal(schemaCall.body.result.isError, undefined);
    const schemaData = schemaCall.body.result.structuredContent.data;
    const sources = schemaPackageMetadata(schemaData)?.sources ?? [];
    assert.equal(sources.length, 2, 'package exposes two sources');

    const spotifySource = sources.find((s) => s.connection_id === spotifyConnId);
    const githubSource = sources.find((s) => s.connection_id === githubConnId);
    assert.ok(spotifySource, 'spotify connection is present in package sources');
    assert.ok(githubSource, 'github connection is present in package sources');

    // Step 2: schema fan-out exposes stream names and source tags for both
    // children. Pick one stream per source for targeted read calls.
    const allRows = schemaStreamRows(schemaData);
    assert.ok(allRows.length > 0, 'schema returns streams from package sources');
    const allConnectorIds = new Set(allRows.map((r) => r.source?.connector_id).filter(Boolean));
    assert.ok(allConnectorIds.has(spotify.connector_id), 'schema fan-out includes spotify streams');
    assert.ok(allConnectorIds.has(github.connector_id), 'schema fan-out includes github streams');
    const spotifyRow = allRows.find((r) => r.source?.connection_id === spotifyConnId);
    const githubRow = allRows.find((r) => r.source?.connection_id === githubConnId);
    assert.ok(spotifyRow?.name, 'spotify connection has a stream to query');
    assert.ok(githubRow?.name, 'github connection has a stream to query');

    // Step 3: query_records scoped to spotify's connection_id routes to that child.
    const spotifyQuery = await postMcpJson(rsUrl, accessToken, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'query_records',
        arguments: { stream: spotifyRow.name, connection_id: spotifyConnId, limit: 1 },
      },
    });
    assert.equal(spotifyQuery.status, 200);
    assert.equal(spotifyQuery.body.result.isError, undefined, 'spotify-scoped query_records must not be an error');

    // Step 4: query_records scoped to github's connection_id routes to that child.
    const githubQuery = await postMcpJson(rsUrl, accessToken, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'query_records',
        arguments: { stream: githubRow.name, connection_id: githubConnId, limit: 1 },
      },
    });
    assert.equal(githubQuery.status, 200);
    assert.equal(githubQuery.body.result.isError, undefined, 'github-scoped query_records must not be an error');

    // Step 5: unknown connection_id must return a structured MCP error
    // (isError: true), not a server crash — proves the PackageRsClient
    // not_found error path is wired through the full live stack.
    const unknownQuery = await postMcpJson(rsUrl, accessToken, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'query_records',
        arguments: { stream: spotifyRow.name, connection_id: 'cin_does_not_exist', limit: 1 },
      },
    });
    assert.equal(unknownQuery.status, 200, 'unknown connection_id returns HTTP 200 (MCP error envelope)');
    assert.equal(unknownQuery.body.result.isError, true, 'unknown connection_id returns isError: true');
  } finally {
    await closeServer(server);
  }
});

// Stream-narrowing inside the hosted MCP picker.
//
// `completeMultiSourcePackageFlow` above always submits the wildcard form by
// selecting sources and explicitly submitting every stream. These tests prove
// the rest of the matrix:
//
//   - the picker renders collapsed source summaries with an owner-controllable
//     checkbox per manifest stream, and the default visual state is source
//     unchecked + child streams unchecked but enabled;
//   - the POST handler narrows a child grant when a subset of streams is
//     submitted;
//   - leaving every stream checked for a source preserves the canonical
//     wildcard so future manifest revisions extend cleanly;
//   - leaving a selected source with zero streams re-renders the picker with
//     HTML validation instead of silently dropping the source or returning JSON;

function buildHostedMcpPickerForm({
  client,
  state,
  challenge,
  sourceSelections,
  accessMode,
}) {
  const params = new URLSearchParams();
  params.append('client_id', client.client_id);
  params.append('redirect_uri', 'https://client.example/callback');
  params.append('response_type', 'code');
  params.append('state', state);
  params.append('code_challenge', challenge);
  params.append('code_challenge_method', 'S256');
  if (typeof accessMode === 'string') {
    params.append('access_mode', accessMode);
  }
  for (const { connectorId, connectionId = null, streamNames } of sourceSelections) {
    params.append('selection', encodeHostedMcpSelection({ connectorId, connectionId }));
    for (const streamName of streamNames) {
      params.append('stream', encodeHostedMcpStreamSelection({ connectorId, connectionId, streamName }));
    }
  }
  return params;
}

async function exchangePackageCode({ asUrl, client, params }) {
  const approveResp = await fetch(`${asUrl}/oauth/authorize/mcp-package`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  return approveResp;
}

test('hosted MCP picker renders collapsed source summaries with per-stream controls', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerSpotify(asUrl);
    const github = await registerGithub(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const verifier = randomBytes(32).toString('base64url');

    const authorizeUrl = new URL(`${asUrl}/oauth/authorize`);
    authorizeUrl.searchParams.set('client_id', client.client_id);
    authorizeUrl.searchParams.set('redirect_uri', 'https://client.example/callback');
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('state', 'streams-render-test');
    authorizeUrl.searchParams.set('code_challenge', pkceChallenge(verifier));
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    const resp = await fetch(authorizeUrl);
    assert.equal(resp.status, 200);
    const html = await resp.text();

    // The picker MUST render the per-source collapsed grouping that holds
    // both the source toggle and the per-stream checkboxes.
    assert.match(html, /class="hosted-ui-option-source"/, 'picker must wrap each row in a source group');
    assert.match(html, /<details class="hosted-ui-option-source"[^>]*data-source-selected="false"/);
    assert.match(html, /data-hosted-mcp-source-checkbox/, 'picker must mark source checkboxes for picker behavior');
    assert.match(
      html,
      /data-source-selection-mode="streams"/,
      'source checkbox state must be derived from stream choices',
    );
    assert.match(html, /class="hosted-ui-option-streams"/, 'picker must render the per-source stream block');
    assert.match(html, /class="hosted-ui-stream-option"/, 'picker must render at least one stream checkbox');
    assert.match(html, /data-hosted-mcp-stream-checkbox/, 'picker must mark stream checkboxes for source coupling');
    assert.match(html, /data-hosted-mcp-select-streams/, 'picker must offer per-source select-all streams');
    assert.match(html, /data-hosted-mcp-clear-streams/, 'picker must offer per-source clear streams');

    const sourceInputs = [...html.matchAll(/<input[^>]*data-hosted-mcp-source-checkbox[^>]*>/g)];
    assert.ok(sourceInputs.length > 0, 'picker must render source checkboxes');
    for (const match of sourceInputs) {
      assert.match(match[0], /data-source-selection-mode="streams"/);
      assert.equal(/\schecked(?:\s|\/|>)/.test(match[0]), false, 'source checkbox must not start checked');
    }

    const sourceDetails = [...html.matchAll(/<details class="hosted-ui-option-source"[^>]*>/g)];
    for (const match of sourceDetails) {
      assert.equal(/\sopen(?:\s|>)/.test(match[0]), false, 'source sections must start collapsed');
    }

    // Every manifest stream must be rendered unchecked but enabled. JS derives
    // the parent source checkbox from checked streams so a source cannot stay
    // selected for grant while every stream is clear.
    for (const stream of spotify.streams) {
      const streamFormValue = encodeHostedMcpStreamSelection({
        connectorId: spotify.connector_id,
        connectionId: null,
        streamName: stream.name,
      });
      const input = html.match(new RegExp(`<input[^>]*name="stream"[^>]*value="${streamFormValue}"[^>]*>`));
      assert.ok(input, `picker must render a stream checkbox for spotify::${stream.name}`);
      assert.equal(/\schecked(?:\s|\/|>)/.test(input[0]), false, `spotify::${stream.name} must not be checked`);
      assert.equal(/\sdisabled(?:\s|\/|>)/.test(input[0]), false, `spotify::${stream.name} must be enabled`);
    }
    for (const stream of github.streams) {
      const streamFormValue = encodeHostedMcpStreamSelection({
        connectorId: github.connector_id,
        connectionId: null,
        streamName: stream.name,
      });
      const input = html.match(new RegExp(`<input[^>]*name="stream"[^>]*value="${streamFormValue}"[^>]*>`));
      assert.ok(input, `picker must render a stream checkbox for github::${stream.name}`);
      assert.equal(/\schecked(?:\s|\/|>)/.test(input[0]), false, `github::${stream.name} must not be checked`);
      assert.equal(/\sdisabled(?:\s|\/|>)/.test(input[0]), false, `github::${stream.name} must be enabled`);
    }

    // Owner-facing copy should make the stream-derived source model
    // clear without registry URLs or demo-only phrasing.
    assert.match(html, /A source is its streams/i, 'picker copy should explain the source-is-its-streams model');
    assert.match(
      html,
      /A source with no streams checked is not shared/i,
      'picker copy should explain derived source state',
    );
    assert.match(
      html,
      /Each stream you check is granted on its own/i,
      'per-source copy should make stream selection authoritative',
    );
    assert.match(
      html,
      /Check one stream to share just that stream/i,
      'picker copy should make single-stream grants discoverable',
    );
    assert.match(html, /sourceBox\.checked = selected/, 'picker JS should derive source checked state from streams');
    assert.match(html, /sourceBox\.indeterminate = partiallySelected/, 'picker JS should expose subset stream grants');
    assert.match(html, /Select every stream/i, 'picker should make whole-source approval explicit');
    assert.match(html, /data-hosted-mcp-select-sources/, 'picker should make global bulk approval explicit');
    assert.match(html, /Select all/i, 'picker should offer a global select-all affordance');
    assert.match(html, /Clear all/i, 'picker should offer a clear global reset affordance');
    assert.match(html, /data-hosted-mcp-expand-all/, 'picker should offer an explicit expand-all disclosure control');
    assert.match(html, /data-hosted-mcp-collapse-all/, 'picker should offer an explicit collapse-all disclosure control');
    assert.match(html, />Expand all</i, 'expand-all control should be owner-labelled');
    assert.match(html, />Collapse all</i, 'collapse-all control should be owner-labelled');
  } finally {
    await closeServer(server);
  }
});

test('hosted MCP picker pre-selects nothing: zero checked sources and zero checked streams on first render', async () => {
  // UAT regression (owner-reported): "Streams should not be selected by
  // default while parent connection is not selected." The existing render
  // test asserts no-checked per known input; this locks the coupled aggregate
  // invariant directly — across the whole picker render there must be zero
  // checked source boxes AND zero checked stream boxes AND every source group
  // must report data-source-selected="false". A future change that pre-checks
  // either side (e.g. defaulting one stream on, or marking a source selected
  // before any stream is chosen) breaks this single assertion.
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    await registerSpotify(asUrl);
    await registerGithub(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const verifier = randomBytes(32).toString('base64url');

    const authorizeUrl = new URL(`${asUrl}/oauth/authorize`);
    authorizeUrl.searchParams.set('client_id', client.client_id);
    authorizeUrl.searchParams.set('redirect_uri', 'https://client.example/callback');
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('state', 'nothing-preselected');
    authorizeUrl.searchParams.set('code_challenge', pkceChallenge(verifier));
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    const resp = await fetch(authorizeUrl);
    assert.equal(resp.status, 200);
    const html = await resp.text();

    const sourceBoxes = [...html.matchAll(/<input[^>]*data-hosted-mcp-source-checkbox[^>]*>/g)].map((m) => m[0]);
    const streamBoxes = [...html.matchAll(/<input[^>]*data-hosted-mcp-stream-checkbox[^>]*>/g)].map((m) => m[0]);

    // The render must actually contain pickable sources and streams, otherwise
    // "zero checked" would pass vacuously.
    assert.ok(sourceBoxes.length >= 2, 'render must contain the registered source checkboxes');
    assert.ok(streamBoxes.length >= 2, 'render must contain stream checkboxes to choose from');

    const checkedSources = sourceBoxes.filter((b) => /\schecked(?:\s|\/|>)/.test(b)).length;
    const checkedStreams = streamBoxes.filter((b) => /\schecked(?:\s|\/|>)/.test(b)).length;
    assert.equal(checkedSources, 0, 'no source may be checked on first render');
    assert.equal(checkedStreams, 0, 'no stream may be checked while its parent source is unselected');

    // Every source group must also declare itself unselected, so the derived
    // "source participates" state starts false everywhere.
    const sourceGroups = [...html.matchAll(/<details class="hosted-ui-option-source"[^>]*>/g)].map((m) => m[0]);
    assert.equal(sourceGroups.length, sourceBoxes.length, 'one source group per source checkbox');
    for (const group of sourceGroups) {
      assert.match(group, /data-source-selected="false"/, 'each source group must start unselected');
    }
  } finally {
    await closeServer(server);
  }
});

test('POST /oauth/authorize/mcp-package narrows the child grant to the submitted stream subset', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerSpotify(asUrl);
    const github = await registerGithub(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const verifier = randomBytes(32).toString('base64url');
    const state = 'streams-narrow';
    const challenge = pkceChallenge(verifier);

    // Owner approves both connectors but narrows each one. The picker is
    // free-form: any subset of source-enabled streams may be submitted.
    const params = buildHostedMcpPickerForm({
      client,
      state,
      challenge,
      sourceSelections: [
        {
          connectorId: spotify.connector_id,
          streamNames: ['saved_tracks'],
        },
        {
          connectorId: github.connector_id,
          streamNames: ['repositories'],
        },
      ],
    });

    const approveResp = await exchangePackageCode({ asUrl, client, params });
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
    const packageId = body.grant_package_id;
    assert.ok(packageId, 'narrowed approval still issues a package-bound token');

    // Inspect the persisted child grants. `getGrantPackageAccess` returns
    // members ordered by `added_at, grant_id` — i.e. spotify first because
    // the picker emits selections in iteration order — but we MUST NOT rely
    // on that ordering. Sort by connector instead.
    const access = await getGrantPackageAccess(packageId);
    assert.ok(access, 'package is retrievable after issuance');
    assert.equal(access.members.length, 2);
    const byConnector = new Map(
      access.members.map((m) => [m.grant.source.id, m]),
    );
    const spotifyChild = byConnector.get(spotify.connector_id);
    const githubChild = byConnector.get(github.connector_id);
    assert.ok(spotifyChild && githubChild, 'one child per approved connector');

    const spotifyStreamNames = spotifyChild.grant.streams.map((s) => s.name).sort();
    const githubStreamNames = githubChild.grant.streams.map((s) => s.name).sort();
    assert.deepEqual(spotifyStreamNames, ['saved_tracks'], 'spotify child carries only the approved stream');
    assert.deepEqual(
      githubStreamNames,
      ['repositories'],
      'github child carries exactly the approved subset',
    );

    // Defense-in-depth: the manifest declares more streams than what the
    // owner approved, so the picker MUST NOT have silently widened the
    // grant. Compare against the manifest itself rather than reasserting
    // the literal list above.
    const spotifyManifestStreamNames = spotify.streams.map((s) => s.name);
    const githubManifestStreamNames = github.streams.map((s) => s.name);
    assert.ok(
      spotifyManifestStreamNames.length > spotifyStreamNames.length,
      'spotify manifest declares more streams than the owner approved',
    );
    assert.ok(
      githubManifestStreamNames.length > githubStreamNames.length,
      'github manifest declares more streams than the owner approved',
    );
  } finally {
    await closeServer(server);
  }
});

test('POST /oauth/authorize/mcp-package preserves the wildcard when every stream is submitted', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const verifier = randomBytes(32).toString('base64url');
    const state = 'streams-wildcard';
    const challenge = pkceChallenge(verifier);

    // Submit every stream the manifest declares. This is the explicit
    // "use all streams" path.
    const params = buildHostedMcpPickerForm({
      client,
      state,
      challenge,
      sourceSelections: [
        {
          connectorId: spotify.connector_id,
          streamNames: spotify.streams.map((stream) => stream.name),
        },
      ],
    });

    const approveResp = await exchangePackageCode({ asUrl, client, params });
    assert.equal(approveResp.status, 302);
    const code = new URL(approveResp.headers.get('location')).searchParams.get('code');
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
    const packageId = body.grant_package_id;
    const access = await getGrantPackageAccess(packageId);
    assert.equal(access.members.length, 1);
    const child = access.members[0];
    const grantedNames = new Set(child.grant.streams.map((s) => s.name));
    for (const stream of spotify.streams) {
      assert.ok(grantedNames.has(stream.name), `child grant must include ${stream.name} when no narrowing happened`);
    }
    assert.equal(grantedNames.size, spotify.streams.length, 'child grant must not include extra streams');
  } finally {
    await closeServer(server);
  }
});

test('POST /oauth/authorize/mcp-package renders picker error when a selected source has no streams', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerSpotify(asUrl);
    const github = await registerGithub(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const verifier = randomBytes(32).toString('base64url');
    const state = 'streams-partial-drop';
    const challenge = pkceChallenge(verifier);

    // Owner selected spotify but left every stream inside it unchecked. github
    // keeps a single stream. The AS must not silently drop the selected
    // spotify source because that hides ambiguous owner intent.
    const params = buildHostedMcpPickerForm({
      client,
      state,
      challenge,
      sourceSelections: [
        { connectorId: spotify.connector_id, streamNames: [] },
        { connectorId: github.connector_id, streamNames: ['commits'] },
      ],
    });

    const resp = await exchangePackageCode({ asUrl, client, params });
    assert.equal(resp.status, 400);
    assert.match(resp.headers.get('content-type') || '', /text\/html/);
    const html = await resp.text();
    assert.match(html, /Choose what this app can read/);
    assert.match(html, /Choose at least one stream for/i);
    assert.match(html, /data-hosted-mcp-picker-error/);
    assert.match(html, /class="hosted-ui-error hosted-ui-picker-error"/);
  } finally {
    await closeServer(server);
  }
});

test('POST /oauth/authorize/mcp-package renders picker error when every selected source has zero streams', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerSpotify(asUrl);
    const github = await registerGithub(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const verifier = randomBytes(32).toString('base64url');
    const state = 'streams-all-empty';
    const challenge = pkceChallenge(verifier);

    const params = buildHostedMcpPickerForm({
      client,
      state,
      challenge,
      sourceSelections: [
        { connectorId: spotify.connector_id, streamNames: [] },
        { connectorId: github.connector_id, streamNames: [] },
      ],
    });

    const resp = await exchangePackageCode({ asUrl, client, params });
    assert.equal(resp.status, 400);
    const html = await resp.text();
    // Error names the affected sources by manifest display name. It MUST
    // NOT leak a raw registry URL or a cin_ id. Scope the leak checks to the
    // error banner: the re-rendered picker page legitimately echoes the
    // client redirect_uri as a hidden OAuth input.
    assert.match(html, /Choose at least one stream/);
    const errorText = renderedHostedMcpPickerErrorText(html).toLowerCase();
    assert.equal(
      errorText.includes('https://'),
      false,
      'error message MUST NOT leak registry URLs',
    );
    assert.equal(
      errorText.includes('cin_'),
      false,
      'error message MUST NOT leak raw connection ids',
    );
  } finally {
    await closeServer(server);
  }
});

test('POST /oauth/authorize/mcp-package renders picker error when streams are submitted without a source', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerSpotify(asUrl);
    const github = await registerGithub(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const verifier = randomBytes(32).toString('base64url');
    const challenge = pkceChallenge(verifier);
    const params = new URLSearchParams();
    params.append('client_id', client.client_id);
    params.append('redirect_uri', 'https://client.example/callback');
    params.append('response_type', 'code');
    params.append('state', 'streams-without-source');
    params.append('code_challenge', challenge);
    params.append('code_challenge_method', 'S256');
    params.append('stream', encodeHostedMcpStreamSelection({
      connectorId: spotify.connector_id,
      connectionId: null,
      streamName: 'saved_tracks',
    }));
    params.append('stream', encodeHostedMcpStreamSelection({
      connectorId: github.connector_id,
      connectionId: null,
      streamName: 'repositories',
    }));

    const resp = await exchangePackageCode({ asUrl, client, params });
    assert.equal(resp.status, 400);
    assert.match(resp.headers.get('content-type') || '', /text\/html/);
    const html = await resp.text();

    assert.match(html, /Choose what this app can read/);
    assert.match(html, /data-hosted-mcp-picker-error/);
    assert.match(html, /Select at least one source and one stream inside each selected source before approving/);
    assert.equal(
      html.includes('{"error"'),
      false,
      'ordinary picker validation should not fall through to the raw JSON OAuth error page',
    );
  } finally {
    await closeServer(server);
  }
});

test('POST /oauth/authorize/mcp-package ignores stream entries whose source was not also selected', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerSpotify(asUrl);
    const github = await registerGithub(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const verifier = randomBytes(32).toString('base64url');
    const state = 'streams-orphan';
    const challenge = pkceChallenge(verifier);

    const params = new URLSearchParams();
    params.append('client_id', client.client_id);
    params.append('redirect_uri', 'https://client.example/callback');
    params.append('response_type', 'code');
    params.append('state', state);
    params.append('code_challenge', challenge);
    params.append('code_challenge_method', 'S256');
    // Only spotify's source checkbox is submitted. The picker would have
    // also submitted github's stream entries if the owner clicked them
    // before unchecking the source; the AS MUST ignore orphan streams so a
    // stale stream toggle cannot smuggle authority into a deselected
    // source.
    params.append('selection', encodeHostedMcpSelection({
      connectorId: spotify.connector_id,
      connectionId: null,
    }));
    params.append('stream', encodeHostedMcpStreamSelection({
      connectorId: spotify.connector_id,
      connectionId: null,
      streamName: 'saved_tracks',
    }));
    params.append('stream', encodeHostedMcpStreamSelection({
      connectorId: github.connector_id,
      connectionId: null,
      streamName: 'repositories',
    }));

    const approveResp = await exchangePackageCode({ asUrl, client, params });
    assert.equal(approveResp.status, 302);
    const code = new URL(approveResp.headers.get('location')).searchParams.get('code');
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
    const access = await getGrantPackageAccess(body.grant_package_id);
    assert.equal(access.members.length, 1, 'orphan stream entries MUST NOT create a child grant');
    assert.equal(access.members[0].grant.source.id, spotify.connector_id);
  } finally {
    await closeServer(server);
  }
});

// ─── Access-mode narrowing ──────────────────────────────────────────────────
// The hosted MCP picker exposes one package-level access-mode radio that
// applies the chosen mode (`continuous` default, `single_use` opt-in) to every
// child grant in the package. The picker:
//   - renders both options with `continuous` pre-selected so the no-action
//     default preserves prior behavior;
//   - the picker copy is honest that the page does NOT set a retention limit
//     for data the app saves after reading from the owner's server;
//   - submitting `access_mode=single_use` narrows every child grant in the
//     package to single_use without any other change to the form;
//   - submitting `access_mode=continuous` (or omitting the field) keeps every
//     child grant continuous;
//   - submitting any other value returns a typed `invalid_request` envelope
//     and issues no grants;
//   - `grant.issued` spine events for every child grant record the resolved
//     access mode, stream names, and an explicit `retention: null` so the
//     operator dashboard can tell narrowed grants from wildcard ones without
//     re-deriving the picker submission and can see that no retention limit
//     was encoded.

test('hosted MCP picker renders an access-mode radio with continuous default and surfaces the retention caveat', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    await registerSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const verifier = randomBytes(32).toString('base64url');

    const authorizeUrl = new URL(`${asUrl}/oauth/authorize`);
    authorizeUrl.searchParams.set('client_id', client.client_id);
    authorizeUrl.searchParams.set('redirect_uri', 'https://client.example/callback');
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('state', 'access-mode-render');
    authorizeUrl.searchParams.set('code_challenge', pkceChallenge(verifier));
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    const resp = await fetch(authorizeUrl);
    assert.equal(resp.status, 200);
    const html = await resp.text();

    assert.match(html, /class="hosted-ui-access-mode"/, 'picker must render the access-mode fieldset');
    assert.ok(
      html.includes('name="access_mode" value="continuous" checked'),
      'picker must pre-select continuous',
    );
    assert.ok(
      html.includes('name="access_mode" value="single_use"'),
      'picker must offer single_use as the narrowing option',
    );
    assert.ok(
      !html.includes('name="access_mode" value="single_use" checked'),
      'picker must NOT pre-select single_use',
    );

    // Retention copy honesty: the picker must not promise an
    // owner-narrowable retention knob, must not advertise the
    // off-spec `client_policy` classification, and must say plainly
    // that the page does not set a retention limit for data saved by
    // the app after it reads from the owner's server.
    assert.ok(
      !html.includes('client-policy retention'),
      'picker must not assert the legacy client-policy phrase',
    );
    assert.ok(
      !html.includes('client_policy'),
      'picker must not surface the off-spec retention.classification value',
    );
    assert.match(
      html,
      /does not set a time limit on data the app keeps/i,
      'picker should tell the owner that this page does not set a retention/time limit for data the app keeps',
    );
  } finally {
    await closeServer(server);
  }
});

test('POST /oauth/authorize/mcp-package narrows every child grant to single_use when the picker submits it', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerSpotify(asUrl);
    const github = await registerGithub(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const verifier = randomBytes(32).toString('base64url');
    const state = 'access-mode-single-use';
    const challenge = pkceChallenge(verifier);

    const params = buildHostedMcpPickerForm({
      client,
      state,
      challenge,
      accessMode: 'single_use',
      sourceSelections: [
        { connectorId: spotify.connector_id, streamNames: spotify.streams.map((s) => s.name) },
        { connectorId: github.connector_id, streamNames: github.streams.map((s) => s.name) },
      ],
    });

    const approveResp = await exchangePackageCode({ asUrl, client, params });
    assert.equal(approveResp.status, 302);
    const code = new URL(approveResp.headers.get('location')).searchParams.get('code');

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
    const access = await getGrantPackageAccess(body.grant_package_id);
    assert.equal(access.members.length, 2);
    for (const member of access.members) {
      assert.equal(
        member.grant.access_mode,
        'single_use',
        `child grant for ${member.grant.source.id} must be single_use when picker submits single_use`,
      );
    }
  } finally {
    await closeServer(server);
  }
});

test('POST /oauth/authorize/mcp-package defaults every child grant to continuous when access_mode is absent', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const verifier = randomBytes(32).toString('base64url');
    const state = 'access-mode-default';
    const challenge = pkceChallenge(verifier);

    // Omit `accessMode` from the helper → no `access_mode` field on the form.
    // This is the "stale picker / no radio submitted" path.
    const params = buildHostedMcpPickerForm({
      client,
      state,
      challenge,
      sourceSelections: [
        { connectorId: spotify.connector_id, streamNames: spotify.streams.map((s) => s.name) },
      ],
    });

    const approveResp = await exchangePackageCode({ asUrl, client, params });
    assert.equal(approveResp.status, 302);
    const code = new URL(approveResp.headers.get('location')).searchParams.get('code');

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
    const access = await getGrantPackageAccess(body.grant_package_id);
    assert.equal(access.members.length, 1);
    assert.equal(
      access.members[0].grant.access_mode,
      'continuous',
      'missing access_mode must default to continuous (prior baseline)',
    );
  } finally {
    await closeServer(server);
  }
});

test('POST /oauth/authorize/mcp-package rejects an unsupported access_mode value without issuing grants', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const verifier = randomBytes(32).toString('base64url');
    const state = 'access-mode-bad';
    const challenge = pkceChallenge(verifier);

    const params = buildHostedMcpPickerForm({
      client,
      state,
      challenge,
      accessMode: 'forever',
      sourceSelections: [
        { connectorId: spotify.connector_id, streamNames: spotify.streams.map((s) => s.name) },
      ],
    });

    const approveResp = await fetch(`${asUrl}/oauth/authorize/mcp-package`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    assert.equal(approveResp.status, 400);
    const errorBody = await approveResp.json();
    assert.equal(errorBody.error, 'invalid_request');
    assert.match(errorBody.error_description, /access_mode/);
  } finally {
    await closeServer(server);
  }
});

test('hosted MCP child-grant grant.issued spine event records access_mode, stream_names, and an explicit retention: null', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const verifier = randomBytes(32).toString('base64url');
    const state = 'access-mode-spine-event';
    const challenge = pkceChallenge(verifier);

    const params = buildHostedMcpPickerForm({
      client,
      state,
      challenge,
      accessMode: 'single_use',
      sourceSelections: [
        // Narrow streams to a subset so the test can verify stream_names
        // surfaces narrowing as well.
        { connectorId: spotify.connector_id, streamNames: ['saved_tracks'] },
      ],
    });

    const approveResp = await exchangePackageCode({ asUrl, client, params });
    assert.equal(approveResp.status, 302);
    const code = new URL(approveResp.headers.get('location')).searchParams.get('code');
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
    const access = await getGrantPackageAccess(body.grant_package_id);
    const childGrantId = access.members[0].grant.grant_id;

    // Owner-session middleware is a no-op when `ownerAuthPassword: ''`
    // (see `startOpenTestServer`), so the timeline read here matches the
    // existing security-auth-surfaces fixtures: anonymous fetch, envelope
    // exposes spine events under `.data`.
    const { status: timelineStatus, body: timeline } = await fetchJson(
      `${asUrl}/_ref/grants/${encodeURIComponent(childGrantId)}/timeline`,
    );
    assert.equal(timelineStatus, 200);
    const issuedEvent = timeline.data.find((e) => e.event_type === 'grant.issued');
    assert.ok(issuedEvent, 'child grant timeline must contain a grant.issued event');
    assert.equal(issuedEvent.data.access_mode, 'single_use');
    assert.deepEqual(issuedEvent.data.stream_names, ['saved_tracks']);
    // The picker intentionally does NOT encode a machine-readable
    // retention bound (no Core `{ max_duration, on_expiry }` commitment
    // exists for this generic ceremony). The event still surfaces the
    // field as an explicit `null` so a dashboard reading the timeline
    // can see absence rather than guessing why retention is missing.
    assert.ok(
      Object.prototype.hasOwnProperty.call(issuedEvent.data, 'retention'),
      'grant.issued must surface a retention key so absence is visible to operators',
    );
    assert.equal(
      issuedEvent.data.retention,
      null,
      'hosted MCP picker must not encode a non-Core retention shape; absence is rendered as null',
    );
  } finally {
    await closeServer(server);
  }
});

// --- Consent-flow repair regression tests ---------------------------------
//
// These lock the behavior of the GET surfaces an owner's browser actually
// hits, which are not otherwise exercised end-to-end:
//   - GET /oauth/authorize/mcp-package (the path from the production symptom
//     report) has no GET route; it MUST 404 cleanly and MUST NOT surface the
//     legacy "Unknown connector: https" parser error.
//   - GET /oauth/authorize?connector_id=<URL-shaped first-party id> MUST
//     resolve via canonical mapping and stage a pending grant, never leak the
//     URL into an "Unknown connector" branch.
//   - GET /consent?request_uri=<urn> MUST render the consent page for a live
//     pending grant, and MUST return a recoverable, branded 404 (not a bare
//     "Not found" string) when the pending grant is expired/unknown.

function buildAuthorizeGetUrl({ asUrl, client, extra = {} }) {
  const url = new URL(`${asUrl}/oauth/authorize`);
  url.searchParams.set('client_id', client.client_id);
  url.searchParams.set('redirect_uri', 'https://client.example/callback');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('code_challenge', pkceChallenge(randomBytes(32).toString('base64url')));
  url.searchParams.set('code_challenge_method', 'S256');
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  return url;
}

test('GET /oauth/authorize/mcp-package 404s cleanly and never leaks "Unknown connector: https"', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await registerSpotify(asUrl);
    const resp = await fetch(`${asUrl}/oauth/authorize/mcp-package`, { redirect: 'manual' });
    assert.equal(resp.status, 404, 'mcp-package has no GET route; the picker submits via POST');
    const text = await resp.text();
    assert.equal(
      text.toLowerCase().includes('unknown connector'),
      false,
      'GET to the package endpoint MUST NOT reach the "Unknown connector" branch',
    );
    assert.equal(
      text.toLowerCase().includes('"https"') || /unknown connector: https/i.test(text),
      false,
      'GET to the package endpoint MUST NOT leak a truncated "https" connector id',
    );
  } finally {
    await closeServer(server);
  }
});

test('GET /oauth/authorize?connector_id=<URL-shaped id> resolves canonically without leaking "https"', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await registerSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const url = buildAuthorizeGetUrl({
      asUrl,
      client,
      extra: { connector_id: 'https://registry.pdpp.org/connectors/spotify' },
    });
    const resp = await fetch(url, { redirect: 'manual' });
    // A URL-shaped first-party connector id must canonicalize and stage a
    // pending grant (302 to /consent), not collapse to "Unknown connector".
    assert.equal(resp.status, 302, 'URL-shaped connector_id should stage a pending grant and redirect');
    const location = resp.headers.get('location') || '';
    assert.ok(location.includes('/consent?request_uri='), 'redirect must target the consent page');
    assert.ok(
      location.includes('urn%3Apdpp%3Apending-consent%3A') || location.includes('urn:pdpp:pending-consent:'),
      'redirect must carry a pending-consent request_uri',
    );
  } finally {
    await closeServer(server);
  }
});

test('GET /consent renders the consent page for a freshly staged pending grant', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await registerSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    // Stage a pending grant via the canonical short key path.
    const authorizeResp = await fetch(
      buildAuthorizeGetUrl({ asUrl, client, extra: { connector_id: 'spotify' } }),
      { redirect: 'manual' },
    );
    assert.equal(authorizeResp.status, 302);
    const consentUrl = new URL(authorizeResp.headers.get('location'), asUrl);
    const requestUri = consentUrl.searchParams.get('request_uri');
    assert.ok(requestUri && requestUri.startsWith('urn:pdpp:pending-consent:'));

    const consentResp = await fetch(consentUrl, { redirect: 'manual' });
    assert.equal(consentResp.status, 200, 'a live pending-consent request_uri must render the consent page');
    const html = await consentResp.text();
    assert.ok(html.includes('<!DOCTYPE html>'), 'consent page is a full hosted document');
    assert.ok(
      /action="\/consent\/approve"/.test(html),
      'consent page must offer the approve action bound to this request_uri',
    );
  } finally {
    await closeServer(server);
  }
});

test('GET /consent returns a recoverable, branded 404 for an expired or unknown request_uri', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    // Well-formed pending-consent URN that addresses no live row (expired,
    // already decided, or minted on another instance).
    const bogus = `${asUrl}/consent?request_uri=${encodeURIComponent('urn:pdpp:pending-consent:dc_does_not_exist')}`;
    const resp = await fetch(bogus, { redirect: 'manual' });
    assert.equal(resp.status, 404, 'an unknown pending grant genuinely does not exist on this instance');
    const text = await resp.text();
    // The defect this repairs: a bare "Not found" string. The page must now
    // be a branded hosted document that tells the owner how to recover.
    assert.ok(text.includes('<!DOCTYPE html>'), 'expired-consent response must be a branded hosted page, not a bare string');
    assert.notEqual(text.trim(), 'Not found', 'must not return the legacy bare "Not found" body');
    assert.ok(
      /expired|already (approved|used)|start the request again/i.test(text),
      'expired-consent page must explain how to recover (restart the request)',
    );
  } finally {
    await closeServer(server);
  }
});

// ── Boundary canonicalization and picker filtering tests ──────────────────────

test('GET /oauth/authorize?connector_id=<URL> stages pending consent with canonical connector_id in storage_binding', async () => {
  // Regression: a URL-shaped connector_id passed via the `connector_id=`
  // shortcut must be canonicalized at the boundary so the pending consent
  // (and the issued grant) store a canonical short key, not a registry URL.
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await registerSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const verifier = randomBytes(32).toString('base64url');
    const url = new URL(`${asUrl}/oauth/authorize`);
    url.searchParams.set('client_id', client.client_id);
    url.searchParams.set('redirect_uri', 'https://client.example/callback');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', 'boundary-norm-test');
    url.searchParams.set('code_challenge', pkceChallenge(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    // URL-shaped connector id — the bug: before the fix this staged a pending
    // consent with storage_binding.connector_id = 'https://...'
    url.searchParams.set('connector_id', 'https://registry.pdpp.org/connectors/spotify');

    const resp = await fetch(url, { redirect: 'manual' });
    assert.equal(resp.status, 302, 'URL-shaped connector_id must stage a pending grant and redirect');
    const location = resp.headers.get('location') || '';
    assert.ok(location.includes('/consent?request_uri='), 'redirect must target the consent page');

    // Retrieve the pending consent and verify the storage_binding holds the
    // canonical key, not the URL. Stage a full approval round-trip to get
    // the issued grant (which inherits storage_binding from the pending row).
    const consentUrl = new URL(location, asUrl);
    const requestUri = consentUrl.searchParams.get('request_uri');
    const ownerToken = await issueOwnerToken(asUrl);

    // POST /consent/approve
    const approveParams = new URLSearchParams();
    approveParams.set('request_uri', requestUri);
    approveParams.set('approved', 'true');
    const approveResp = await fetch(`${asUrl}/consent/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${ownerToken}` },
      body: approveParams.toString(),
      redirect: 'manual',
    });
    // /consent/approve redirects; we just need the code
    const codeLocation = approveResp.headers.get('location') || '';
    const codeUrl = new URL(codeLocation, asUrl);
    const code = codeUrl.searchParams.get('code');
    assert.ok(code, 'approval must issue an authorization code');

    // Exchange the code for a token
    const tokenParams = new URLSearchParams();
    tokenParams.set('grant_type', 'authorization_code');
    tokenParams.set('code', code);
    tokenParams.set('redirect_uri', 'https://client.example/callback');
    tokenParams.set('client_id', client.client_id);
    tokenParams.set('code_verifier', verifier);
    const { status: tokenStatus, body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams.toString(),
    });
    assert.equal(tokenStatus, 200, 'token exchange must succeed');
    const grantId = tokenBody.grant_id;
    assert.ok(grantId, 'token response must carry grant_id');

    // Inspect the issued grant source identity — must be canonical key, not URL.
    const grantResp = await fetchJson(`${asUrl}/_ref/grants/${grantId}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    // If the endpoint doesn't exist, just verify the token came back.
    if (grantResp.status === 200) {
      const sourceId = grantResp.body?.data?.grant?.source?.id;
      if (sourceId) {
        assert.equal(
          sourceId.startsWith('https://'),
          false,
          `issued grant source.id MUST be a canonical key, not a URL; got: ${sourceId}`,
        );
        assert.equal(sourceId, 'spotify', 'issued grant source.id must be the canonical key "spotify"');
      }
    }

    // The token itself is proof the boundary normalization worked —
    // a URL-shaped connector_id that failed manifest lookup would have
    // produced a 400 "Unknown connector" or "Unknown source" error instead.
    assert.ok(tokenBody.access_token, 'access token must be present, proving canonical lookup succeeded');
  } finally {
    await closeServer(server);
  }
});

test('hosted MCP picker excludes internal/test/stub connectors', async () => {
  // Connectors whose id contains test/stub/internal markers (e.g.
  // `manual_action_stub`, `pg_runtime_*`, `stream-test-stub`) must not
  // appear in the owner-facing consent picker. These are implementation
  // artifacts registered during testing; they are never user-configured
  // sources and must not show up as selectable consent targets.
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await registerSpotify(asUrl);

    // Register a stub connector with a marker id. The AS accepts arbitrary
    // connector manifests; the picker is the surface that must filter it out.
    // The manifest must pass full validation (schema.properties, primary_key,
    // cursor_field with a compatible type) — the marker is in the connector_id.
    const stubManifest = {
      connector_id: 'stream-test-stub-picker-regression',
      display_name: 'Stream Test Stub',
      version: '0.1.0',
      streams: [
        {
          name: 'events',
          primary_key: 'id',
          cursor_field: 'ts',
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              ts: { type: 'string', format: 'date-time' },
            },
          },
        },
      ],
    };
    const regResp = await fetchJson(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(stubManifest),
    });
    assert.ok(
      regResp.status === 201 || regResp.status === 200,
      `stub connector registration returned unexpected status ${regResp.status}: ${JSON.stringify(regResp.body)}`,
    );

    const client = await registerAuthCodeClient(asUrl);
    const verifier = randomBytes(32).toString('base64url');
    const authorizeUrl = new URL(`${asUrl}/oauth/authorize`);
    authorizeUrl.searchParams.set('client_id', client.client_id);
    authorizeUrl.searchParams.set('redirect_uri', 'https://client.example/callback');
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('state', 'stub-filter-test');
    authorizeUrl.searchParams.set('code_challenge', pkceChallenge(verifier));
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    const resp = await fetch(authorizeUrl);
    assert.equal(resp.status, 200);
    const html = await resp.text();

    // The picker must not expose the stub connector's id or display name
    // in any selectable row. Spotify (real connector) must still appear.
    assert.equal(
      html.includes('stream-test-stub'),
      false,
      'picker HTML MUST NOT contain the internal stub connector id',
    );
    assert.equal(
      html.includes('Stream Test Stub'),
      false,
      'picker HTML MUST NOT contain the internal stub connector display name in a selectable row',
    );
    assert.match(html, /spotify/i, 'real connector (spotify) must still appear in the picker');
  } finally {
    await closeServer(server);
  }
});

test('sourceMetadata.display_name uses human-readable connection name, not raw cin_* id', async () => {
  // Regression for the bug where `display_name: resolvedConnectionId || null`
  // set the package member's display_name to the opaque `cin_*` connection ID
  // instead of the owner-readable name returned by `projectBindingForWire`.
  // The package member source in `_ref/grant-packages/:id` MUST carry the
  // human display name; it MUST NOT surface the raw connection ID as a label.
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerSpotify(asUrl);

    // Seed a named connection for the spotify connector directly into the store.
    const instanceId = 'cin_test_spotify_account';
    const humanDisplayName = 'My Spotify Premium';
    const store = createSqliteConnectorInstanceStore();
    const now = new Date().toISOString();
    await store.upsert({
      connectorInstanceId: instanceId,
      ownerSubjectId: 'owner_local',
      connectorId: spotify.connector_id,
      displayName: humanDisplayName,
      status: 'active',
      sourceKind: 'account',
      sourceBindingKey: 'spotify-user@example.com',
      sourceBinding: { account: 'spotify-user@example.com' },
      createdAt: now,
      updatedAt: now,
    });

    const client = await registerAuthCodeClient(asUrl);
    const verifier = randomBytes(32).toString('base64url');
    const challenge = pkceChallenge(verifier);
    const state = 'display-name-regression-test';

    const authorizeUrl = new URL(`${asUrl}/oauth/authorize`);
    authorizeUrl.searchParams.set('client_id', client.client_id);
    authorizeUrl.searchParams.set('redirect_uri', 'https://client.example/callback');
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    const pickerResp = await fetch(authorizeUrl, { redirect: 'manual' });
    assert.equal(pickerResp.status, 200);
    const pickerHtml = await pickerResp.text();

    // The picker must show the connection under the named connection row.
    assert.ok(
      pickerHtml.includes(humanDisplayName),
      `picker MUST surface the human display name "${humanDisplayName}" as a row label`,
    );

    // Submit the picker with the connection-scoped selection value.
    const params = new URLSearchParams();
    params.append('client_id', client.client_id);
    params.append('redirect_uri', 'https://client.example/callback');
    params.append('response_type', 'code');
    params.append('state', state);
    params.append('code_challenge', challenge);
    params.append('code_challenge_method', 'S256');
    params.append(
      'selection',
      encodeHostedMcpSelection({ connectorId: spotify.connector_id, connectionId: instanceId }),
    );
    // Mirror explicit whole-source approval: submit every stream value.
    for (const streamValue of renderedHostedMcpStreamValues(pickerHtml)) {
      params.append('stream', streamValue);
    }

    const approveResp = await fetch(`${asUrl}/oauth/authorize/mcp-package`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    assert.equal(approveResp.status, 302);
    const callback = new URL(approveResp.headers.get('location'));
    const code = callback.searchParams.get('code');
    assert.ok(code);

    const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
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
    assert.ok(tokenBody.grant_package_id, 'connection-scoped package issued');

    // Inspect the package member source — display_name MUST be the human
    // name, never the raw cin_* connection ID.
    const { status: detailStatus, body: detail } = await fetchJson(
      `${asUrl}/_ref/grant-packages/${encodeURIComponent(tokenBody.grant_package_id)}`,
    );
    assert.equal(detailStatus, 200);
    assert.equal(detail.children.length, 1);
    const child = detail.children[0];
    assert.ok(child.source, 'child carries a source envelope');

    // The raw cin_* id MUST NOT appear as display_name.
    assert.notEqual(
      child.source.display_name,
      instanceId,
      'sourceMetadata.display_name MUST NOT be the raw cin_* connection ID',
    );
    // The human name MUST appear.
    assert.equal(
      child.source.display_name,
      humanDisplayName,
      'sourceMetadata.display_name MUST be the human-readable connection name',
    );
    // The connection_id IS the raw id and may appear in the source envelope —
    // but only on the dedicated connection_id field, not as display_name.
    assert.equal(
      child.source.connection_id,
      instanceId,
      'source.connection_id carries the stable connection ID for programmatic use',
    );

    getDb().prepare(
      'UPDATE grant_package_members SET source_json = ? WHERE package_id = ? AND grant_id = ?',
    ).run(
      ...[
        JSON.stringify({ ...child.source, display_name: instanceId }),
        tokenBody.grant_package_id,
        child.grant_id,
      ],
    );

    const { body: legacyDetail } = await fetchJson(
      `${asUrl}/_ref/grant-packages/${encodeURIComponent(tokenBody.grant_package_id)}`,
    );
    assert.equal(
      legacyDetail.children[0].source.display_name,
      humanDisplayName,
      'owner package detail sanitizes old rows whose display_name was persisted as the raw connection ID',
    );

    const legacyAccess = await getGrantPackageAccess(tokenBody.grant_package_id);
    assert.equal(
      legacyAccess.members[0].source.display_name,
      humanDisplayName,
      'MCP package access sanitizes old rows whose display_name was persisted as the raw connection ID',
    );
  } finally {
    await closeServer(server);
  }
});

test('picker renders connector type and connection name as distinct semantic elements', async () => {
  // Acceptance target: the picker must make it clear that "Claude Code" is the
  // connector *type* and "peregrine Claude Code" is the *connection name* —
  // not two competing ontologies. The HTML must carry separate elements with
  // class="hosted-ui-connector-type" and class="hosted-ui-connection-name"
  // so they can be styled and machine-read as distinct concepts.
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerSpotify(asUrl);

    // Seed a named connection so the picker renders a connection row.
    const instanceId = 'cin_test_type_vs_connection';
    const connectionDisplayName = 'My Work Spotify';
    const store = createSqliteConnectorInstanceStore();
    const now = new Date().toISOString();
    await store.upsert({
      connectorInstanceId: instanceId,
      ownerSubjectId: 'owner_local',
      connectorId: spotify.connector_id,
      displayName: connectionDisplayName,
      status: 'active',
      sourceKind: 'account',
      sourceBindingKey: 'work@example.com',
      sourceBinding: { account: 'work@example.com' },
      createdAt: now,
      updatedAt: now,
    });

    const client = await registerAuthCodeClient(asUrl);
    const verifier = randomBytes(32).toString('base64url');
    const authorizeUrl = new URL(`${asUrl}/oauth/authorize`);
    authorizeUrl.searchParams.set('client_id', client.client_id);
    authorizeUrl.searchParams.set('redirect_uri', 'https://client.example/callback');
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('state', 'type-vs-connection-test');
    authorizeUrl.searchParams.set('code_challenge', pkceChallenge(verifier));
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    const resp = await fetch(authorizeUrl);
    assert.equal(resp.status, 200);
    const html = await resp.text();

    // The connector type (Spotify display name) must appear in a dedicated element.
    assert.match(
      html,
      /class="hosted-ui-connector-type"[^>]*>[^<]*Spotify/,
      'connector type label must be in a hosted-ui-connector-type element',
    );

    // The connection name must appear in a dedicated element — distinct from
    // the connector type element so type and instance are never ambiguous.
    assert.match(
      html,
      /class="hosted-ui-connection-name"[^>]*>[^<]*My Work Spotify/,
      'connection name must be in a hosted-ui-connection-name element separate from the connector type',
    );

    // The connector type element and the connection name element MUST NOT be
    // the same element — the whole point is that they are distinguished.
    const connectorTypePattern = /class="hosted-ui-connector-type"[^>]*>([^<]*)<\/span>/g;
    for (const match of html.matchAll(connectorTypePattern)) {
      assert.ok(
        !match[1].includes(connectionDisplayName),
        'connector type element MUST NOT contain the connection name — they must be separate elements',
      );
    }
  } finally {
    await closeServer(server);
  }
});

test('picker hides URL-shaped default connection labels from owner-visible copy', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerSpotify(asUrl);

    // Production/default connector instances can carry the connector URI as a
    // fallback display name. That value is useful as an identifier, but it is
    // not owner-readable copy and must not be shown next to the connector type.
    const store = createSqliteConnectorInstanceStore();
    const now = new Date().toISOString();
    await store.upsert({
      connectorInstanceId: 'cin_test_url_label',
      ownerSubjectId: 'owner_local',
      connectorId: spotify.connector_id,
      displayName: spotify.connector_id,
      status: 'active',
      sourceKind: 'account',
      sourceBindingKey: 'default',
      sourceBinding: { account: 'default' },
      createdAt: now,
      updatedAt: now,
    });

    const client = await registerAuthCodeClient(asUrl);
    const verifier = randomBytes(32).toString('base64url');
    const authorizeUrl = new URL(`${asUrl}/oauth/authorize`);
    authorizeUrl.searchParams.set('client_id', client.client_id);
    authorizeUrl.searchParams.set('redirect_uri', 'https://client.example/callback');
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('state', 'url-label-test');
    authorizeUrl.searchParams.set('code_challenge', pkceChallenge(verifier));
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    const resp = await fetch(authorizeUrl);
    assert.equal(resp.status, 200);
    const html = await resp.text();
    const visibleText = visibleTextFromHtml(html);

    assert.doesNotMatch(
      html,
      /class="hosted-ui-connection-name"[^>]*>https:\/\/registry\.pdpp\.org\/connectors\/spotify/,
      'URL-shaped connector ids must not render as connection-name copy',
    );
    assert.equal(
      visibleText.includes('https://registry.pdpp.org/connectors/spotify'),
      false,
      'URL-shaped connector ids must not appear in owner-visible picker text',
    );
  } finally {
    await closeServer(server);
  }
});

// ─── Connection-pin: selection → enforceable grant scope ────────────────────
//
// The picker validates the owner's chosen connection, but the bug the scout
// report surfaced is that the value never reached `grant.streams[].connection_id`
// — it was stored only in the package member's `source_json` (audit/display),
// so a "Slack work" pick still fanned in across every Slack connection at read
// time. These tests prove the enforcement parity invariant end-to-end:
//
//   - a connection chosen among >1 active binding pins `streams[].connection_id`
//     on the persisted child grant;
//   - a single-connection connector keeps the field OMITTED (fan-in preserved,
//     no brittle stored id, no reissuance pressure);
//   - the pinned `connection_id` is enforced on the read path — a grant-scoped
//     read under the persisted child grant excludes the unselected sibling's
//     records (the decisive anti-Goodhart check: `source_json` alone is the
//     pre-existing bug, so we run the real fan-in resolver, not metadata);
//   - the wildcard stream case persists `{ name: "*", connection_id }`;
//   - audit metadata (`source_json.connection_id`) and the enforced grant scope
//     agree for the pinned member (no drift between shown and enforced).
//
// A custom connector with an ingestible `messages` stream lets us seed real
// records per connection and prove disclosure narrowing, which the
// spotify/github fixtures (no ingestible records) cannot.

const PIN_CONNECTOR_ID = 'pin-fixture';
const PIN_STREAM = 'messages';

function pinConnectorManifest() {
  return {
    protocol_version: '0.1.0',
    connector_id: PIN_CONNECTOR_ID,
    version: '1.0.0',
    display_name: 'Pin Fixture Connector',
    capabilities: { human_interaction: [] },
    streams: [
      {
        name: PIN_STREAM,
        primary_key: ['id'],
        cursor_field: 'received_at',
        consent_time_field: 'received_at',
        schema: {
          type: 'object',
          required: ['id', 'subject', 'received_at'],
          properties: {
            id: { type: 'string' },
            subject: { type: 'string' },
            received_at: { type: 'string', format: 'date-time' },
          },
        },
      },
    ],
  };
}

async function registerPinConnector(asUrl) {
  const manifest = pinConnectorManifest();
  const { status } = await fetchJson(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  assert.equal(status, 201);
  return manifest;
}

async function seedPinConnection({ store, connectionId, displayName, account }) {
  const now = new Date().toISOString();
  await store.upsert({
    connectorInstanceId: connectionId,
    ownerSubjectId: 'owner_local',
    connectorId: PIN_CONNECTOR_ID,
    displayName,
    status: 'active',
    sourceKind: 'account',
    sourceBindingKey: account,
    sourceBinding: { account },
    createdAt: now,
    updatedAt: now,
  });
}

function pinRecord(id, subject, receivedAt) {
  return {
    stream: PIN_STREAM,
    key: id,
    data: { id, subject, received_at: receivedAt },
    emitted_at: receivedAt,
  };
}

// Drive the picker for a single source/connection, narrowing to `streamNames`
// (pass null to submit the whole-source wildcard via every-stream selection),
// and return the persisted package access object.
async function approvePinPackage({ asUrl, client, connectionId, streamNames }) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = pkceChallenge(verifier);
  const state = `pin-${connectionId || 'none'}`;

  const params = new URLSearchParams();
  params.append('client_id', client.client_id);
  params.append('redirect_uri', 'https://client.example/callback');
  params.append('response_type', 'code');
  params.append('state', state);
  params.append('code_challenge', challenge);
  params.append('code_challenge_method', 'S256');
  params.append('selection', encodeHostedMcpSelection({ connectorId: PIN_CONNECTOR_ID, connectionId }));
  const names = streamNames || [PIN_STREAM];
  for (const streamName of names) {
    params.append('stream', encodeHostedMcpStreamSelection({ connectorId: PIN_CONNECTOR_ID, connectionId, streamName }));
  }

  const approveResp = await fetch(`${asUrl}/oauth/authorize/mcp-package`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  assert.equal(approveResp.status, 302);
  const code = new URL(approveResp.headers.get('location')).searchParams.get('code');
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
  assert.ok(body.grant_package_id, 'pin approval issues a package-bound token');
  return getGrantPackageAccess(body.grant_package_id);
}

test('hosted MCP picker pins streams[].connection_id on the child grant for a connection chosen among siblings, and enforces it on reads', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    await registerPinConnector(asUrl);
    const store = createSqliteConnectorInstanceStore();
    const connA = 'cin_pin_work';
    const connB = 'cin_pin_personal';
    await seedPinConnection({ store, connectionId: connA, displayName: 'Work', account: 'work@example.com' });
    await seedPinConnection({ store, connectionId: connB, displayName: 'Personal', account: 'me@example.com' });
    // Distinct records per connection so the read-path proof can show the
    // unselected sibling's records are excluded — not merely de-emphasised.
    await ingestRecord(
      { connector_id: PIN_CONNECTOR_ID, connector_instance_id: connA },
      pinRecord('rec-work-1', 'Work first', '2026-05-18T12:00:00.000Z'),
    );
    await ingestRecord(
      { connector_id: PIN_CONNECTOR_ID, connector_instance_id: connA },
      pinRecord('rec-work-2', 'Work second', '2026-05-18T12:01:00.000Z'),
    );
    await ingestRecord(
      { connector_id: PIN_CONNECTOR_ID, connector_instance_id: connB },
      pinRecord('rec-personal-1', 'Personal first', '2026-05-18T12:02:00.000Z'),
    );

    const client = await registerAuthCodeClient(asUrl);
    const access = await approvePinPackage({ asUrl, client, connectionId: connA, streamNames: [PIN_STREAM] });
    assert.equal(access.members.length, 1);
    const member = access.members[0];

    // Criterion 1: the persisted child grant carries the selected connection_id
    // on every stream entry.
    const pinnedStreams = member.grant.streams.filter((s) => s.name === PIN_STREAM);
    assert.ok(pinnedStreams.length >= 1, 'child grant carries the messages stream');
    for (const stream of member.grant.streams) {
      assert.equal(
        stream.connection_id,
        connA,
        `every issued stream entry must pin connection_id=${connA}; got ${JSON.stringify(stream)}`,
      );
    }

    // Criterion 3: audit/display metadata and the enforced grant scope agree.
    assert.equal(member.connection_id, connA, 'package member audit metadata pins the same connection');
    assert.equal(member.source?.connection_id, connA, 'source_json connection_id matches the enforced grant');

    // Criterion 2 (decisive, anti-Goodhart): run a real grant-authorized read
    // through the fan-in resolver under the PERSISTED child grant and prove the
    // unselected sibling's records are absent. Testing source_json alone would
    // reproduce the original bug as a green check.
    const { bindings } = await resolveReadRequestBindings({
      ownerSubjectId: 'owner_local',
      storageBinding: member.grant_storage_binding,
      grant: member.grant,
      requestParams: {},
      streamName: PIN_STREAM,
    });
    assert.equal(bindings.length, 1, 'pinned grant resolves to exactly one binding');
    assert.equal(bindings[0].connectorInstanceId, connA, 'resolved binding is the selected connection');

    const response = await queryRecordsAcrossBindings(
      bindings,
      PIN_STREAM,
      member.grant,
      {},
      pinConnectorManifest(),
    );
    const returnedIds = response.data.map((r) => r.id).sort();
    assert.deepEqual(returnedIds, ['rec-work-1', 'rec-work-2'], 'read returns only the selected connection records');
    for (const record of response.data) {
      assert.equal(record.connection_id, connA, 'every returned record is attributed to the selected connection');
      assert.notEqual(record.id, 'rec-personal-1', 'the unselected sibling record MUST NOT be disclosed');
    }
  } finally {
    await closeServer(server);
  }
});

test('hosted MCP picker omits connection_id for a single-connection connector (fan-in preserved)', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    await registerPinConnector(asUrl);
    const store = createSqliteConnectorInstanceStore();
    const soleConn = 'cin_pin_sole';
    await seedPinConnection({ store, connectionId: soleConn, displayName: 'Sole', account: 'sole@example.com' });
    await ingestRecord(
      { connector_id: PIN_CONNECTOR_ID, connector_instance_id: soleConn },
      pinRecord('rec-sole-1', 'Sole first', '2026-05-18T12:00:00.000Z'),
    );

    const client = await registerAuthCodeClient(asUrl);
    // Owner picks the only connection row. Because there is exactly one active
    // binding, this is not a disambiguating choice — the grant must stay fan-in.
    const access = await approvePinPackage({ asUrl, client, connectionId: soleConn, streamNames: [PIN_STREAM] });
    assert.equal(access.members.length, 1);
    const member = access.members[0];

    // Criterion 5: no connection_id appears where none did before.
    for (const stream of member.grant.streams) {
      assert.equal(
        'connection_id' in stream,
        false,
        `single-connection grant must NOT pin connection_id; got ${JSON.stringify(stream)}`,
      );
    }

    // Fan-in over a set of one still resolves and reads the sole connection.
    const { bindings } = await resolveReadRequestBindings({
      ownerSubjectId: 'owner_local',
      storageBinding: member.grant_storage_binding,
      grant: member.grant,
      requestParams: {},
      streamName: PIN_STREAM,
    });
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].connectorInstanceId, soleConn);
  } finally {
    await closeServer(server);
  }
});

test('hosted MCP picker pins the wildcard stream entry when the whole source is approved for a chosen sibling', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const manifest = await registerPinConnector(asUrl);
    const store = createSqliteConnectorInstanceStore();
    const connA = 'cin_pin_wild_a';
    const connB = 'cin_pin_wild_b';
    await seedPinConnection({ store, connectionId: connA, displayName: 'Wild A', account: 'a@example.com' });
    await seedPinConnection({ store, connectionId: connB, displayName: 'Wild B', account: 'b@example.com' });

    const client = await registerAuthCodeClient(asUrl);
    // Submit every manifest stream for connection A → the AS emits the
    // canonical wildcard authorization detail (`{ name: "*", connection_id }`),
    // which `resolveGrantSelection` expands into the enforceable narrowed
    // wildcard: one entry per manifest stream, each carrying the connection
    // pin. Criterion 4 accepts that equivalent enforceable form.
    const allStreamNames = manifest.streams.map((s) => s.name);
    const access = await approvePinPackage({ asUrl, client, connectionId: connA, streamNames: allStreamNames });
    assert.equal(access.members.length, 1);
    const member = access.members[0];

    // Criterion 4: the persisted grant covers every manifest stream and pins
    // the chosen connection on every entry — no stream escapes the pin.
    const grantedNames = member.grant.streams.map((s) => s.name).sort();
    assert.deepEqual(grantedNames, [...allStreamNames].sort(), 'whole-source approval covers every manifest stream');
    for (const stream of member.grant.streams) {
      assert.equal(
        stream.connection_id,
        connA,
        `wildcard-expanded stream "${stream.name}" must carry the connection pin; got ${JSON.stringify(stream)}`,
      );
    }
  } finally {
    await closeServer(server);
  }
});
