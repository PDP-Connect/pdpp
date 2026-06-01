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
 *   - browser-bound connectors (Amazon) return a typed `unsupported` whose reason
 *     names the missing browser-collector primitive — NOT a faked success;
 *   - API/network-only connectors (gmail) return a typed `unsupported`;
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
import { listSpineEventsPage } from '../lib/spine.ts';
import { startServer } from '../server/index.js';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';
import { classifyConnectorIntentModality } from '../server/routes/owner-connection-intent.ts';

const OWNER_SUBJECT_ID = 'owner_local';
const PROTOCOL_HEADERS = { 'X-PDPP-Collector-Protocol': COLLECTOR_PROTOCOL_VERSION };

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
    assert.equal(body.connection_active, false);
    assert.equal(body.next_step.kind, 'unsupported');
    assert.match(body.next_step.reason, /browser/i);
    assert.match(body.next_step.reason, /browser_collector|primitive/i);
    // Honesty: the reason must point at the owner-run procedure that works today
    // (the runbook), not loop the owner back to a dashboard that lists Amazon as
    // unsupported. It must also state that the primitive ships and only committed
    // live proof is pending — not imply the whole primitive is missing.
    assert.match(body.next_step.reason, /browser-collector-proof-runbook\.md/);
    assert.match(body.next_step.reason, /already ships|proof/i);
    // The reason names the eventual next-step kind but the route must NOT yet
    // advertise it as the actual next step. Per the spec proof gate
    // (add-browser-collector-enrollment-primitive design Decision 3/4), the flip
    // to `enroll_browser_collector` lands with the committed live proof, not via
    // copy. The structural next_step.kind stays `unsupported`.
    assert.notEqual(body.next_step.kind, 'enroll_browser_collector');

    const audit = findIntentAuditEvent(resp);
    assert.equal(audit.status, 'succeeded');
    assert.equal(audit.data?.connector_key, 'amazon');
    assert.equal(audit.data?.connector_modality, 'browser_bound');
    assert.equal(audit.data?.next_step_kind, 'unsupported');
  });
});

test('owner-agent initiating an API/network-only connector (gmail) gets a typed unsupported', async () => {
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
    assert.equal(body.next_step.kind, 'unsupported');
    assert.match(body.next_step.reason, /API|network/i);
    // Honesty: an API connection materializes implicitly on first ingest, so the
    // reason must name that truth and NOT loop the owner back to "add this from
    // the dashboard" — the console marks API/network sources unsupported for the
    // same reason (apps/console/.../connection-modality.ts), and there is no
    // provider-connect URL to send the owner to. It must also name the deferred
    // owner-agent API-connect primitive so an agent/reviewer has the concrete gap.
    assert.match(body.next_step.reason, /first ingest/i);
    assert.match(body.next_step.reason, /open_url/);
    assert.doesNotMatch(
      body.next_step.reason,
      /add this connection from the dashboard/i,
      'must not point the owner at a dashboard that lists API/network as unsupported',
    );
    // Honesty: gmail/github authenticate with a STATIC provider secret the owner
    // supplies locally (app password / personal access token), NOT an OAuth
    // authorization-code flow. The reason must name that credential model so a
    // future lane does not mistakenly wire these connectors to an OAuth `open_url`
    // redirect they cannot consume. The verified credential paths are
    // gmail/index.ts:463-498 (Google app password over IMAP) and
    // github/index.ts:406-409 (PAT). See design.md "Deferred: API/network
    // connection initiation" -> "The actual reference credential model".
    assert.match(
      body.next_step.reason,
      /static provider secret/i,
      'reason must name the static-secret credential model, not imply OAuth',
    );
    assert.match(body.next_step.reason, /app password|personal access token|token/i);
    // The reason must affirm these connectors are NOT OAuth-backed (it may mention
    // OAuth only to negate it), so a future reader cannot conclude open_url applies.
    assert.match(
      body.next_step.reason,
      /none of the current ones are|no OAuth authorization URL/i,
      'reason must explicitly state no current connector is OAuth-backed',
    );
    // The reason names the eventual next-step kind but the route must NOT yet
    // advertise it: no real provider-connect URL or owner-mediated capture route
    // exists, so emitting open_url would be a faked success the criteria forbid.
    assert.notEqual(body.next_step.kind, 'open_url');
  });
});

test('owner-agent initiating an unknown connector gets unsupported / unknown modality', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await createIntent(rsUrl, ownerToken, { connector_id: 'definitely-not-a-connector' });
    assert.equal(status, 201);
    assert.equal(body.connector_modality, 'unknown');
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

// The published contract reserves `enroll_browser_collector` as a next-step kind
// BEFORE any route emits it. Per add-browser-collector-enrollment-primitive design
// Decision 3, reserving the value keeps the post-proof `browser_bound` flip a single
// reviewable unit (flip the branch + its tests) instead of a flip PLUS a contract
// widening that a reviewer could miss. This pins the reservation so a future
// contract regen/edit can't silently drop it. It is the contract complement of the
// runtime guard above (the Amazon intent test asserts the live branch stays
// `unsupported` and does NOT yet emit `enroll_browser_collector`): reserved in the
// contract, not emitted at runtime.
test('owner-agent intent contract reserves enroll_browser_collector without emitting it', () => {
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
  // Reserved-then-emitted: the value is in the contract enum so the flip is not a
  // contract break, alongside the other reserved-but-unemitted kinds.
  assert.ok(
    nextStepEnum.includes('enroll_browser_collector'),
    'contract must reserve enroll_browser_collector for the post-proof browser_bound flip',
  );
  assert.ok(nextStepEnum.includes('enroll_local_collector'), 'the emitted local-collector kind stays reserved');
  assert.ok(nextStepEnum.includes('unsupported'), 'unsupported stays the honest browser-bound default');
});
