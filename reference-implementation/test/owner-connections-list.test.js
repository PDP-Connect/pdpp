/**
 * Integration suite for the bearer-authed owner-agent control-surface listing
 * `GET /v1/owner/connections` (mounted from `server/routes/owner-connections.ts`).
 *
 * Covers the Lane B slice of the owner-agent control surface:
 *
 *   - a trusted owner-agent bearer can list configured connection instances;
 *   - client grant tokens and missing/unauthenticated bearers cannot;
 *   - `/mcp` continues to reject owner bearers (the boundary this lane preserves);
 *   - each row exposes `connection_id`, the deprecated `connector_instance_id`
 *     alias, `connector_id`/`connector_key`, `display_name`, lifecycle fields,
 *     and a `label_status` (`owner_set` vs `fallback`);
 *   - two Amazon connections share the `amazon` connector identity but carry
 *     distinct `connection_id` values (multi-connection disambiguation);
 *   - a never-labeled connection (display_name defaulting to the connector id)
 *     reports `label_status: "fallback"` rather than masquerading as owner-set.
 *
 * Spec: openspec/changes/add-owner-agent-control-surface
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { COLLECTOR_PROTOCOL_VERSION } from '../server/collector-protocol.ts';
import { startServer } from '../server/index.js';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';
import { canonicalConnectorKey } from '../server/connector-key.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');
const OWNER_SUBJECT_ID = 'owner_local';
const NOW = '2026-05-31T00:00:00.000Z';

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

async function withServer(fn) {
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:', ownerAuthPassword: '' });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    await fn({ asUrl, rsUrl });
  } finally {
    await closeServer(server);
  }
}

// Device-code exchange yields an owner-kind bearer (pdpp_token_kind: "owner").
// Default subject_id matches the seeded OWNER_SUBJECT_ID so seeded instances
// resolve to the token's owner.
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

// PAR + consent yields a grant-scoped client-kind bearer (pdpp_token_kind:
// "client"). These must NOT reach the owner-agent control surface.
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
        purpose_description: 'owner-connections boundary test',
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

async function seedInstance({ connectorInstanceId, connectorId, displayName, sourceBindingKey, sourceBinding }) {
  const store = createSqliteConnectorInstanceStore();
  await store.upsert({
    connectorInstanceId,
    ownerSubjectId: OWNER_SUBJECT_ID,
    connectorId,
    displayName,
    status: 'active',
    sourceKind: 'account',
    sourceBindingKey,
    sourceBinding: sourceBinding ?? { account_hint: sourceBindingKey },
    createdAt: NOW,
    updatedAt: NOW,
  });
}

test('owner-agent bearer lists a configured connection with full identity + owner_set label', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest('amazon'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_amazon_personal',
      connectorId: connectorKey,
      displayName: 'the owner personal',
      sourceBindingKey: 'the owner@example.com',
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/connections`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    assert.equal(status, 200);
    assert.equal(body.object, 'list');
    assert.equal(body.data.length, 1);
    const row = body.data[0];
    assert.equal(row.object, 'owner_connection');
    assert.equal(row.connection_id, 'cin_amazon_personal');
    // Deprecated alias preserved for compatibility.
    assert.equal(row.connector_instance_id, 'cin_amazon_personal');
    assert.equal(row.connector_id, connectorKey);
    assert.equal(row.connector_key, connectorKey);
    assert.equal(row.display_name, 'the owner personal');
    assert.equal(row.label_status, 'owner_set');
    assert.equal(row.status, 'active');
    assert.equal(row.source_kind, 'account');
    assert.equal(row.schedule, null);

    // Capability-advertised, instance-scoped control actions (task 2.2 /
    // design.md #5). Projected from the same catalog GET /v1/owner/control
    // reads, so the row can never claim a supported action the control
    // document calls unsupported.
    assert.ok(Array.isArray(row.supported_actions), 'row must carry supported_actions');
    const byFamily = new Map(row.supported_actions.map((a) => [a.family, a]));
    // Surface-level families (discover/list/initiate) are NOT instance-scoped
    // and must be absent from a per-connection action list.
    assert.equal(byFamily.has('discover_control_capabilities'), false);
    assert.equal(byFamily.has('list_connections'), false);
    assert.equal(byFamily.has('initiate_connection'), false);
    // rename is supported over the owner-agent bearer and carries THIS
    // connection's concrete URL (placeholder resolved, no `{connection_id}`).
    const rename = byFamily.get('rename_connection');
    assert.ok(rename, 'rename_connection action must be advertised');
    assert.equal(rename.status, 'supported');
    assert.equal(rename.method, 'PATCH');
    assert.ok(rename.url.endsWith('/v1/owner/connections/cin_amazon_personal'), rename.url);
    assert.ok(!rename.url.includes('{connection_id}'), 'placeholder must be resolved');
    // manage_schedule is supported over the owner-agent bearer and carries THIS
    // connection's concrete pause URL (placeholder resolved); the resume sibling
    // is named in the reason (tasks 6.1-6.3).
    const manageSchedule = byFamily.get('manage_schedule');
    assert.ok(manageSchedule, 'manage_schedule action must be advertised');
    assert.equal(manageSchedule.status, 'supported');
    assert.equal(manageSchedule.method, 'POST');
    assert.ok(
      manageSchedule.url.endsWith('/v1/owner/connections/cin_amazon_personal/schedule/pause'),
      manageSchedule.url,
    );
    assert.ok(!manageSchedule.url.includes('{connection_id}'), 'placeholder must be resolved');
    assert.match(manageSchedule.reason, /resume/);
    // run_connection is supported over the owner-agent bearer and carries THIS
    // connection's concrete run URL (placeholder resolved); connector-only
    // addressing is named in the reason (tasks 6.1-6.3).
    const runConnection = byFamily.get('run_connection');
    assert.ok(runConnection, 'run_connection action must be advertised');
    assert.equal(runConnection.status, 'supported');
    assert.equal(runConnection.method, 'POST');
    assert.ok(
      runConnection.url.endsWith('/v1/owner/connections/cin_amazon_personal/run'),
      runConnection.url,
    );
    assert.ok(!runConnection.url.includes('{connection_id}'), 'placeholder must be resolved');
    // inspect_diagnostics is supported and instance-scoped: the per-connection
    // URL resolves to this connection's diagnostics route.
    const inspectDiagnostics = byFamily.get('inspect_diagnostics');
    assert.ok(inspectDiagnostics, 'inspect_diagnostics action must be advertised');
    assert.equal(inspectDiagnostics.status, 'supported');
    assert.equal(inspectDiagnostics.method, 'GET');
    assert.ok(
      inspectDiagnostics.url.endsWith('/v1/owner/connections/cin_amazon_personal/diagnostics'),
      inspectDiagnostics.url,
    );
    assert.ok(!inspectDiagnostics.url.includes('{connection_id}'), 'placeholder must be resolved');
    // revoke_connection is supported and instance-scoped: the per-connection
    // URL resolves to this connection's revoke route.
    const revokeConnection = byFamily.get('revoke_connection');
    assert.ok(revokeConnection, 'revoke_connection action must be advertised');
    assert.equal(revokeConnection.status, 'supported');
    assert.equal(revokeConnection.method, 'POST');
    assert.ok(
      revokeConnection.url.endsWith('/v1/owner/connections/cin_amazon_personal/revoke'),
      revokeConnection.url,
    );
    assert.ok(!revokeConnection.url.includes('{connection_id}'), 'placeholder must be resolved');
    // delete_connection remains a typed unsupported family (named, not omitted).
    assert.equal(byFamily.get('delete_connection')?.status, 'unsupported');
  });
});

test('per-connection supported_actions agree with GET /v1/owner/control', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest('amazon'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_amazon_personal',
      connectorId: connectorKey,
      displayName: 'the owner personal',
      sourceBindingKey: 'the owner@example.com',
    });
    const ownerToken = await issueOwnerToken(asUrl);

    const control = (await fetchJson(`${rsUrl}/v1/owner/control`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    })).body;
    const connections = (await fetchJson(`${rsUrl}/v1/owner/connections`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    })).body;

    const controlByFamily = new Map(control.actions.map((a) => [a.family, a]));
    const row = connections.data.find((r) => r.connection_id === 'cin_amazon_personal');
    // Every instance-scoped action on the row must carry the same status the
    // control document reports for that family — single source of truth.
    for (const action of row.supported_actions) {
      const fromControl = controlByFamily.get(action.family);
      assert.ok(fromControl, `control document must also list ${action.family}`);
      assert.equal(action.status, fromControl.status, `status mismatch for ${action.family}`);
      assert.equal(action.method, fromControl.method, `method mismatch for ${action.family}`);
      assert.equal(action.reason, fromControl.reason, `reason mismatch for ${action.family}`);
    }
    // The control document's rename URL is templated; the row's is concrete.
    assert.ok(controlByFamily.get('rename_connection').url.includes('{connection_id}'));
    assert.ok(
      byFamilyUrl(row, 'rename_connection').endsWith('/v1/owner/connections/cin_amazon_personal'),
    );
  });
});

function byFamilyUrl(row, family) {
  return row.supported_actions.find((a) => a.family === family).url;
}

test('owner-agent bearer sees fallback label_status for a never-labeled connection', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    // display_name left equal to the connector id — the storage default for an
    // unlabeled connection. The surface must report this as label-needed.
    await seedInstance({
      connectorInstanceId: 'cin_spotify_unlabeled',
      connectorId: connectorKey,
      displayName: connectorKey,
      sourceBindingKey: 'acct_unlabeled',
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/connections`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    assert.equal(status, 200);
    const row = body.data.find((r) => r.connection_id === 'cin_spotify_unlabeled');
    assert.ok(row, 'unlabeled connection must appear in the listing');
    assert.equal(row.label_status, 'fallback');
  });
});

test('owner-agent bearer sees fallback label_status for a registry URL display_name', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest('amazon'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_amazon_registry_fallback',
      connectorId: connectorKey,
      displayName: manifest.connector_id,
      sourceBindingKey: 'acct_registry_fallback',
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/connections`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    assert.equal(status, 200);
    const row = body.data.find((r) => r.connection_id === 'cin_amazon_registry_fallback');
    assert.ok(row, 'registry fallback connection must appear in the listing');
    assert.equal(row.display_name, manifest.connector_id);
    assert.equal(row.label_status, 'fallback');
  });
});

test('owner-agent bearer distinguishes two Amazon connections by connection_id', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest('amazon'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_amazon_personal',
      connectorId: connectorKey,
      displayName: 'the owner personal',
      sourceBindingKey: 'the owner@example.com',
    });
    await seedInstance({
      connectorInstanceId: 'cin_amazon_shared',
      connectorId: connectorKey,
      // Distinct binding key so the upsert does not collapse onto the first row.
      displayName: connectorKey, // unlabeled -> fallback
      sourceBindingKey: 'shared@example.com',
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/owner/connections?connector_id=${encodeURIComponent(connectorKey)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );

    assert.equal(status, 200);
    const amazonRows = body.data.filter((r) => r.connector_key === connectorKey);
    assert.equal(amazonRows.length, 2, 'both Amazon connections must be listed');
    const ids = amazonRows.map((r) => r.connection_id).sort();
    assert.deepEqual(ids, ['cin_amazon_personal', 'cin_amazon_shared']);
    // Same connector identity, distinct connection identity.
    assert.ok(amazonRows.every((r) => r.connector_key === connectorKey));
    assert.equal(new Set(ids).size, 2);
    // One labeled, one label-needed — the agent can tell them apart and knows
    // which still needs a label.
    const personal = amazonRows.find((r) => r.connection_id === 'cin_amazon_personal');
    const shared = amazonRows.find((r) => r.connection_id === 'cin_amazon_shared');
    assert.equal(personal.label_status, 'owner_set');
    assert.equal(personal.display_name, 'the owner personal');
    assert.equal(shared.label_status, 'fallback');
  });
});

// Enroll a connector through the REAL binding-aware device-exporter path
// (mint code -> enroll), so the resulting instance's `source_kind` is the one
// the enrollment resolver derived from the manifest, not a seeded value. The
// enrollment-codes route is owner-session authed and defaults the owner subject
// to `owner_local` (no session password in the test server), matching the
// bearer subject issued by `issueOwnerToken`, so the listing resolves to it.
async function enrollThroughBindingAwarePath(asUrl, { connectorId, localBindingName }) {
  const codeResp = await fetchJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connector_id: connectorId, local_binding_name: localBindingName }),
  });
  assert.equal(codeResp.status, 201, JSON.stringify(codeResp.body));
  const enrollResp = await fetchJson(`${asUrl}/_ref/device-exporters/enroll`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-PDPP-Collector-Protocol': COLLECTOR_PROTOCOL_VERSION,
    },
    body: JSON.stringify({ enrollment_code: codeResp.body.enrollment_code }),
  });
  assert.equal(enrollResp.status, 201, JSON.stringify(enrollResp.body));
  return enrollResp.body;
}

// Honesty proof for the browser-collector proof runbook
// (docs/operator/browser-collector-proof-runbook.md). Step 2 / Step 4 tell the
// owner to verify the enrolled Amazon connection is recorded as
// `browser_collector` after the live run. `source_kind` is NOT exposed on the
// device-exporter `source-instances` JSON, so the runbook directs the owner at
// the owner-agent listing. This pins that the binding-aware enrollment path
// surfaces `source_kind: "browser_collector"` end-to-end on
// `GET /v1/owner/connections`, so the runbook's verification step is real and
// no owner SQL is required. It does NOT flip Amazon's intent off `unsupported`.
test('owner-agent bearer sees source_kind=browser_collector for an Amazon connection enrolled through the binding-aware path', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest('amazon'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    const enrolled = await enrollThroughBindingAwarePath(asUrl, {
      connectorId: 'amazon',
      localBindingName: 'the owner-personal-amazon',
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/connections`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    assert.equal(status, 200);
    const row = body.data.find((r) => r.connection_id === enrolled.connector_instance_id);
    assert.ok(row, 'the enrolled Amazon connection must be listed for its owner');
    assert.equal(row.connector_key, connectorKey);
    // The runbook's source-kind verification: the owner-agent API honestly
    // reports browser_collector (not local_device, not account) for a
    // browser-bound connector enrolled through the real path.
    assert.equal(row.source_kind, 'browser_collector');
    assert.notEqual(row.source_kind, 'local_device');
    assert.equal(row.source_binding?.kind, 'browser_collector');
  });
});

test('owner-agent connection listing rejects a client grant token with 403', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest('amazon'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_amazon_personal',
      connectorId: connectorKey,
      displayName: 'the owner personal',
      sourceBindingKey: 'the owner@example.com',
    });
    // A client grant needs a stream to scope to; amazon's first stream suffices.
    const streamName = manifest.streams[0].name;
    const clientToken = await approveClientGrant(asUrl, connectorKey, streamName);

    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/connections`, {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    assert.equal(status, 403);
    assert.equal(body?.error?.code, 'permission_error');
  });
});

test('owner-agent connection listing rejects a request with no bearer (401)', async () => {
  await withServer(async ({ rsUrl }) => {
    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/connections`);
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
