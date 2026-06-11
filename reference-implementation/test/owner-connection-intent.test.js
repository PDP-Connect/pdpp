/**
 * Integration suite for the bearer-authed owner-agent connection-intent route
 * `POST /v1/owner/connections/intents` (mounted from
 * `server/routes/owner-connection-intent.ts`) plus unit coverage for the pure
 * `classifyConnectorIntentModality` classifier.
 *
 * Covers the owner-agent connection-initiation slice (tasks 2.3, 5.1-5.4) of the
 * owner-agent control surface:
 *
 *   - a trusted owner-agent bearer initiating a connection for a proven
 *     local-collector connector (`codex`, `claude-code`) gets a real
 *     `enroll_local_collector` next step with a single-use enrollment code, and
 *     exchanging that code at the device-exporter enroll endpoint materializes a
 *     real `cin_*` connection — proving the minted code is genuine, not a stub;
 *   - proof-gated browser-bound connectors return typed `manual_runbook` setup
 *     steps, while static-secret connectors return a non-secret
 *     `capture_static_secret` owner-session step — NOT faked active
 *     connections;
 *   - provider-authorization connectors with missing platform config return
 *     `needs_deployment_config` with non-secret blockers;
 *   - an unknown connector returns `unsupported` / `connector_modality: unknown`;
 *   - every response carries `connection_active: false` and the intent itself
 *     writes no connection row;
 *   - the `GET /v1/owner/control` catalog advertises `initiate_connection` as
 *     `supported` (POST + URL), kept in sync with the metadata hint;
 *   - client grant tokens (403) and missing bearers (401) cannot initiate, and
 *     `/mcp` continues to reject owner bearers;
 *   - non-secret audit evidence (`owner_agent.connection.initiate`) records actor
 *     kind/client, connector key, modality, next-step kind, and outcome without
 *     logging the bearer token or the minted enrollment code.
 *
 * Spec: openspec/changes/add-owner-agent-control-surface
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { COLLECTOR_PROTOCOL_VERSION } from '../server/collector-protocol.ts';
import { classifyConnectorIntentModality } from '../server/connection-setup-plan.ts';
import { canonicalConnectorKey } from '../server/connector-key.js';
import { startServer } from '../server/index.js';
import { listSpineEventsPage } from '../lib/spine.ts';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';

const OWNER_SUBJECT_ID = 'owner_local';
const PROTOCOL_HEADERS = { 'X-PDPP-Collector-Protocol': COLLECTOR_PROTOCOL_VERSION };
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
        purpose_description: 'owner-connection intent boundary test',
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

async function createIntent(rsUrl, ownerToken, body) {
  return fetchJson(`${rsUrl}/v1/owner/connections/intents`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function findIntentAuditEvent(resp) {
  const traceId = resp.headers.get('PDPP-Reference-Trace-Id');
  assert.ok(traceId?.startsWith('trc_'), 'intent response should carry an audit trace id');
  const page = listSpineEventsPage('trace', traceId, { limit: 20 });
  const event = page.events.find((entry) => entry.event_type === 'owner_agent.connection.initiate');
  assert.ok(event, 'expected owner-agent connection-initiate audit event');
  assert.equal(event.request_id, resp.headers.get('Request-Id'));
  assert.equal(event.token_id, null, 'audit event must not store bearer tokens');
  return event;
}

function loadPackageManifest(name) {
  return JSON.parse(
    readFileSync(new URL(`../../packages/polyfill-connectors/manifests/${name}.json`, import.meta.url), 'utf8'),
  );
}

async function registerConnector(asUrl, manifest) {
  const resp = await fetch(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  const text = await resp.text();
  assert.equal(resp.status, 201, `register ${manifest.connector_id} failed: ${resp.status} ${text}`);
  return manifest;
}

// Seed one configured connection instance directly, the same way the schedule
// suite does, so the "owner already has a first Amazon account" precondition is
// real without driving an enroll/ingest flow.
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

// ---- classifier unit tests -------------------------------------------------

test('classifyConnectorIntentModality: filesystem binding -> local_collector', () => {
  assert.equal(
    classifyConnectorIntentModality({ runtime_requirements: { bindings: { filesystem: { required: true } } } }),
    'local_collector',
  );
});

test('classifyConnectorIntentModality: browser binding -> browser_bound', () => {
  assert.equal(
    classifyConnectorIntentModality({
      runtime_requirements: { bindings: { network: { required: true }, browser: { required: true } } },
    }),
    'browser_bound',
  );
});

test('classifyConnectorIntentModality: network-only binding -> api_network', () => {
  assert.equal(
    classifyConnectorIntentModality({ runtime_requirements: { bindings: { network: { required: true } } } }),
    'api_network',
  );
});

test('classifyConnectorIntentModality: null manifest -> unknown', () => {
  assert.equal(classifyConnectorIntentModality(null), 'unknown');
});

test('classifyConnectorIntentModality: no bindings -> unknown', () => {
  assert.equal(classifyConnectorIntentModality({ runtime_requirements: {} }), 'unknown');
});

test('classifyConnectorIntentModality: filesystem wins over a stray browser binding', () => {
  assert.equal(
    classifyConnectorIntentModality({
      runtime_requirements: { bindings: { filesystem: { required: true }, browser: { required: true } } },
    }),
    'local_collector',
  );
});

// ---- route integration tests ----------------------------------------------

test('owner-agent initiates a local-collector connection and receives a real enrollment next step', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body, resp } = await createIntent(rsUrl, ownerToken, {
      connector_id: ' https://registry.pdpp.org/connectors/codex ',
      display_name: 'My laptop Codex',
    });
    assert.equal(status, 201);
    assert.equal(body.object, 'owner_connection_intent');
    assert.equal(body.connector_id, 'codex');
    assert.equal(body.connector_key, 'codex');
    assert.equal(body.connector_modality, 'local_collector');
    assert.equal(body.setup_modality, 'local_collector');
    assert.equal(body.support_state, 'supported');
    assert.equal(body.proof_gate, null);
    assert.equal(body.runbook_path, null);
    assert.equal(body.deployment_readiness.state, 'not_applicable');
    assert.equal(body.connection_active, false);
    assert.equal(body.next_step.kind, 'enroll_local_collector');
    assert.ok(body.next_step.enrollment_code, 'should mint a single-use enrollment code');
    assert.match(body.next_step.enroll_endpoint, /\/_ref\/device-exporters\/enroll$/);
    assert.equal(body.next_step.local_binding_name, 'codex');
    assert.ok(body.next_step.expires_at, 'should carry an expiry');

    // Audit: succeeded, owner_agent, codex, local_collector, enroll_local_collector.
    const audit = findIntentAuditEvent(resp);
    assert.equal(audit.actor_type, 'owner_agent');
    assert.equal(audit.actor_id, 'cli_longview');
    assert.equal(audit.client_id, 'cli_longview');
    assert.equal(audit.subject_id, OWNER_SUBJECT_ID);
    assert.equal(audit.object_type, 'connection_intent');
    assert.equal(audit.object_id, 'codex');
    assert.equal(audit.status, 'succeeded');
    assert.equal(audit.data?.actor_kind, 'owner_agent');
    assert.equal(audit.data?.auth_token_kind, 'owner');
    assert.equal(audit.data?.operation, 'initiate_connection');
    assert.equal(audit.data?.connector_key, 'codex');
    assert.equal(audit.data?.connector_modality, 'local_collector');
    assert.equal(audit.data?.next_step_kind, 'enroll_local_collector');
    assert.equal(audit.data?.display_name_supplied, true);
    // Audit must NOT carry the minted enrollment code anywhere.
    assert.equal(JSON.stringify(audit).includes(body.next_step.enrollment_code), false);
  });
});

test('the minted enrollment code is genuine: exchanging it materializes a real connection', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const intent = (await createIntent(rsUrl, ownerToken, { connector_id: 'codex' })).body;
    assert.equal(intent.next_step.kind, 'enroll_local_collector');

    // Before enroll: the intent wrote no connection row.
    const beforeStore = await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID);
    assert.equal(beforeStore.length, 0, 'the intent itself must not create a connection');

    // Exchange the minted code at the enroll endpoint named by the intent.
    const enroll = await fetchJson(intent.next_step.enroll_endpoint, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...PROTOCOL_HEADERS },
      body: JSON.stringify({ enrollment_code: intent.next_step.enrollment_code }),
    });
    assert.equal(enroll.status, 201);
    assert.equal(enroll.body.object, 'device_exporter_enrollment');
    assert.match(enroll.body.connector_instance_id, /^cin_/);

    // After enroll: a real codex connection now exists for the owner.
    const after = await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID);
    assert.equal(after.length, 1);
    assert.equal(after[0].connectorId, 'codex');
  });
});

test('owner-agent initiating a browser-bound connector (Amazon) gets a typed unsupported, not a faked success', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    // Amazon must be a registered connector for its manifest (and thus its
    // browser binding) to resolve. An operator with the Amazon connector
    // available is the motivating second-account case.
    const manifest = JSON.parse(
      (await import('node:fs')).readFileSync(
        new URL('../../packages/polyfill-connectors/manifests/amazon.json', import.meta.url),
        'utf8',
      ),
    );
    await fetch(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    });
    const { status, body, resp } = await createIntent(rsUrl, ownerToken, {
      connector_id: 'https://registry.pdpp.org/connectors/amazon',
    });
    assert.equal(status, 201);
    assert.equal(body.connector_key, 'amazon');
    assert.equal(body.connector_modality, 'browser_bound');
    assert.equal(body.setup_modality, 'browser_bound');
    assert.equal(body.support_state, 'proof_gated');
    assert.equal(body.proof_gate, 'browser_collector_live_proof_missing');
    assert.match(body.runbook_path, /browser-collector-proof-runbook\.md$/);
    assert.equal(body.connection_active, false);
    assert.equal(body.next_step.kind, 'manual_runbook');
    assert.match(body.next_step.runbook_path, /browser-collector-proof-runbook\.md$/);
    assert.match(body.next_step.reason, /browser/i);
    assert.match(body.next_step.reason, /browser_collector|primitive/i);
    // Honesty: the reason must point at the owner-run procedure that works today
    // (the runbook), not loop the owner back to a dashboard that lists Amazon as
    // unsupported. It must also state that the primitive ships and only committed
    // live proof is pending — not imply the whole primitive is missing.
    assert.match(body.next_step.reason, /browser-collector-proof-runbook\.md/);
    assert.match(body.next_step.reason, /already ships|proof/i);
    // The route must NOT yet mint browser enrollment material. Per the proof
    // gate, the flip to an actual `enroll_browser_collector` payload lands with
    // committed live proof, not via copy.
    assert.notEqual(body.next_step.kind, 'enroll_browser_collector');
    assert.equal(Object.hasOwn(body.next_step, 'enrollment_code'), false);

    const audit = findIntentAuditEvent(resp);
    assert.equal(audit.status, 'succeeded');
    assert.equal(audit.data?.connector_key, 'amazon');
    assert.equal(audit.data?.connector_modality, 'browser_bound');
    assert.equal(audit.data?.next_step_kind, 'manual_runbook');
  });
});

// ---- Amazon second-account acceptance (task 5.3) ---------------------------
//
// Task 5.3 asks for proof that a trusted owner agent can "initiate the
// second-account flow up to the owner-mediated next step." The other Amazon test
// above initiates from a clean slate; this one exercises the actual acceptance
// fixture from design.md Decision 2: the owner ALREADY has one configured Amazon
// connection ("the owner personal") and the agent adds a SECOND account ("Shared
// Amazon"). It walks both planes the design names — the owner control listing
// plane (discover the existing account by its distinct `connection_id`) and the
// intent plane (initiate the second account) — and asserts the flow reaches the
// typed owner-mediated browser-assistance stop without faking success or
// silently materializing the second connection.
//
// This is the acceptance-permitted form of 5.3: the browser-collector enrollment
// primitive's live proof is still pending, so the honest second-account outcome
// is a typed `manual_runbook`/`browser_bound` next step describing the owner-run
// browser-assistance step. The response does NOT claim the agent can complete
// provider login/2FA by bearer authority.
test('a trusted owner agent initiates an Amazon SECOND account up to the owner-mediated next step', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadPackageManifest('amazon'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.equal(connectorKey, 'amazon');

    // Precondition: the owner already has ONE configured Amazon account.
    await seedInstance({
      connectorInstanceId: 'cin_amazon_personal',
      connectorId: connectorKey,
      displayName: 'the owner personal',
      sourceBindingKey: 'the owner@example.com',
    });

    const ownerToken = await issueOwnerToken(asUrl);

    // --- Discovery plane: the agent lists connections and sees the existing
    // Amazon account by its distinct connection_id + owner-meaningful label, so
    // it knows which account the second one is being added alongside. (Spec:
    // "Owner agent lists Amazon state".)
    const listing = await fetchJson(`${rsUrl}/v1/owner/connections`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(listing.status, 200);
    const amazonRows = listing.body.data.filter((r) => r.connector_key === 'amazon');
    assert.equal(amazonRows.length, 1, 'exactly one Amazon account exists before the second-account intent');
    const firstAccount = amazonRows[0];
    assert.equal(firstAccount.connection_id, 'cin_amazon_personal');
    assert.equal(firstAccount.connector_id, 'amazon');
    assert.equal(firstAccount.display_name, 'the owner personal');
    assert.equal(firstAccount.label_status, 'owner_set');

    // --- Intent plane: the agent initiates the SECOND Amazon account, carrying
    // the owner-meaningful label it intends to apply once the account is live.
    const { status, body, resp } = await createIntent(rsUrl, ownerToken, {
      connector_id: 'https://registry.pdpp.org/connectors/amazon',
      display_name: 'Shared Amazon',
    });

    // The flow reaches the typed owner-mediated next step: an auditable intent,
    // classified browser_bound, not yet active, with a proof-gated runbook step.
    assert.equal(status, 201);
    assert.equal(body.object, 'owner_connection_intent');
    assert.equal(body.connector_key, 'amazon');
    assert.equal(body.connector_modality, 'browser_bound');
    assert.equal(body.setup_modality, 'browser_bound');
    assert.equal(body.support_state, 'proof_gated');
    assert.equal(body.proof_gate, 'browser_collector_live_proof_missing');
    assert.equal(body.connection_active, false);
    assert.equal(body.next_step.kind, 'manual_runbook');
    assert.match(body.next_step.runbook_path, /browser-collector-proof-runbook\.md$/);
    // The reason describes the browser-assistance step the owner / local
    // environment performs (spec "Connector requires browser assistance"): it
    // names the browser-bound nature and points at the owner-run procedure.
    assert.match(body.next_step.reason, /browser/i);
    assert.match(body.next_step.reason, /browser-collector-proof-runbook\.md/);
    // It must NOT claim the agent can complete login/2FA by bearer authority, and
    // it must NOT yet mint the one-click enroll payload (gated on live proof).
    assert.notEqual(body.next_step.kind, 'enroll_browser_collector');
    assert.equal(Object.hasOwn(body.next_step, 'enrollment_code'), false);
    assert.doesNotMatch(
      body.next_step.reason,
      /\b(headless|2fa|two-factor|log in for you|on your behalf without)\b/i,
      'the next step must not claim the agent completes provider login/2FA itself',
    );

    // --- No silent success: the second intent wrote NO connection row. The owner
    // still has exactly the one original Amazon account; the second materializes
    // only when the owner completes the browser-assistance step locally.
    const afterRows = (await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID))
      .filter((row) => row.connectorId === 'amazon');
    assert.equal(afterRows.length, 1, 'the second-account intent must not materialize a connection');
    assert.equal(afterRows[0].connectorInstanceId, 'cin_amazon_personal');

    // The owner-agent listing still shows exactly one Amazon account, unchanged.
    const afterListing = await fetchJson(`${rsUrl}/v1/owner/connections`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const afterAmazonRows = afterListing.body.data.filter((r) => r.connector_key === 'amazon');
    assert.equal(afterAmazonRows.length, 1);
    assert.equal(afterAmazonRows[0].connection_id, 'cin_amazon_personal');

    // --- Audit: the second-account initiation is recorded as a non-secret,
    // owner-agent, browser_bound, unsupported event with no bearer/secret leak.
    const audit = findIntentAuditEvent(resp);
    assert.equal(audit.actor_type, 'owner_agent');
    assert.equal(audit.subject_id, OWNER_SUBJECT_ID);
    assert.equal(audit.status, 'succeeded');
    assert.equal(audit.data?.actor_kind, 'owner_agent');
    assert.equal(audit.data?.connector_key, 'amazon');
    assert.equal(audit.data?.connector_modality, 'browser_bound');
    assert.equal(audit.data?.next_step_kind, 'manual_runbook');
    assert.equal(audit.data?.operation, 'initiate_connection');
    assert.equal(audit.data?.display_name_supplied, true);
    // The owner-supplied label is never persisted in audit evidence.
    assert.equal(JSON.stringify(audit).includes('Shared Amazon'), false);
  });
});

test('owner-agent initiating a static-secret API connector gets a non-secret capture step', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    // gmail must be a registered connector for the manifest to resolve.
    const manifest = JSON.parse(
      (await import('node:fs')).readFileSync(
        new URL('../../packages/polyfill-connectors/manifests/gmail.json', import.meta.url),
        'utf8',
      ),
    );
    await fetch(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    });
    const { status, body } = await createIntent(rsUrl, ownerToken, { connector_id: 'gmail' });
    assert.equal(status, 201);
    assert.equal(body.connector_key, 'gmail');
    assert.equal(body.connector_modality, 'api_network');
    assert.equal(body.setup_modality, 'static_secret');
    assert.equal(body.support_state, 'supported');
    assert.equal(body.proof_gate, null);
    assert.equal(body.runbook_path, null);
    assert.equal(body.deployment_readiness.state, 'not_applicable');
    // Gmail has a synchronous credential probe, so the owner-agent/CLI setup
    // projection advertises synchronous validation — without exposing a secret.
    assert.equal(body.validation, 'synchronous');
    assert.equal(body.next_step.kind, 'capture_static_secret');
    assert.equal(body.next_step.capture_endpoint, '/dashboard/connect/static-secret/gmail');
    assert.equal(body.next_step.runbook_path, undefined);
    assert.match(body.next_step.reason, /static-secret credential capture/i);
    // Honesty: static-secret connectors authenticate with a connector-declared
    // provider secret the owner supplies through an owner-session surface, NOT
    // an OAuth authorization-code flow. The route may point at the
    // owner-session capture page and runbook, but it must not emit the provider
    // secret, an owner cookie, or an OAuth authorization URL.
    assert.doesNotMatch(
      body.next_step.reason,
      /add this connection from the dashboard/i,
      'must not point the owner at a dashboard that lists API/network as unsupported',
    );
    assert.equal(body.next_step.authorization_url, undefined);
    assert.equal(body.next_step.enrollment_code, undefined);
    assert.equal(body.enrollment_code, undefined);
    const responseText = JSON.stringify(body);
    assert.doesNotMatch(responseText, /pdpp_owner_session/i);
    assert.doesNotMatch(responseText, /"secret"\s*:/i);
    assert.doesNotMatch(responseText, /super-secret|provider-secret-value|app-password-value/i);
  });
});

test('owner-agent initiating a manual/upload connector gets a non-secret upload step', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    await registerConnector(asUrl, loadPackageManifest('google_maps'));
    const { status, body, resp } = await createIntent(rsUrl, ownerToken, { connector_id: 'google-maps' });
    assert.equal(status, 201);
    assert.equal(body.connector_key, 'google-maps');
    assert.equal(body.connector_modality, 'local_collector');
    assert.equal(body.setup_modality, 'manual_or_upload');
    assert.equal(body.support_state, 'supported');
    assert.equal(body.proof_gate, null);
    assert.equal(body.next_step.kind, 'provide_import_file');
    assert.equal(body.next_step.upload_endpoint, '/dashboard/connect/manual-upload/google-maps');
    assert.equal(body.next_step.enrollment_code, undefined);
    assert.equal(body.next_step.capture_endpoint, undefined);
    assert.doesNotMatch(JSON.stringify(body), /GOOGLE_MAPS_TIMELINE_DIR|import_dir|pdpp_owner_session/i);

    const audit = findIntentAuditEvent(resp);
    assert.equal(audit.actor_type, 'owner_agent');
    assert.equal(audit.data?.connector_key, 'google-maps');
    assert.equal(audit.data?.connector_modality, 'local_collector');
    assert.equal(audit.data?.next_step_kind, 'provide_import_file');
  });
});

test('owner-agent initiating provider authorization returns deployment blockers, not secrets or fake support', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    await registerConnector(asUrl, {
      ...loadPackageManifest('notion'),
      connector_id: 'fitness_oauth',
      connector_key: 'fitness_oauth',
      manifest_uri: 'https://registry.pdpp.org/connectors/fitness-oauth',
      display_name: 'Fitness OAuth',
      capabilities: {
        auth: {
          kind: 'oauth',
          deployment_config: ['FITNESS_OAUTH_CLIENT_ID', 'FITNESS_OAUTH_CLIENT_SECRET'],
        },
      },
    });
    const { status, body } = await createIntent(rsUrl, ownerToken, { connector_id: 'fitness_oauth' });
    assert.equal(status, 201);
    assert.equal(body.connector_key, 'fitness_oauth');
    assert.equal(body.connector_modality, 'api_network');
    assert.equal(body.setup_modality, 'provider_authorization');
    assert.equal(body.support_state, 'needs_deployment_config');
    assert.equal(body.proof_gate, 'provider_app_deployment_config_missing');
    assert.equal(body.next_step.kind, 'needs_deployment_config');
    assert.equal(body.deployment_readiness.state, 'needs_config');
    assert.deepEqual(
      body.deployment_readiness.blockers.map((item) => item.key),
      ['FITNESS_OAUTH_CLIENT_ID', 'FITNESS_OAUTH_CLIENT_SECRET'],
    );
    const serialized = JSON.stringify(body);
    assert.doesNotMatch(serialized, /Bearer|access_token|refresh_token|owner_session|mcp_package/i);
    assert.doesNotMatch(serialized, /client-secret-value|cookie-value/i);
  });
});

test('owner-agent initiating Google Maps Data Portability blocks on provider app config', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    await registerConnector(asUrl, loadPackageManifest('google_maps_data_portability'));
    const { status, body } = await createIntent(rsUrl, ownerToken, {
      connector_id: 'google-maps-data-portability',
    });
    assert.equal(status, 201);
    assert.equal(body.connector_key, 'google-maps-data-portability');
    assert.equal(body.connector_modality, 'api_network');
    assert.equal(body.setup_modality, 'provider_authorization');
    assert.equal(body.support_state, 'needs_deployment_config');
    assert.equal(body.proof_gate, 'provider_app_deployment_config_missing');
    assert.equal(body.next_step.kind, 'needs_deployment_config');
    assert.deepEqual(
      body.deployment_readiness.blockers.map((item) => item.key),
      [
        'GOOGLE_DATAPORTABILITY_CLIENT_ID',
        'GOOGLE_DATAPORTABILITY_CLIENT_SECRET',
        'GOOGLE_DATAPORTABILITY_REDIRECT_URI',
      ],
    );
    const serialized = JSON.stringify(body);
    assert.doesNotMatch(serialized, /GMAIL_APP_PASSWORD|GOOGLE_APP_PASSWORD|Timeline\\.json|owner_session/i);
    assert.doesNotMatch(serialized, /access_token|refresh_token|client-secret-value/i);
  });
});

test('owner-agent initiating an unknown connector gets unsupported / unknown modality', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await createIntent(rsUrl, ownerToken, { connector_id: 'definitely-not-a-connector' });
    assert.equal(status, 201);
    assert.equal(body.connector_modality, 'unknown');
    assert.equal(body.setup_modality, 'unknown');
    assert.equal(body.support_state, 'unsupported');
    assert.equal(body.next_step.kind, 'unsupported');
  });
});

test('owner-agent intent rejects a missing connector_id with a typed 400', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body, resp } = await createIntent(rsUrl, ownerToken, {});
    assert.equal(status, 400);
    assert.equal(body?.error?.code, 'invalid_request');
    assert.equal(body?.error?.param, 'connector_id');
    const audit = findIntentAuditEvent(resp);
    assert.equal(audit.status, 'failed');
    assert.equal(audit.data?.actor_kind, 'owner_agent');
    assert.equal(audit.data?.error?.code, 'invalid_request');
  });
});

test('owner-agent intent rejects a non-string display_name with a typed 400', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await createIntent(rsUrl, ownerToken, { connector_id: 'codex', display_name: 42 });
    assert.equal(status, 400);
    assert.equal(body?.error?.code, 'invalid_request');
    assert.equal(body?.error?.param, 'display_name');
  });
});

test('owner-agent intent rejects display_name values over the contract length cap', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await createIntent(rsUrl, ownerToken, {
      connector_id: 'codex',
      display_name: 'x'.repeat(201),
    });
    assert.equal(status, 400);
    assert.equal(body?.error?.code, 'invalid_request');
    assert.equal(body?.error?.param, 'display_name');
  });
});

test('owner-agent intent rejects a client grant token with 403 and audits the failure', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    // Register codex so a client grant is well-formed against a real connector.
    const manifest = JSON.parse(
      (await import('node:fs')).readFileSync(
        new URL('../../packages/polyfill-connectors/manifests/codex.json', import.meta.url),
        'utf8',
      ),
    );
    await fetch(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    });
    const streamName = manifest.streams?.[0]?.name || 'sessions';
    const clientToken = await approveClientGrant(asUrl, 'codex', streamName);

    const { status, body, resp } = await createIntent(rsUrl, clientToken, { connector_id: 'codex' });
    assert.equal(status, 403);
    assert.equal(body?.error?.code, 'permission_error');
    const audit = findIntentAuditEvent(resp);
    assert.equal(audit.status, 'failed');
    assert.equal(audit.actor_type, 'client');
    assert.equal(audit.client_id, 'longview');
    assert.equal(audit.data?.actor_kind, 'client');
    assert.equal(audit.data?.auth_token_kind, 'client');
    assert.equal(audit.data?.error?.code, 'permission_error');
  });
});

test('owner-agent intent rejects a request with no bearer (401)', async () => {
  await withServer(async ({ rsUrl }) => {
    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/connections/intents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connector_id: 'codex' }),
    });
    assert.equal(status, 401);
    assert.equal(body?.error?.type, 'authentication_error');
  });
});

test('/mcp continues to reject owner-agent bearers after connection-intent support lands', async () => {
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

test('GET /v1/owner/control advertises initiate_connection as supported with the intent route', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/control`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    const initiate = body.actions.find((a) => a.family === 'initiate_connection');
    assert.ok(initiate, 'control surface should list initiate_connection');
    assert.equal(initiate.status, 'supported');
    assert.equal(initiate.method, 'POST');
    assert.match(initiate.url, /\/v1\/owner\/connections\/intents$/);
  });
});

test('owner-agent intent contract exposes the setup-plan next-step vocabulary', () => {
  const openapi = JSON.parse(
    readFileSync(new URL('../openapi/reference-full.openapi.json', import.meta.url), 'utf8'),
  );
  const intentResponseSchema =
    openapi.paths?.['/v1/owner/connections/intents']?.post?.responses?.['201']?.content?.[
      'application/json'
    ]?.schema;
  assert.ok(intentResponseSchema, 'intent route must document a 201 JSON response schema');
  const nextStepEnum = intentResponseSchema.properties?.next_step?.properties?.kind?.enum;
  assert.ok(Array.isArray(nextStepEnum), 'next_step.kind must be a closed enum in the contract');
  assert.deepEqual(nextStepEnum, [
    'enroll_local_collector',
    'enroll_browser_collector',
    'capture_static_secret',
    'open_provider_auth',
    'needs_deployment_config',
    'provide_import_file',
    'manual_runbook',
    'unsupported',
  ]);
});
