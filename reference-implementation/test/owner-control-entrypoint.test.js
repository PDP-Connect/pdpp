// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

    // Connection-scoped diagnostics is served over the owner-agent bearer surface
    // as of the diagnostics slice (task 6.1d / design "Deferred: connection-scoped
    // diagnostics"). It is templated by connection_id; the representative URL is
    // the connection-scoped route and the reason names the typed health states
    // and the connector-only addressing.
    const inspectDiagnostics = actionByFamily(body, 'inspect_diagnostics');
    assert.ok(inspectDiagnostics, 'inspect_diagnostics must be listed');
    assert.equal(inspectDiagnostics.status, 'supported');
    assert.equal(inspectDiagnostics.method, 'GET');
    assert.equal(inspectDiagnostics.url, `${rsUrl}/v1/owner/connections/{connection_id}/diagnostics`);
    assert.match(inspectDiagnostics.reason, /health/);

    // Connection revoke is served over the owner-agent bearer surface as of the
    // revoke-durability slice (tasks 3.1d/6.1d / design "Deferred:
    // connection-revoke durability"). It is templated by connection_id; the
    // representative URL is the connection-scoped route and the reason states it
    // stops future collection, preserves records, and is reversible only by
    // explicit re-initiate.
    const revokeConnection = actionByFamily(body, 'revoke_connection');
    assert.ok(revokeConnection, 'revoke_connection must be listed');
    assert.equal(revokeConnection.status, 'supported');
    assert.equal(revokeConnection.method, 'POST');
    assert.equal(revokeConnection.url, `${rsUrl}/v1/owner/connections/{connection_id}/revoke`);
    assert.match(revokeConnection.reason, /future collection/i);
    assert.match(revokeConnection.reason, /records/i);

    // Connection delete is served over the owner-agent bearer surface as of the
    // delete-cascade slice (add-owner-connection-delete-contract section 2). It
    // is templated by connection_id; the representative URL is the bare
    // connection resource (REST DELETE verb, no `/delete` suffix) and the reason
    // states it erases the past and removes the configuration (NOT revoke).
    const deleteConnection = actionByFamily(body, 'delete_connection');
    assert.ok(deleteConnection, 'delete_connection must be listed');
    assert.equal(deleteConnection.status, 'supported');
    assert.equal(deleteConnection.method, 'DELETE');
    assert.equal(deleteConnection.url, `${rsUrl}/v1/owner/connections/{connection_id}`);
    assert.match(deleteConnection.reason, /erase/i);
    assert.match(deleteConnection.reason, /NOT revoke/i);

    // Event-subscription management is served over the owner-agent bearer
    // surface: the `/v1/event-subscriptions*` routes already accept a
    // trusted_owner_agent bearer, and the control catalog now advertises that
    // capability (admin-surface audit "one genuine construction gap"). It is a
    // surface-level family (not bound to one connection); the representative URL
    // is the list/create collection route and the reason names the
    // per-subscription and test-event siblings.
    const manageSubscriptions = actionByFamily(body, 'manage_event_subscriptions');
    assert.ok(manageSubscriptions, 'manage_event_subscriptions must be listed');
    assert.equal(manageSubscriptions.status, 'supported');
    assert.equal(manageSubscriptions.method, 'GET');
    assert.equal(manageSubscriptions.url, `${rsUrl}/v1/event-subscriptions`);
    assert.match(manageSubscriptions.reason, /test-event/);
    assert.match(manageSubscriptions.reason, /subscription_id/);
  });
});

test('control document advertises cancel_run honestly: typed, run-scoped, no owner-agent bearer URL', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { body } = await fetchJson(`${rsUrl}/v1/owner/control`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    // cancel_run is served only over the owner-session reference route
    // (`POST /_ref/runs/{run_id}/cancel`) in this tranche; the owner-agent
    // bearer route is deferred (R.2). So the catalog NAMES the action with a
    // typed status but advertises no bearer method/URL — the honesty rule.
    const cancelRun = actionByFamily(body, 'cancel_run');
    assert.ok(cancelRun, 'cancel_run must be named in the catalog');
    assert.equal(cancelRun.status, 'owner_mediated');
    assert.equal(cancelRun.method, null, 'no owner-agent bearer method while only the owner-session route serves it');
    assert.equal(cancelRun.url, null, 'no owner-agent bearer url while only the owner-session route serves it');
    // It is described as run-scoped, non-destructive, and distinct from the
    // connection lifecycle actions.
    assert.match(cancelRun.reason, /run_id/);
    assert.match(cancelRun.reason, /run_connection/);
    assert.match(cancelRun.reason, /revoke_connection/);
    assert.match(cancelRun.reason, /delete_connection/);
  });
});

test('control document names every family with a typed status and a non-empty reason (no silent omission)', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { body } = await fetchJson(`${rsUrl}/v1/owner/control`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    // As of the delete-cascade slice (add-owner-connection-delete-contract
    // section 2) every owner-agent control family is `supported`:
    // `delete_connection` was the last destructive family honestly typed
    // `unsupported`, and its route + store primitive + acceptance-test matrix
    // now land together, so the catalog flips it to `supported`. The
    // no-silent-omission property the catalog guarantees still holds: EVERY
    // family is named, carries a typed status from the known enum, and has a
    // non-empty reason — nothing is dropped.
    const VALID_STATUSES = new Set(['supported', 'owner_mediated', 'unsupported']);
    assert.ok(Array.isArray(body.actions) && body.actions.length > 0, 'catalog must enumerate families');
    for (const action of body.actions) {
      assert.ok(typeof action.family === 'string' && action.family.length > 0, 'every family is named');
      assert.ok(VALID_STATUSES.has(action.status), `${action.family} carries a typed status`);
      assert.ok(typeof action.reason === 'string' && action.reason.length > 0, `${action.family} carries a non-empty reason`);
      // A non-supported family must not advertise a route; a supported one must.
      if (action.status === 'supported') {
        assert.ok(action.method, `${action.family} supported → method present`);
        assert.ok(action.url, `${action.family} supported → url present`);
      } else {
        assert.equal(action.url, null, `${action.family} not supported → no url`);
      }
    }

    // delete_connection is specifically the formerly-unsupported destructive
    // family that is now named-and-supported (the overclaim guard inverted: it
    // is no longer faked as unsupported now that the cascade is proven).
    const del = actionByFamily(body, 'delete_connection');
    assert.ok(del, 'delete_connection must be named in the catalog');
    assert.equal(del.status, 'supported');
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

test('manage_event_subscriptions advertisement is honest: owner bearer is accepted on the route, /mcp rejects it', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);

    // (1) The control catalog advertises the family as supported, pointing at
    // the real `/v1/event-subscriptions` collection route.
    const control = await fetchJson(`${rsUrl}/v1/owner/control`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const manageSubscriptions = actionByFamily(control.body, 'manage_event_subscriptions');
    assert.ok(manageSubscriptions, 'manage_event_subscriptions must be advertised');
    assert.equal(manageSubscriptions.status, 'supported');
    assert.equal(manageSubscriptions.url, `${rsUrl}/v1/event-subscriptions`);

    // (2) The advertisement is honest: a trusted owner-agent bearer is actually
    // accepted on the advertised route (it can list its subscriptions; here zero
    // exist, so an empty data array, not a 401/403).
    const ownerList = await fetchJson(`${rsUrl}/v1/event-subscriptions`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(ownerList.status, 200, 'owner bearer must be accepted on /v1/event-subscriptions');
    assert.ok(Array.isArray(ownerList.body.data), 'listing returns a data array');
    assert.equal(ownerList.body.data.length, 0, 'no subscriptions configured yet');

    // (3) The credential boundary is preserved: the same owner bearer cannot
    // reach event-subscription tools over /mcp — /mcp rejects owner bearers by
    // construction, so advertising the REST control family does not widen /mcp.
    const mcp = await fetchJson(`${rsUrl}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(mcp.status, 403, '/mcp must still reject owner bearers');
    assert.equal(mcp.body?.error?.code, 'permission_error');
    assert.match(mcp.body?.error?.message ?? '', /owner-agent/i);
  });
});

test('manage_event_subscriptions is a surface family, never projected onto a connection row', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/connections`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    // Surface-level families (discover/list/initiate/manage_event_subscriptions)
    // must not leak into a connection's instance-scoped supported_actions, even
    // when configured connections exist.
    for (const connection of body.data ?? []) {
      const families = (connection.supported_actions ?? []).map((a) => a.family);
      assert.ok(
        !families.includes('manage_event_subscriptions'),
        'manage_event_subscriptions must not appear in per-connection supported_actions',
      );
    }
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
