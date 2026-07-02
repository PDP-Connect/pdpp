/**
 * Integration suite for the bearer-authed owner-agent connector-template
 * listing `GET /v1/owner/connector-templates`.
 *
 * This is the template half of the owner-agent control shape: agents can see
 * connector types separately from configured connection instances and can tell
 * whether adding a new connection is supported, owner-mediated, or currently
 * unsupported before probing an action.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { canonicalConnectorKey } from '../server/connector-key.js';
import { startServer } from '../server/index.js';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');
const OWNER_SUBJECT_ID = 'owner_local';
const NOW = '2026-06-01T00:00:00.000Z';

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
        purpose_description: 'owner-connector-template boundary test',
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

async function seedInstance({ connectorInstanceId, connectorId, displayName, sourceBindingKey }) {
  const store = createSqliteConnectorInstanceStore();
  await store.upsert({
    connectorInstanceId,
    ownerSubjectId: OWNER_SUBJECT_ID,
    connectorId,
    displayName,
    status: 'active',
    sourceKind: 'account',
    sourceBindingKey,
    sourceBinding: { account_hint: sourceBindingKey },
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function byConnector(body, connectorKey) {
  const row = body.data.find((item) => item.connector_key === connectorKey);
  assert.ok(row, `expected connector template ${connectorKey}`);
  return row;
}

function actionByFamily(row, family) {
  const action = row.supported_actions.find((item) => item.family === family);
  assert.ok(action, `expected supported_actions.${family}`);
  return action;
}

test('owner-agent bearer lists connector templates with related connection summaries', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const amazonManifest = await registerConnector(asUrl, loadManifest('amazon'));
    const amazonKey = canonicalConnectorKey(amazonManifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_amazon_personal',
      connectorId: amazonKey,
      displayName: 'the owner personal',
      sourceBindingKey: 'the owner@example.com',
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/connector-templates`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    assert.equal(status, 200);
    assert.equal(body.object, 'list');

    const amazon = byConnector(body, 'amazon');
    assert.equal(amazon.object, 'owner_connector_template');
    assert.equal(amazon.connector_id, 'amazon');
    assert.equal(amazon.display_name, 'Amazon');
    assert.equal(amazon.connector_modality, 'browser_bound');
    assert.equal(amazon.setup_plan.setup_modality, 'static_secret');
    assert.equal(amazon.setup_plan.support_state, 'proof_gated');
    assert.equal(amazon.setup_plan.next_step_kind, 'capture_static_secret');
    assert.equal(amazon.setup_plan.proof_gate, 'static_secret_live_proof_missing');
    assert.equal(amazon.setup_plan.runbook_path, 'docs/operator/static-secret-connection-runbook.md');
    assert.equal(amazon.connection_count, 1);
    assert.equal(amazon.connections[0].object, 'owner_connection_summary');
    assert.equal(amazon.connections[0].connection_id, 'cin_amazon_personal');
    assert.equal(amazon.connections[0].connector_key, 'amazon');
    assert.equal(amazon.connections[0].display_name, 'the owner personal');
    assert.equal(amazon.connections[0].label_status, 'owner_set');

    const amazonInitiate = actionByFamily(amazon, 'initiate_connection');
    assert.equal(amazonInitiate.status, 'unsupported');
    assert.equal(amazonInitiate.method, null);
    assert.equal(amazonInitiate.url, null);
    assert.match(amazonInitiate.reason, /static provider secret|static-secret/i);

    // Local-collector templates are discoverable even before a connection is
    // registered, because they live in the reference local-collector catalog.
    const codex = byConnector(body, 'codex');
    assert.equal(codex.connector_modality, 'local_collector');
    assert.equal(codex.setup_plan.support_state, 'supported');
    assert.equal(codex.setup_plan.next_step_kind, 'enroll_local_collector');
    assert.equal(codex.connection_count, 0);
    const codexInitiate = actionByFamily(codex, 'initiate_connection');
    assert.equal(codexInitiate.status, 'supported');
    assert.equal(codexInitiate.method, 'POST');
    assert.match(codexInitiate.url, /\/v1\/owner\/connections\/intents$/);
  });
});

test('GET /v1/owner/control advertises list_connector_templates with the template route', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/control`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    const listTemplates = body.actions.find((action) => action.family === 'list_connector_templates');
    assert.ok(listTemplates, 'control surface should list list_connector_templates');
    assert.equal(listTemplates.status, 'supported');
    assert.equal(listTemplates.method, 'GET');
    assert.match(listTemplates.url, /\/v1\/owner\/connector-templates$/);
  });
});

test('client grant bearer cannot list owner connector templates', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    const clientToken = await approveClientGrant(asUrl, connectorKey, 'saved_tracks');
    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/connector-templates`, {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    assert.equal(status, 403);
    assert.equal(body?.error?.code, 'permission_error');
  });
});
