import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { revokeGrant } from '../server/auth.js';
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
    assert.deepEqual(toolNames, ['fetch', 'fetch_blob', 'list_streams', 'query_records', 'schema', 'search']);

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
    assert.deepEqual(mcpMetadata.pdpp_token_kinds_supported, ['client']);
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
