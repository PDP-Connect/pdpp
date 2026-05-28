import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { getGrantPackageAccess, revokeGrant, revokeGrantPackage } from '../server/auth.js';
import {
  encodeHostedMcpSelection,
  encodeHostedMcpStreamSelection,
} from '../server/hosted-mcp-selection.js';
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

async function fetchJson(url, opts = {}) {
  const resp = await fetch(url, opts);
  const body = await resp.json();
  return { resp, status: resp.status, body };
}

function pkceChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function registerSpotify(asUrl) {
  const manifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'));
  const { status } = await fetchJson(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  assert.equal(status, 201);
  return manifest;
}

async function registerGithub(asUrl) {
  const manifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/github.json'), 'utf8'));
  const { status } = await fetchJson(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  assert.equal(status, 201);
  return manifest;
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
  return body;
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
  assert.ok(body.access_token);
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || null,
    grantId: body.grant_id,
    code,
  };
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
  // The picker renders per-stream checkboxes for each source, pre-checked,
  // so an owner who clicks "Approve" without narrowing submits one
  // `stream=<encoded>` entry per (source, stream). Mirror that here so this
  // helper tests the no-narrowing path; tests for narrowing construct their
  // own forms instead of going through this helper.
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
  // Scrape every pre-checked stream form value from the rendered picker and
  // submit them. This is what a browser would do for "approve everything".
  const streamRegex = /name="stream" value="([^"]+)" checked/g;
  for (const match of pickerHtml.matchAll(streamRegex)) {
    params.append('stream', match[1]);
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

async function postMcpJson(rsUrl, token, message) {
  const resp = await fetch(`${rsUrl}/mcp`, {
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

    const tools = await postMcpJson(rsUrl, accessToken, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });
    assert.equal(tools.status, 200);
    const toolNames = tools.body.result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(toolNames, [
      'create_event_subscription',
      'delete_event_subscription',
      'discover_event_subscription_capabilities',
      'fetch',
      'fetch_blob',
      'get_event_subscription',
      'list_event_subscriptions',
      'list_streams',
      'query_records',
      'schema',
      'search',
      'send_test_event',
      'update_event_subscription',
    ]);

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
    const manifest = await registerSpotify(asUrl);
    assert.match(manifest.connector_id, /^https?:\/\//, 'precondition: first-party manifest carries URL-shaped id');
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
    params.append('selection', `connection:${manifest.connector_id}:conn_owner_local`);

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
    assert.match(html, /Choose what this MCP client can read/);
    assert.match(html, /class="hosted-ui-option-group"/);
    assert.match(html, /class="hosted-ui-option"/);
    assert.match(html, /class="hosted-ui-button" data-variant="primary"/);

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

    const cssResp = await fetch(`${asUrl}/__pdpp/hosted-ui.css`);
    assert.equal(cssResp.status, 200);
    const css = await cssResp.text();
    assert.match(css, /\.hosted-ui-option-group/);
    assert.match(css, /\.hosted-ui-option\b/);
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
    assert.equal(missing.body.error.resource_metadata, `${rsUrl}/.well-known/oauth-protected-resource/mcp`);
    const mcpMetadata = await fetchProtectedResourceMetadata(missing.body.error.resource_metadata);
    assert.equal(mcpMetadata.resource, `${rsUrl}/mcp`);
    assert.deepEqual(mcpMetadata.pdpp_token_kinds_supported, ['client', 'mcp_package']);
    assert.equal(mcpMetadata.pdpp_agent_discovery.mcp.endpoint, `${rsUrl}/mcp`);

    const ownerToken = await issueOwnerToken(asUrl);
    const owner = await postMcpJson(rsUrl, ownerToken, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });
    assert.equal(owner.status, 403);
    assert.equal(owner.body.error.code, 'permission_error');
  } finally {
    await closeServer(server);
  }
});

test('dynamic registration accepts only public authorization-code and refresh-token metadata', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    await registerAuthCodeClient(asUrl);
    const noRefresh = await registerAuthCodeClient(asUrl, { refreshToken: false });
    assert.deepEqual(noRefresh.grant_types, ['authorization_code']);

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
    assert.ok(schemaData?.data?.package?.grant_package, 'schema response carries package metadata');
    assert.equal(schemaData.data.package.member_count, 2);
    const schemaConnectorIds = new Set(
      (schemaData.data.streams || []).map((s) => s.source?.connector_id).filter(Boolean),
    );
    assert.ok(schemaConnectorIds.has(spotify.connector_id), 'schema fanout includes spotify streams');
    assert.ok(schemaConnectorIds.has(github.connector_id), 'schema fanout includes github streams');
    const schemaGrantIds = new Set(
      (schemaData.data.streams || []).map((s) => s.source?.grant_id).filter(Boolean),
    );
    assert.equal(schemaGrantIds.size, 2, 'each stream is tagged with its child grant_id');

    // list_streams fan-out: rows tagged + meta.package.member_count = 2.
    const listCall = await postMcpJson(rsUrl, accessToken, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_streams', arguments: {} },
    });
    assert.equal(listCall.status, 200);
    const listData = listCall.body.result.structuredContent.data;
    assert.equal(listData?.meta?.package?.member_count, 2);
    const listConnectorIds = new Set(
      (listData.data || []).map((row) => row.source?.connector_id).filter(Boolean),
    );
    assert.ok(listConnectorIds.has(spotify.connector_id));
    assert.ok(listConnectorIds.has(github.connector_id));

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
    assert.equal(refreshedSchemaData.data.package.member_count, 2);
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
    assert.equal(beforeData.data.package.member_count, 2);
    const childGrants = beforeData.data.package.sources.map((s) => ({
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
    assert.equal(afterData.data.package.member_count, 1, 'revoked child is no longer counted in the package fanout');
    const afterConnectorIds = new Set(afterData.data.streams.map((s) => s.source?.connector_id));
    assert.ok(!afterConnectorIds.has(spotify.connector_id), 'spotify streams are absent after its child grant is revoked');
    assert.ok(afterConnectorIds.has(github.connector_id), 'github streams still present');
    const afterSourceConnectorIds = afterData.data.package.sources.map((s) => s.connector_id);
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

// Stream-narrowing inside the hosted MCP picker.
//
// `completeMultiSourcePackageFlow` above always submits the wildcard form by
// implicitly accepting every stream the picker pre-checks. These tests prove
// the rest of the matrix:
//
//   - the picker renders an owner-controllable checkbox per manifest stream
//     and pre-checks them all (the default == "no narrowing");
//   - the POST handler narrows a child grant when a subset of streams is
//     submitted;
//   - leaving every stream checked for a source preserves the canonical
//     wildcard so future manifest revisions extend cleanly;
//   - deselecting every stream for one source drops that source from the
//     package without affecting other sources;
//   - deselecting every stream across all selected sources returns a typed
//     `invalid_request` envelope that names the affected sources by manifest
//     display name (no raw URLs, no cin_ ids).

function buildHostedMcpPickerForm({
  client,
  state,
  challenge,
  sourceSelections,
}) {
  const params = new URLSearchParams();
  params.append('client_id', client.client_id);
  params.append('redirect_uri', 'https://client.example/callback');
  params.append('response_type', 'code');
  params.append('state', state);
  params.append('code_challenge', challenge);
  params.append('code_challenge_method', 'S256');
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

test('hosted MCP picker renders a per-stream checkbox per source, pre-checked', async () => {
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

    // The picker MUST render the per-source <fieldset> grouping that holds
    // both the source toggle and the per-stream checkboxes.
    assert.match(html, /class="hosted-ui-option-source"/, 'picker must wrap each row in the fieldset');
    assert.match(html, /class="hosted-ui-option-streams"/, 'picker must render the per-source stream block');
    assert.match(html, /class="hosted-ui-stream-option"/, 'picker must render at least one stream checkbox');

    // Every manifest stream for a selected source must be rendered, and the
    // checkbox MUST be pre-checked so the no-action default still authorizes
    // every stream (matches prior behavior; narrowing is opt-in).
    for (const stream of spotify.streams) {
      const streamFormValue = encodeHostedMcpStreamSelection({
        connectorId: spotify.connector_id,
        connectionId: null,
        streamName: stream.name,
      });
      assert.ok(
        html.includes(`name="stream" value="${streamFormValue}" checked`),
        `picker must render a pre-checked stream checkbox for spotify::${stream.name}`,
      );
    }
    for (const stream of github.streams) {
      const streamFormValue = encodeHostedMcpStreamSelection({
        connectorId: github.connector_id,
        connectionId: null,
        streamName: stream.name,
      });
      assert.ok(
        html.includes(`name="stream" value="${streamFormValue}" checked`),
        `picker must render a pre-checked stream checkbox for github::${stream.name}`,
      );
    }

    // Owner-facing risk copy should mention per-stream narrowing now that
    // the picker offers it.
    assert.match(html, /uncheck/i, 'picker risk copy should mention deselecting streams');
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
    // free-form: any subset of pre-checked streams may be submitted.
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
          streamNames: ['repositories', 'starred_repos'],
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
      ['repositories', 'starred_repos'],
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

test('POST /oauth/authorize/mcp-package preserves the wildcard when every stream stays checked', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const verifier = randomBytes(32).toString('base64url');
    const state = 'streams-wildcard';
    const challenge = pkceChallenge(verifier);

    // Submit every stream the manifest declares. The picker default leaves
    // all streams pre-checked, so this is the "no narrowing" path.
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

test('POST /oauth/authorize/mcp-package drops a source whose streams are all unchecked but keeps the others', async () => {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerSpotify(asUrl);
    const github = await registerGithub(asUrl);
    const client = await registerAuthCodeClient(asUrl);

    const verifier = randomBytes(32).toString('base64url');
    const state = 'streams-partial-drop';
    const challenge = pkceChallenge(verifier);

    // Owner toggled the spotify source checkbox but unchecked every stream
    // inside it. github keeps a single stream. Result: package contains
    // only the github child grant; the spotify source is silently dropped
    // because the owner expressed "no streams" for it.
    const params = buildHostedMcpPickerForm({
      client,
      state,
      challenge,
      sourceSelections: [
        { connectorId: spotify.connector_id, streamNames: [] },
        { connectorId: github.connector_id, streamNames: ['commits'] },
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
    assert.equal(access.members.length, 1, 'only the source with selected streams becomes a child grant');
    const child = access.members[0];
    assert.equal(child.grant.source.id, github.connector_id);
    const streamNames = child.grant.streams.map((s) => s.name).sort();
    assert.deepEqual(streamNames, ['commits']);
  } finally {
    await closeServer(server);
  }
});

test('POST /oauth/authorize/mcp-package returns a typed error when every selected source has zero streams', async () => {
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
    const respBody = await resp.json();
    assert.equal(respBody.error, 'invalid_request');
    assert.ok(typeof respBody.error_description === 'string');
    // Error names the affected sources by manifest display name. It MUST
    // NOT leak a raw registry URL or a cin_ id.
    assert.match(respBody.error_description, /Select at least one stream/);
    assert.equal(
      respBody.error_description.toLowerCase().includes('https://'),
      false,
      'error message MUST NOT leak registry URLs',
    );
    assert.equal(
      respBody.error_description.toLowerCase().includes('cin_'),
      false,
      'error message MUST NOT leak raw connection ids',
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
