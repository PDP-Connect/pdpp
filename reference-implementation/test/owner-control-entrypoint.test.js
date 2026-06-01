/**
 * Integration suite for the bearer-authed owner-agent control entrypoint
 * `GET /v1/owner/control` (mounted from `server/routes/owner-control.ts`) and
 * the `pdpp_owner_agent_onboarding.control_surface` discovery hint.
 *
 * Covers the control-entrypoint slice of the owner-agent control surface:
 *
 *   - a trusted owner-agent bearer can fetch the control capability document;
 *   - client grant tokens and missing/unauthenticated bearers cannot;
 *   - `/mcp` continues to reject owner bearers (the boundary this lane preserves);
 *   - the document marks supported families (`discover_control_capabilities`,
 *     `list_connections`) with method + absolute URL, and names every other
 *     family explicitly with an `owner_mediated`/`unsupported` status rather than
 *     silently omitting it;
 *   - the supported `list_connections` URL points at `/v1/owner/connections`;
 *   - the composed-mode discovery metadata advertises the same control entrypoint
 *     and action catalog, so discovery and the live document agree.
 *
 * Spec: openspec/changes/add-owner-agent-control-surface
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');
const OWNER_SUBJECT_ID = 'owner_local';

async function closeServer(server) {
  server.schedulerManager?.stop?.();
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
}

async function fetchJson(url, opts = {}) {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { body, resp, status: resp.status };
}

async function withServer(fn, startOpts = {}) {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    ownerAuthPassword: '',
    ...startOpts,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    await fn({ asUrl, rsUrl, server });
  } finally {
    await closeServer(server);
  }
}

async function issueOwnerToken(asUrl, subjectId = OWNER_SUBJECT_ID) {
  const clientId = 'cli_longview';
  const device = (await fetchJson(`${asUrl}/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId }).toString(),
  })).body;
  await fetch(`${asUrl}/device/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user_code: device.user_code, subject_id: subjectId }).toString(),
  });
  const tok = (await fetchJson(`${asUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.device_code,
      client_id: clientId,
    }).toString(),
  })).body;
  assert.ok(tok.access_token, 'device exchange should issue an owner token');
  return tok.access_token;
}

function loadManifest(name) {
  return JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, '..', 'packages', 'polyfill-connectors', 'manifests', `${name}.json`), 'utf8'),
  );
}

async function registerConnector(asUrl, manifest) {
  const resp = await fetch(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  assert.equal(resp.status, 201, `register ${manifest.connector_id} failed: ${resp.status}`);
  return manifest;
}

// PAR + consent yields a grant-scoped client-kind bearer. It must NOT reach the
// owner-agent control entrypoint. Scopes to a real registered connector/stream.
async function approveClientGrant(asUrl, connectorId, streamName) {
  const par = (await fetchJson(`${asUrl}/oauth/par`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: 'longview',
      authorization_details: [{
        type: 'https://pdpp.org/data-access',
        source: { kind: 'connector', id: connectorId },
        purpose_code: 'https://pdpp.org/purpose/analytics',
        purpose_description: 'owner-control boundary test',
        access_mode: 'continuous',
        streams: [{ name: streamName, fields: ['id'] }],
      }],
    }),
  })).body;
  const approved = (await fetchJson(`${asUrl}/consent/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_uri: par.request_uri, subject_id: OWNER_SUBJECT_ID }),
  })).body;
  assert.ok(approved.token, 'consent approval should issue a client grant token');
  return approved.token;
}

function actionByFamily(doc, family) {
  return doc.actions.find((a) => a.family === family);
}

test('owner-agent bearer fetches the control capability document', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/control`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    assert.equal(status, 200);
    assert.equal(body.object, 'owner_agent_control_surface');
    assert.equal(body.scope, 'reference_implementation');
    assert.equal(body.mcp_owner_bearer_rejected, true);
    assert.equal(body.entrypoint, `${rsUrl}/v1/owner/control`);
    assert.ok(Array.isArray(body.actions) && body.actions.length > 0);
  });
});

test('control document marks supported families with method + absolute URL', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { body } = await fetchJson(`${rsUrl}/v1/owner/control`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    const discover = actionByFamily(body, 'discover_control_capabilities');
    assert.ok(discover, 'discover_control_capabilities must be listed');
    assert.equal(discover.status, 'supported');
    assert.equal(discover.method, 'GET');
    assert.equal(discover.url, `${rsUrl}/v1/owner/control`);

    // The already-supported owner-agent route must be linked, by URL, so an
    // agent does not have to guess where connection listing lives.
    const listConnections = actionByFamily(body, 'list_connections');
    assert.ok(listConnections, 'list_connections must be listed');
    assert.equal(listConnections.status, 'supported');
    assert.equal(listConnections.method, 'GET');
    assert.equal(listConnections.url, `${rsUrl}/v1/owner/connections`);

    // Rename is served over the owner-agent bearer surface as of the
    // owner-agent rename slice (task 4.4). It is templated by connection_id so
    // the URL carries a literal `{connection_id}` placeholder, not a live id.
    const rename = actionByFamily(body, 'rename_connection');
    assert.ok(rename, 'rename_connection must be listed');
    assert.equal(rename.status, 'supported');
    assert.equal(rename.method, 'PATCH');
    assert.equal(rename.url, `${rsUrl}/v1/owner/connections/{connection_id}`);

    // Connection initiation is served over the owner-agent bearer surface as of
    // the connection-initiation slice (tasks 2.3, 5.1-5.4). The intent route
    // returns a typed owner-mediated next step; it never marks a connection
    // active.
    const initiate = actionByFamily(body, 'initiate_connection');
    assert.ok(initiate, 'initiate_connection must be listed');
    assert.equal(initiate.status, 'supported');
    assert.equal(initiate.method, 'POST');
    assert.equal(initiate.url, `${rsUrl}/v1/owner/connections/intents`);

    // Schedule pause/resume is served over the owner-agent bearer surface as of
    // the instance-scoped schedule slice (tasks 6.1-6.3). It is templated by
    // connection_id; the representative URL is the pause route and the reason
    // names the resume sibling.
    const manageSchedule = actionByFamily(body, 'manage_schedule');
    assert.ok(manageSchedule, 'manage_schedule must be listed');
    assert.equal(manageSchedule.status, 'supported');
    assert.equal(manageSchedule.method, 'POST');
    assert.equal(manageSchedule.url, `${rsUrl}/v1/owner/connections/{connection_id}/schedule/pause`);
    assert.match(manageSchedule.reason, /resume/);

    // Run-now is served over the owner-agent bearer surface as of the run
    // control slice (tasks 6.1-6.3). It is templated by connection_id; the
    // representative URL is the connection-scoped route and the reason names the
    // connector-only addressing.
    const runConnection = actionByFamily(body, 'run_connection');
    assert.ok(runConnection, 'run_connection must be listed');
    assert.equal(runConnection.status, 'supported');
    assert.equal(runConnection.method, 'POST');
    assert.equal(runConnection.url, `${rsUrl}/v1/owner/connections/{connection_id}/run`);
    assert.match(runConnection.reason, /connector_id/);
  });
});

test('control document names unsupported/owner-mediated families instead of omitting them', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { body } = await fetchJson(`${rsUrl}/v1/owner/control`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    // Important admin tasks the change explicitly does NOT overclaim in this
    // branch must be present and typed, not silently dropped.
    // `rename_connection`, `initiate_connection`, `manage_schedule`, and
    // `run_connection` are intentionally NOT in this list anymore: all are now
    // served over the owner-agent bearer surface (tasks 4.4, 2.3/5.x, 6.1-6.3)
    // and are asserted as `supported` in the "supported families" test above.
    for (const family of [
      'inspect_diagnostics',
      'delete_connection',
      'revoke_connection',
    ]) {
      const action = actionByFamily(body, family);
      assert.ok(action, `${family} must be named in the catalog`);
      assert.notEqual(action.status, 'supported', `${family} must not be overclaimed as supported`);
      assert.ok(['owner_mediated', 'unsupported'].includes(action.status));
      // No supported route → no URL to probe.
      assert.equal(action.url, null);
      assert.ok(action.reason.length > 0, `${family} must carry a non-empty reason`);
    }
  });
});

test('owner-agent control entrypoint rejects a client grant token with 403', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest('amazon'));
    const clientToken = await approveClientGrant(asUrl, manifest.connector_id, manifest.streams[0].name);
    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/control`, {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    assert.equal(status, 403);
    assert.equal(body?.error?.code, 'permission_error');
  });
});

test('owner-agent control entrypoint rejects a request with no bearer (401)', async () => {
  await withServer(async ({ rsUrl }) => {
    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/control`);
    assert.equal(status, 401);
    assert.equal(body?.error?.type, 'authentication_error');
  });
});

test('/mcp continues to reject owner-agent bearers (boundary preserved)', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(`${rsUrl}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(status, 403);
    assert.equal(body?.error?.code, 'permission_error');
    assert.match(body?.error?.message ?? '', /owner-agent/i);
  });
});

test('discovery metadata advertises the same control entrypoint and catalog', async () => {
  const publicOrigin = 'http://localhost:3219';
  await withServer(
    async ({ rsUrl }) => {
      const { status, body } = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
      assert.equal(status, 200);
      const onboarding = body.pdpp_owner_agent_onboarding;
      assert.ok(onboarding, 'composed mode must advertise owner-agent onboarding');
      const surface = onboarding.control_surface;
      assert.ok(surface, 'onboarding block must carry a control_surface hint');
      assert.equal(surface.object, 'owner_agent_control_surface');
      assert.equal(surface.entrypoint, `${publicOrigin}/v1/owner/control`);
      assert.equal(surface.mcp_owner_bearer_rejected, true);

      // The discovery hint and the live document must agree on the supported
      // list_connections route. (The live document is fetched against the
      // ephemeral rsUrl; the hint is rebased to the composed public origin, so
      // compare path suffixes.)
      const listConnections = surface.actions.find((a) => a.family === 'list_connections');
      assert.ok(listConnections);
      assert.equal(listConnections.status, 'supported');
      assert.equal(listConnections.url, `${publicOrigin}/v1/owner/connections`);
    },
    { referenceMode: 'composed', referenceOrigin: publicOrigin }
  );
});
