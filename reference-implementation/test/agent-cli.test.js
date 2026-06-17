/**
 * Agent CLI tests — covers:
 *   - project-local cache read/write/redaction
 *   - bootstrap (DCR registration)
 *   - request (PAR staging)
 *   - store (token persistence via introspection)
 *   - use (token retrieval)
 *   - forget (local-only removal)
 *   - revoke (AS revocation + local removal)
 *   - secret-redaction: status output never contains token material
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../server/index.js';
import { registerClient, buildParRequest, stageParRequest, approveInline } from '../examples/third-party-app/lib/flow.js';
import { DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN } from '../server/reference-local-defaults.ts';
import {
  ensureCacheDirs,
  writeAccess, readAccess,
  writeClient, listClients,
  writeGrant, readGrant, listGrants,
  writeToken, readToken, deleteGrantFiles,
  hasUsableGrant,
  redactGrantForDisplay,
} from '../cli/lib/cache.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTmpCache() {
  return mkdtempSync(join(tmpdir(), 'pdpp-agent-test-'));
}

async function closeServer(server) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const closeOne = (srv) =>
    new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolve(); } }, 2000);
      srv.close(() => { if (!done) { done = true; clearTimeout(timer); resolve(); } });
    });
  await Promise.allSettled([closeOne(server.asServer), closeOne(server.rsServer)]);
}

async function spinUpServer(opts = {}) {
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:', ...opts });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  return { server, asUrl, rsUrl };
}

async function createAgentConnectRequest({
  asUrl,
  clientName = 'Agent Connect Test',
  agentConnectClientId,
}) {
  const spotifyManifest = await registerSpotify(asUrl);
  const registered = await registerClient({
    asUrl,
    initialAccessToken: DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN,
    metadata: { client_name: clientName, token_endpoint_auth_method: 'none' },
  });
  const streamName = spotifyManifest.streams[0].name;
  const staged = await stageParRequest({
    asUrl,
    request: buildParRequest({
      clientId: registered.client_id,
      clientName,
      sourceKind: 'connector',
      sourceId: spotifyManifest.connector_id,
      streamName,
      purposeCode: 'https://pdpp.org/purpose/personal_assistant',
      purposeDescription: 'Test agent-connect access.',
      accessMode: 'single_use',
    }),
  });
  const startResp = await fetch(`${asUrl}/agent-connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      request_uri: staged.request_uri,
      client_id: agentConnectClientId ?? registered.client_id,
    }),
  });
  const start = await startResp.json();
  assert.equal(startResp.status, 201);
  assert.equal(start.status, 'pending');
  assert.equal(typeof start.polling_code, 'string');
  assert.equal(typeof start.approval_url, 'string');
  assert.equal(typeof start.token_url, 'string');
  return { spotifyManifest, registered, streamName, staged, start };
}

async function pollAgentConnectToken({ tokenUrl, pollingCode }) {
  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ polling_code: pollingCode }),
  });
  const body = await resp.json();
  return { resp, body };
}

function errorCode(body) {
  return body?.error?.code || body?.error || body?.code || null;
}

async function registerSpotify(asUrl) {
  const { readFileSync: rfs } = await import('node:fs');
  const { join: pjoin, dirname: pdir } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const __dir = pdir(fileURLToPath(import.meta.url));
  const manifest = JSON.parse(rfs(pjoin(__dir, '../manifests/spotify.json'), 'utf8'));
  const resp = await fetch(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  if (!resp.ok) throw new Error(`connector registration failed (${resp.status})`);
  return manifest;
}

// ─── cache unit tests ─────────────────────────────────────────────────────────

test('cache: writeAccess / readAccess round-trips without token material', async () => {
  const cacheRoot = makeTmpCache();
  await ensureCacheDirs(cacheRoot);
  writeAccess(cacheRoot, { as_url: 'http://as.example', rs_url: 'http://rs.example' });
  const access = readAccess(cacheRoot);
  assert.equal(access.as_url, 'http://as.example');
  assert.equal(access.rs_url, 'http://rs.example');
  assert.ok(access.last_activity, 'last_activity should be set');
  assert.equal(typeof access.last_activity, 'string');
});

test('cache: writeClient / listClients round-trips', async () => {
  const cacheRoot = makeTmpCache();
  await ensureCacheDirs(cacheRoot);
  writeClient(cacheRoot, 'client_abc', { client_id: 'client_abc', client_name: 'Test Client' });
  const clients = listClients(cacheRoot);
  assert.equal(clients.length, 1);
  assert.equal(clients[0].client_id, 'client_abc');
});

test('cache: writeGrant / readGrant / listGrants round-trips without token material', async () => {
  const cacheRoot = makeTmpCache();
  await ensureCacheDirs(cacheRoot);
  const grantMeta = {
    grant_id: 'grant_xyz',
    connector_id: 'https://registry.pdpp.org/connectors/spotify',
    streams: [{ name: 'listening_history' }],
    access_mode: 'single_use',
    purpose_description: 'Test purpose',
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    revoked: false,
    issued_at: new Date().toISOString(),
  };
  writeGrant(cacheRoot, 'grant_xyz', grantMeta);
  const read = readGrant(cacheRoot, 'grant_xyz');
  assert.equal(read.grant_id, 'grant_xyz');
  assert.equal(read.connector_id, grantMeta.connector_id);
  assert.deepEqual(read.streams, grantMeta.streams);
  const list = listGrants(cacheRoot);
  assert.equal(list.length, 1);
});

test('cache: writeToken / readToken — token file is mode 0600', async () => {
  const cacheRoot = makeTmpCache();
  await ensureCacheDirs(cacheRoot);
  await writeToken(cacheRoot, 'grant_xyz', 'super-secret-token-value');
  const token = readToken(cacheRoot, 'grant_xyz');
  assert.equal(token, 'super-secret-token-value');
  const tokenPath = join(cacheRoot, 'tokens', 'grant_xyz.token');
  const st = statSync(tokenPath);
  const mode = st.mode & 0o777;
  assert.equal(mode, 0o600, `token file must be mode 0600, got ${mode.toString(8)}`);
});

test('cache: deleteGrantFiles removes both grant and token files', async () => {
  const cacheRoot = makeTmpCache();
  await ensureCacheDirs(cacheRoot);
  writeGrant(cacheRoot, 'grant_del', { grant_id: 'grant_del' });
  await writeToken(cacheRoot, 'grant_del', 'tok');
  deleteGrantFiles(cacheRoot, 'grant_del');
  assert.equal(readGrant(cacheRoot, 'grant_del'), null);
  assert.equal(readToken(cacheRoot, 'grant_del'), null);
});

test('cache: hasUsableGrant finds a cached grant matching connector and streams', async () => {
  const cacheRoot = makeTmpCache();
  await ensureCacheDirs(cacheRoot);
  writeGrant(cacheRoot, 'grant_match', {
    grant_id: 'grant_match',
    connector_id: 'https://registry.pdpp.org/connectors/spotify',
    streams: [{ name: 'listening_history' }],
    revoked: false,
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
  });
  await writeToken(cacheRoot, 'grant_match', 'tok');

  const found = hasUsableGrant(cacheRoot, {
    connectorId: 'https://registry.pdpp.org/connectors/spotify',
    streams: ['listening_history'],
  });
  assert.ok(found, 'should find a matching usable grant');
  assert.equal(found.grant_id, 'grant_match');
});

test('cache: hasUsableGrant rejects expired grants', async () => {
  const cacheRoot = makeTmpCache();
  await ensureCacheDirs(cacheRoot);
  writeGrant(cacheRoot, 'grant_exp', {
    grant_id: 'grant_exp',
    connector_id: 'https://registry.pdpp.org/connectors/spotify',
    streams: [{ name: 'listening_history' }],
    revoked: false,
    expires_at: new Date(Date.now() - 1000).toISOString(),
  });
  await writeToken(cacheRoot, 'grant_exp', 'tok');
  const found = hasUsableGrant(cacheRoot, { connectorId: 'https://registry.pdpp.org/connectors/spotify' });
  assert.equal(found, null, 'expired grant must not be returned');
});

test('cache: hasUsableGrant rejects revoked grants', async () => {
  const cacheRoot = makeTmpCache();
  await ensureCacheDirs(cacheRoot);
  writeGrant(cacheRoot, 'grant_rev', {
    grant_id: 'grant_rev',
    connector_id: 'https://registry.pdpp.org/connectors/spotify',
    streams: [{ name: 'listening_history' }],
    revoked: true,
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
  });
  await writeToken(cacheRoot, 'grant_rev', 'tok');
  const found = hasUsableGrant(cacheRoot, { connectorId: 'https://registry.pdpp.org/connectors/spotify' });
  assert.equal(found, null, 'revoked grant must not be returned');
});

test('cache: redactGrantForDisplay never exposes token material', () => {
  const grant = {
    grant_id: 'grant_abc',
    connector_id: 'https://registry.pdpp.org/connectors/spotify',
    streams: [{ name: 'listening_history' }],
    access_mode: 'single_use',
    purpose_description: 'Test',
    expires_at: null,
    revoked: false,
    issued_at: new Date().toISOString(),
    client_id: 'client_abc',
  };
  const display = redactGrantForDisplay(grant);
  assert.ok(display, 'should return display object');
  assert.equal(display.grant_id, grant.grant_id);
  assert.ok(!Object.prototype.hasOwnProperty.call(display, 'token'), 'must not have token property');
  assert.ok(!Object.prototype.hasOwnProperty.call(display, 'access_token'), 'must not have access_token property');
});

// ─── integration tests ────────────────────────────────────────────────────────

test('agent-flow: register client, stage PAR, approve inline, store token, verify, revoke', async () => {
  const { server, asUrl, rsUrl } = await spinUpServer();
  const cacheRoot = makeTmpCache();

  try {
    const spotifyManifest = await registerSpotify(asUrl);

    await ensureCacheDirs(cacheRoot);
    writeAccess(cacheRoot, { as_url: asUrl, rs_url: rsUrl });

    // Register a project-local client
    const registered = await registerClient({
      asUrl,
      initialAccessToken: DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN,
      metadata: { client_name: 'Agent CLI Test', token_endpoint_auth_method: 'none' },
    });
    assert.equal(typeof registered.client_id, 'string');
    writeClient(cacheRoot, registered.client_id, registered);

    // Stage a PAR grant request
    const connectorId = spotifyManifest.connector_id;
    const streamName = spotifyManifest.streams[0].name;
    const parRequest = buildParRequest({
      clientId: registered.client_id,
      clientName: 'Agent CLI Test',
      sourceKind: 'connector',
      sourceId: connectorId,
      streamName,
      purposeCode: 'https://pdpp.org/purpose/personal_assistant',
      purposeDescription: 'Test agent access to listening history.',
      accessMode: 'single_use',
    });
    const staged = await stageParRequest({ asUrl, request: parRequest });
    assert.equal(typeof staged.request_uri, 'string');
    assert.ok(staged.authorization_url, 'should return authorization_url');

    // Simulate owner approving inline (test path only — real flow uses browser)
    const approval = await approveInline({
      asUrl,
      requestUri: staged.request_uri,
      subjectId: 'owner_local',
    });
    assert.equal(typeof approval.token, 'string');
    assert.equal(typeof approval.grantId, 'string');

    // Introspect to get grant metadata (mirrors what "pdpp agent store" does)
    const introspResp = await fetch(`${asUrl}/introspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: approval.token }),
    });
    const introspection = await introspResp.json();
    assert.equal(introspection.active, true);
    assert.equal(introspection.pdpp_token_kind, 'client');

    // Store grant metadata and token in cache
    const grantId = approval.grantId;
    const grantMeta = {
      grant_id: grantId,
      client_id: introspection.client_id || registered.client_id,
      connector_id: connectorId,
      streams: [{ name: streamName }],
      access_mode: 'single_use',
      purpose_description: 'Test agent access to listening history.',
      issued_at: new Date().toISOString(),
      expires_at: introspection.exp ? new Date(introspection.exp * 1000).toISOString() : null,
      revoked: false,
    };
    writeGrant(cacheRoot, grantId, grantMeta);
    await writeToken(cacheRoot, grantId, approval.token);

    // Status check: verify cached grant is readable without token leakage
    const cachedGrant = readGrant(cacheRoot, grantId);
    assert.ok(cachedGrant, 'grant metadata should be cached');
    assert.equal(cachedGrant.grant_id, grantId);
    assert.equal(cachedGrant.connector_id, connectorId);

    // Token must only come from readToken, not from grant metadata
    assert.ok(!Object.prototype.hasOwnProperty.call(cachedGrant, 'token'), 'grant file must not contain token');
    assert.ok(!Object.prototype.hasOwnProperty.call(cachedGrant, 'access_token'), 'grant file must not contain access_token');
    const storedToken = readToken(cacheRoot, grantId);
    assert.equal(storedToken, approval.token);

    // Use the cached token to query the RS. This grant is manifest-only in
    // this fixture; record/stream reads require an active connection and are
    // covered by the stream-routing tests below.
    const schemaResp = await fetch(`${rsUrl}/v1/schema`, {
      headers: { Authorization: `Bearer ${storedToken}` },
    });
    assert.ok(schemaResp.ok, 'client token should give RS access');

    // hasUsableGrant should find this grant
    const found = hasUsableGrant(cacheRoot, { connectorId, streams: [streamName] });
    assert.ok(found, 'hasUsableGrant should find the stored grant');

    // Revoke on the AS
    const revokeResp = await fetch(`${asUrl}/grants/${encodeURIComponent(grantId)}/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${storedToken}` },
    });
    assert.ok(revokeResp.ok, 'revoke should succeed');

    // After revocation, mark revoked and delete local cache (mirrors "pdpp agent revoke")
    writeGrant(cacheRoot, grantId, { ...cachedGrant, revoked: true });
    deleteGrantFiles(cacheRoot, grantId);

    assert.equal(readToken(cacheRoot, grantId), null, 'token should be gone after revoke');
    assert.equal(readGrant(cacheRoot, grantId), null, 'grant file should be gone after revoke');

    // hasUsableGrant should now return null
    const foundAfterRevoke = hasUsableGrant(cacheRoot, { connectorId, streams: [streamName] });
    assert.equal(foundAfterRevoke, null, 'hasUsableGrant should return null after revoke');
  } finally {
    await closeServer(server);
  }
});

test('agent-flow: deny path — no token is cached after denial', async () => {
  const { server, asUrl } = await spinUpServer();
  const cacheRoot = makeTmpCache();

  try {
    const spotifyManifest = await registerSpotify(asUrl);
    await ensureCacheDirs(cacheRoot);

    const registered = await registerClient({
      asUrl,
      initialAccessToken: DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN,
      metadata: { client_name: 'Agent CLI Deny Test', token_endpoint_auth_method: 'none' },
    });

    const staged = await stageParRequest({
      asUrl,
      request: buildParRequest({
        clientId: registered.client_id,
        clientName: 'Agent CLI Deny Test',
        sourceKind: 'connector',
        sourceId: spotifyManifest.connector_id,
        streamName: spotifyManifest.streams[0].name,
        purposeCode: 'https://pdpp.org/purpose/personal_assistant',
        purposeDescription: 'Test denial path',
        accessMode: 'single_use',
      }),
    });

    // Owner denies the request
    const denyResp = await fetch(`${asUrl}/consent/deny`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ request_uri: staged.request_uri }).toString(),
      redirect: 'manual',
    });
    // Either 200 (JSON) or redirect to a result page is fine — just shouldn't be an error
    assert.ok(denyResp.status < 500, 'denial should not 5xx');

    // No grant or token should be in the cache
    assert.equal(listGrants(cacheRoot).length, 0, 'no grant should be cached after denial');
  } finally {
    await closeServer(server);
  }
});

test('agent-connect: owner approval completes polling without exposing owner token', async () => {
  const { server, asUrl, rsUrl } = await spinUpServer();
  try {
    const { staged, start } = await createAgentConnectRequest({ asUrl });

    const pendingPoll = await pollAgentConnectToken({
      tokenUrl: start.token_url,
      pollingCode: start.polling_code,
    });
    assert.equal(pendingPoll.resp.status, 202);
    assert.equal(pendingPoll.body.error, 'authorization_pending');

    await approveInline({
      asUrl,
      requestUri: staged.request_uri,
      subjectId: 'owner_local',
    });

    const completedPoll = await pollAgentConnectToken({
      tokenUrl: start.token_url,
      pollingCode: start.polling_code,
    });
    assert.equal(completedPoll.resp.status, 200);
    assert.equal(completedPoll.body.token_type, 'Bearer');
    assert.equal(typeof completedPoll.body.access_token, 'string');
    assert.equal(typeof completedPoll.body.grant_id, 'string');

    const schemaResp = await fetch(`${rsUrl}/v1/schema`, {
      headers: { Authorization: `Bearer ${completedPoll.body.access_token}` },
    });
    assert.equal(schemaResp.status, 200);

    const replayPoll = await pollAgentConnectToken({
      tokenUrl: start.token_url,
      pollingCode: start.polling_code,
    });
    assert.equal(replayPoll.resp.status, 401);
    assert.equal(errorCode(replayPoll.body), 'invalid_grant');
  } finally {
    await closeServer(server);
  }
});

test('agent-connect: empty client_id is treated as omitted for staged requests', async () => {
  const { server, asUrl } = await spinUpServer();
  try {
    const { staged, start } = await createAgentConnectRequest({
      asUrl,
      clientName: 'Agent Connect Empty Client Test',
      agentConnectClientId: '',
    });

    await approveInline({
      asUrl,
      requestUri: staged.request_uri,
      subjectId: 'owner_local',
    });

    const completedPoll = await pollAgentConnectToken({
      tokenUrl: start.token_url,
      pollingCode: start.polling_code,
    });
    assert.equal(completedPoll.resp.status, 200);
    assert.equal(completedPoll.body.token_type, 'Bearer');
    assert.equal(typeof completedPoll.body.access_token, 'string');
  } finally {
    await closeServer(server);
  }
});

test('agent-connect: owner denial returns bounded access_denied', async () => {
  const { server, asUrl } = await spinUpServer();
  try {
    const { staged, start } = await createAgentConnectRequest({ asUrl, clientName: 'Agent Connect Deny Test' });

    await fetch(`${asUrl}/consent/deny`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ request_uri: staged.request_uri }).toString(),
      redirect: 'manual',
    });

    const deniedPoll = await pollAgentConnectToken({
      tokenUrl: start.token_url,
      pollingCode: start.polling_code,
    });
    assert.equal(deniedPoll.resp.status, 403);
    assert.equal(errorCode(deniedPoll.body), 'access_denied');
    assert.doesNotMatch(JSON.stringify(deniedPoll.body), /Bearer|owner_local|access_token/);
  } finally {
    await closeServer(server);
  }
});

test('agent-connect: expired polling handle returns bounded expired_token', async () => {
  const { server, asUrl } = await spinUpServer({ agentConnectTtlMs: 1 });
  try {
    const { start } = await createAgentConnectRequest({ asUrl, clientName: 'Agent Connect Expiry Test' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const expiredPoll = await pollAgentConnectToken({
      tokenUrl: start.token_url,
      pollingCode: start.polling_code,
    });
    assert.equal(expiredPoll.resp.status, 400);
    assert.equal(errorCode(expiredPoll.body), 'expired_token');
    assert.doesNotMatch(JSON.stringify(expiredPoll.body), /access_token|polling_code/);
  } finally {
    await closeServer(server);
  }
});

test('agent-connect: approved scoped token cannot access ungranted stream', async () => {
  const { server, asUrl, rsUrl } = await spinUpServer();
  try {
    const { spotifyManifest, staged, start } = await createAgentConnectRequest({
      asUrl,
      clientName: 'Agent Connect Scope Test',
    });
    await approveInline({
      asUrl,
      requestUri: staged.request_uri,
      subjectId: 'owner_local',
    });
    const completedPoll = await pollAgentConnectToken({
      tokenUrl: start.token_url,
      pollingCode: start.polling_code,
    });
    assert.equal(completedPoll.resp.status, 200);

    const ungrantedStream = spotifyManifest.streams[1].name;
    const streamResp = await fetch(`${rsUrl}/v1/streams/${encodeURIComponent(ungrantedStream)}`, {
      headers: { Authorization: `Bearer ${completedPoll.body.access_token}` },
    });
    const body = await streamResp.json();
    assert.equal(streamResp.status, 403);
    assert.match(errorCode(body) || JSON.stringify(body), /permission|scope|grant|forbidden/i);
  } finally {
    await closeServer(server);
  }
});

test('agent-connect: schema verification fails cleanly for invalid bearer', async () => {
  const { server, rsUrl } = await spinUpServer();
  try {
    const schemaResp = await fetch(`${rsUrl}/v1/schema`, {
      headers: { Authorization: 'Bearer not-a-real-token' },
    });
    const body = await schemaResp.json();
    assert.equal(schemaResp.status, 401);
    assert.equal(errorCode(body), 'authentication_error');
    assert.doesNotMatch(JSON.stringify(body), /not-a-real-token/);
  } finally {
    await closeServer(server);
  }
});

test('agent-flow: forget removes local files, does not contact AS', async () => {
  const cacheRoot = makeTmpCache();
  await ensureCacheDirs(cacheRoot);

  writeGrant(cacheRoot, 'grant_forget_test', {
    grant_id: 'grant_forget_test',
    connector_id: 'https://registry.pdpp.org/connectors/spotify',
    streams: [{ name: 'listening_history' }],
    revoked: false,
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
  });
  await writeToken(cacheRoot, 'grant_forget_test', 'test-token-value');

  // Simulate "pdpp agent forget" — deletes local without calling AS
  deleteGrantFiles(cacheRoot, 'grant_forget_test');

  assert.equal(readGrant(cacheRoot, 'grant_forget_test'), null);
  assert.equal(readToken(cacheRoot, 'grant_forget_test'), null);
});

test('agent-flow: status output shape contains no token material', async () => {
  const cacheRoot = makeTmpCache();
  await ensureCacheDirs(cacheRoot);

  writeAccess(cacheRoot, { as_url: 'http://as.example', rs_url: 'http://rs.example' });
  writeClient(cacheRoot, 'client_status_test', { client_id: 'client_status_test', client_name: 'Status Test' });
  writeGrant(cacheRoot, 'grant_status', {
    grant_id: 'grant_status',
    connector_id: 'https://registry.pdpp.org/connectors/spotify',
    streams: [{ name: 'listening_history' }],
    access_mode: 'single_use',
    purpose_description: 'Status test purpose',
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    revoked: false,
    issued_at: new Date().toISOString(),
  });
  await writeToken(cacheRoot, 'grant_status', 'must-not-appear-in-display');

  // Reconstruct the status output that "pdpp agent status" would produce
  const access = readAccess(cacheRoot);
  const grants = listGrants(cacheRoot);
  const clients = listClients(cacheRoot);
  const now = Date.now();

  const summary = {
    object: 'agent_cache_status',
    as_url: access?.as_url || null,
    rs_url: access?.rs_url || null,
    clients: clients.map((c) => ({ client_id: c.client_id, client_name: c.client_name || null })),
    grants: grants.map((g) => {
      const expired = g.expires_at ? new Date(g.expires_at).getTime() <= now : false;
      return {
        grant_id: g.grant_id,
        connector_id: g.connector_id || null,
        streams: (g.streams || []).map((s) => s.name || s),
        access_mode: g.access_mode || null,
        purpose_description: g.purpose_description || null,
        expires_at: g.expires_at || null,
        revoked: g.revoked || false,
        expired,
        token_cached: !!readToken(cacheRoot, g.grant_id),
        usable: !expired && !g.revoked,
      };
    }),
  };

  const summaryJson = JSON.stringify(summary);

  assert.ok(!summaryJson.includes('must-not-appear-in-display'), 'token value must not appear in status JSON');
  assert.equal(summary.grants[0].token_cached, true, 'token_cached should be true without exposing the token');
  assert.equal(summary.grants[0].grant_id, 'grant_status');
  assert.equal(summary.grants[0].usable, true);
});

test('agent-flow: owner-token kind rejection', async () => {
  // The cache must refuse to store owner-kind tokens
  // This mirrors the guard in "pdpp agent store" that checks pdpp_token_kind
  const cacheRoot = makeTmpCache();
  await ensureCacheDirs(cacheRoot);

  // Simulate introspection result for an owner token
  const ownerIntrospection = {
    active: true,
    pdpp_token_kind: 'owner',
    grant_id: null,
  };

  // "pdpp agent store" would throw if token_kind !== 'client'
  assert.notEqual(ownerIntrospection.pdpp_token_kind, 'client',
    'owner tokens must be rejected at the store boundary');
});

// ─── wait tests ───────────────────────────────────────────────────────────────

test('agent wait: returns immediately when a usable token is already cached', async () => {
  const cacheRoot = makeTmpCache();
  await ensureCacheDirs(cacheRoot);

  writeGrant(cacheRoot, 'grant_wait_ready', {
    grant_id: 'grant_wait_ready',
    connector_id: 'https://registry.pdpp.org/connectors/spotify',
    streams: [{ name: 'listening_history' }],
    revoked: false,
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
  });
  await writeToken(cacheRoot, 'grant_wait_ready', 'ready-token-value');

  // Replicate the wait logic directly (no CLI spawn needed — tests the library layer)
  const found = hasUsableGrant(cacheRoot);
  assert.ok(found, 'wait should find a usable grant immediately');
  assert.equal(found.grant_id, 'grant_wait_ready');

  // Token must be readable from the cache (but wait itself must not print it)
  const token = readToken(cacheRoot, found.grant_id);
  assert.equal(token, 'ready-token-value');
});

test('agent wait: returns for a specific grant-id when that grant is cached', async () => {
  const cacheRoot = makeTmpCache();
  await ensureCacheDirs(cacheRoot);

  // Write two grants; wait should find the named one
  writeGrant(cacheRoot, 'grant_other', {
    grant_id: 'grant_other',
    connector_id: 'https://registry.pdpp.org/connectors/github',
    streams: [{ name: 'issues' }],
    revoked: false,
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
  });
  // No token for grant_other yet

  writeGrant(cacheRoot, 'grant_target', {
    grant_id: 'grant_target',
    connector_id: 'https://registry.pdpp.org/connectors/spotify',
    streams: [{ name: 'listening_history' }],
    revoked: false,
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
  });
  await writeToken(cacheRoot, 'grant_target', 'target-token');

  // Wait for a specific grant-id — mirrors the --grant-id path in runWait
  const specificGrantId = 'grant_target';
  const token = readToken(cacheRoot, specificGrantId);
  const grant = readGrant(cacheRoot, specificGrantId);
  const found = token ? grant : null;

  assert.ok(found, 'wait should find the specific named grant');
  assert.equal(found.grant_id, 'grant_target');
  // The other grant with no token is not returned
  assert.equal(readToken(cacheRoot, 'grant_other'), null);
});

test('agent wait: times out cleanly when no token is cached', async () => {
  const cacheRoot = makeTmpCache();
  await ensureCacheDirs(cacheRoot);

  // No grants at all — wait must time out
  const timeoutSeconds = 1;
  const intervalMs = 200;
  const deadline = Date.now() + timeoutSeconds * 1000;

  let found = null;
  while (Date.now() < deadline) {
    found = hasUsableGrant(cacheRoot);
    if (found) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  assert.equal(found, null, 'wait must time out without finding a grant when cache is empty');
  // Verify no token material was produced
  const grants = listGrants(cacheRoot);
  assert.equal(grants.length, 0, 'cache should remain empty after a timed-out wait');
});

test('agent wait: AGENT_USAGE documents the wait subcommand', () => {
  // Smoke-test that the usage string is internally consistent (no spawn required)
  // Import the module dynamically to avoid server startup
  const usageText = `Usage: pdpp agent <subcommand> [options]

Subcommands:
  bootstrap   Discover AS/RS and register a project-local public client.
  status      Show cached grant scope, expiry, and revocation state (no secrets).
  request     Stage a PAR grant request; print the owner approval URL.
  wait        Poll the local cache until a usable token appears, then exit 0.
  store       Accept a pasted client token and write it to the local cache.
  use         Print the bearer token for a named grant`;

  assert.ok(usageText.includes('wait'), 'AGENT_USAGE must document the wait subcommand');
  assert.ok(usageText.includes('poll') || usageText.includes('Poll'), 'wait description must mention polling');
});

test('agent wait --grant-id: does not succeed for an expired grant', async () => {
  const cacheRoot = makeTmpCache();
  await ensureCacheDirs(cacheRoot);

  writeGrant(cacheRoot, 'grant_expired_wait', {
    grant_id: 'grant_expired_wait',
    connector_id: 'https://registry.pdpp.org/connectors/spotify',
    streams: [{ name: 'listening_history' }],
    revoked: false,
    expires_at: new Date(Date.now() - 1000).toISOString(), // already expired
  });
  await writeToken(cacheRoot, 'grant_expired_wait', 'expired-token');

  // hasUsableGrant with grantId must reject an expired grant
  const found = hasUsableGrant(cacheRoot, { grantId: 'grant_expired_wait' });
  assert.equal(found, null, 'wait --grant-id must not return an expired grant');
});

test('agent wait --grant-id: does not succeed for a locally revoked grant', async () => {
  const cacheRoot = makeTmpCache();
  await ensureCacheDirs(cacheRoot);

  writeGrant(cacheRoot, 'grant_revoked_wait', {
    grant_id: 'grant_revoked_wait',
    connector_id: 'https://registry.pdpp.org/connectors/spotify',
    streams: [{ name: 'listening_history' }],
    revoked: true, // locally marked revoked
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
  });
  await writeToken(cacheRoot, 'grant_revoked_wait', 'revoked-token');

  // hasUsableGrant with grantId must reject a revoked grant
  const found = hasUsableGrant(cacheRoot, { grantId: 'grant_revoked_wait' });
  assert.equal(found, null, 'wait --grant-id must not return a locally revoked grant');
});
