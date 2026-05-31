import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';
import { parsePendingConsentRequestUri } from '../server/auth.js';
import { getDb } from '../server/db.js';
import { ingestRecord } from '../server/records.js';
import { runConnector, loadSyncState } from '../runtime/index.js';
import { makeDefaultAccountConnectorInstanceId } from '../server/stores/connector-instance-store.js';
import { canonicalConnectorKey } from '../server/connector-key.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');
const TEST_DCR_INITIAL_ACCESS_TOKEN = 'pdpp-reference-test-initial-access-token';
// Registering the URL-shaped spotify manifest stores the catalog row, the
// connector_instances row, and records under the canonical connector key
// (Decision 1). Raw-SQL fixtures that target those rows by connector_id must
// use the canonical key, not the manifest URL, or they match zero rows.
const SPOTIFY_CONNECTOR_KEY = canonicalConnectorKey('https://registry.pdpp.org/connectors/spotify');


async function closeServer(server) {
  // Force-close keep-alive connections to prevent hanging.
  // Clear fallback timers when close callbacks win so the harness does not
  // retain stray timer handles after an otherwise clean shutdown.
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();

  const closeWithTimeout = (srv) => new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve();
    }, 2000);

    srv.close(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
  });

  await Promise.allSettled([
    closeWithTimeout(server.asServer),
    closeWithTimeout(server.rsServer),
  ]);
}

async function fetchJson(url, opts = {}) {
  const resp = await fetch(url, opts);
  const body = await resp.json();
  return {
    status: resp.status,
    body,
    headers: Object.fromEntries(resp.headers.entries()),
  };
}

async function withHarness(fn) {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'));

  try {
    await fetchJson(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spotifyManifest),
    });

    await fn({ asUrl, rsUrl, spotifyManifest });
  } finally {
    await closeServer(server);
  }
}

async function withNativeHarness(fn) {
  const nativeManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/northstar-hr.json'), 'utf8'));
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    nativeManifest,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    await fn({ asUrl, rsUrl, nativeManifest });
  } finally {
    await closeServer(server);
  }
}

function createTempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'pdpp-auth-db-'));
  return {
    dbPath: join(dir, 'pdpp.sqlite'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function startGrantRequest(asUrl, params) {
  return fetchJson(`${asUrl}/oauth/par`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: params.client_id,
      client_display: params.client_display,
      authorization_details: [
        {
          type: 'https://pdpp.org/data-access',
          source: params.source || (
            params.provider_id
              ? { kind: 'provider_native', id: params.provider_id }
              : { kind: 'connector', id: params.connector_id }
          ),
          purpose_code: params.purpose_code,
          purpose_description: params.purpose_description,
          access_mode: params.access_mode,
          retention: params.retention,
          streams: params.streams,
        },
      ],
    }),
  });
}

async function approveGrantRequest(asUrl, requestUri, subjectId, extra = {}) {
  return fetchJson(`${asUrl}/consent/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_uri: requestUri, subject_id: subjectId, ...extra }),
  });
}

async function denyGrantRequest(asUrl, requestUri) {
  const resp = await fetch(`${asUrl}/consent/deny`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_uri: requestUri }),
  });
  return {
    status: resp.status,
    headers: Object.fromEntries(resp.headers.entries()),
    body: await resp.text(),
  };
}

async function mutatePendingConsentRequest(requestUri, mutate) {
  const deviceCode = parsePendingConsentRequestUri(requestUri);
  assert.ok(deviceCode, 'request_uri should decode to a pending device code');

  const row = getDb().prepare(
    'SELECT params_json FROM pending_consents WHERE device_code = ?'
  ).get(deviceCode);
  assert.ok(row, 'pending consent row exists');

  const request = JSON.parse(row.params_json);
  mutate(request);

  getDb().prepare(
    'UPDATE pending_consents SET params_json = ? WHERE device_code = ?'
  ).run(JSON.stringify(request), deviceCode);
}

// Build a UPDATE SET clause dynamically from an `updates` object restricted to
// an allowlist of column names. Returns `{ setText, binds }` — the caller
// concatenates `setText` into a fixed UPDATE SQL string and passes the binds
// to `.run()` along with any trailing WHERE binds.
function buildDynamicSet(updates, allowedKeys) {
  const parts = [];
  const binds = [];
  for (const key of allowedKeys) {
    if (Object.hasOwn(updates, key)) {
      parts.push(`${key} = ?`);
      binds.push(updates[key]);
    }
  }
  return { setText: parts.join(', '), binds };
}

async function updatePendingConsentRow(requestUri, updates) {
  const deviceCode = parsePendingConsentRequestUri(requestUri);
  assert.ok(deviceCode, 'request_uri should decode to a pending device code');

  const { setText, binds } = buildDynamicSet(updates, [
    'params_json', 'request_id', 'trace_id', 'scenario_id',
  ]);
  assert.ok(binds.length, 'expected pending consent row updates');

  getDb().prepare(
    `UPDATE pending_consents SET ${setText} WHERE device_code = ?`
  ).run(...binds, deviceCode);
}

async function readPendingConsentTraceContext(requestUri) {
  const deviceCode = parsePendingConsentRequestUri(requestUri);
  assert.ok(deviceCode, 'request_uri should decode to a pending device code');

  const row = getDb().prepare(
    'SELECT request_id, trace_id, scenario_id FROM pending_consents WHERE device_code = ?'
  ).get(deviceCode);
  assert.ok(row, 'pending consent row exists');
  return row;
}

async function mutateRegisteredClient(clientId, mutate) {
  const row = getDb().prepare(
    'SELECT metadata_json FROM oauth_clients WHERE client_id = ?'
  ).get(clientId);
  assert.ok(row, 'expected exactly one registered client row');

  const metadata = JSON.parse(row.metadata_json);
  mutate(metadata);

  getDb().prepare(
    'UPDATE oauth_clients SET metadata_json = ? WHERE client_id = ?'
  ).run(JSON.stringify(metadata), clientId);
}

async function updateRegisteredClientRow(clientId, updates) {
  const { setText, binds } = buildDynamicSet(updates, [
    'metadata_json', 'token_endpoint_auth_method',
  ]);
  assert.ok(binds.length, 'expected registered client row updates');

  getDb().prepare(
    `UPDATE oauth_clients SET ${setText} WHERE client_id = ?`
  ).run(...binds, clientId);
}

async function deleteRegisteredClient(clientId) {
  getDb().prepare('DELETE FROM oauth_clients WHERE client_id = ?').run(clientId);
}

async function issueOwnerToken(asUrl, subjectId = 'owner_local') {
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
      subject_id: subjectId,
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

async function registerDynamicClient(asUrl, metadata, initialAccessToken = TEST_DCR_INITIAL_ACCESS_TOKEN) {
  const headers = { 'Content-Type': 'application/json' };
  if (initialAccessToken) {
    headers.Authorization = `Bearer ${initialAccessToken}`;
  }
  return fetchJson(`${asUrl}/oauth/register`, {
    method: 'POST',
    headers,
    body: JSON.stringify(metadata),
  });
}

async function seedSpotify(rsUrl, manifest, ownerToken) {
  const connectorPath = join(REFERENCE_IMPL_DIR, 'connectors/seed/index.js');
  return runConnector({
    connectorPath,
    connectorId: manifest.connector_id,
    ownerToken,
    manifest,
    state: null,
    collectionMode: 'full_refresh',
    rsUrl,
  });
}

async function seedNorthstar(nativeManifest) {
  const records = [
    {
      stream: 'pay_statements',
      key: 'ps_2026_04_15',
      data: {
        statement_id: 'ps_2026_04_15',
        employer: 'Northstar HR',
        pay_period_start: '2026-04-01',
        pay_period_end: '2026-04-15',
        issued_at: '2026-04-16T12:00:00Z',
        gross_pay: 5400,
        net_pay: 3912,
        currency: 'USD',
        employee_id: 'emp_123',
      },
      emitted_at: '2026-04-16T12:00:00Z',
    },
    {
      stream: 'equity_grants',
      key: 'eq_2026_01_01',
      data: {
        grant_id: 'eq_2026_01_01',
        employer: 'Northstar HR',
        grant_type: 'RSU',
        quantity: 1200,
        strike_price: 0,
        currency: 'USD',
        granted_at: '2026-01-01T00:00:00Z',
        vesting_start_date: '2026-01-01',
        vesting_end_date: '2030-01-01',
        employee_id: 'emp_123',
      },
      emitted_at: '2026-01-01T00:00:00Z',
    },
    {
      stream: 'benefits_enrollments',
      key: 'ben_medical_2026',
      data: {
        enrollment_id: 'ben_medical_2026',
        employer: 'Northstar HR',
        plan_name: 'Northstar PPO',
        coverage_level: 'employee_plus_family',
        effective_date: '2026-01-01',
        employee_cost_monthly: 280,
        currency: 'USD',
        employee_id: 'emp_123',
      },
      emitted_at: '2026-01-01T00:00:00Z',
    },
  ];

  for (const record of records) {
    await ingestRecord(nativeManifest.storage_binding.connector_id, record);
  }
}

async function approveGrant(asUrl, subjectId, params) {
  const { body: initiate } = await startGrantRequest(asUrl, params);

  const { body: approved } = await approveGrantRequest(asUrl, initiate.request_uri, subjectId);

  return approved;
}

async function mutateGrantSource(grantId, mutate) {
  const row = getDb().prepare(
    'SELECT grant_json FROM grants WHERE grant_id = ?'
  ).get(grantId);
  assert.ok(row, 'expected exactly one persisted grant row');

  const grant = JSON.parse(row.grant_json);
  grant.source = mutate(grant.source);

  getDb().prepare(
    'UPDATE grants SET grant_json = ? WHERE grant_id = ?'
  ).run(JSON.stringify(grant), grantId);
}

async function mutateGrantStorageBinding(grantId, mutate) {
  const row = getDb().prepare(
    'SELECT storage_binding_json FROM grants WHERE grant_id = ?'
  ).get(grantId);
  assert.ok(row, 'expected exactly one persisted grant row');

  const storageBinding = JSON.parse(row.storage_binding_json);
  getDb().prepare(
    'UPDATE grants SET storage_binding_json = ? WHERE grant_id = ?'
  ).run(JSON.stringify(mutate(storageBinding)), grantId);
}

function assertNormalizedGrantSource(source, expected, label) {
  assert.deepEqual(source, expected, `${label} should expose only the canonical source descriptor`);
  assert.ok(!('storage_connector_id' in (source || {})), `${label} should not expose storage_connector_id`);
  assert.ok(!('debug_context' in (source || {})), `${label} should not expose stray persisted source fields`);
}

test('PDPP reference implementation integration', async (t) => {
  await t.test('pending consent survives server restart when backed by durable storage', async () => {
    const { dbPath, cleanup } = createTempDbPath();
    const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'));

    let server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath });
    const asUrl = `http://localhost:${server.asPort}`;

    try {
      await fetchJson(`${asUrl}/connectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spotifyManifest),
      });

      const { body: initiate } = await startGrantRequest(asUrl, {
        client_id: 'concert_recommendation_app',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Maintain a concert-recommendation profile over time',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists', view: 'basic' }],
      });

      assert.ok(initiate.request_uri);

      await closeServer(server);
      server = await startServer({ quiet: true, asPort: server.asPort, rsPort: server.rsPort, dbPath });

      const consentResp = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(initiate.request_uri)}`);
      assert.equal(consentResp.status, 200);

      const { body: approved } = await approveGrantRequest(asUrl, initiate.request_uri, 'u1');

      assert.ok(approved.grant_id);
      assert.ok(approved.token);

      const postApprovalConsentResp = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(initiate.request_uri)}`);
      assert.equal(postApprovalConsentResp.status, 404);
    } finally {
      await closeServer(server);
      cleanup();
    }
  });

  await t.test('expired pending consent is rejected consistently across display and approve paths', async () => {
    const { dbPath, cleanup } = createTempDbPath();
    const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'));
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath });
    const asUrl = `http://localhost:${server.asPort}`;

    try {
      await fetchJson(`${asUrl}/connectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spotifyManifest),
      });

      const { body: initiate } = await startGrantRequest(asUrl, {
        client_id: 'concert_recommendation_app',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Maintain a concert-recommendation profile over time',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists', view: 'basic' }],
      });

      const deviceCode = parsePendingConsentRequestUri(initiate.request_uri);
      getDb().prepare(`
        UPDATE pending_consents
        SET expires_at = ?
        WHERE device_code = ?
      `).run(new Date(Date.now() - 1000).toISOString(), deviceCode);

      const consentResp = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(initiate.request_uri)}`);
      assert.equal(consentResp.status, 404);

      const approveResp = await fetch(`${asUrl}/consent/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_uri: initiate.request_uri, subject_id: 'u1' }),
      });
      assert.equal(approveResp.status, 404);
    } finally {
      await closeServer(server);
      cleanup();
    }
  });

  await t.test('authorization_details envelope requests normalize into the current pending-grant flow', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiateResp = await fetch(`${asUrl}/oauth/par`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'longview',
          client_display: {
            name: 'Longview',
            uri: 'https://longview.example',
            policy_uri: 'https://longview.example/privacy',
            tos_uri: 'https://longview.example/terms',
          },
          authorization_details: [
            {
              type: 'https://pdpp.org/data-access',
              source: { kind: 'connector', id: spotifyManifest.connector_id },
              purpose_code: 'https://pdpp.org/purpose/personalization',
              purpose_description: 'Maintain a concert-recommendation profile over time',
              access_mode: 'continuous',
              retention: {
                max_duration: 'P30D',
                on_expiry: 'delete',
              },
              streams: [{ name: 'top_artists', view: 'basic' }],
            },
          ],
        }),
      });
      assert.equal(initiateResp.status, 201);
      const initiate = await initiateResp.json();

      const consentResp = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(initiate.request_uri)}`);
      assert.equal(consentResp.status, 200);
      const consentHtml = await consentResp.text();
      assert.match(consentHtml, /Longview/);
      assert.match(consentHtml, /concert-recommendation profile/);
      assert.match(consentHtml, /top_artists/);

      const { body: approved } = await fetchJson(`${asUrl}/consent/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_uri: initiate.request_uri, subject_id: 'u1' }),
      });

      assert.equal(approved.grant.client.client_id, 'longview');
      assert.equal(approved.grant.client.client_display.name, 'Longview');
      assert.equal(approved.grant.source?.kind, 'connector');
      assert.equal(approved.grant.source?.id, SPOTIFY_CONNECTOR_KEY);
      assert.equal(approved.grant.access_mode, 'continuous');
      assert.equal(approved.grant.retention.max_duration, 'P30D');
      assert.equal(approved.grant.streams[0].name, 'top_artists');
      assert.equal(approved.grant.streams[0].view, 'basic');
      assert.ok(approved.token);

      const grantRows = getDb().prepare(`
        SELECT storage_binding_json
        FROM grants
        WHERE grant_id = ?
      `).all(approved.grant.grant_id);
      assert.equal(grantRows.length, 1);
      assert.deepEqual(JSON.parse(grantRows[0].storage_binding_json), { connector_id: SPOTIFY_CONNECTOR_KEY });
    });
  });

  await t.test('polyfill persisted grant bindings with unsupported fields are rejected on introspection and revocation', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const approved = await approveGrant(asUrl, 'u1', {
        client_id: 'longview',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Maintain a concert-recommendation profile over time',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists', view: 'basic' }],
      });

      await mutateGrantSource(approved.grant.grant_id, (source) => ({
        ...source,
        storage_connector_id: 'leaky_storage_connector',
        debug_context: 'should_not_escape',
      }));
      await mutateGrantStorageBinding(approved.grant.grant_id, (storageBinding) => ({
        ...storageBinding,
        debug_context: 'should_not_escape',
      }));

      const { body: introspection } = await fetchJson(`${asUrl}/introspect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: approved.token }),
      });
      assert.equal(introspection.active, false);
      assert.equal(introspection.inactive_reason, 'grant_invalid');
      assert.ok(!('grant' in introspection), 'malformed polyfill persisted grants should not be surfaced publicly');

      const revokeResp = await fetch(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${approved.token}`,
        },
      });
      assert.equal(revokeResp.status, 403);
      const revokeRequestId = revokeResp.headers.get('Request-Id');
      const revokeTraceId = revokeResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(revokeRequestId?.startsWith('req_'));
      assert.ok(revokeTraceId?.startsWith('trc_'));
      const revokeBody = await revokeResp.json();
      assert.equal(revokeBody.error.code, 'grant_invalid');
      assert.match(revokeBody.error.message, /Grant is malformed or no longer valid/);

      const { body: revokedTimeline } = await fetchJson(`${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`);
      const revokedEvent = revokedTimeline.data.find((event) => event.event_type === 'grant.revoked');
      assert.equal(revokedEvent, undefined, 'malformed polyfill persisted grants should not emit degraded grant.revoked artifacts');
      const rejectedEvent = revokedTimeline.data.find((event) => event.event_type === 'grant.revoke_rejected');
      assert.ok(rejectedEvent, 'malformed polyfill persisted grants should emit grant.revoke_rejected artifacts');
      assert.equal(rejectedEvent.request_id, revokeRequestId);
      assert.equal(rejectedEvent.trace_id, revokeTraceId);
      assert.equal(rejectedEvent.data?.error?.code, 'grant_invalid');
      assert.match(rejectedEvent.data?.error?.message || '', /Grant is malformed or no longer valid/);
    });
  });

  await t.test('polyfill malformed grant revocation preserves connector source when only storage binding drifts', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const approved = await approveGrant(asUrl, 'u1', {
        client_id: 'longview',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Maintain a concert-recommendation profile over time',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists', view: 'basic' }],
      });

      await mutateGrantStorageBinding(approved.grant.grant_id, (storageBinding) => ({
        ...storageBinding,
        debug_context: 'should_not_escape',
      }));

      const revokeResp = await fetch(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${approved.token}`,
        },
      });
      assert.equal(revokeResp.status, 403);
      const revokeRequestId = revokeResp.headers.get('Request-Id');
      const revokeTraceId = revokeResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(revokeRequestId?.startsWith('req_'));
      assert.ok(revokeTraceId?.startsWith('trc_'));

      const { body: revokedTimeline } = await fetchJson(`${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`);
      const rejectedEvent = revokedTimeline.data.find((event) => event.event_type === 'grant.revoke_rejected');
      assert.ok(rejectedEvent, 'malformed polyfill persisted grants should emit grant.revoke_rejected artifacts');
      assert.equal(rejectedEvent.request_id, revokeRequestId);
      assert.equal(rejectedEvent.trace_id, revokeTraceId);
      assert.equal(rejectedEvent.data?.source?.kind, 'connector');
      assert.equal(rejectedEvent.data?.source?.id, SPOTIFY_CONNECTOR_KEY);
      assert.ok(!('connector_id' in (rejectedEvent.data || {})), 'polyfill revoke rejection should use a source descriptor instead of a raw connector_id field');
      assert.ok(!('storage_connector_id' in (rejectedEvent.data || {})), 'polyfill revoke rejection should not expose storage connector ids');
      assert.equal(rejectedEvent.data?.error?.code, 'grant_invalid');
    });
  });

  await t.test('provider-connect request staging rejects malformed request envelopes', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const missingDetailsResp = await fetch(`${asUrl}/oauth/par`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: 'longview' }),
      });
      assert.equal(missingDetailsResp.status, 400);
      const missingDetailsBody = await missingDetailsResp.json();
      assert.equal(missingDetailsBody.error.code, 'invalid_request');
      assert.match(missingDetailsBody.error.message, /authorization_details/);

      const missingClientResp = await fetch(`${asUrl}/oauth/par`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authorization_details: [
            {
              type: 'https://pdpp.org/data-access',
              source: { kind: 'connector', id: spotifyManifest.connector_id },
              purpose_code: 'https://pdpp.org/purpose/personalization',
              access_mode: 'continuous',
              streams: [{ name: 'top_artists' }],
            },
          ],
        }),
      });
      assert.equal(missingClientResp.status, 400);
      const missingClientBody = await missingClientResp.json();
      assert.equal(missingClientBody.error.code, 'invalid_request');
      assert.match(missingClientBody.error.message, /requires client_id/);

      const multiDetailsResp = await fetch(`${asUrl}/oauth/par`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'longview',
          authorization_details: [
            {
              type: 'https://pdpp.org/data-access',
              source: { kind: 'connector', id: spotifyManifest.connector_id },
              purpose_code: 'https://pdpp.org/purpose/personalization',
              access_mode: 'continuous',
              streams: [{ name: 'top_artists' }],
            },
            {
              type: 'https://pdpp.org/data-access',
              source: { kind: 'connector', id: spotifyManifest.connector_id },
              purpose_code: 'https://pdpp.org/purpose/personalization',
              access_mode: 'continuous',
              streams: [{ name: 'saved_tracks' }],
            },
          ],
        }),
      });
      assert.equal(multiDetailsResp.status, 400);
      assert.equal(multiDetailsResp.headers.get('PDPP-Reference-Trace-Id'), null);
      const multiDetailsBody = await multiDetailsResp.json();
      assert.equal(multiDetailsBody.error.type, 'invalid_request_error');
      assert.equal(multiDetailsBody.error.code, 'invalid_request');
      assert.match(multiDetailsBody.error.message, /Exactly one authorization_details entry is supported/);
      assert.ok(multiDetailsBody.error.request_id);

      const unsupportedRequestFieldsResp = await fetch(`${asUrl}/oauth/par`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'longview',
          redirect_uri: 'https://longview.example/callback',
          response_type: 'code',
          code_challenge: 'challenge',
          authorization_details: [
            {
              type: 'https://pdpp.org/data-access',
              source: { kind: 'connector', id: spotifyManifest.connector_id },
              purpose_code: 'https://pdpp.org/purpose/personalization',
              access_mode: 'continuous',
              streams: [{ name: 'top_artists' }],
            },
          ],
        }),
      });
      assert.equal(unsupportedRequestFieldsResp.status, 400);
      const unsupportedRequestFieldsBody = await unsupportedRequestFieldsResp.json();
      assert.equal(unsupportedRequestFieldsBody.error.code, 'invalid_request');
      assert.match(unsupportedRequestFieldsBody.error.message, /Unsupported request fields: redirect_uri, response_type, code_challenge/);

      const badTypeResp = await fetch(`${asUrl}/oauth/par`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'longview',
          authorization_details: [
            {
              type: 'https://example.com/not-pdpp',
              source: { kind: 'connector', id: 'spotify' },
              purpose_code: 'https://pdpp.org/purpose/personalization',
              access_mode: 'continuous',
              streams: [{ name: 'top_artists' }],
            },
          ],
        }),
      });
      assert.equal(badTypeResp.status, 400);
      const badTypeBody = await badTypeResp.json();
      assert.equal(badTypeBody.error.code, 'invalid_request');
      assert.match(badTypeBody.error.message, /Unsupported authorization_details type/);

      const unsupportedAccessModeResp = await fetch(`${asUrl}/oauth/par`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'longview',
          authorization_details: [
            {
              type: 'https://pdpp.org/data-access',
              source: { kind: 'connector', id: spotifyManifest.connector_id },
              purpose_code: 'https://pdpp.org/purpose/personalization',
              access_mode: 'time_bounded',
              streams: [{ name: 'top_artists' }],
            },
          ],
        }),
      });
      assert.equal(unsupportedAccessModeResp.status, 400);
      const unsupportedAccessModeBody = await unsupportedAccessModeResp.json();
      assert.equal(unsupportedAccessModeBody.error.code, 'invalid_request');
      assert.match(unsupportedAccessModeBody.error.message, /access_mode must be "single_use" or "continuous"/);

      const emptyStreamsResp = await fetch(`${asUrl}/oauth/par`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'longview',
          authorization_details: [
            {
              type: 'https://pdpp.org/data-access',
              source: { kind: 'connector', id: spotifyManifest.connector_id },
              purpose_code: 'https://pdpp.org/purpose/personalization',
              access_mode: 'continuous',
              streams: [],
            },
          ],
        }),
      });
      assert.equal(emptyStreamsResp.status, 400);
      const emptyStreamsBody = await emptyStreamsResp.json();
      assert.equal(emptyStreamsBody.error.code, 'invalid_request');
      assert.match(emptyStreamsBody.error.message, /streams must be a non-empty array/);

      const unsupportedAuthorizationDetailFieldsResp = await fetch(`${asUrl}/oauth/par`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'longview',
          authorization_details: [
            {
              type: 'https://pdpp.org/data-access',
              source: { kind: 'connector', id: spotifyManifest.connector_id },
              purpose_code: 'https://pdpp.org/purpose/personalization',
              access_mode: 'continuous',
              locations: ['https://rs.pdpp.example'],
              streams: [{ name: 'top_artists', expand: ['albums'] }],
            },
          ],
        }),
      });
      assert.equal(unsupportedAuthorizationDetailFieldsResp.status, 400);
      const unsupportedAuthorizationDetailFieldsBody = await unsupportedAuthorizationDetailFieldsResp.json();
      assert.equal(unsupportedAuthorizationDetailFieldsBody.error.code, 'invalid_request');
      assert.match(unsupportedAuthorizationDetailFieldsBody.error.message, /Unsupported authorization_details fields: locations/);

      const unsupportedStreamSelectionFieldsResp = await fetch(`${asUrl}/oauth/par`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'longview',
          authorization_details: [
            {
              type: 'https://pdpp.org/data-access',
              source: { kind: 'connector', id: spotifyManifest.connector_id },
              purpose_code: 'https://pdpp.org/purpose/personalization',
              access_mode: 'continuous',
              streams: [{ name: 'top_artists', expand: ['albums'] }],
            },
          ],
        }),
      });
      assert.equal(unsupportedStreamSelectionFieldsResp.status, 400);
      const unsupportedStreamSelectionFieldsBody = await unsupportedStreamSelectionFieldsResp.json();
      assert.equal(unsupportedStreamSelectionFieldsBody.error.code, 'invalid_request');
      assert.match(unsupportedStreamSelectionFieldsBody.error.message, /Unsupported stream selection fields on 'top_artists': expand/);

      const unknownConnectorResp = await fetch(`${asUrl}/oauth/par`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'longview',
          authorization_details: [
            {
              type: 'https://pdpp.org/data-access',
              source: { kind: 'connector', id: 'not_a_real_connector' },
              purpose_code: 'https://pdpp.org/purpose/personalization',
              access_mode: 'continuous',
              streams: [{ name: 'top_artists' }],
            },
          ],
        }),
      });
      assert.equal(unknownConnectorResp.status, 400);
      const unknownConnectorBody = await unknownConnectorResp.json();
      assert.equal(unknownConnectorBody.error.code, 'invalid_request');
      assert.match(unknownConnectorBody.error.message, /Unknown source/);

      const unknownStreamResp = await fetch(`${asUrl}/oauth/par`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'longview',
          authorization_details: [
            {
              type: 'https://pdpp.org/data-access',
              source: { kind: 'connector', id: spotifyManifest.connector_id },
              purpose_code: 'https://pdpp.org/purpose/personalization',
              access_mode: 'continuous',
              streams: [{ name: 'not_a_real_stream' }],
            },
          ],
        }),
      });
      assert.equal(unknownStreamResp.status, 400);
      const unknownStreamBody = await unknownStreamResp.json();
      assert.equal(unknownStreamBody.error.code, 'invalid_request');
      assert.match(unknownStreamBody.error.message, /Unknown stream: not_a_real_stream/);

      const unknownViewResp = await fetch(`${asUrl}/oauth/par`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'longview',
          authorization_details: [
            {
              type: 'https://pdpp.org/data-access',
              source: { kind: 'connector', id: spotifyManifest.connector_id },
              purpose_code: 'https://pdpp.org/purpose/personalization',
              access_mode: 'continuous',
              streams: [{ name: 'top_artists', view: 'not_a_real_view' }],
            },
          ],
        }),
      });
      assert.equal(unknownViewResp.status, 400);
      const unknownViewBody = await unknownViewResp.json();
      assert.equal(unknownViewBody.error.code, 'invalid_request');
      assert.match(unknownViewBody.error.message, /Unknown view 'not_a_real_view' on stream 'top_artists'/);

      const contradictorySelectionResp = await fetch(`${asUrl}/oauth/par`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'longview',
          authorization_details: [
            {
              type: 'https://pdpp.org/data-access',
              source: { kind: 'connector', id: spotifyManifest.connector_id },
              purpose_code: 'https://pdpp.org/purpose/personalization',
              access_mode: 'continuous',
              streams: [{ name: 'top_artists', view: 'basic', fields: ['id'] }],
            },
          ],
        }),
      });
      assert.equal(contradictorySelectionResp.status, 400);
      const contradictorySelectionBody = await contradictorySelectionResp.json();
      assert.equal(contradictorySelectionBody.error.code, 'invalid_request');
      assert.match(contradictorySelectionBody.error.message, /view and fields are mutually exclusive/);

      const unknownFieldsResp = await fetch(`${asUrl}/oauth/par`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'longview',
          authorization_details: [
            {
              type: 'https://pdpp.org/data-access',
              source: { kind: 'connector', id: spotifyManifest.connector_id },
              purpose_code: 'https://pdpp.org/purpose/personalization',
              access_mode: 'continuous',
              streams: [{ name: 'top_artists', fields: ['id', 'not_a_real_field'] }],
            },
          ],
        }),
      });
      assert.equal(unknownFieldsResp.status, 400);
      const unknownFieldsBody = await unknownFieldsResp.json();
      assert.equal(unknownFieldsBody.error.code, 'invalid_request');
      assert.match(unknownFieldsBody.error.message, /Unknown fields on stream 'top_artists': not_a_real_field/);

      const malformedFieldsResp = await fetch(`${asUrl}/oauth/par`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'longview',
          authorization_details: [
            {
              type: 'https://pdpp.org/data-access',
              source: { kind: 'connector', id: spotifyManifest.connector_id },
              purpose_code: 'https://pdpp.org/purpose/personalization',
              access_mode: 'continuous',
              streams: [{ name: 'top_artists', fields: [] }],
            },
          ],
        }),
      });
      assert.equal(malformedFieldsResp.status, 400);
      const malformedFieldsBody = await malformedFieldsResp.json();
      assert.equal(malformedFieldsBody.error.code, 'invalid_request');
      assert.match(malformedFieldsBody.error.message, /fields must be a non-empty array of field names/);
    });
  });

  await t.test('provider-connect request staging rejects unknown client ids', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiateResp = await fetch(`${asUrl}/oauth/par`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'unknown_client',
          authorization_details: [
            {
              type: 'https://pdpp.org/data-access',
              source: { kind: 'connector', id: spotifyManifest.connector_id },
              purpose_code: 'https://pdpp.org/purpose/personalization',
              access_mode: 'continuous',
              streams: [{ name: 'top_artists' }],
            },
          ],
        }),
      });

      assert.equal(initiateResp.status, 400);
      const initiateBody = await initiateResp.json();
      assert.equal(initiateBody.error.code, 'invalid_client');
      assert.match(initiateBody.error.message, /Unknown client_id/);
    });
  });

  await t.test('provider-connect request staging rejects malformed persisted registered-client rows', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const registration = await registerDynamicClient(asUrl, {
        client_name: 'Transient Longview',
        token_endpoint_auth_method: 'none',
      });
      await updateRegisteredClientRow(registration.body.client_id, {
        metadata_json: '{',
      });

      const initiateResp = await fetch(`${asUrl}/oauth/par`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: registration.body.client_id,
          authorization_details: [
            {
              type: 'https://pdpp.org/data-access',
              source: { kind: 'connector', id: spotifyManifest.connector_id },
              purpose_code: 'https://pdpp.org/purpose/personalization',
              access_mode: 'continuous',
              streams: [{ name: 'top_artists' }],
            },
          ],
        }),
      });

      assert.equal(initiateResp.status, 400);
      const initiateBody = await initiateResp.json();
      assert.equal(initiateBody.error.code, 'invalid_client');
      assert.match(initiateBody.error.message, /malformed or no longer valid/);
    });
  });

  await t.test('provider-connect request staging failures preserve request and reference trace correlation through request.rejected artifacts', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const registration = await registerDynamicClient(asUrl, {
        client_name: 'Transient Longview',
        token_endpoint_auth_method: 'none',
      });
      await updateRegisteredClientRow(registration.body.client_id, {
        metadata_json: '{',
      });

      const initiateResp = await fetch(`${asUrl}/oauth/par`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: registration.body.client_id,
          authorization_details: [
            {
              type: 'https://pdpp.org/data-access',
              source: { kind: 'connector', id: spotifyManifest.connector_id },
              purpose_code: 'https://pdpp.org/purpose/personalization',
              access_mode: 'continuous',
              streams: [{ name: 'top_artists' }],
            },
          ],
        }),
      });

      assert.equal(initiateResp.status, 400);
      const requestId = initiateResp.headers.get('Request-Id');
      const traceId = initiateResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(requestId && requestId.startsWith('req_'));
      assert.ok(traceId && traceId.startsWith('trc_'));

      const initiateBody = await initiateResp.json();
      assert.equal(initiateBody.error.code, 'invalid_client');
      assert.equal(initiateBody.error.request_id, requestId);

      const { body: trace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(traceId)}`);
      const rejectedEvent = (trace.data || []).find((event) => event.event_type === 'request.rejected');
      assert.ok(rejectedEvent, 'trace should include request.rejected');
      assert.equal(rejectedEvent.request_id, requestId);
      assert.equal(rejectedEvent.client_id, registration.body.client_id);
      assert.equal(rejectedEvent.status, 'rejected');
      assert.equal(rejectedEvent.data?.error?.code, 'invalid_client');
      assert.match(rejectedEvent.data?.error?.message || '', /malformed or no longer valid/);
      assert.equal(rejectedEvent.data?.source?.kind, 'connector');
      assert.equal(rejectedEvent.data?.source?.id, SPOTIFY_CONNECTOR_KEY);
      assert.ok(!('connector_id' in (rejectedEvent.data || {})));
    });
  });

  await t.test('provider-connect request staging success preserves request and reference trace correlation through request.submitted artifacts', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiateResp = await fetch(`${asUrl}/oauth/par`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'longview',
          authorization_details: [
            {
              type: 'https://pdpp.org/data-access',
              source: { kind: 'connector', id: spotifyManifest.connector_id },
              purpose_code: 'https://pdpp.org/purpose/personalization',
              purpose_description: 'Maintain a concert-recommendation profile over time',
              access_mode: 'continuous',
              streams: [{ name: 'top_artists', view: 'basic' }],
            },
          ],
        }),
      });

      assert.equal(initiateResp.status, 201);
      const requestId = initiateResp.headers.get('Request-Id');
      const traceId = initiateResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(requestId && requestId.startsWith('req_'));
      assert.ok(traceId && traceId.startsWith('trc_'));

      const initiateBody = await initiateResp.json();
      assert.ok(initiateBody.request_uri?.startsWith('urn:pdpp:pending-consent:'));
      assert.ok(!('trace_context' in initiateBody), 'public PAR response should not expose internal trace_context');

      const { body: trace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(traceId)}`);
      const submittedEvent = (trace.data || []).find((event) => event.event_type === 'request.submitted');
      assert.ok(submittedEvent, 'trace should include request.submitted');
      assert.equal(submittedEvent.request_id, requestId);
      assert.equal(submittedEvent.trace_id, traceId);
      assert.equal(submittedEvent.client_id, 'longview');
      assert.equal(submittedEvent.status, 'succeeded');
      assert.equal(submittedEvent.data?.source?.kind, 'connector');
      assert.equal(submittedEvent.data?.source?.id, SPOTIFY_CONNECTOR_KEY);
      assert.ok(!('connector_id' in (submittedEvent.data || {})));
    });
  });

  await t.test('initial-access-token dynamic client registration returns a usable public client', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const registration = await registerDynamicClient(asUrl, {
        client_name: 'Dynamic Longview',
        client_uri: 'https://longview.example',
        policy_uri: 'https://longview.example/privacy',
        tos_uri: 'https://longview.example/terms',
        redirect_uris: ['https://longview.example/callback'],
        token_endpoint_auth_method: 'none',
      });

      assert.equal(registration.status, 201);
      const registrationRequestId = registration.headers['request-id'];
      const registrationTraceId = registration.headers['pdpp-reference-trace-id'];
      assert.ok(registrationRequestId?.startsWith('req_'));
      assert.ok(registrationTraceId?.startsWith('trc_'));
      assert.ok(typeof registration.body.client_id === 'string' && registration.body.client_id.startsWith('cli_'));
      assert.equal(registration.body.client_name, 'Dynamic Longview');
      assert.equal(registration.body.token_endpoint_auth_method, 'none');
      const { body: registrationTrace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(registrationTraceId)}`);
      const registeredEvent = (registrationTrace.data || []).find((event) => event.event_type === 'client.registered');
      assert.ok(registeredEvent, 'trace should include client.registered');
      assert.equal(registeredEvent.request_id, registrationRequestId);
      assert.equal(registeredEvent.trace_id, registrationTraceId);
      assert.equal(registeredEvent.object_id, registration.body.client_id);
      assert.equal(registeredEvent.client_id, registration.body.client_id);
      assert.equal(registeredEvent.data?.registration_mode, 'dynamic');
      assert.equal(registeredEvent.data?.registration_access, 'initial_access_token');
      assert.equal(registeredEvent.data?.client_name, 'Dynamic Longview');
      assert.equal(registeredEvent.data?.token_endpoint_auth_method, 'none');
      assert.equal(registeredEvent.data?.redirect_uri_count, 1);

      const initiateResp = await fetch(`${asUrl}/oauth/par`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: registration.body.client_id,
          authorization_details: [
            {
              type: 'https://pdpp.org/data-access',
              source: { kind: 'connector', id: spotifyManifest.connector_id },
              purpose_code: 'https://pdpp.org/purpose/personalization',
              purpose_description: 'Maintain a concert-recommendation profile over time',
              access_mode: 'continuous',
              streams: [{ name: 'top_artists', view: 'basic' }],
            },
          ],
        }),
      });
      assert.equal(initiateResp.status, 201);
      const initiate = await initiateResp.json();

      const { body: approved } = await fetchJson(`${asUrl}/consent/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_uri: initiate.request_uri, subject_id: 'u1' }),
      });

      assert.equal(approved.grant.client.client_id, registration.body.client_id);
      assert.equal(approved.grant.client.client_display.name, 'Dynamic Longview');
      assert.equal(approved.grant.client.client_display.uri, 'https://longview.example');
    });
  });

  await t.test('public dynamic client registration works without an initial access token', async () => {
    await withHarness(async ({ asUrl }) => {
      const registration = await registerDynamicClient(
        asUrl,
        {
          client_name: 'Public Dynamic Longview',
          token_endpoint_auth_method: 'none',
        },
        null,
      );

      assert.equal(registration.status, 201);
      const registrationTraceId = registration.headers['pdpp-reference-trace-id'];
      assert.ok(registrationTraceId?.startsWith('trc_'));
      assert.ok(typeof registration.body.client_id === 'string' && registration.body.client_id.startsWith('cli_'));
      assert.equal(registration.body.client_name, 'Public Dynamic Longview');
      assert.equal(registration.body.token_endpoint_auth_method, 'none');

      const { body: registrationTrace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(registrationTraceId)}`);
      const registeredEvent = (registrationTrace.data || []).find((event) => event.event_type === 'client.registered');
      assert.ok(registeredEvent, 'trace should include client.registered');
      assert.equal(registeredEvent.data?.registration_access, 'public');
    });
  });

  await t.test('registered client metadata stays authoritative over caller-supplied client_display assertions', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const registration = await registerDynamicClient(asUrl, {
        client_name: 'Registered Longview',
        client_uri: 'https://registered.longview.example',
        token_endpoint_auth_method: 'none',
      });

      const initiateResp = await fetch(`${asUrl}/oauth/par`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: registration.body.client_id,
          client_display: {
            name: 'Forged Display Name',
            uri: 'https://forged.longview.example',
          },
          authorization_details: [
            {
              type: 'https://pdpp.org/data-access',
              source: { kind: 'connector', id: spotifyManifest.connector_id },
              purpose_code: 'https://pdpp.org/purpose/personalization',
              purpose_description: 'Maintain a concert-recommendation profile over time',
              access_mode: 'continuous',
              streams: [{ name: 'top_artists', view: 'basic' }],
            },
          ],
        }),
      });
      assert.equal(initiateResp.status, 201);
      const initiate = await initiateResp.json();

      const consentResp = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(initiate.request_uri)}`);
      assert.equal(consentResp.status, 200);
      const consentHtml = await consentResp.text();
      assert.match(consentHtml, /Registered Longview/);
      assert.doesNotMatch(consentHtml, /Forged Display Name/);

      const { body: approved } = await fetchJson(`${asUrl}/consent/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_uri: initiate.request_uri, subject_id: 'u1' }),
      });

      assert.equal(approved.grant.client.client_display.name, 'Registered Longview');
      assert.equal(approved.grant.client.client_display.uri, 'https://registered.longview.example');
    });
  });

  await t.test('consent display and approval re-resolve registered client metadata instead of trusting the staged client snapshot', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const registration = await registerDynamicClient(asUrl, {
        client_name: 'Registered Longview',
        client_uri: 'https://registered.longview.example',
        token_endpoint_auth_method: 'none',
      });

      const initiate = await startGrantRequest(asUrl, {
        client_id: registration.body.client_id,
        client_display: {
          name: 'Forged Display Name',
          uri: 'https://forged.longview.example',
        },
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Maintain a concert-recommendation profile over time',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists', view: 'basic' }],
      });
      assert.equal(initiate.status, 201);

      await mutatePendingConsentRequest(initiate.body.request_uri, (request) => {
        request.client.client_display = {
          name: 'Persisted Forgery',
          uri: 'https://persisted.forgery.example',
        };
      });
      await mutateRegisteredClient(registration.body.client_id, (metadata) => {
        metadata.client_name = 'Updated Longview';
        metadata.client_uri = 'https://updated.longview.example';
      });

      const consentResp = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(initiate.body.request_uri)}`);
      assert.equal(consentResp.status, 200);
      const consentHtml = await consentResp.text();
      assert.match(consentHtml, /Updated Longview/);
      assert.doesNotMatch(consentHtml, /Persisted Forgery/);

      const approveResp = await approveGrantRequest(asUrl, initiate.body.request_uri, 'u1');
      assert.equal(approveResp.status, 200);
      assert.equal(approveResp.body.grant.client.client_display.name, 'Updated Longview');
      assert.equal(approveResp.body.grant.client.client_display.uri, 'https://updated.longview.example');
    });
  });

  await t.test('persisted pending request trace-context drift does not break staged trace correlation on approval', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiate = await startGrantRequest(asUrl, {
        client_id: 'longview',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Maintain a concert-recommendation profile over time',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists', view: 'basic' }],
      });
      assert.equal(initiate.status, 201);
      const stagedTrace = await readPendingConsentTraceContext(initiate.body.request_uri);
      const stagedRequestId = stagedTrace.request_id;
      const stagedTraceId = stagedTrace.trace_id;
      assert.ok(stagedRequestId?.startsWith('req_'));
      assert.ok(stagedTraceId?.startsWith('trc_'));

      await mutatePendingConsentRequest(initiate.body.request_uri, (request) => {
        request.trace_context = {
          request_id: 'req_forged_pending',
          trace_id: 'trc_forged_pending',
          scenario_id: 'scn_forged_pending',
          debug_context: 'should_not_escape',
        };
      });

      const consentResp = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(initiate.body.request_uri)}`);
      assert.equal(consentResp.status, 200);
      const consentHtml = await consentResp.text();
      assert.match(consentHtml, /Longview/);
      assert.match(
        consentHtml,
        new RegExp(`<dt>Connector</dt><dd>${SPOTIFY_CONNECTOR_KEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</dd>`),
      );

      const approveResp = await approveGrantRequest(asUrl, initiate.body.request_uri, 'u1');
      assert.equal(approveResp.status, 200);
      assert.equal(approveResp.headers['request-id'], stagedRequestId);
      assert.equal(approveResp.headers['pdpp-reference-trace-id'], stagedTraceId);
      assert.equal(approveResp.body.grant.source.kind, 'connector');
      assert.equal(approveResp.body.grant.source.id, SPOTIFY_CONNECTOR_KEY);

      const { body: trace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(stagedTraceId)}`);
      const approvedEvent = (trace.data || []).find((event) =>
        event.event_type === 'consent.approved'
        && event.request_id === stagedRequestId
      );
      assert.ok(approvedEvent, 'trace should keep consent.approved on the original staged trace');
      assert.equal(approvedEvent.data?.source?.kind, 'connector');
      assert.equal(approvedEvent.data?.source?.id, SPOTIFY_CONNECTOR_KEY);

      const grantIssuedEvent = (trace.data || []).find((event) =>
        event.event_type === 'grant.issued'
        && event.request_id === stagedRequestId
      );
      assert.ok(grantIssuedEvent, 'trace should keep grant.issued on the original staged trace');
      assert.equal(grantIssuedEvent.data?.source?.kind, 'connector');
      assert.equal(grantIssuedEvent.data?.source?.id, SPOTIFY_CONNECTOR_KEY);

      const forgedTraceResp = await fetch(`${asUrl}/_ref/traces/trc_forged_pending`);
      assert.equal(forgedTraceResp.status, 404);
    });
  });

  await t.test('persisted pending rows missing top-level trace correlation are rejected instead of falling back to embedded request trace_context', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiate = await startGrantRequest(asUrl, {
        client_id: 'longview',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Maintain a concert-recommendation profile over time',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists', view: 'basic' }],
      });
      assert.equal(initiate.status, 201);
      const stagedTrace = await readPendingConsentTraceContext(initiate.body.request_uri);
      const stagedRequestId = stagedTrace.request_id;
      const stagedTraceId = stagedTrace.trace_id;

      const deviceCode = parsePendingConsentRequestUri(initiate.body.request_uri);
      assert.ok(deviceCode);

      const pendingRows = getDb().prepare(`
        SELECT params_json
        FROM pending_consents
        WHERE device_code = ?
      `).all(deviceCode);
      assert.equal(pendingRows.length, 1);
      const driftedRequest = JSON.parse(pendingRows[0].params_json);
      driftedRequest.trace_context = {
        request_id: 'req_forged_pending',
        trace_id: 'trc_forged_pending',
        scenario_id: 'scn_forged_pending',
      };
      await updatePendingConsentRow(initiate.body.request_uri, {
        params_json: JSON.stringify(driftedRequest),
        request_id: null,
        trace_id: null,
        scenario_id: null,
      });

      const consentResp = await fetchJson(`${asUrl}/consent?request_uri=${encodeURIComponent(initiate.body.request_uri)}`);
      assert.equal(consentResp.status, 400);
      assert.equal(consentResp.body.error?.code, 'invalid_request');
      assert.equal(consentResp.body.error?.message, 'Pending consent row is missing persisted trace correlation');
      assert.notEqual(consentResp.headers['request-id'], stagedRequestId);
      assert.equal(consentResp.headers['pdpp-reference-trace-id'], undefined);

      const approveResp = await approveGrantRequest(asUrl, initiate.body.request_uri, 'u1');
      assert.equal(approveResp.status, 400);
      assert.equal(approveResp.body.error?.code, 'invalid_request');
      assert.equal(approveResp.body.error?.message, 'Pending consent row is missing persisted trace correlation');
      assert.notEqual(approveResp.headers['request-id'], stagedRequestId);
      assert.equal(approveResp.headers['pdpp-reference-trace-id'], undefined);

      const denyResp = await fetchJson(`${asUrl}/consent/deny?request_uri=${encodeURIComponent(initiate.body.request_uri)}`, {
        method: 'POST',
      });
      assert.equal(denyResp.status, 400);
      assert.equal(denyResp.body.error?.code, 'invalid_request');
      assert.equal(denyResp.body.error?.message, 'Pending consent row is missing persisted trace correlation');
      assert.notEqual(denyResp.headers['request-id'], stagedRequestId);
      assert.equal(denyResp.headers['pdpp-reference-trace-id'], undefined);

      const { body: stagedTraceBody } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(stagedTraceId)}`);
      const stagedFollowOnEvents = (stagedTraceBody.data || []).filter((event) =>
        ['request.rejected', 'consent.approved', 'consent.denied', 'grant.issued'].includes(event.event_type)
      );
      assert.equal(stagedFollowOnEvents.length, 0, 'malformed pending rows should not append forged follow-on artifacts to the staged trace');

      const forgedTraceResp = await fetch(`${asUrl}/_ref/traces/trc_forged_pending`);
      assert.equal(forgedTraceResp.status, 404);
    });
  });

  await t.test('persisted pending request bindings with unsupported fields are rejected on the original staged trace', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiate = await startGrantRequest(asUrl, {
        client_id: 'longview',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Maintain a concert-recommendation profile over time',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists', view: 'basic' }],
      });
      assert.equal(initiate.status, 201);
      const stagedTrace = await readPendingConsentTraceContext(initiate.body.request_uri);
      const stagedRequestId = stagedTrace.request_id;
      const stagedTraceId = stagedTrace.trace_id;

      await mutatePendingConsentRequest(initiate.body.request_uri, (request) => {
        request.trace_context = {
          request_id: 'req_forged_pending',
          trace_id: 'trc_forged_pending',
          scenario_id: 'scn_forged_pending',
          debug_context: 'should_not_escape',
        };
        request.source_binding = {
          ...request.source_binding,
          debug_context: 'should_not_escape',
        };
        request.storage_binding = {
          ...request.storage_binding,
          debug_context: 'should_not_escape',
        };
      });

      const consentResp = await fetchJson(`${asUrl}/consent?request_uri=${encodeURIComponent(initiate.body.request_uri)}`);
      assert.equal(consentResp.status, 400);
      assert.equal(consentResp.body.error.code, 'invalid_request');
      assert.match(consentResp.body.error.message, /source_binding must include only kind and id/);

      const approveResp = await approveGrantRequest(asUrl, initiate.body.request_uri, 'u1');
      assert.equal(approveResp.status, 400);
      assert.equal(approveResp.body.error.code, 'invalid_request');
      assert.match(approveResp.body.error.message, /source_binding must include only kind and id/);

      const { body: trace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(stagedTraceId)}`);
      const rejectedEvent = (trace.data || []).find((event) =>
        event.event_type === 'request.rejected'
        && event.request_id === stagedRequestId
      );
      assert.ok(rejectedEvent, 'trace should keep request.rejected on the original staged trace');
      assert.equal(rejectedEvent.data?.source?.kind, 'connector');
      assert.equal(rejectedEvent.data?.source?.id, SPOTIFY_CONNECTOR_KEY);
    });
  });

  await t.test('persisted pending request source bindings without kind are rejected without reconstructing connector source artifacts', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiate = await startGrantRequest(asUrl, {
        client_id: 'longview',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Maintain a concert-recommendation profile over time',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists', view: 'basic' }],
      });
      assert.equal(initiate.status, 201);
      const stagedTrace = await readPendingConsentTraceContext(initiate.body.request_uri);
      const stagedRequestId = stagedTrace.request_id;
      const stagedTraceId = stagedTrace.trace_id;

      await mutatePendingConsentRequest(initiate.body.request_uri, (request) => {
        request.source_binding = {
          id: request.source_binding.id,
        };
      });

      const consentResp = await fetchJson(`${asUrl}/consent?request_uri=${encodeURIComponent(initiate.body.request_uri)}`);
      assert.equal(consentResp.status, 400);
      assert.equal(consentResp.body.error.code, 'invalid_request');
      assert.match(consentResp.body.error.message, /source_binding must include only kind and id/);

      const approveResp = await approveGrantRequest(asUrl, initiate.body.request_uri, 'u1');
      assert.equal(approveResp.status, 400);
      assert.equal(approveResp.body.error.code, 'invalid_request');
      assert.match(approveResp.body.error.message, /source_binding must include only kind and id/);

      const { body: trace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(stagedTraceId)}`);
      const rejectedEvent = (trace.data || []).find((event) =>
        event.event_type === 'request.rejected'
        && event.request_id === stagedRequestId
      );
      assert.ok(rejectedEvent, 'trace should keep request.rejected on the original staged trace');
      assert.equal(rejectedEvent.data?.source, null);
    });
  });

  await t.test('consent display and approval reject staged requests whose registered client no longer exists', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const registration = await registerDynamicClient(asUrl, {
        client_name: 'Transient Longview',
        token_endpoint_auth_method: 'none',
      });

      const initiate = await startGrantRequest(asUrl, {
        client_id: registration.body.client_id,
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Maintain a concert-recommendation profile over time',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists', view: 'basic' }],
      });
      assert.equal(initiate.status, 201);

      await deleteRegisteredClient(registration.body.client_id);

      const consentResp = await fetch(
        `${asUrl}/consent?request_uri=${encodeURIComponent(initiate.body.request_uri)}`,
      );
      assert.equal(consentResp.status, 400);
      const consentRequestId = consentResp.headers.get('Request-Id');
      const consentTraceId = consentResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(consentRequestId?.startsWith('req_'));
      assert.ok(consentTraceId?.startsWith('trc_'));
      const consentBody = await consentResp.json();
      assert.equal(consentBody.error.code, 'invalid_client');
      assert.match(consentBody.error.message, /Unknown client_id/);

      const approveResp = await fetch(`${asUrl}/consent/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_uri: initiate.body.request_uri, subject_id: 'u1' }),
      });
      assert.equal(approveResp.status, 400);
      const approveRequestId = approveResp.headers.get('Request-Id');
      const approveTraceId = approveResp.headers.get('PDPP-Reference-Trace-Id');
      assert.equal(approveRequestId, consentRequestId);
      assert.equal(approveTraceId, consentTraceId);
      const approveBody = await approveResp.json();
      assert.equal(approveBody.error.code, 'invalid_client');
      assert.match(approveBody.error.message, /Unknown client_id/);

      const { body: trace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(consentTraceId)}`);
      const rejectedEvents = (trace.data || []).filter((event) =>
        event.event_type === 'request.rejected'
        && event.request_id === consentRequestId
      );
      assert.ok(rejectedEvents.length >= 1, 'trace should include request.rejected for consent-time client drift');
      const rejectedEvent = rejectedEvents.find((event) => event.data?.error?.code === 'invalid_client');
      assert.ok(rejectedEvent, 'trace should preserve invalid_client rejection details');
      assert.equal(rejectedEvent.object_type, 'pending_consent');
      assert.equal(rejectedEvent.client_id, registration.body.client_id);
      assert.equal(rejectedEvent.data?.source?.kind, 'connector');
      assert.equal(rejectedEvent.data?.source?.id, SPOTIFY_CONNECTOR_KEY);
      assert.match(rejectedEvent.data?.error?.message || '', /Unknown client_id/);
    });
  });

  await t.test('consent denial preserves staged trace correlation and emits consent.denied on the original trace', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiate = await startGrantRequest(asUrl, {
        client_id: 'longview',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Maintain a concert-recommendation profile over time',
        access_mode: 'single_use',
        streams: [{ name: 'saved_tracks', fields: ['id', 'name'] }],
      });
      assert.equal(initiate.status, 201);

      const stagedRequestId = initiate.headers['request-id'];
      const stagedTraceId = initiate.headers['pdpp-reference-trace-id'];
      assert.ok(stagedRequestId?.startsWith('req_'));
      assert.ok(stagedTraceId?.startsWith('trc_'));

      const denyResp = await denyGrantRequest(asUrl, initiate.body.request_uri);
      assert.equal(denyResp.status, 200);
      assert.equal(denyResp.headers['request-id'], stagedRequestId);
      assert.equal(denyResp.headers['pdpp-reference-trace-id'], stagedTraceId);
      assert.match(denyResp.body, /Access Denied/);

      const { body: trace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(stagedTraceId)}`);
      const deniedEvent = (trace.data || []).find((event) =>
        event.event_type === 'consent.denied'
        && event.request_id === stagedRequestId
      );
      assert.ok(deniedEvent, 'trace should include consent.denied on the original staged trace');
      assert.equal(deniedEvent.client_id, 'longview');
      assert.equal(deniedEvent.object_type, 'pending_consent');
      assert.equal(deniedEvent.status, 'denied');
      assert.equal(deniedEvent.data?.source?.kind, 'connector');
      assert.equal(deniedEvent.data?.source?.id, SPOTIFY_CONNECTOR_KEY);

      const grantIssuedEvent = (trace.data || []).find((event) => event.event_type === 'grant.issued');
      assert.equal(grantIssuedEvent, undefined, 'denied consent trace should not issue a grant');
    });
  });

  await t.test('consent display and approval reject staged requests whose registered client row becomes malformed', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const registration = await registerDynamicClient(asUrl, {
        client_name: 'Transient Longview',
        token_endpoint_auth_method: 'none',
      });

      const initiate = await startGrantRequest(asUrl, {
        client_id: registration.body.client_id,
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Maintain a concert-recommendation profile over time',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists', view: 'basic' }],
      });
      assert.equal(initiate.status, 201);

      await updateRegisteredClientRow(registration.body.client_id, {
        metadata_json: '{',
      });

      const consentResp = await fetchJson(
        `${asUrl}/consent?request_uri=${encodeURIComponent(initiate.body.request_uri)}`,
      );
      assert.equal(consentResp.status, 400);
      assert.equal(consentResp.body.error.code, 'invalid_client');
      assert.match(consentResp.body.error.message, /malformed or no longer valid/);

      const approveResp = await approveGrantRequest(asUrl, initiate.body.request_uri, 'u1');
      assert.equal(approveResp.status, 400);
      assert.equal(approveResp.body.error.code, 'invalid_client');
      assert.match(approveResp.body.error.message, /malformed or no longer valid/);
    });
  });

  await t.test('owner device authorization rejects unknown client ids instead of staging orphaned device codes', async () => {
    await withHarness(async ({ asUrl }) => {
      const deviceResp = await fetchJson(`${asUrl}/oauth/device_authorization`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: 'not-a-real-client' }).toString(),
      });

      assert.equal(deviceResp.status, 400);
      assert.equal(deviceResp.body.error, 'invalid_client');
      assert.match(deviceResp.body.error_description, /Unknown client_id/);
    });
  });

  await t.test('owner device authorization rejects malformed registered-client rows instead of staging orphaned device codes', async () => {
    await withHarness(async ({ asUrl }) => {
      await updateRegisteredClientRow('cli_longview', {
        metadata_json: '{',
      });

      const deviceResp = await fetchJson(`${asUrl}/oauth/device_authorization`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: 'cli_longview' }).toString(),
      });

      assert.equal(deviceResp.status, 400);
      assert.equal(deviceResp.body.error, 'invalid_client');
      assert.match(deviceResp.body.error_description, /malformed or no longer valid/);
    });
  });

  await t.test('owner device authorization stays inspectable through request correlation and trace artifacts', async () => {
    await withHarness(async ({ asUrl }) => {
      const deviceResp = await fetch(`${asUrl}/oauth/device_authorization`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: 'cli_longview' }).toString(),
      });

      assert.equal(deviceResp.status, 200);
      const requestId = deviceResp.headers.get('Request-Id');
      const traceId = deviceResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(requestId && requestId.startsWith('req_'));
      assert.ok(traceId && traceId.startsWith('trc_'));

      const deviceBody = await deviceResp.json();
      const { body: trace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(traceId)}`);
      const submittedEvent = (trace.data || []).find((event) => event.event_type === 'request.submitted');
      assert.ok(submittedEvent, 'trace should include request.submitted');
      assert.equal(submittedEvent.request_id, requestId);
      assert.equal(submittedEvent.client_id, 'cli_longview');
      assert.equal(submittedEvent.object_type, 'owner_device_auth');
      // The live device_code is bearer-equivalent for owner_device_auth
      // (it redeems for an owner bearer at /oauth/token), so the public
      // _ref read surface SHALL replace object_id with a redaction
      // literal. Spec: harden-reference-auth-surfaces §7.
      assert.equal(submittedEvent.object_id, '<redacted-device-code>');
      assert.equal(submittedEvent.data?.issuance_path, 'owner_device_flow');
      // user_code is part of the takeover chain; redacted on public reads.
      assert.equal(submittedEvent.data?.user_code, '<redacted-bearer>');

      const pendingResp = await fetch(`${asUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceBody.device_code,
          client_id: 'cli_longview',
        }).toString(),
      });
      assert.equal(pendingResp.status, 400);
      assert.equal(pendingResp.headers.get('Request-Id'), requestId);
      assert.equal(pendingResp.headers.get('PDPP-Reference-Trace-Id'), traceId);
      const pendingBody = await pendingResp.json();
      assert.equal(pendingBody.error, 'authorization_pending');

      const approveResp = await fetch(`${asUrl}/device/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          user_code: deviceBody.user_code,
          subject_id: 'cli_owner',
        }).toString(),
      });
      assert.equal(approveResp.status, 200);
      const exchangeResp = await fetch(`${asUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceBody.device_code,
          client_id: 'cli_longview',
        }).toString(),
      });
      assert.equal(exchangeResp.status, 200);
      assert.equal(exchangeResp.headers.get('Request-Id'), requestId);
      assert.equal(exchangeResp.headers.get('PDPP-Reference-Trace-Id'), traceId);
      const exchangeBody = await exchangeResp.json();
      assert.ok(exchangeBody.access_token);
      const { body: approvedTrace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(traceId)}`);
      const ownerTokenEvent = (approvedTrace.data || []).find(
        (event) => event.event_type === 'token.issued' && event.data?.issuance_path === 'owner_device_flow'
      );
      assert.ok(ownerTokenEvent, 'trace should include owner token issuance');
      assert.equal(ownerTokenEvent.request_id, requestId);
      assert.equal(ownerTokenEvent.client_id, 'cli_longview');
      // user_code redacted on public _ref read.
      assert.equal(ownerTokenEvent.data?.user_code, '<redacted-bearer>');
    });
  });

  await t.test('owner device denial stays inspectable through request correlation and trace artifacts', async () => {
    await withHarness(async ({ asUrl }) => {
      const deviceResp = await fetch(`${asUrl}/oauth/device_authorization`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: 'cli_longview' }).toString(),
      });

      assert.equal(deviceResp.status, 200);
      const requestId = deviceResp.headers.get('Request-Id');
      const traceId = deviceResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(requestId && requestId.startsWith('req_'));
      assert.ok(traceId && traceId.startsWith('trc_'));

      const deviceBody = await deviceResp.json();

      const denyResp = await fetch(`${asUrl}/device/deny`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          user_code: deviceBody.user_code,
          subject_id: 'cli_owner',
        }).toString(),
      });
      assert.equal(denyResp.status, 200);

      const tokenResp = await fetch(`${asUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceBody.device_code,
          client_id: 'cli_longview',
        }).toString(),
      });
      assert.equal(tokenResp.status, 400);
      assert.equal(tokenResp.headers.get('Request-Id'), requestId);
      assert.equal(tokenResp.headers.get('PDPP-Reference-Trace-Id'), traceId);
      const tokenBody = await tokenResp.json();
      assert.equal(tokenBody.error, 'access_denied');

      const { body: trace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(traceId)}`);
      const rejectedEvent = (trace.data || []).find((event) =>
        event.event_type === 'request.rejected'
        && event.request_id === requestId
      );
      assert.ok(rejectedEvent, 'trace should include request.rejected for owner-device denial');
      assert.equal(rejectedEvent.client_id, 'cli_longview');
      // device_code / user_code redacted on public _ref read surfaces
      // (harden-reference-auth-surfaces §7). The internal correlation
      // by request_id and client_id remains intact.
      assert.equal(rejectedEvent.object_id, '<redacted-device-code>');
      assert.equal(rejectedEvent.data?.issuance_path, 'owner_device_flow');
      assert.equal(rejectedEvent.data?.user_code, '<redacted-bearer>');
      assert.equal(rejectedEvent.data?.error?.code, 'access_denied');
      assert.match(rejectedEvent.data?.error?.message || '', /denied the request/);
    });
  });

  await t.test('owner device authorization failures preserve request and reference trace correlation through request.rejected artifacts', async () => {
    await withHarness(async ({ asUrl }) => {
      await updateRegisteredClientRow('cli_longview', {
        metadata_json: '{',
      });

      const deviceResp = await fetch(`${asUrl}/oauth/device_authorization`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: 'cli_longview' }).toString(),
      });

      assert.equal(deviceResp.status, 400);
      const requestId = deviceResp.headers.get('Request-Id');
      const traceId = deviceResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(requestId && requestId.startsWith('req_'));
      assert.ok(traceId && traceId.startsWith('trc_'));

      const deviceBody = await deviceResp.json();
      assert.equal(deviceBody.error, 'invalid_client');
      assert.match(deviceBody.error_description, /malformed or no longer valid/);

      const { body: trace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(traceId)}`);
      const rejectedEvent = (trace.data || []).find((event) => event.event_type === 'request.rejected');
      assert.ok(rejectedEvent, 'trace should include request.rejected');
      assert.equal(rejectedEvent.request_id, requestId);
      assert.equal(rejectedEvent.client_id, 'cli_longview');
      assert.equal(rejectedEvent.status, 'rejected');
      assert.equal(rejectedEvent.data?.issuance_path, 'owner_device_flow');
      assert.equal(rejectedEvent.data?.error?.code, 'invalid_client');
      assert.match(rejectedEvent.data?.error?.message || '', /malformed or no longer valid/);
    });
  });

  await t.test('owner device approval and exchange reject device codes whose client registration disappears before completion', async () => {
    await withHarness(async ({ asUrl }) => {
      const { body: device } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: 'cli_longview' }).toString(),
      });

      await deleteRegisteredClient('cli_longview');

      const devicePageResp = await fetch(`${asUrl}/device?user_code=${encodeURIComponent(device.user_code)}`);
      assert.equal(devicePageResp.status, 200);
      const devicePageHtml = await devicePageResp.text();
      assert.doesNotMatch(devicePageHtml, /Approve owner access/i);

      const approveResp = await fetchJson(`${asUrl}/device/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          user_code: device.user_code,
          subject_id: 'owner_local',
        }).toString(),
      });
      assert.equal(approveResp.status, 400);
      assert.equal(approveResp.body.error, 'invalid_client');
      assert.match(approveResp.body.error_description, /Unknown client_id/);

      const tokenResp = await fetchJson(`${asUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: device.device_code,
          client_id: 'cli_longview',
        }).toString(),
      });
      assert.equal(tokenResp.status, 400);
      assert.equal(tokenResp.body.error, 'invalid_client');
      assert.match(tokenResp.body.error_description, /Unknown client_id/);
    });
  });

  await t.test('owner device display, approval, and exchange reject device codes whose client registration row becomes malformed', async () => {
    await withHarness(async ({ asUrl }) => {
      const { body: device } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: 'cli_longview' }).toString(),
      });

      await updateRegisteredClientRow('cli_longview', {
        metadata_json: '{',
      });

      const devicePageResp = await fetch(`${asUrl}/device?user_code=${encodeURIComponent(device.user_code)}`);
      assert.equal(devicePageResp.status, 200);
      const devicePageHtml = await devicePageResp.text();
      assert.doesNotMatch(devicePageHtml, /Approve owner access/i);

      const approveResp = await fetchJson(`${asUrl}/device/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          user_code: device.user_code,
          subject_id: 'owner_local',
        }).toString(),
      });
      assert.equal(approveResp.status, 400);
      assert.equal(approveResp.body.error, 'invalid_client');
      assert.match(approveResp.body.error_description, /malformed or no longer valid/);

      const tokenResp = await fetchJson(`${asUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: device.device_code,
          client_id: 'cli_longview',
        }).toString(),
      });
      assert.equal(tokenResp.status, 400);
      assert.equal(tokenResp.body.error, 'invalid_client');
      assert.match(tokenResp.body.error_description, /malformed or no longer valid/);
    });
  });

  await t.test('dynamic client registration rejects invalid initial access tokens', async () => {
    await withHarness(async ({ asUrl }) => {
      const registration = await fetch(`${asUrl}/oauth/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer wrong-token',
        },
        body: JSON.stringify({
          client_name: 'Rejected Client',
          token_endpoint_auth_method: 'none',
        }),
      });

      assert.equal(registration.status, 401);
      const registrationRequestId = registration.headers.get('Request-Id');
      const registrationTraceId = registration.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(registrationRequestId?.startsWith('req_'));
      assert.ok(registrationTraceId?.startsWith('trc_'));
      const registrationBody = await registration.json();
      assert.equal(registrationBody.error, 'invalid_client');
      assert.match(registrationBody.error_description, /Invalid initial access token/);

      const { body: registrationTrace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(registrationTraceId)}`);
      const rejectedEvent = (registrationTrace.data || []).find((event) => event.event_type === 'client.register_rejected');
      assert.ok(rejectedEvent, 'trace should include client.register_rejected');
      assert.equal(rejectedEvent.request_id, registrationRequestId);
      assert.equal(rejectedEvent.trace_id, registrationTraceId);
      assert.equal(rejectedEvent.object_id, registrationRequestId);
      assert.equal(rejectedEvent.data?.requested_client_name, 'Rejected Client');
      assert.equal(rejectedEvent.data?.requested_token_endpoint_auth_method, 'none');
      assert.equal(rejectedEvent.data?.requested_redirect_uri_count, 0);
      assert.equal(rejectedEvent.data?.error?.code, 'invalid_client');
    });
  });

  await t.test('dynamic client registration rejects unsupported OAuth metadata beyond the current public-client profile', async () => {
    await withHarness(async ({ asUrl }) => {
      const responseTypes = await fetch(`${asUrl}/oauth/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_DCR_INITIAL_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({
          client_name: 'Too Broad',
          token_endpoint_auth_method: 'none',
          response_types: ['token'],
        }),
      });

      assert.equal(responseTypes.status, 400);
      const responseTypesBody = await responseTypes.json();
      assert.equal(responseTypesBody.error, 'invalid_client_metadata');
      assert.match(responseTypesBody.error_description, /Unsupported response_types/i);

      const confidential = await fetch(`${asUrl}/oauth/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_DCR_INITIAL_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({
          client_name: 'Confidential Client',
          token_endpoint_auth_method: 'none',
          client_secret: 'not-allowed',
        }),
      });

      assert.equal(confidential.status, 400);
      const confidentialBody = await confidential.json();
      assert.equal(confidentialBody.error, 'invalid_client_metadata');
      assert.match(confidentialBody.error_description, /only registers public clients/i);

      const applicationType = await fetch(`${asUrl}/oauth/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_DCR_INITIAL_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({
          client_name: 'Native Longview',
          token_endpoint_auth_method: 'none',
          application_type: 'browser',
        }),
      });

      assert.equal(applicationType.status, 400);
      const applicationTypeBody = await applicationType.json();
      assert.equal(applicationTypeBody.error, 'invalid_client_metadata');
      assert.match(applicationTypeBody.error_description, /Unsupported application_type/i);
    });
  });

  await t.test('dynamic client registration rejects unsupported client metadata extension fields', async () => {
    await withHarness(async ({ asUrl }) => {
      const registration = await fetch(`${asUrl}/oauth/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_DCR_INITIAL_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({
          client_name: 'Longview',
          jwks_uri: 'https://client.example/jwks.json',
          scope: 'openid profile',
        }),
      });

      assert.equal(registration.status, 400);
      const registrationBody = await registration.json();
      assert.equal(registrationBody.error, 'invalid_client_metadata');
      assert.match(registrationBody.error_description, /Unsupported client metadata fields: jwks_uri, scope/);
    });
  });

  await t.test('dynamic client registration rejects malformed URI metadata fields', async () => {
    await withHarness(async ({ asUrl }) => {
      const invalidRedirectUris = await fetch(`${asUrl}/oauth/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_DCR_INITIAL_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({
          client_name: 'Longview',
          redirect_uris: ['not a uri'],
        }),
      });

      assert.equal(invalidRedirectUris.status, 400);
      const invalidRedirectUrisBody = await invalidRedirectUris.json();
      assert.equal(invalidRedirectUrisBody.error, 'invalid_client_metadata');
      assert.match(invalidRedirectUrisBody.error_description, /redirect_uris must be a valid absolute URI/);

      const invalidClientUri = await fetch(`${asUrl}/oauth/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_DCR_INITIAL_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({
          client_name: 'Longview',
          client_uri: 'still not a uri',
        }),
      });

      assert.equal(invalidClientUri.status, 400);
      const invalidClientUriBody = await invalidClientUri.json();
      assert.equal(invalidClientUriBody.error, 'invalid_client_metadata');
      assert.match(invalidClientUriBody.error_description, /client_uri must be a valid absolute URI/);
    });
  });

  await t.test('request staging rejects time_range on streams without consent_time_field support', async () => {
    const server = await startServer({
    quiet: true,
      asPort: 0,
      rsPort: 0,
      dbPath: ':memory:',
      dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    });
    const asUrl = `http://localhost:${server.asPort}`;

    const manifest = {
      connector_id: 'time_range_test',
      display_name: 'Time Range Test',
      version: '0.1.0',
      streams: [
        {
          name: 'items',
          semantics: 'append_only',
          primary_key: 'id',
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              value: { type: 'string' },
            },
          },
        },
      ],
    };

    try {
      const registerResp = await fetchJson(`${asUrl}/connectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(manifest),
      });
      assert.equal(registerResp.status, 201);

      const initiate = await startGrantRequest(asUrl, {
        client_id: 'longview',
        connector_id: manifest.connector_id,
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Test unsupported time_range validation',
        access_mode: 'continuous',
        streams: [{ name: 'items', time_range: { since: '2026-01-01T00:00:00Z' } }],
      });

      assert.equal(initiate.status, 400);
      assert.equal(initiate.body.error.code, 'invalid_request');
      assert.match(initiate.body.error.message, /does not support time_range/);
    } finally {
      await closeServer(server);
    }
  });

  await t.test('connector registry rejects provider-native manifests on the polyfill connector surface', async () => {
    const server = await startServer({
    quiet: true,
      asPort: 0,
      rsPort: 0,
      dbPath: ':memory:',
      dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    });
    const asUrl = `http://localhost:${server.asPort}`;

    try {
      const manifest = {
        connector_id: 'https://registry.pdpp.org/connectors/not-actually-polyfill',
        provider_id: 'https://native.example/providers/hr',
        version: '0.1.0',
        streams: [
          {
            name: 'items',
            semantics: 'append_only',
            schema: {
              type: 'object',
              properties: {
                id: { type: 'string' },
              },
            },
            primary_key: 'id',
          },
        ],
      };

      const registerResp = await fetchJson(`${asUrl}/connectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(manifest),
      });
      assert.equal(registerResp.status, 400);
      assert.equal(registerResp.body.error.code, 'invalid_request');
      assert.match(registerResp.body.error.message, /provider_id is not allowed/);
    } finally {
      await closeServer(server);
    }
  });

  await t.test('connector registry rejects manifests whose primary keys or views reference unknown schema fields', async () => {
    const server = await startServer({
    quiet: true,
      asPort: 0,
      rsPort: 0,
      dbPath: ':memory:',
      dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    });
    const asUrl = `http://localhost:${server.asPort}`;

    try {
      const invalidPrimaryKeyManifest = {
        connector_id: 'https://registry.pdpp.org/connectors/invalid-primary-key',
        version: '0.1.0',
        streams: [
          {
            name: 'items',
            semantics: 'append_only',
            schema: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                value: { type: 'string' },
              },
            },
            primary_key: ['missing_id'],
          },
        ],
      };

      const invalidPrimaryKeyResp = await fetchJson(`${asUrl}/connectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invalidPrimaryKeyManifest),
      });
      assert.equal(invalidPrimaryKeyResp.status, 400);
      assert.equal(invalidPrimaryKeyResp.body.error.code, 'invalid_request');
      assert.match(invalidPrimaryKeyResp.body.error.message, /primary_key fields must exist in schema\.properties: missing_id/);

      const invalidViewManifest = {
        connector_id: 'https://registry.pdpp.org/connectors/invalid-view-fields',
        version: '0.1.0',
        streams: [
          {
            name: 'items',
            semantics: 'append_only',
            schema: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                value: { type: 'string' },
              },
            },
            primary_key: ['id'],
            views: [
              {
                id: 'basic',
                fields: ['id', 'missing_value'],
              },
            ],
          },
        ],
      };

      const invalidViewResp = await fetchJson(`${asUrl}/connectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invalidViewManifest),
      });
      assert.equal(invalidViewResp.status, 400);
      assert.equal(invalidViewResp.body.error.code, 'invalid_request');
      assert.match(invalidViewResp.body.error.message, /view 'basic' references unknown fields: missing_value/);
    } finally {
      await closeServer(server);
    }
  });

  await t.test('connector registry rejects connector manifests that include native-only storage_binding', async () => {
    const server = await startServer({
      quiet: true,
      asPort: 0,
      rsPort: 0,
      dbPath: ':memory:',
      dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    });
    const asUrl = `http://localhost:${server.asPort}`;

    try {
      const manifest = {
        connector_id: 'https://registry.pdpp.org/connectors/not-actually-polyfill',
        storage_binding: {
          connector_id: 'native_storage_connector',
        },
        version: '0.1.0',
        streams: [
          {
            name: 'items',
            semantics: 'append_only',
            schema: {
              type: 'object',
              properties: {
                id: { type: 'string' },
              },
            },
            primary_key: 'id',
          },
        ],
      };

      const registerResp = await fetchJson(`${asUrl}/connectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(manifest),
      });
      assert.equal(registerResp.status, 400);
      assert.equal(registerResp.body.error.code, 'invalid_request');
      assert.match(registerResp.body.error.message, /storage_binding is not allowed/);
    } finally {
      await closeServer(server);
    }
  });

  await t.test('consent display and approval reject malformed persisted requests with streams that are not present in the manifest', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiate = await startGrantRequest(asUrl, {
        client_id: 'longview',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/concert_recommendation',
        purpose_description: 'Recommend concerts and nearby live events',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists' }],
      });

      assert.equal(initiate.status, 201);
      await mutatePendingConsentRequest(initiate.body.request_uri, (request) => {
        request.selection.streams = [{ name: 'not_a_real_stream' }];
      });

      const consentResp = await fetchJson(
        `${asUrl}/consent?request_uri=${encodeURIComponent(initiate.body.request_uri)}`,
      );
      assert.equal(consentResp.status, 400);
      assert.equal(consentResp.body.error.code, 'invalid_request');
      assert.match(consentResp.body.error.message, /Unknown stream: not_a_real_stream/);

      const approveResp = await approveGrantRequest(asUrl, initiate.body.request_uri, 'owner_local');
      assert.equal(approveResp.status, 400);
      assert.equal(approveResp.body.error.code, 'invalid_request');
      assert.match(approveResp.body.error.message, /Unknown stream: not_a_real_stream/);
    });
  });

  await t.test('consent display and approval reject malformed persisted requests with views that are not present on the stream manifest', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiate = await startGrantRequest(asUrl, {
        client_id: 'longview',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/concert_recommendation',
        purpose_description: 'Recommend concerts and nearby live events',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists', view: 'basic' }],
      });

      assert.equal(initiate.status, 201);
      await mutatePendingConsentRequest(initiate.body.request_uri, (request) => {
        request.selection.streams = [{ name: 'top_artists', view: 'not_a_real_view' }];
      });

      const consentResp = await fetchJson(
        `${asUrl}/consent?request_uri=${encodeURIComponent(initiate.body.request_uri)}`,
      );
      assert.equal(consentResp.status, 400);
      assert.equal(consentResp.body.error.code, 'invalid_request');
      assert.match(consentResp.body.error.message, /Unknown view 'not_a_real_view' on stream 'top_artists'/);

      const approveResp = await approveGrantRequest(asUrl, initiate.body.request_uri, 'owner_local');
      assert.equal(approveResp.status, 400);
      assert.equal(approveResp.body.error.code, 'invalid_request');
      assert.match(approveResp.body.error.message, /Unknown view 'not_a_real_view' on stream 'top_artists'/);
    });
  });

  await t.test('consent display and approval reject malformed persisted requests with unsupported time_range', async () => {
    const server = await startServer({
    quiet: true,
      asPort: 0,
      rsPort: 0,
      dbPath: ':memory:',
      dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    });
    const asUrl = `http://localhost:${server.asPort}`;

    const manifest = {
      connector_id: 'time_range_test',
      display_name: 'Time Range Test',
      version: '0.1.0',
      streams: [
        {
          name: 'items',
          semantics: 'append_only',
          primary_key: 'id',
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              value: { type: 'string' },
            },
          },
        },
      ],
    };

    try {
      const registerResp = await fetchJson(`${asUrl}/connectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(manifest),
      });
      assert.equal(registerResp.status, 201);

      const initiate = await startGrantRequest(asUrl, {
        client_id: 'longview',
        connector_id: manifest.connector_id,
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Test unsupported time_range validation',
        access_mode: 'continuous',
        streams: [{ name: 'items' }],
      });

      assert.equal(initiate.status, 201);
      await mutatePendingConsentRequest(initiate.body.request_uri, (request) => {
        request.selection.streams = [{ name: 'items', time_range: { since: '2026-01-01T00:00:00Z' } }];
      });

      const consentResp = await fetchJson(
        `${asUrl}/consent?request_uri=${encodeURIComponent(initiate.body.request_uri)}`,
      );
      assert.equal(consentResp.status, 400);
      assert.equal(consentResp.body.error.code, 'invalid_request');
      assert.match(consentResp.body.error.message, /does not support time_range/);

      const approveResp = await approveGrantRequest(asUrl, initiate.body.request_uri, 'owner_local');
      assert.equal(approveResp.status, 400);
      assert.equal(approveResp.body.error.code, 'invalid_request');
      assert.match(approveResp.body.error.message, /does not support time_range/);
    } finally {
      await closeServer(server);
    }
  });

  await t.test('consent display and approval reject malformed persisted requests with contradictory view and fields selection', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiate = await startGrantRequest(asUrl, {
        client_id: 'longview',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/concert_recommendation',
        purpose_description: 'Recommend concerts and nearby live events',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists', view: 'basic' }],
      });

      assert.equal(initiate.status, 201);
      await mutatePendingConsentRequest(initiate.body.request_uri, (request) => {
        request.selection.streams = [{ name: 'top_artists', view: 'basic', fields: ['id'] }];
      });

      const consentResp = await fetchJson(
        `${asUrl}/consent?request_uri=${encodeURIComponent(initiate.body.request_uri)}`,
      );
      assert.equal(consentResp.status, 400);
      assert.equal(consentResp.body.error.code, 'invalid_request');
      assert.match(consentResp.body.error.message, /view and fields are mutually exclusive/);

      const approveResp = await approveGrantRequest(asUrl, initiate.body.request_uri, 'owner_local');
      assert.equal(approveResp.status, 400);
      assert.equal(approveResp.body.error.code, 'invalid_request');
      assert.match(approveResp.body.error.message, /view and fields are mutually exclusive/);
    });
  });

  await t.test('consent display and approval reject malformed persisted requests with unknown selected fields', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiate = await startGrantRequest(asUrl, {
        client_id: 'longview',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/concert_recommendation',
        purpose_description: 'Recommend concerts and nearby live events',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists', fields: ['id'] }],
      });

      assert.equal(initiate.status, 201);
      await mutatePendingConsentRequest(initiate.body.request_uri, (request) => {
        request.selection.streams = [{ name: 'top_artists', fields: ['id', 'not_a_real_field'] }];
      });

      const consentResp = await fetchJson(
        `${asUrl}/consent?request_uri=${encodeURIComponent(initiate.body.request_uri)}`,
      );
      assert.equal(consentResp.status, 400);
      assert.equal(consentResp.body.error.code, 'invalid_request');
      assert.match(consentResp.body.error.message, /Unknown fields on stream 'top_artists': not_a_real_field/);

      const approveResp = await approveGrantRequest(asUrl, initiate.body.request_uri, 'owner_local');
      assert.equal(approveResp.status, 400);
      assert.equal(approveResp.body.error.code, 'invalid_request');
      assert.match(approveResp.body.error.message, /Unknown fields on stream 'top_artists': not_a_real_field/);
    });
  });

  await t.test('consent display and approval reject malformed persisted requests with unsupported normalized request fields', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiate = await startGrantRequest(asUrl, {
        client_id: 'longview',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/concert_recommendation',
        purpose_description: 'Recommend concerts and nearby live events',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists' }],
      });

      assert.equal(initiate.status, 201);
      await mutatePendingConsentRequest(initiate.body.request_uri, (request) => {
        request.redirect_uri = 'https://longview.example/callback';
      });

      const consentResp = await fetchJson(
        `${asUrl}/consent?request_uri=${encodeURIComponent(initiate.body.request_uri)}`,
      );
      assert.equal(consentResp.status, 400);
      assert.equal(consentResp.body.error.code, 'invalid_request');
      assert.match(consentResp.body.error.message, /Unsupported pending request fields: redirect_uri/);

      const approveResp = await approveGrantRequest(asUrl, initiate.body.request_uri, 'owner_local');
      assert.equal(approveResp.status, 400);
      assert.equal(approveResp.body.error.code, 'invalid_request');
      assert.match(approveResp.body.error.message, /Unsupported pending request fields: redirect_uri/);
    });
  });

  await t.test('consent display and approval reject malformed persisted requests with unsupported pending stream selection fields', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiate = await startGrantRequest(asUrl, {
        client_id: 'longview',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/concert_recommendation',
        purpose_description: 'Recommend concerts and nearby live events',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists' }],
      });

      assert.equal(initiate.status, 201);
      await mutatePendingConsentRequest(initiate.body.request_uri, (request) => {
        request.selection.streams = [{ name: 'top_artists', expand: ['albums'] }];
      });

      const consentResp = await fetchJson(
        `${asUrl}/consent?request_uri=${encodeURIComponent(initiate.body.request_uri)}`,
      );
      assert.equal(consentResp.status, 400);
      assert.equal(consentResp.body.error.code, 'invalid_request');
      assert.match(consentResp.body.error.message, /Unsupported pending stream selection fields on 'top_artists': expand/);

      const approveResp = await approveGrantRequest(asUrl, initiate.body.request_uri, 'owner_local');
      assert.equal(approveResp.status, 400);
      assert.equal(approveResp.body.error.code, 'invalid_request');
      assert.match(approveResp.body.error.message, /Unsupported pending stream selection fields on 'top_artists': expand/);
    });
  });

  await t.test('consent display and approval reject persisted polyfill requests whose manifest_version no longer matches the current manifest', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiate = await startGrantRequest(asUrl, {
        client_id: 'longview',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/concert_recommendation',
        purpose_description: 'Recommend concerts and nearby live events',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists' }],
      });

      assert.equal(initiate.status, 201);
      await mutatePendingConsentRequest(initiate.body.request_uri, (request) => {
        request.manifest_version = '999.0.0';
      });

      const consentResp = await fetchJson(
        `${asUrl}/consent?request_uri=${encodeURIComponent(initiate.body.request_uri)}`,
      );
      assert.equal(consentResp.status, 400);
      assert.equal(consentResp.body.error.code, 'invalid_request');
      assert.match(consentResp.body.error.message, /Pending consent request manifest_version '999\.0\.0' does not match current manifest version/);

      const approveResp = await approveGrantRequest(asUrl, initiate.body.request_uri, 'owner_local');
      assert.equal(approveResp.status, 400);
      assert.equal(approveResp.body.error.code, 'invalid_request');
      assert.match(approveResp.body.error.message, /Pending consent request manifest_version '999\.0\.0' does not match current manifest version/);
    });
  });

  await t.test('consent display and approval reject persisted native requests whose manifest_version no longer matches the current manifest', async () => {
    await withNativeHarness(async ({ asUrl, nativeManifest }) => {
      const initiate = await startGrantRequest(asUrl, {
        client_id: 'longview',
        source: { kind: 'provider_native', id: nativeManifest.provider_id },
        purpose_code: 'https://pdpp.org/purpose/financial_planning',
        purpose_description: 'Support compensation planning and verification',
        access_mode: 'continuous',
        streams: [{ name: 'pay_statements' }],
      });

      assert.equal(initiate.status, 201);
      await mutatePendingConsentRequest(initiate.body.request_uri, (request) => {
        request.manifest_version = '999.0.0';
      });

      const consentResp = await fetch(
        `${asUrl}/consent?request_uri=${encodeURIComponent(initiate.body.request_uri)}`,
      );
      assert.equal(consentResp.status, 400);
      const consentRequestId = consentResp.headers.get('Request-Id');
      const consentTraceId = consentResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(consentRequestId?.startsWith('req_'));
      assert.ok(consentTraceId?.startsWith('trc_'));
      const consentBody = await consentResp.json();
      assert.equal(consentBody.error.code, 'invalid_request');
      assert.match(consentBody.error.message, /Pending consent request manifest_version '999\.0\.0' does not match current manifest version/);

      const approveResp = await fetch(`${asUrl}/consent/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_uri: initiate.body.request_uri, subject_id: 'employee_1' }),
      });
      assert.equal(approveResp.status, 400);
      const approveRequestId = approveResp.headers.get('Request-Id');
      const approveTraceId = approveResp.headers.get('PDPP-Reference-Trace-Id');
      assert.equal(approveRequestId, consentRequestId);
      assert.equal(approveTraceId, consentTraceId);
      const approveBody = await approveResp.json();
      assert.equal(approveBody.error.code, 'invalid_request');
      assert.match(approveBody.error.message, /Pending consent request manifest_version '999\.0\.0' does not match current manifest version/);

      const { body: trace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(consentTraceId)}`);
      const rejectedEvents = (trace.data || []).filter((event) =>
        event.event_type === 'request.rejected'
        && event.request_id === consentRequestId
      );
      assert.ok(rejectedEvents.length >= 1, 'trace should include request.rejected for consent-time manifest drift');
      const rejectedEvent = rejectedEvents.find((event) => event.data?.error?.code === 'invalid_request');
      assert.ok(rejectedEvent, 'trace should preserve invalid_request rejection details');
      assert.equal(rejectedEvent.object_type, 'pending_consent');
      assert.equal(rejectedEvent.client_id, 'longview');
      assert.equal(rejectedEvent.data?.source?.kind, 'provider_native');
      assert.equal(rejectedEvent.data?.source?.id, nativeManifest.provider_id);
      assert.match(rejectedEvent.data?.error?.message || '', /Pending consent request manifest_version '999\.0\.0' does not match current manifest version/);
    });
  });

  await t.test('native consent denial preserves staged trace correlation without connector or storage leakage', async () => {
    await withNativeHarness(async ({ asUrl, nativeManifest }) => {
      const initiate = await startGrantRequest(asUrl, {
        client_id: 'longview',
        source: { kind: 'provider_native', id: nativeManifest.provider_id },
        purpose_code: 'https://pdpp.org/purpose/financial_planning',
        purpose_description: 'Support compensation planning and verification',
        access_mode: 'single_use',
        streams: [{ name: 'pay_statements' }],
      });
      assert.equal(initiate.status, 201);

      const stagedRequestId = initiate.headers['request-id'];
      const stagedTraceId = initiate.headers['pdpp-reference-trace-id'];
      assert.ok(stagedRequestId?.startsWith('req_'));
      assert.ok(stagedTraceId?.startsWith('trc_'));

      const denyResp = await denyGrantRequest(asUrl, initiate.body.request_uri);
      assert.equal(denyResp.status, 200);
      assert.equal(denyResp.headers['request-id'], stagedRequestId);
      assert.equal(denyResp.headers['pdpp-reference-trace-id'], stagedTraceId);
      assert.match(denyResp.body, /Access Denied/);

      const { body: trace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(stagedTraceId)}`);
      const deniedEvent = (trace.data || []).find((event) =>
        event.event_type === 'consent.denied'
        && event.request_id === stagedRequestId
      );
      assert.ok(deniedEvent, 'trace should include consent.denied for native staged denial');
      assert.equal(deniedEvent.client_id, 'longview');
      assert.equal(deniedEvent.object_type, 'pending_consent');
      assert.equal(deniedEvent.status, 'denied');
      assert.equal(deniedEvent.data?.source?.kind, 'provider_native');
      assert.equal(deniedEvent.data?.source?.id, nativeManifest.provider_id);
      assert.ok(!('connector_id' in (deniedEvent.data || {})));
      assert.ok(!('storage_connector_id' in (deniedEvent.data || {})));

      const grantIssuedEvent = (trace.data || []).find((event) => event.event_type === 'grant.issued');
      assert.equal(grantIssuedEvent, undefined, 'denied native consent should not issue a grant');
    });
  });

  await t.test('polyfill mode rejects provider-native request envelopes', async () => {
    await withHarness(async ({ asUrl }) => {
      const initiateResp = await fetch(`${asUrl}/oauth/par`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'longview',
          authorization_details: [
            {
              type: 'https://pdpp.org/data-access',
              source: { kind: 'provider_native', id: 'northstar_hr' },
              purpose_code: 'https://pdpp.org/purpose/financial_planning',
              access_mode: 'continuous',
              streams: [{ name: 'pay_statements' }],
            },
          ],
        }),
      });

      assert.equal(initiateResp.status, 400);
      const initiateBody = await initiateResp.json();
      assert.equal(initiateBody.error.code, 'invalid_request');
      assert.match(initiateBody.error.message, /source.*provider_native/);
    });
  });

  await t.test('polyfill reference traces expose public source descriptors without storage_connector_id', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const approved = await approveGrant(asUrl, 'u1', {
        client_id: 'longview',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Maintain a concert-recommendation profile over time',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists', view: 'basic' }],
      });

      const { body: timeline } = await fetchJson(`${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`);
      const { body: trace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(timeline.trace_id)}`);
      const events = [...(timeline.data || []), ...(trace.data || [])];

      for (const event of events) {
        if (!event?.data?.source || event.data.source.kind !== 'connector') continue;
        assert.equal(event.data.source.id, SPOTIFY_CONNECTOR_KEY);
        assert.ok(!('storage_connector_id' in event.data), `connector event ${event.event_type} should not expose storage_connector_id`);
      }
    });
  });

  await t.test('removed compatibility grant-initiation and device-code consent routes stay unavailable', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiateResp = await fetch(`${asUrl}/grants/initiate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'longview',
          authorization_details: [
            {
              type: 'https://pdpp.org/data-access',
              source: { kind: 'connector', id: spotifyManifest.connector_id },
              purpose_code: 'https://pdpp.org/purpose/personalization',
              purpose_description: 'Maintain a concert-recommendation profile over time',
              access_mode: 'continuous',
              streams: [{ name: 'top_artists', view: 'basic' }],
            },
          ],
        }),
      });
      assert.equal(initiateResp.status, 404);

      const legacyConsentResp = await fetch(`${asUrl}/consent/legacy-device-code`);
      assert.equal(legacyConsentResp.status, 404);

      const legacyApproveResp = await fetch(`${asUrl}/consent/legacy-device-code/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject_id: 'u1' }),
      });
      assert.equal(legacyApproveResp.status, 404);

      const legacyDenyResp = await fetch(`${asUrl}/consent/legacy-device-code/deny`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      assert.equal(legacyDenyResp.status, 404);
    });
  });

  await t.test('native provider hides connector registry and collection-profile routes', async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'employee_1');

      const connectorsResp = await fetch(`${asUrl}/connectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(nativeManifest),
      });
      assert.equal(connectorsResp.status, 404);

      const connectorLookupResp = await fetch(`${asUrl}/connectors/${encodeURIComponent(nativeManifest.storage_binding.connector_id)}`);
      assert.equal(connectorLookupResp.status, 404);

      const ingestResp = await fetch(`${rsUrl}/v1/ingest/pay_statements?connector_id=${encodeURIComponent(nativeManifest.storage_binding.connector_id)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          'Content-Type': 'application/x-ndjson',
        },
        body: '',
      });
      assert.equal(ingestResp.status, 404);

      const stateResp = await fetch(`${rsUrl}/v1/state/${encodeURIComponent(nativeManifest.storage_binding.connector_id)}`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(stateResp.status, 404);

      const resetStreamResp = await fetch(
        `${rsUrl}/v1/streams/pay_statements/records?connector_id=${encodeURIComponent(nativeManifest.storage_binding.connector_id)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${ownerToken}` },
        }
      );
      assert.equal(resetStreamResp.status, 404);

      const resetRecordResp = await fetch(
        `${rsUrl}/v1/streams/pay_statements/records/${encodeURIComponent('ps_2026_04_15')}?connector_id=${encodeURIComponent(nativeManifest.storage_binding.connector_id)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${ownerToken}` },
        }
      );
      assert.equal(resetRecordResp.status, 404);
    });
  });

  await t.test('native provider client grants do not require public connector_id', async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'employee_1');
      await seedNorthstar(nativeManifest);

      const approved = await approveGrant(asUrl, 'employee_1', {
        client_id: 'longview',
        client_display: { name: 'Longview' },
        source: { kind: 'provider_native', id: nativeManifest.provider_id },
        purpose_code: 'https://pdpp.org/purpose/financial_planning',
        purpose_description: 'Support compensation planning and verification',
        access_mode: 'continuous',
        streams: [{ name: 'pay_statements' }, { name: 'equity_grants', view: 'summary' }],
      });

      assert.ok(!('connector_id' in approved.grant), 'native grants should not expose connector_id');
      assert.equal(approved.grant.source?.kind, 'provider_native');
      assert.equal(approved.grant.source?.id, nativeManifest.provider_id);

      const grantRows = getDb().prepare(`
        SELECT storage_binding_json
        FROM grants
        WHERE grant_id = ?
      `).all(approved.grant.grant_id);
      assert.equal(grantRows.length, 1);
      assert.deepEqual(JSON.parse(grantRows[0].storage_binding_json), {
        connector_id: nativeManifest.storage_binding.connector_id,
      });

      const { body: introspection } = await fetchJson(`${asUrl}/introspect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: approved.token }),
      });
      assert.equal(introspection.active, true);
      assert.equal(introspection.grant.source?.kind, 'provider_native');
      assert.equal(introspection.grant.source?.id, nativeManifest.provider_id);
      assert.ok(!('grant_storage_connector_id' in introspection), 'public introspection should not leak storage connector ids');
      assert.ok(!('grant_storage_binding' in introspection), 'public introspection should not leak structured storage bindings');

      const { body: initialTimeline } = await fetchJson(`${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`);
      const { body: trace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(initialTimeline.trace_id)}`);
      for (const event of trace.data || []) {
        if (!event.data) continue;
        assert.ok(!('storage_connector_id' in event.data), `${event.event_type} should not expose storage_connector_id in native traces`);
        assert.ok(!('connector_id' in event.data), `${event.event_type} should not expose connector_id in native traces`);
        if (event.data.source?.kind === 'provider_native') {
          assert.equal(event.data.source.id, nativeManifest.provider_id);
        }
      }
      const requestEvent = trace.data.find((event) => event.event_type === 'request.submitted');
      assert.ok(requestEvent, 'trace should include request.submitted');
      assert.equal(requestEvent.data.source?.kind, 'provider_native');
      assert.equal(requestEvent.data.source?.id, nativeManifest.provider_id);
      assert.ok(!('storage_connector_id' in requestEvent.data), 'native request event should not expose storage connector ids');

      const consentApprovedEvent = trace.data.find((event) => event.event_type === 'consent.approved');
      assert.ok(consentApprovedEvent, 'trace should include consent.approved');
      assert.equal(consentApprovedEvent.data.source?.kind, 'provider_native');
      assert.equal(consentApprovedEvent.data.source?.id, nativeManifest.provider_id);

      const issuedEvent = initialTimeline.data.find((event) => event.event_type === 'grant.issued');
      assert.ok(issuedEvent, 'grant timeline should include grant.issued');
      assert.equal(issuedEvent.data.source?.kind, 'provider_native');
      assert.equal(issuedEvent.data.source?.id, nativeManifest.provider_id);
      assert.ok(!('connector_id' in issuedEvent.data), 'native grant-issued event should not expose connector_id');
      assert.ok(!('storage_connector_id' in issuedEvent.data), 'native grant-issued event should not expose storage connector ids');

      const tokenIssuedEvent = initialTimeline.data.find((event) => event.event_type === 'token.issued');
      assert.ok(tokenIssuedEvent, 'grant timeline should include token.issued');
      assert.equal(tokenIssuedEvent.data.source?.kind, 'provider_native');
      assert.equal(tokenIssuedEvent.data.source?.id, nativeManifest.provider_id);
      assert.equal(tokenIssuedEvent.data.issuance_path, 'grant_approval');
      assert.ok(!('connector_id' in tokenIssuedEvent.data), 'native token-issued event should not expose connector_id');
      assert.ok(!('storage_connector_id' in tokenIssuedEvent.data), 'native token-issued event should not expose storage connector ids');

      const clientStreamsResp = await fetch(`${rsUrl}/v1/streams`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(clientStreamsResp.status, 200);
      const clientStreamsRequestId = clientStreamsResp.headers.get('Request-Id');
      const clientStreamsTraceId = clientStreamsResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(clientStreamsRequestId?.startsWith('req_'));
      assert.equal(clientStreamsTraceId, initialTimeline.trace_id);
      const clientStreamsBody = await clientStreamsResp.json();
      assert.deepEqual(clientStreamsBody.data.map((stream) => stream.name), ['pay_statements', 'equity_grants']);

      const streamMetadataResp = await fetch(`${rsUrl}/v1/streams/pay_statements`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(streamMetadataResp.status, 200);
      const streamMetadataRequestId = streamMetadataResp.headers.get('Request-Id');
      const streamMetadataTraceId = streamMetadataResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(streamMetadataRequestId?.startsWith('req_'));
      assert.equal(streamMetadataTraceId, initialTimeline.trace_id);
      const streamMetadataBody = await streamMetadataResp.json();
      assert.equal(streamMetadataBody.object, 'stream_metadata');
      assert.equal(streamMetadataBody.name, 'pay_statements');

      const recordsResp = await fetch(`${rsUrl}/v1/streams/pay_statements/records`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(recordsResp.status, 200);
      const recordsRequestId = recordsResp.headers.get('Request-Id');
      const recordsTraceId = recordsResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(recordsRequestId?.startsWith('req_'));
      assert.equal(recordsTraceId, initialTimeline.trace_id);
      const recordsBody = await recordsResp.json();
      assert.equal(recordsBody.data.length, 1);
      assert.equal(recordsBody.data[0].id, 'ps_2026_04_15');

      const connectionScopedClientResp = await fetch(
        `${rsUrl}/v1/streams/pay_statements/records?connection_id=not_a_native_concept`,
        { headers: { Authorization: `Bearer ${approved.token}` } },
      );
      assert.equal(connectionScopedClientResp.status, 400);
      const connectionScopedClientBody = await connectionScopedClientResp.json();
      assert.equal(connectionScopedClientBody.error.code, 'invalid_argument');
      assert.match(connectionScopedClientBody.error.message, /provider_native/);

      const recordResp = await fetch(`${rsUrl}/v1/streams/pay_statements/records/ps_2026_04_15`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(recordResp.status, 200);
      const recordRequestId = recordResp.headers.get('Request-Id');
      const recordTraceId = recordResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(recordRequestId?.startsWith('req_'));
      assert.equal(recordTraceId, initialTimeline.trace_id);
      const recordBody = await recordResp.json();
      assert.equal(recordBody.id, 'ps_2026_04_15');

      const { body: postQueryTimeline } = await fetchJson(`${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`);
      for (const event of postQueryTimeline.data || []) {
        if (!event.data) continue;
        assert.ok(!('storage_connector_id' in event.data), `${event.event_type} should not expose storage_connector_id in native grant timelines`);
        assert.ok(!('connector_id' in event.data), `${event.event_type} should not expose connector_id in native grant timelines`);
        if (event.data.source?.kind === 'provider_native') {
          assert.equal(event.data.source.id, nativeManifest.provider_id);
        }
      }
      const streamListQueryEvent = postQueryTimeline.data.find((event) =>
        event.event_type === 'query.received'
        && event.object_id === clientStreamsRequestId
      );
      assert.ok(streamListQueryEvent, 'grant timeline should include query.received for native stream list');
      assert.equal(streamListQueryEvent.data.source?.kind, 'provider_native');
      assert.equal(streamListQueryEvent.data.source?.id, nativeManifest.provider_id);
      assert.equal(streamListQueryEvent.data.query_shape, 'stream_list');
      assert.ok(!('storage_connector_id' in streamListQueryEvent.data), 'native stream-list query should not expose storage connector ids');

      const streamListDisclosureEvent = postQueryTimeline.data.find((event) =>
        event.event_type === 'disclosure.served'
        && event.object_id === clientStreamsRequestId
      );
      assert.ok(streamListDisclosureEvent, 'grant timeline should include disclosure.served for native stream list');
      assert.equal(streamListDisclosureEvent.data.source?.kind, 'provider_native');
      assert.equal(streamListDisclosureEvent.data.source?.id, nativeManifest.provider_id);
      assert.equal(streamListDisclosureEvent.data.query_shape, 'stream_list');
      assert.ok(!('storage_connector_id' in streamListDisclosureEvent.data), 'native stream-list disclosure should not expose storage connector ids');

      const streamMetadataQueryEvent = postQueryTimeline.data.find((event) =>
        event.event_type === 'query.received'
        && event.object_id === streamMetadataRequestId
      );
      assert.ok(streamMetadataQueryEvent, 'grant timeline should include query.received for native stream metadata');
      assert.equal(streamMetadataQueryEvent.stream_id, 'pay_statements');
      assert.equal(streamMetadataQueryEvent.data.query_shape, 'stream_metadata');

      const streamMetadataDisclosureEvent = postQueryTimeline.data.find((event) =>
        event.event_type === 'disclosure.served'
        && event.object_id === streamMetadataRequestId
      );
      assert.ok(streamMetadataDisclosureEvent, 'grant timeline should include disclosure.served for native stream metadata');
      assert.equal(streamMetadataDisclosureEvent.stream_id, 'pay_statements');
      assert.equal(streamMetadataDisclosureEvent.data.query_shape, 'stream_metadata');

      const recordsQueryEvent = postQueryTimeline.data.find((event) =>
        event.event_type === 'query.received'
        && event.object_id === recordsRequestId
      );
      assert.ok(recordsQueryEvent, 'grant timeline should include query.received for native record list disclosure');
      assert.equal(recordsQueryEvent.data.query_shape, 'record_list');

      const recordQueryEvent = postQueryTimeline.data.find((event) =>
        event.event_type === 'query.received'
        && event.object_id === recordRequestId
      );
      assert.ok(recordQueryEvent, 'grant timeline should include query.received for native single-record disclosure');
      assert.equal(recordQueryEvent.data.requested_record_id, 'ps_2026_04_15');

      const recordDisclosureEvent = postQueryTimeline.data.find((event) =>
        event.event_type === 'disclosure.served'
        && event.object_id === recordRequestId
      );
      assert.ok(recordDisclosureEvent, 'grant timeline should include disclosure.served for native single-record disclosure');
      assert.equal(recordDisclosureEvent.data.requested_record_id, 'ps_2026_04_15');
      assert.equal(recordDisclosureEvent.data.record_count, 1);

      const revokeResp = await fetchJson(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${approved.token}`,
        },
      });
      assert.equal(revokeResp.status, 200);

      const { body: revokedTimeline } = await fetchJson(`${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`);
      const revokedEvent = revokedTimeline.data.find((event) => event.event_type === 'grant.revoked');
      assert.ok(revokedEvent, 'grant timeline should include grant.revoked after native revocation');
      assert.equal(revokedEvent.data.source?.kind, 'provider_native');
      assert.equal(revokedEvent.data.source?.id, nativeManifest.provider_id);
      assert.ok(!('connector_id' in revokedEvent.data), 'native revoked event should not expose connector_id');
      assert.ok(!('storage_connector_id' in revokedEvent.data), 'native revoked event should not expose storage connector ids');
    });
  });

  await t.test('native persisted grant bindings with unsupported fields are rejected on introspection and revocation', async () => {
    await withNativeHarness(async ({ asUrl, nativeManifest }) => {
      await seedNorthstar(nativeManifest);

      const approved = await approveGrant(asUrl, 'employee_1', {
        client_id: 'longview',
        source: { kind: 'provider_native', id: nativeManifest.provider_id },
        purpose_code: 'https://pdpp.org/purpose/financial_planning',
        purpose_description: 'Support compensation planning and verification',
        access_mode: 'continuous',
        streams: [{ name: 'pay_statements' }],
      });

      await mutateGrantSource(approved.grant.grant_id, (source) => ({
        ...source,
        connector_id: 'should_not_escape',
        storage_connector_id: nativeManifest.storage_binding.connector_id,
        debug_context: 'should_not_escape',
      }));
      await mutateGrantStorageBinding(approved.grant.grant_id, (storageBinding) => ({
        ...storageBinding,
        debug_context: 'should_not_escape',
      }));

      const { body: introspection } = await fetchJson(`${asUrl}/introspect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: approved.token }),
      });
      assert.equal(introspection.active, false);
      assert.equal(introspection.inactive_reason, 'grant_invalid');
      assert.ok(!('grant' in introspection), 'malformed native persisted grants should not be surfaced publicly');

      const revokeResp = await fetchJson(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${approved.token}`,
        },
      });
      assert.equal(revokeResp.status, 403);
      assert.equal(revokeResp.body.error.code, 'grant_invalid');
      assert.match(revokeResp.body.error.message, /Grant is malformed or no longer valid/);

      const { body: revokedTimeline } = await fetchJson(`${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`);
      const revokedEvent = revokedTimeline.data.find((event) => event.event_type === 'grant.revoked');
      assert.equal(revokedEvent, undefined, 'malformed native persisted grants should not emit degraded grant.revoked artifacts');
    });
  });

  await t.test('native malformed grant revocation preserves provider-first source when only storage binding drifts', async () => {
    await withNativeHarness(async ({ asUrl, nativeManifest }) => {
      await seedNorthstar(nativeManifest);

      const approved = await approveGrant(asUrl, 'employee_1', {
        client_id: 'longview',
        source: { kind: 'provider_native', id: nativeManifest.provider_id },
        purpose_code: 'https://pdpp.org/purpose/financial_planning',
        purpose_description: 'Support compensation planning and verification',
        access_mode: 'continuous',
        streams: [{ name: 'pay_statements' }],
      });

      await mutateGrantStorageBinding(approved.grant.grant_id, (storageBinding) => ({
        ...storageBinding,
        debug_context: 'should_not_escape',
      }));

      const revokeResp = await fetch(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${approved.token}`,
        },
      });
      assert.equal(revokeResp.status, 403);
      const revokeRequestId = revokeResp.headers.get('Request-Id');
      const revokeTraceId = revokeResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(revokeRequestId?.startsWith('req_'));
      assert.ok(revokeTraceId?.startsWith('trc_'));

      const { body: revokedTimeline } = await fetchJson(`${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`);
      const rejectedEvent = revokedTimeline.data.find((event) => event.event_type === 'grant.revoke_rejected');
      assert.ok(rejectedEvent, 'malformed native persisted grants should emit grant.revoke_rejected artifacts');
      assert.equal(rejectedEvent.request_id, revokeRequestId);
      assert.equal(rejectedEvent.trace_id, revokeTraceId);
      assert.equal(rejectedEvent.data?.source?.kind, 'provider_native');
      assert.equal(rejectedEvent.data?.source?.id, nativeManifest.provider_id);
      assert.ok(!('connector_id' in (rejectedEvent.data || {})), 'native revoke rejection should not expose connector_id');
      assert.ok(!('storage_connector_id' in (rejectedEvent.data || {})), 'native revoke rejection should not expose storage connector ids');
      assert.equal(rejectedEvent.data?.error?.code, 'grant_invalid');
    });
  });

  await t.test('native client reads reject malformed grant storage bindings as invalid grants', async () => {
    const { dbPath, cleanup } = createTempDbPath();
    const nativeManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/northstar-hr.json'), 'utf8'));
    let server = await startServer({
    quiet: true,
      asPort: 0,
      rsPort: 0,
      dbPath,
      nativeManifest,
    });
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;

    try {
      await seedNorthstar(nativeManifest);

      const approved = await approveGrant(asUrl, 'employee_1', {
        client_id: 'longview',
        source: { kind: 'provider_native', id: nativeManifest.provider_id },
        purpose_code: 'https://pdpp.org/purpose/financial_planning',
        purpose_description: 'Support compensation planning and verification',
        access_mode: 'continuous',
        streams: [{ name: 'pay_statements' }, { name: 'equity_grants', view: 'summary' }],
      });

      getDb().prepare(`
        UPDATE grants
        SET storage_binding_json = ?
        WHERE grant_id = ?
      `).run(JSON.stringify({ connector_id: 'missing_native_storage_connector' }), approved.grant.grant_id);

      await closeServer(server);
      server = await startServer({
    quiet: true,
        asPort: server.asPort,
        rsPort: server.rsPort,
        dbPath,
        nativeManifest,
      });

      async function assertMalformedNativeClientRead(path, queryShape, streamId = null, requestedRecordId = null) {
        const rejectedResp = await fetch(`${rsUrl}${path}`, {
          headers: { Authorization: `Bearer ${approved.token}` },
        });
        assert.equal(rejectedResp.status, 403);
        const rejectedRequestId = rejectedResp.headers.get('Request-Id');
        const rejectedTraceId = rejectedResp.headers.get('PDPP-Reference-Trace-Id');
        assert.ok(rejectedRequestId?.startsWith('req_'));
        assert.ok(rejectedTraceId?.startsWith('trc_'));
        const rejectedBody = await rejectedResp.json();
        assert.equal(rejectedBody.error.code, 'grant_invalid');
        assert.match(rejectedBody.error.message, /Grant is malformed or no longer valid/);
        assert.doesNotMatch(rejectedBody.error.message, /missing_native_storage_connector/);
      }

      await assertMalformedNativeClientRead('/v1/streams', 'stream_list');
      await assertMalformedNativeClientRead('/v1/streams/pay_statements', 'stream_metadata', 'pay_statements');
      await assertMalformedNativeClientRead('/v1/streams/pay_statements/records', 'record_list', 'pay_statements');
      await assertMalformedNativeClientRead(
        '/v1/streams/pay_statements/records/ps_2026_04_15',
        'record_detail',
        'pay_statements',
        'ps_2026_04_15',
      );
    } finally {
      await closeServer(server);
      cleanup();
    }
  });

  await t.test('native client reads reject grants missing structured storage bindings', async () => {
    const { dbPath, cleanup } = createTempDbPath();
    const nativeManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/northstar-hr.json'), 'utf8'));
    let server = await startServer({
    quiet: true,
      asPort: 0,
      rsPort: 0,
      dbPath,
      nativeManifest,
    });
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;

    try {
      await seedNorthstar(nativeManifest);

      const approved = await approveGrant(asUrl, 'employee_1', {
        client_id: 'longview',
        source: { kind: 'provider_native', id: nativeManifest.provider_id },
        purpose_code: 'https://pdpp.org/purpose/financial_planning',
        purpose_description: 'Support compensation planning and verification',
        access_mode: 'continuous',
        streams: [{ name: 'pay_statements' }, { name: 'equity_grants', view: 'summary' }],
      });

      getDb().prepare(`
        UPDATE grants
        SET storage_binding_json = NULL
        WHERE grant_id = ?
      `).run(approved.grant.grant_id);

      await closeServer(server);
      server = await startServer({
    quiet: true,
        asPort: server.asPort,
        rsPort: server.rsPort,
        dbPath,
        nativeManifest,
      });

      const streamsResp = await fetchJson(`${rsUrl}/v1/streams`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(streamsResp.status, 403);
      assert.ok(streamsResp.headers['request-id']?.startsWith('req_'));
      assert.ok(streamsResp.headers['pdpp-reference-trace-id']?.startsWith('trc_'));
      assert.equal(streamsResp.body.error.code, 'grant_invalid');
      assert.match(streamsResp.body.error.message, /Grant is malformed or no longer valid/);

      const metadataResp = await fetchJson(`${rsUrl}/v1/streams/pay_statements`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(metadataResp.status, 403);
      assert.ok(metadataResp.headers['request-id']?.startsWith('req_'));
      assert.ok(metadataResp.headers['pdpp-reference-trace-id']?.startsWith('trc_'));
      assert.equal(metadataResp.body.error.code, 'grant_invalid');
      assert.match(metadataResp.body.error.message, /Grant is malformed or no longer valid/);

      const recordResp = await fetchJson(`${rsUrl}/v1/streams/pay_statements/records/ps_2026_04_15`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(recordResp.status, 403);
      assert.ok(recordResp.headers['request-id']?.startsWith('req_'));
      assert.ok(recordResp.headers['pdpp-reference-trace-id']?.startsWith('trc_'));
      assert.equal(recordResp.body.error.code, 'grant_invalid');
      assert.match(recordResp.body.error.message, /Grant is malformed or no longer valid/);
    } finally {
      await closeServer(server);
      cleanup();
    }
  });

  await t.test('polyfill client reads fail connector-first when the persisted storage binding points to an unknown connector', async () => {
    const { dbPath, cleanup } = createTempDbPath();
    const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'));
    let server = await startServer({
    quiet: true,
      asPort: 0,
      rsPort: 0,
      dbPath,
      dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    });
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;

    try {
      const registerResp = await fetchJson(`${asUrl}/connectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spotifyManifest),
      });
      assert.equal(registerResp.status, 201);

      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);
      const ownerRecordListResp = await fetchJson(
        `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}&limit=1`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      const visibleRecord = ownerRecordListResp.body.data?.[0];
      assert.ok(visibleRecord, 'expected an owner-visible top_artists record before corrupting the grant binding');

      const approved = await approveGrant(asUrl, 'u1', {
        client_id: 'concert_recommendation_app',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/concert_recommendation',
        purpose_description: 'Recommend concerts and nearby live events',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists' }],
      });

      const missingConnectorId = 'missing_spotify_connector';
      const remappedGrant = JSON.parse(JSON.stringify(approved.grant));
      remappedGrant.source = {
        kind: 'connector',
        id: missingConnectorId,
      };

      getDb().prepare(`
        UPDATE grants
        SET grant_json = ?,
            storage_binding_json = ?
        WHERE grant_id = ?
      `).run(JSON.stringify(remappedGrant), JSON.stringify({ connector_id: missingConnectorId }), approved.grant.grant_id);

      await closeServer(server);
      server = await startServer({
    quiet: true,
        asPort: server.asPort,
        rsPort: server.rsPort,
        dbPath,
        dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
      });

      const reRegisterResp = await fetchJson(`${asUrl}/connectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spotifyManifest),
      });
      assert.equal(reRegisterResp.status, 201);

      async function assertBrokenPolyfillClientRead(path, queryShape, streamId = null, requestedRecordId = null) {
        const rejectedResp = await fetch(`${rsUrl}${path}`, {
          headers: { Authorization: `Bearer ${approved.token}` },
        });
        assert.equal(rejectedResp.status, 404);
        const rejectedRequestId = rejectedResp.headers.get('Request-Id');
        const rejectedTraceId = rejectedResp.headers.get('PDPP-Reference-Trace-Id');
        assert.ok(rejectedRequestId?.startsWith('req_'));
        assert.ok(rejectedTraceId?.startsWith('trc_'));
        const rejectedBody = await rejectedResp.json();
        assert.equal(rejectedBody.error.code, 'not_found');
        assert.match(rejectedBody.error.message, /Unknown connector: missing_spotify_connector/);

        const { body: timeline } = await fetchJson(
          `${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`,
        );
        const queryReceivedEvent = timeline.data.find((event) =>
          event.event_type === 'query.received'
          && event.object_id === rejectedRequestId
        );
        assert.ok(queryReceivedEvent, `grant timeline should include query.received for broken polyfill ${queryShape} reads`);
        assert.equal(queryReceivedEvent.data.query_shape, queryShape);
        assert.equal(queryReceivedEvent.data.source?.kind, 'connector');
        assert.equal(queryReceivedEvent.data.source?.id, missingConnectorId);
        if (streamId) {
          assert.equal(queryReceivedEvent.stream_id, streamId);
        }
        if (requestedRecordId) {
          assert.equal(queryReceivedEvent.data.requested_record_id, requestedRecordId);
        }

        const rejectedEvent = timeline.data.find((event) =>
          event.event_type === 'query.rejected'
          && event.object_id === rejectedRequestId
        );
        assert.ok(rejectedEvent, `grant timeline should include query.rejected for broken polyfill ${queryShape} reads`);
        assert.equal(rejectedEvent.trace_id, rejectedTraceId);
        assert.equal(rejectedEvent.data.query_shape, queryShape);
        assert.equal(rejectedEvent.data.source?.kind, 'connector');
        assert.equal(rejectedEvent.data.source?.id, missingConnectorId);
        assert.equal(rejectedEvent.data.error?.code, 'not_found');
        assert.match(rejectedEvent.data.error?.message || '', /Unknown connector: missing_spotify_connector/);
        if (streamId) {
          assert.equal(rejectedEvent.stream_id, streamId);
        }

        const servedEvent = timeline.data.find((event) =>
          event.event_type === 'disclosure.served'
          && event.object_id === rejectedRequestId
        );
        assert.equal(servedEvent, undefined, `broken polyfill ${queryShape} reads should not produce disclosure.served`);
      }

      await assertBrokenPolyfillClientRead('/v1/streams', 'stream_list');
      await assertBrokenPolyfillClientRead('/v1/streams/top_artists', 'stream_metadata', 'top_artists');
      await assertBrokenPolyfillClientRead('/v1/streams/top_artists/records', 'record_list', 'top_artists');
      await assertBrokenPolyfillClientRead(
        `/v1/streams/top_artists/records/${encodeURIComponent(visibleRecord.id)}`,
        'record_detail',
        'top_artists',
        visibleRecord.id,
      );
    } finally {
      await closeServer(server);
      cleanup();
    }
  });

  await t.test('native client introspection and revocation reject grants missing structured source bindings', async () => {
    const { dbPath, cleanup } = createTempDbPath();
    const nativeManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/northstar-hr.json'), 'utf8'));
    let server = await startServer({
    quiet: true,
      asPort: 0,
      rsPort: 0,
      dbPath,
      nativeManifest,
    });
    const asUrl = `http://localhost:${server.asPort}`;

    try {
      await seedNorthstar(nativeManifest);

      const approved = await approveGrant(asUrl, 'employee_1', {
        client_id: 'longview',
        source: { kind: 'provider_native', id: nativeManifest.provider_id },
        purpose_code: 'https://pdpp.org/purpose/financial_planning',
        purpose_description: 'Support compensation planning and verification',
        access_mode: 'continuous',
        streams: [{ name: 'pay_statements' }, { name: 'equity_grants', view: 'summary' }],
      });

      const {
        body: timelineBeforeRevoke,
      } = await fetchJson(`${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`);
      const revokedEventsBefore = (timelineBeforeRevoke.data || [])
        .filter((event) => event.event_type === 'grant.revoked')
        .length;

      const malformedGrant = JSON.parse(JSON.stringify(approved.grant));
      delete malformedGrant.source;

      getDb().prepare(`
        UPDATE grants
        SET grant_json = ?
        WHERE grant_id = ?
      `).run(JSON.stringify(malformedGrant), approved.grant.grant_id);

      await closeServer(server);
      server = await startServer({
    quiet: true,
        asPort: server.asPort,
        rsPort: server.rsPort,
        dbPath,
        nativeManifest,
      });

      const introspectResp = await fetchJson(`${asUrl}/introspect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: approved.token }).toString(),
      });
      assert.equal(introspectResp.status, 200);
      assert.equal(introspectResp.body.active, false);
      assert.equal(introspectResp.body.inactive_reason, 'grant_invalid');
      assert.ok(!('grant' in introspectResp.body), 'malformed persisted grant source should not be surfaced publicly');

      const revokeResp = await fetchJson(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${approved.token}`,
        },
      });
      assert.equal(revokeResp.status, 403);
      assert.equal(revokeResp.body.error.code, 'grant_invalid');
      assert.match(revokeResp.body.error.message, /Grant is malformed or no longer valid/);

      const { body: timelineAfterRevoke } = await fetchJson(
        `${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`,
      );
      const revokedEventsAfter = (timelineAfterRevoke.data || [])
        .filter((event) => event.event_type === 'grant.revoked')
        .length;
      assert.equal(
        revokedEventsAfter,
        revokedEventsBefore,
        'malformed grants should not emit degraded grant.revoked artifacts',
      );
    } finally {
      await closeServer(server);
      cleanup();
    }
  });

  await t.test('polyfill client introspection and revocation reject grants missing structured source bindings', async () => {
    const { dbPath, cleanup } = createTempDbPath();
    const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'));
    let server = await startServer({
    quiet: true,
      asPort: 0,
      rsPort: 0,
      dbPath,
      dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    });
    const asUrl = `http://localhost:${server.asPort}`;

    try {
      const registerResp = await fetchJson(`${asUrl}/connectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spotifyManifest),
      });
      assert.equal(registerResp.status, 201);

      const approved = await approveGrant(asUrl, 'owner_local', {
        client_id: 'longview',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/concert_recommendation',
        purpose_description: 'Recommend concerts and nearby live events',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists' }, { name: 'recently_played' }],
      });

      const {
        body: timelineBeforeRevoke,
      } = await fetchJson(`${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`);
      const revokedEventsBefore = (timelineBeforeRevoke.data || [])
        .filter((event) => event.event_type === 'grant.revoked')
        .length;

      const malformedGrant = JSON.parse(JSON.stringify(approved.grant));
      delete malformedGrant.source;

      getDb().prepare(`
        UPDATE grants
        SET grant_json = ?
        WHERE grant_id = ?
      `).run(JSON.stringify(malformedGrant), approved.grant.grant_id);

      await closeServer(server);
      server = await startServer({
    quiet: true,
        asPort: server.asPort,
        rsPort: server.rsPort,
        dbPath,
        dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
      });

      const reRegisterResp = await fetchJson(`${asUrl}/connectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spotifyManifest),
      });
      assert.equal(reRegisterResp.status, 201);

      const introspectResp = await fetchJson(`${asUrl}/introspect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: approved.token }).toString(),
      });
      assert.equal(introspectResp.status, 200);
      assert.equal(introspectResp.body.active, false);
      assert.equal(introspectResp.body.inactive_reason, 'grant_invalid');
      assert.ok(!('grant' in introspectResp.body), 'malformed persisted grant source should not be surfaced publicly');

      const revokeResp = await fetchJson(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${approved.token}`,
        },
      });
      assert.equal(revokeResp.status, 403);
      assert.equal(revokeResp.body.error.code, 'grant_invalid');
      assert.match(revokeResp.body.error.message, /Grant is malformed or no longer valid/);

      const { body: timelineAfterRevoke } = await fetchJson(
        `${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`,
      );
      const revokedEventsAfter = (timelineAfterRevoke.data || [])
        .filter((event) => event.event_type === 'grant.revoked')
        .length;
      assert.equal(
        revokedEventsAfter,
        revokedEventsBefore,
        'malformed grants should not emit degraded grant.revoked artifacts',
      );
    } finally {
      await closeServer(server);
      cleanup();
    }
  });

  await t.test('polyfill client introspection and reads reject persisted grants with stream contracts that no longer resolve against the manifest', async () => {
    const { dbPath, cleanup } = createTempDbPath();
    const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'));
    let server = await startServer({
    quiet: true,
      asPort: 0,
      rsPort: 0,
      dbPath,
      dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    });
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;

    try {
      const registerResp = await fetchJson(`${asUrl}/connectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spotifyManifest),
      });
      assert.equal(registerResp.status, 201);

      const approved = await approveGrant(asUrl, 'owner_local', {
        client_id: 'longview',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/concert_recommendation',
        purpose_description: 'Recommend concerts and nearby live events',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists', view: 'basic' }],
      });
      const {
        body: timelineBeforeRevoke,
      } = await fetchJson(`${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`);
      const revokedEventsBefore = (timelineBeforeRevoke.data || [])
        .filter((event) => event.event_type === 'grant.revoked')
        .length;

      const malformedGrant = JSON.parse(JSON.stringify(approved.grant));
      malformedGrant.streams = [{ name: 'missing_stream' }];

      getDb().prepare(`
        UPDATE grants
        SET grant_json = ?
        WHERE grant_id = ?
      `).run(JSON.stringify(malformedGrant), approved.grant.grant_id);

      const introspectResp = await fetchJson(`${asUrl}/introspect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: approved.token }).toString(),
      });
      assert.equal(introspectResp.status, 200);
      assert.equal(introspectResp.body.active, false);
      assert.equal(introspectResp.body.inactive_reason, 'grant_invalid');

      const streamsResp = await fetchJson(`${rsUrl}/v1/streams`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(streamsResp.status, 403);
      assert.equal(streamsResp.body.error.code, 'grant_invalid');
      assert.match(streamsResp.body.error.message, /Grant is malformed or no longer valid/);

      const revokeResp = await fetchJson(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${approved.token}`,
        },
      });
      assert.equal(revokeResp.status, 403);
      assert.equal(revokeResp.body.error.code, 'grant_invalid');
      assert.match(revokeResp.body.error.message, /Grant is malformed or no longer valid/);

      const { body: timelineAfterRevoke } = await fetchJson(
        `${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`,
      );
      const revokedEventsAfter = (timelineAfterRevoke.data || [])
        .filter((event) => event.event_type === 'grant.revoked')
        .length;
      assert.equal(
        revokedEventsAfter,
        revokedEventsBefore,
        'manifest-drifted grants should not emit degraded grant.revoked artifacts',
      );
    } finally {
      await closeServer(server);
      cleanup();
    }
  });

  await t.test('polyfill client introspection and reads reject persisted grants whose manifest_version no longer matches the current manifest', async () => {
    const { dbPath, cleanup } = createTempDbPath();
    const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'));
    let server = await startServer({
    quiet: true,
      asPort: 0,
      rsPort: 0,
      dbPath,
      dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    });
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;

    try {
      const registerResp = await fetchJson(`${asUrl}/connectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spotifyManifest),
      });
      assert.equal(registerResp.status, 201);

      const approved = await approveGrant(asUrl, 'owner_local', {
        client_id: 'longview',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/concert_recommendation',
        purpose_description: 'Recommend concerts and nearby live events',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists' }],
      });
      const {
        body: timelineBeforeRevoke,
      } = await fetchJson(`${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`);
      const revokedEventsBefore = (timelineBeforeRevoke.data || [])
        .filter((event) => event.event_type === 'grant.revoked')
        .length;

      const malformedGrant = JSON.parse(JSON.stringify(approved.grant));
      malformedGrant.manifest_version = '999.0.0';

      getDb().prepare(`
        UPDATE grants
        SET grant_json = ?
        WHERE grant_id = ?
      `).run(JSON.stringify(malformedGrant), approved.grant.grant_id);

      const introspectResp = await fetchJson(`${asUrl}/introspect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: approved.token }).toString(),
      });
      assert.equal(introspectResp.status, 200);
      assert.equal(introspectResp.body.active, false);
      assert.equal(introspectResp.body.inactive_reason, 'grant_invalid');

      const metadataResp = await fetchJson(`${rsUrl}/v1/streams/top_artists`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(metadataResp.status, 403);
      assert.equal(metadataResp.body.error.code, 'grant_invalid');
      assert.match(metadataResp.body.error.message, /Grant is malformed or no longer valid/);

      const revokeResp = await fetchJson(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${approved.token}`,
        },
      });
      assert.equal(revokeResp.status, 403);
      assert.equal(revokeResp.body.error.code, 'grant_invalid');
      assert.match(revokeResp.body.error.message, /Grant is malformed or no longer valid/);

      const { body: timelineAfterRevoke } = await fetchJson(
        `${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`,
      );
      const revokedEventsAfter = (timelineAfterRevoke.data || [])
        .filter((event) => event.event_type === 'grant.revoked')
        .length;
      assert.equal(
        revokedEventsAfter,
        revokedEventsBefore,
        'manifest-version drifted grants should not emit degraded grant.revoked artifacts',
      );
    } finally {
      await closeServer(server);
      cleanup();
    }
  });

  await t.test('native client introspection and reads reject persisted grants with stream contracts that no longer resolve against the manifest', async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      const approved = await approveGrant(asUrl, 'employee_1', {
        client_id: 'longview',
        source: { kind: 'provider_native', id: nativeManifest.provider_id },
        purpose_code: 'https://pdpp.org/purpose/financial_planning',
        purpose_description: 'Support compensation planning and verification',
        access_mode: 'continuous',
        streams: [{ name: 'pay_statements' }],
      });
      const {
        body: timelineBeforeRevoke,
      } = await fetchJson(`${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`);
      const revokedEventsBefore = (timelineBeforeRevoke.data || [])
        .filter((event) => event.event_type === 'grant.revoked')
        .length;

      const malformedGrant = JSON.parse(JSON.stringify(approved.grant));
      malformedGrant.streams = [{ name: 'missing_stream' }];

      getDb().prepare(`
        UPDATE grants
        SET grant_json = ?
        WHERE grant_id = ?
      `).run(JSON.stringify(malformedGrant), approved.grant.grant_id);

      const introspectResp = await fetchJson(`${asUrl}/introspect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: approved.token }).toString(),
      });
      assert.equal(introspectResp.status, 200);
      assert.equal(introspectResp.body.active, false);
      assert.equal(introspectResp.body.inactive_reason, 'grant_invalid');

      const metadataResp = await fetchJson(`${rsUrl}/v1/streams/pay_statements`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(metadataResp.status, 403);
      assert.equal(metadataResp.body.error.code, 'grant_invalid');
      assert.match(metadataResp.body.error.message, /Grant is malformed or no longer valid/);

      const revokeResp = await fetchJson(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${approved.token}`,
        },
      });
      assert.equal(revokeResp.status, 403);
      assert.equal(revokeResp.body.error.code, 'grant_invalid');
      assert.match(revokeResp.body.error.message, /Grant is malformed or no longer valid/);

      const { body: timelineAfterRevoke } = await fetchJson(
        `${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`,
      );
      const revokedEventsAfter = (timelineAfterRevoke.data || [])
        .filter((event) => event.event_type === 'grant.revoked')
        .length;
      assert.equal(
        revokedEventsAfter,
        revokedEventsBefore,
        'manifest-drifted native grants should not emit degraded grant.revoked artifacts',
      );
    });
  });

  await t.test('native client introspection and reads reject persisted grants whose manifest_version no longer matches the current manifest', async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      const approved = await approveGrant(asUrl, 'employee_1', {
        client_id: 'longview',
        source: { kind: 'provider_native', id: nativeManifest.provider_id },
        purpose_code: 'https://pdpp.org/purpose/financial_planning',
        purpose_description: 'Support compensation planning and verification',
        access_mode: 'continuous',
        streams: [{ name: 'pay_statements' }],
      });
      const {
        body: timelineBeforeRevoke,
      } = await fetchJson(`${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`);
      const revokedEventsBefore = (timelineBeforeRevoke.data || [])
        .filter((event) => event.event_type === 'grant.revoked')
        .length;

      const malformedGrant = JSON.parse(JSON.stringify(approved.grant));
      malformedGrant.manifest_version = '999.0.0';

      getDb().prepare(`
        UPDATE grants
        SET grant_json = ?
        WHERE grant_id = ?
      `).run(JSON.stringify(malformedGrant), approved.grant.grant_id);

      const introspectResp = await fetchJson(`${asUrl}/introspect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: approved.token }).toString(),
      });
      assert.equal(introspectResp.status, 200);
      assert.equal(introspectResp.body.active, false);
      assert.equal(introspectResp.body.inactive_reason, 'grant_invalid');

      const metadataResp = await fetchJson(`${rsUrl}/v1/streams/pay_statements`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(metadataResp.status, 403);
      assert.equal(metadataResp.body.error.code, 'grant_invalid');
      assert.match(metadataResp.body.error.message, /Grant is malformed or no longer valid/);

      const revokeResp = await fetchJson(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${approved.token}`,
        },
      });
      assert.equal(revokeResp.status, 403);
      assert.equal(revokeResp.body.error.code, 'grant_invalid');
      assert.match(revokeResp.body.error.message, /Grant is malformed or no longer valid/);

      const { body: timelineAfterRevoke } = await fetchJson(
        `${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`,
      );
      const revokedEventsAfter = (timelineAfterRevoke.data || [])
        .filter((event) => event.event_type === 'grant.revoked')
        .length;
      assert.equal(
        revokedEventsAfter,
        revokedEventsBefore,
        'manifest-version drifted native grants should not emit degraded grant.revoked artifacts',
      );
    });
  });

  await t.test('native provider grants reject an unknown provider_id', async () => {
    await withNativeHarness(async ({ asUrl }) => {
      const initiateResp = await fetch(`${asUrl}/oauth/par`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'longview',
          authorization_details: [
            {
              type: 'https://pdpp.org/data-access',
              source: { kind: 'provider_native', id: 'wrong_provider' },
              purpose_code: 'https://pdpp.org/purpose/financial_planning',
              access_mode: 'continuous',
              streams: [{ name: 'pay_statements' }],
            },
          ],
        }),
      });

      assert.equal(initiateResp.status, 400);
      const initiateBody = await initiateResp.json();
      assert.equal(initiateBody.error.code, 'invalid_request');
      assert.match(initiateBody.error.message, /Unknown source/);
    });
  });

  await t.test('native provider grants reject requests that mix legacy source scalars with source objects', async () => {
    await withNativeHarness(async ({ asUrl, nativeManifest }) => {
      const initiateResp = await fetch(`${asUrl}/oauth/par`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'longview',
          authorization_details: [
            {
              type: 'https://pdpp.org/data-access',
              source: {
                kind: 'provider_native',
                id: nativeManifest.provider_id,
              },
              connector_id: 'spotify',
              purpose_code: 'https://pdpp.org/purpose/financial_planning',
              access_mode: 'continuous',
              streams: [{ name: 'pay_statements' }],
            },
          ],
        }),
      });

      assert.equal(initiateResp.status, 400);
      const initiateBody = await initiateResp.json();
      assert.equal(initiateBody.error.code, 'invalid_request');
      assert.match(initiateBody.error.message, /source: \{ kind/);
    });
  });

  await t.test('malformed persisted native pending requests are rejected instead of normalized', async () => {
    await withNativeHarness(async ({ asUrl, nativeManifest }) => {
      const initiate = await startGrantRequest(asUrl, {
        client_id: 'longview',
        source: { kind: 'provider_native', id: nativeManifest.provider_id },
        purpose_code: 'https://pdpp.org/purpose/financial_planning',
        purpose_description: 'Support compensation planning and verification',
        access_mode: 'continuous',
        streams: [{ name: 'pay_statements' }],
      });

      assert.equal(initiate.status, 201);
      const deviceCode = parsePendingConsentRequestUri(initiate.body.request_uri);
      assert.ok(deviceCode, 'request_uri should decode to a pending device code');

      const rows = getDb().prepare(`
        SELECT params_json
        FROM pending_consents
        WHERE device_code = ?
      `).all(deviceCode);
      assert.equal(rows.length, 1);

      const malformedRequest = JSON.parse(rows[0].params_json);
      delete malformedRequest.source_binding;

      getDb().prepare(`
        UPDATE pending_consents
        SET params_json = ?
        WHERE device_code = ?
      `).run(JSON.stringify(malformedRequest), deviceCode);

      const consentResp = await fetchJson(
        `${asUrl}/consent?request_uri=${encodeURIComponent(initiate.body.request_uri)}`,
      );
      assert.equal(consentResp.status, 400);
      assert.equal(consentResp.body.error.code, 'invalid_request');
      assert.match(consentResp.body.error.message, /source_binding is required/);

      const approveResp = await approveGrantRequest(asUrl, initiate.body.request_uri, 'employee_1');
      assert.equal(approveResp.status, 400);
      assert.equal(approveResp.body.error.code, 'invalid_request');
      assert.match(approveResp.body.error.message, /source_binding is required/);
    });
  });

  await t.test('malformed persisted native pending request bindings with unsupported fields are rejected instead of normalized', async () => {
    await withNativeHarness(async ({ asUrl, nativeManifest }) => {
      const initiate = await startGrantRequest(asUrl, {
        client_id: 'longview',
        source: { kind: 'provider_native', id: nativeManifest.provider_id },
        purpose_code: 'https://pdpp.org/purpose/financial_planning',
        purpose_description: 'Support compensation planning and verification',
        access_mode: 'continuous',
        streams: [{ name: 'pay_statements' }],
      });

      assert.equal(initiate.status, 201);
      const deviceCode = parsePendingConsentRequestUri(initiate.body.request_uri);
      assert.ok(deviceCode, 'request_uri should decode to a pending device code');

      const rows = getDb().prepare(`
        SELECT params_json
        FROM pending_consents
        WHERE device_code = ?
      `).all(deviceCode);
      assert.equal(rows.length, 1);

      const malformedRequest = JSON.parse(rows[0].params_json);
      malformedRequest.source_binding.debug_context = 'should_not_escape';
      malformedRequest.storage_binding.debug_context = 'should_not_escape';

      getDb().prepare(`
        UPDATE pending_consents
        SET params_json = ?
        WHERE device_code = ?
      `).run(JSON.stringify(malformedRequest), deviceCode);

      const consentResp = await fetchJson(
        `${asUrl}/consent?request_uri=${encodeURIComponent(initiate.body.request_uri)}`,
      );
      assert.equal(consentResp.status, 400);
      assert.equal(consentResp.body.error.code, 'invalid_request');
      assert.match(consentResp.body.error.message, /source_binding must include only kind and id/);

      const approveResp = await approveGrantRequest(asUrl, initiate.body.request_uri, 'employee_1');
      assert.equal(approveResp.status, 400);
      assert.equal(approveResp.body.error.code, 'invalid_request');
      assert.match(approveResp.body.error.message, /source_binding must include only kind and id/);
    });
  });

  await t.test('malformed persisted polyfill pending requests with mismatched bindings are rejected instead of normalized', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiate = await startGrantRequest(asUrl, {
        client_id: 'longview',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/concert_recommendation',
        purpose_description: 'Recommend concerts and nearby live events',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists' }],
      });

      assert.equal(initiate.status, 201);
      const deviceCode = parsePendingConsentRequestUri(initiate.body.request_uri);
      assert.ok(deviceCode, 'request_uri should decode to a pending device code');

      const rows = getDb().prepare(`
        SELECT params_json
        FROM pending_consents
        WHERE device_code = ?
      `).all(deviceCode);
      assert.equal(rows.length, 1);

      const malformedRequest = JSON.parse(rows[0].params_json);
      malformedRequest.source_binding.id = 'other_connector';

      getDb().prepare(`
        UPDATE pending_consents
        SET params_json = ?
        WHERE device_code = ?
      `).run(JSON.stringify(malformedRequest), deviceCode);

      const consentResp = await fetchJson(
        `${asUrl}/consent?request_uri=${encodeURIComponent(initiate.body.request_uri)}`,
      );
      assert.equal(consentResp.status, 400);
      assert.equal(consentResp.body.error.code, 'invalid_request');
      assert.match(consentResp.body.error.message, /source_binding\.id must match storage_binding\.connector_id/);

      const approveResp = await approveGrantRequest(asUrl, initiate.body.request_uri, 'owner_local');
      assert.equal(approveResp.status, 400);
      assert.equal(approveResp.body.error.code, 'invalid_request');
      assert.match(approveResp.body.error.message, /source_binding\.id must match storage_binding\.connector_id/);
    });
  });

  await t.test('native provider owner queries do not require public connector_id', async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'employee_1');
      await seedNorthstar(nativeManifest);

      const streamsResp = await fetch(`${rsUrl}/v1/streams`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(streamsResp.status, 200);
      const streamsRequestId = streamsResp.headers.get('Request-Id');
      const streamsTraceId = streamsResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(streamsRequestId?.startsWith('req_'));
      assert.ok(streamsTraceId?.startsWith('trc_qry_'));
      const streamsBody = await streamsResp.json();
      assert.deepEqual(streamsBody.data.map((stream) => stream.name), ['benefits_enrollments', 'equity_grants', 'pay_statements']);

      const streamMetadataResp = await fetch(`${rsUrl}/v1/streams/pay_statements`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(streamMetadataResp.status, 200);
      const streamMetadataRequestId = streamMetadataResp.headers.get('Request-Id');
      const streamMetadataTraceId = streamMetadataResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(streamMetadataRequestId?.startsWith('req_'));
      assert.ok(streamMetadataTraceId?.startsWith('trc_qry_'));
      const streamMetadataBody = await streamMetadataResp.json();
      const payStatementsManifest = nativeManifest.streams.find((stream) => stream.name === 'pay_statements');
      assert.equal(streamMetadataBody.name, 'pay_statements');
      assert.equal(streamMetadataBody.semantics, payStatementsManifest.semantics);
      assert.equal(streamMetadataBody.consent_time_field, payStatementsManifest.consent_time_field);
      assert.deepEqual(streamMetadataBody.primary_key, [payStatementsManifest.primary_key]);

      const recordsResp = await fetch(`${rsUrl}/v1/streams/pay_statements/records`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(recordsResp.status, 200);
      const recordsRequestId = recordsResp.headers.get('Request-Id');
      const recordsTraceId = recordsResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(recordsRequestId?.startsWith('req_'));
      assert.ok(recordsTraceId?.startsWith('trc_qry_'));
      const recordsBody = await recordsResp.json();
      assert.equal(recordsBody.data.length, 1);
      assert.equal(recordsBody.data[0].id, 'ps_2026_04_15');
      assert.equal(recordsBody.data[0].data.employer, 'Northstar HR');

      const connectionScopedOwnerResp = await fetch(
        `${rsUrl}/v1/streams/pay_statements/records?connection_id=not_a_native_concept`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      assert.equal(connectionScopedOwnerResp.status, 400);
      const connectionScopedOwnerBody = await connectionScopedOwnerResp.json();
      assert.equal(connectionScopedOwnerBody.error.code, 'invalid_argument');
      assert.match(connectionScopedOwnerBody.error.message, /provider_native/);

      const { body: streamsTrace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(streamsTraceId)}`);
      const { body: streamMetadataTrace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(streamMetadataTraceId)}`);
      const { body: ownerTrace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(recordsTraceId)}`);

      const ownerStreamListQueryEvent = streamsTrace.data.find((event) =>
        event.event_type === 'query.received'
        && event.object_id === streamsRequestId
      );
      assert.ok(ownerStreamListQueryEvent, 'owner self-export trace should include query.received for stream list');
      assert.equal(ownerStreamListQueryEvent.data.query_shape, 'stream_list');
      assert.equal(ownerStreamListQueryEvent.actor_type, 'subject');
      assert.equal(ownerStreamListQueryEvent.subject_id, 'employee_1');
      assert.equal(ownerStreamListQueryEvent.data.source?.kind, 'provider_native');
      assert.ok(!('connector_id' in ownerStreamListQueryEvent.data), 'owner stream-list query event should not expose connector_id');

      const ownerStreamListDisclosureEvent = streamsTrace.data.find((event) =>
        event.event_type === 'disclosure.served'
        && event.object_id === streamsRequestId
      );
      assert.ok(ownerStreamListDisclosureEvent, 'owner self-export trace should include disclosure.served for stream list');
      assert.equal(ownerStreamListDisclosureEvent.data.query_shape, 'stream_list');
      assert.equal(ownerStreamListDisclosureEvent.actor_type, 'subject');
      assert.equal(ownerStreamListDisclosureEvent.subject_id, 'employee_1');
      assert.equal(ownerStreamListDisclosureEvent.data.source?.kind, 'provider_native');
      assert.ok(!('connector_id' in ownerStreamListDisclosureEvent.data), 'owner stream-list disclosure event should not expose connector_id');

      const ownerStreamMetadataQueryEvent = streamMetadataTrace.data.find((event) =>
        event.event_type === 'query.received'
        && event.object_id === streamMetadataRequestId
      );
      assert.ok(ownerStreamMetadataQueryEvent, 'owner self-export trace should include query.received for stream metadata');
      assert.equal(ownerStreamMetadataQueryEvent.stream_id, 'pay_statements');
      assert.equal(ownerStreamMetadataQueryEvent.data.query_shape, 'stream_metadata');
      assert.equal(ownerStreamMetadataQueryEvent.data.source?.kind, 'provider_native');
      assert.ok(!('connector_id' in ownerStreamMetadataQueryEvent.data), 'owner stream-metadata query event should not expose connector_id');

      const ownerStreamMetadataDisclosureEvent = streamMetadataTrace.data.find((event) =>
        event.event_type === 'disclosure.served'
        && event.object_id === streamMetadataRequestId
      );
      assert.ok(ownerStreamMetadataDisclosureEvent, 'owner self-export trace should include disclosure.served for stream metadata');
      assert.equal(ownerStreamMetadataDisclosureEvent.stream_id, 'pay_statements');
      assert.equal(ownerStreamMetadataDisclosureEvent.data.query_shape, 'stream_metadata');
      assert.equal(ownerStreamMetadataDisclosureEvent.data.source?.kind, 'provider_native');
      assert.ok(!('connector_id' in ownerStreamMetadataDisclosureEvent.data), 'owner stream-metadata disclosure event should not expose connector_id');

      const ownerQueryEvent = ownerTrace.data.find((event) =>
        event.event_type === 'query.received'
        && event.object_id === recordsRequestId
      );
      assert.ok(ownerQueryEvent, 'owner self-export trace should include query.received');
      assert.equal(ownerQueryEvent.object_id, recordsRequestId);
      assert.equal(ownerQueryEvent.actor_type, 'subject');
      assert.equal(ownerQueryEvent.subject_id, 'employee_1');
      assert.equal(ownerQueryEvent.data.source?.kind, 'provider_native');
      assert.equal(ownerQueryEvent.data.source?.id, nativeManifest.provider_id);
      assert.ok(!('connector_id' in ownerQueryEvent.data), 'owner trace query event should not expose connector_id');

      const ownerDisclosureEvent = ownerTrace.data.find((event) =>
        event.event_type === 'disclosure.served'
        && event.object_id === recordsRequestId
      );
      assert.ok(ownerDisclosureEvent, 'owner self-export trace should include disclosure.served');
      assert.equal(ownerDisclosureEvent.object_id, recordsRequestId);
      assert.equal(ownerDisclosureEvent.actor_type, 'subject');
      assert.equal(ownerDisclosureEvent.subject_id, 'employee_1');
      assert.equal(ownerDisclosureEvent.data.source?.kind, 'provider_native');
      assert.equal(ownerDisclosureEvent.data.source?.id, nativeManifest.provider_id);
      assert.equal(ownerDisclosureEvent.data.record_count, 1);
      assert.ok(!('connector_id' in ownerDisclosureEvent.data), 'owner trace disclosure event should not expose connector_id');
    });
  });

  await t.test('polyfill owner reads fail connector-first when the requested connector is unknown', async () => {
    await withHarness(async ({ asUrl, rsUrl }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      const missingConnectorId = 'missing_spotify_connector';

      const rejectedResp = await fetch(
        `${rsUrl}/v1/streams?connector_id=${encodeURIComponent(missingConnectorId)}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      assert.equal(rejectedResp.status, 404);
      const rejectedRequestId = rejectedResp.headers.get('Request-Id');
      const rejectedTraceId = rejectedResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(rejectedRequestId?.startsWith('req_'));
      assert.ok(rejectedTraceId?.startsWith('trc_qry_'));
      const rejectedBody = await rejectedResp.json();
      assert.equal(rejectedBody.error.code, 'not_found');
      assert.match(rejectedBody.error.message, /Unknown connector: missing_spotify_connector/);

      const { body: trace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(rejectedTraceId)}`);
      const queryReceivedEvent = trace.data.find((event) =>
        event.event_type === 'query.received'
        && event.object_id === rejectedRequestId
      );
      assert.ok(queryReceivedEvent, 'owner trace should include query.received for broken polyfill owner reads');
      assert.equal(queryReceivedEvent.data.query_shape, 'stream_list');
      assert.equal(queryReceivedEvent.actor_type, 'subject');
      assert.equal(queryReceivedEvent.subject_id, 'u1');
      assert.equal(queryReceivedEvent.data.source?.kind, 'connector');
      assert.equal(queryReceivedEvent.data.source?.id, missingConnectorId);

      const rejectedEvent = trace.data.find((event) =>
        event.event_type === 'query.rejected'
        && event.object_id === rejectedRequestId
      );
      assert.ok(rejectedEvent, 'owner trace should include query.rejected for broken polyfill owner reads');
      assert.equal(rejectedEvent.trace_id, rejectedTraceId);
      assert.equal(rejectedEvent.data.query_shape, 'stream_list');
      assert.equal(rejectedEvent.data.source?.kind, 'connector');
      assert.equal(rejectedEvent.data.source?.id, missingConnectorId);
      assert.equal(rejectedEvent.data.error?.code, 'not_found');
      assert.match(rejectedEvent.data.error?.message || '', /Unknown connector: missing_spotify_connector/);

      const servedEvent = trace.data.find((event) =>
        event.event_type === 'disclosure.served'
        && event.object_id === rejectedRequestId
      );
      assert.equal(servedEvent, undefined, 'broken polyfill owner reads should not produce disclosure.served');
    });
  });

  await t.test('polyfill owner reads reject duplicate connector_id query params instead of normalizing them into owner scope', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      const duplicateQuery = new URLSearchParams();
      duplicateQuery.append('connector_id', spotifyManifest.connector_id);
      duplicateQuery.append('connector_id', 'unexpected_second_value');

      const rejectedResp = await fetch(
        `${rsUrl}/v1/streams?${duplicateQuery.toString()}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      assert.equal(rejectedResp.status, 400);
      const rejectedRequestId = rejectedResp.headers.get('Request-Id');
      const rejectedTraceId = rejectedResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(rejectedRequestId?.startsWith('req_'));
      assert.ok(rejectedTraceId?.startsWith('trc_qry_'));
      const rejectedBody = await rejectedResp.json();
      assert.equal(rejectedBody.error.code, 'invalid_request');
      assert.match(rejectedBody.error.message, /connector_id must be a single non-empty string/);

      const { body: trace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(rejectedTraceId)}`);
      const queryReceivedEvent = trace.data.find((event) =>
        event.event_type === 'query.received'
        && event.object_id === rejectedRequestId
      );
      assert.ok(queryReceivedEvent, 'owner trace should include query.received for duplicate connector_id reads');
      assert.equal(queryReceivedEvent.data.query_shape, 'stream_list');
      assert.equal(queryReceivedEvent.data.source, null, 'duplicate connector_id should not be normalized into a connector-shaped owner source');

      const rejectedEvent = trace.data.find((event) =>
        event.event_type === 'query.rejected'
        && event.object_id === rejectedRequestId
      );
      assert.ok(rejectedEvent, 'owner trace should include query.rejected for duplicate connector_id reads');
      assert.equal(rejectedEvent.trace_id, rejectedTraceId);
      assert.equal(rejectedEvent.data.query_shape, 'stream_list');
      assert.equal(rejectedEvent.data.source, null, 'duplicate connector_id should not be normalized into a connector-shaped rejection source');
      assert.equal(rejectedEvent.data.error?.code, 'invalid_request');
      assert.match(rejectedEvent.data.error?.message || '', /connector_id must be a single non-empty string/);
    });
  });

  await t.test('polyfill owner stream metadata rejects duplicate connector_id query params and preserves null-source trace artifacts', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      const duplicateQuery = new URLSearchParams();
      duplicateQuery.append('connector_id', spotifyManifest.connector_id);
      duplicateQuery.append('connector_id', 'unexpected_second_value');

      const rejectedResp = await fetch(
        `${rsUrl}/v1/streams/top_artists?${duplicateQuery.toString()}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      assert.equal(rejectedResp.status, 400);
      const rejectedRequestId = rejectedResp.headers.get('Request-Id');
      const rejectedTraceId = rejectedResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(rejectedRequestId?.startsWith('req_'));
      assert.ok(rejectedTraceId?.startsWith('trc_qry_'));
      const rejectedBody = await rejectedResp.json();
      assert.equal(rejectedBody.error.code, 'invalid_request');
      assert.match(rejectedBody.error.message, /connector_id must be a single non-empty string/);

      const { body: trace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(rejectedTraceId)}`);
      const queryReceivedEvent = trace.data.find((event) =>
        event.event_type === 'query.received'
        && event.object_id === rejectedRequestId
      );
      assert.ok(queryReceivedEvent, 'owner trace should include query.received for duplicate connector_id metadata reads');
      assert.equal(queryReceivedEvent.stream_id, 'top_artists');
      assert.equal(queryReceivedEvent.data.query_shape, 'stream_metadata');
      assert.equal(queryReceivedEvent.data.source, null);

      const rejectedEvent = trace.data.find((event) =>
        event.event_type === 'query.rejected'
        && event.object_id === rejectedRequestId
      );
      assert.ok(rejectedEvent, 'owner trace should include query.rejected for duplicate connector_id metadata reads');
      assert.equal(rejectedEvent.stream_id, 'top_artists');
      assert.equal(rejectedEvent.data.query_shape, 'stream_metadata');
      assert.equal(rejectedEvent.data.source, null);
      assert.equal(rejectedEvent.data.error?.code, 'invalid_request');
      assert.match(rejectedEvent.data.error?.message || '', /connector_id must be a single non-empty string/);
    });
  });

  await t.test('polyfill owner record-list rejects duplicate connector_id query params and preserves null-source trace artifacts', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      const duplicateQuery = new URLSearchParams();
      duplicateQuery.append('connector_id', spotifyManifest.connector_id);
      duplicateQuery.append('connector_id', 'unexpected_second_value');
      duplicateQuery.append('limit', '2');

      const rejectedResp = await fetch(
        `${rsUrl}/v1/streams/top_artists/records?${duplicateQuery.toString()}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      assert.equal(rejectedResp.status, 400);
      const rejectedRequestId = rejectedResp.headers.get('Request-Id');
      const rejectedTraceId = rejectedResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(rejectedRequestId?.startsWith('req_'));
      assert.ok(rejectedTraceId?.startsWith('trc_qry_'));
      const rejectedBody = await rejectedResp.json();
      assert.equal(rejectedBody.error.code, 'invalid_request');
      assert.match(rejectedBody.error.message, /connector_id must be a single non-empty string/);

      const { body: trace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(rejectedTraceId)}`);
      const queryReceivedEvent = trace.data.find((event) =>
        event.event_type === 'query.received'
        && event.object_id === rejectedRequestId
      );
      assert.ok(queryReceivedEvent, 'owner trace should include query.received for duplicate connector_id record-list reads');
      assert.equal(queryReceivedEvent.stream_id, 'top_artists');
      assert.equal(queryReceivedEvent.data.query_shape, 'record_list');
      assert.equal(queryReceivedEvent.data.limit, 2);
      assert.equal(queryReceivedEvent.data.source, null);

      const rejectedEvent = trace.data.find((event) =>
        event.event_type === 'query.rejected'
        && event.object_id === rejectedRequestId
      );
      assert.ok(rejectedEvent, 'owner trace should include query.rejected for duplicate connector_id record-list reads');
      assert.equal(rejectedEvent.stream_id, 'top_artists');
      assert.equal(rejectedEvent.data.query_shape, 'record_list');
      assert.equal(rejectedEvent.data.limit, 2);
      assert.equal(rejectedEvent.data.source, null);
      assert.equal(rejectedEvent.data.error?.code, 'invalid_request');
      assert.match(rejectedEvent.data.error?.message || '', /connector_id must be a single non-empty string/);
    });
  });

  await t.test('polyfill owner reads reject malformed persisted connector manifests instead of drifting into generic failures', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const ownerRecordListResp = await fetchJson(
        `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}&limit=1`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      const visibleRecord = ownerRecordListResp.body.data?.[0];
      assert.ok(visibleRecord, 'expected an owner-visible top_artists record before corrupting the manifest');

      getDb().prepare(`
        UPDATE connectors
        SET manifest = ?
        WHERE connector_id = ?
      `).run('{"connector_id":"https://registry.pdpp.org/connectors/spotify","streams":[{"name":"top_artists","primary_key":["missing_id"]}]}', SPOTIFY_CONNECTOR_KEY);

      const connectorLookupResp = await fetchJson(
        `${asUrl}/connectors/${encodeURIComponent(spotifyManifest.connector_id)}`,
      );
      assert.equal(connectorLookupResp.status, 400);
      assert.equal(connectorLookupResp.body.error.code, 'connector_invalid');
      assert.match(
        connectorLookupResp.body.error.message,
        new RegExp(`Connector manifest for ${spotifyManifest.connector_id} is malformed or no longer valid`),
      );

      async function assertMalformedOwnerRead(path, queryShape, streamId = null) {
        const rejectedResp = await fetch(`${rsUrl}${path}`, {
          headers: { Authorization: `Bearer ${ownerToken}` },
        });
        assert.equal(rejectedResp.status, 400);
        const rejectedRequestId = rejectedResp.headers.get('Request-Id');
        const rejectedTraceId = rejectedResp.headers.get('PDPP-Reference-Trace-Id');
        assert.ok(rejectedRequestId?.startsWith('req_'));
        assert.ok(rejectedTraceId?.startsWith('trc_qry_'));
        // Owner read routes canonicalize the connector id at the boundary, so
        // the rejection message, the query.received source descriptor, and the
        // query.rejected message all carry the canonical connector key
        // (Decision 1), not the URL-shaped manifest id.
        const rejectedBody = await rejectedResp.json();
        assert.equal(rejectedBody.error.code, 'connector_invalid');
        assert.match(
          rejectedBody.error.message,
          new RegExp(`Connector manifest for ${SPOTIFY_CONNECTOR_KEY} is malformed or no longer valid`),
        );

        const { body: trace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(rejectedTraceId)}`);
        const queryReceivedEvent = trace.data.find((event) =>
          event.event_type === 'query.received'
          && event.object_id === rejectedRequestId
        );
        assert.ok(queryReceivedEvent, `owner trace should include query.received for malformed ${queryShape} reads`);
        assert.equal(queryReceivedEvent.data.query_shape, queryShape);
        assert.equal(queryReceivedEvent.data.source?.kind, 'connector');
        assert.equal(queryReceivedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
        if (streamId) {
          assert.equal(queryReceivedEvent.stream_id, streamId);
        }

        const rejectedEvent = trace.data.find((event) =>
          event.event_type === 'query.rejected'
          && event.object_id === rejectedRequestId
        );
        assert.ok(rejectedEvent, `owner trace should include query.rejected for malformed ${queryShape} reads`);
        assert.equal(rejectedEvent.data.query_shape, queryShape);
        assert.equal(rejectedEvent.data.error?.code, 'connector_invalid');
        assert.match(
          rejectedEvent.data.error?.message || '',
          new RegExp(`Connector manifest for ${SPOTIFY_CONNECTOR_KEY} is malformed or no longer valid`),
        );
        if (streamId) {
          assert.equal(rejectedEvent.stream_id, streamId);
        }

        const servedEvent = trace.data.find((event) =>
          event.event_type === 'disclosure.served'
          && event.object_id === rejectedRequestId
        );
        assert.equal(servedEvent, undefined, `malformed ${queryShape} reads should not produce disclosure.served`);
      }

      await assertMalformedOwnerRead(
        `/v1/streams?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
        'stream_list',
      );
      await assertMalformedOwnerRead(
        `/v1/streams/top_artists?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
        'stream_metadata',
        'top_artists',
      );
      await assertMalformedOwnerRead(
        `/v1/streams/top_artists/records/${encodeURIComponent(visibleRecord.id)}?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
        'record_detail',
        'top_artists',
      );
    });
  });

  await t.test('polyfill state routes reject unknown connectors and manifest-unknown streams instead of creating orphaned state', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      const missingConnectorId = 'missing_spotify_connector';

      const unknownGetResp = await fetchJson(
        `${rsUrl}/v1/state/${encodeURIComponent(missingConnectorId)}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      assert.equal(unknownGetResp.status, 404);
      assert.equal(unknownGetResp.body.error.code, 'not_found');
      assert.match(unknownGetResp.body.error.message, /Unknown connector: missing_spotify_connector/);
      const unknownGetRequestId = unknownGetResp.headers['request-id'];
      const unknownGetTraceId = unknownGetResp.headers['pdpp-reference-trace-id'];
      assert.ok(unknownGetRequestId?.startsWith('req_'));
      assert.ok(unknownGetTraceId?.startsWith('trc_state'));

      const { body: unknownGetTrace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(unknownGetTraceId)}`);
      const unknownGetRequested = (unknownGetTrace.data || []).find((event) =>
        event.event_type === 'state.requested'
        && event.object_id === unknownGetRequestId
      );
      assert.ok(unknownGetRequested, 'owner state traces should include state.requested for rejected unknown-connector reads');
      assert.equal(unknownGetRequested.data.state_scope, 'owner');
      assert.equal(unknownGetRequested.data.operation, 'read');
      assert.equal(unknownGetRequested.data.source?.kind, 'connector');
      assert.equal(unknownGetRequested.data.source?.id, missingConnectorId);

      const unknownGetRejected = (unknownGetTrace.data || []).find((event) =>
        event.event_type === 'state.rejected'
        && event.object_id === unknownGetRequestId
      );
      assert.ok(unknownGetRejected, 'owner state traces should include state.rejected for rejected unknown-connector reads');
      assert.equal(unknownGetRejected.data.error?.code, 'not_found');
      assert.match(unknownGetRejected.data.error?.message || '', /Unknown connector: missing_spotify_connector/);

      const unknownPutResp = await fetchJson(
        `${rsUrl}/v1/state/${encodeURIComponent(missingConnectorId)}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ state: { top_artists: { cursor: 'missing_connector_cursor' } } }),
        },
      );
      assert.equal(unknownPutResp.status, 404);
      assert.equal(unknownPutResp.body.error.code, 'not_found');
      assert.match(unknownPutResp.body.error.message, /Unknown connector: missing_spotify_connector/);

      const unknownStreamPutResp = await fetchJson(
        `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ state: { not_a_stream: { cursor: 'missing_stream_cursor' } } }),
        },
      );
      assert.equal(unknownStreamPutResp.status, 404);
      assert.equal(unknownStreamPutResp.body.error.code, 'not_found');
      assert.match(
        unknownStreamPutResp.body.error.message,
        new RegExp(`Stream 'not_a_stream' not found for connector ${SPOTIFY_CONNECTOR_KEY}`),
      );

      const stateRows = getDb().prepare(`
        SELECT connector_id, stream, state_json
        FROM connector_state
        WHERE connector_id IN (?, ?)
      `).all(missingConnectorId, SPOTIFY_CONNECTOR_KEY);
      assert.equal(stateRows.length, 0, 'rejected state writes should not create connector_state rows');
    });
  });

  await t.test('polyfill state routes reject malformed persisted connector manifests instead of drifting into generic failures', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');

      getDb().prepare(`
        UPDATE connectors
        SET manifest = ?
        WHERE connector_id = ?
      `).run('{"connector_id":"https://registry.pdpp.org/connectors/spotify","streams":[{"name":"top_artists","primary_key":["missing_id"]}]}', SPOTIFY_CONNECTOR_KEY);

      const malformedGetResp = await fetchJson(
        `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      assert.equal(malformedGetResp.status, 400);
      assert.equal(malformedGetResp.body.error.code, 'connector_invalid');
      assert.match(
        malformedGetResp.body.error.message,
        new RegExp(`Connector manifest for ${SPOTIFY_CONNECTOR_KEY} is malformed or no longer valid`),
      );

      const malformedPutResp = await fetchJson(
        `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ state: { top_artists: { cursor: 'malformed_manifest_cursor' } } }),
        },
      );
      assert.equal(malformedPutResp.status, 400);
      assert.equal(malformedPutResp.body.error.code, 'connector_invalid');
      assert.match(
        malformedPutResp.body.error.message,
        new RegExp(`Connector manifest for ${SPOTIFY_CONNECTOR_KEY} is malformed or no longer valid`),
      );

      const stateRows = getDb().prepare(`
        SELECT connector_id, stream, state_json
        FROM connector_state
        WHERE connector_id = ?
      `).all(SPOTIFY_CONNECTOR_KEY);
      assert.equal(stateRows.length, 0, 'malformed-manifest state writes should not create connector_state rows');
    });
  });

  await t.test('grant-scoped polyfill state rejects unknown grants and connector-mismatched grants instead of creating orphaned grant state', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const githubManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/github.json'), 'utf8'));
      const githubConnectorKey = canonicalConnectorKey(githubManifest.connector_id) ?? githubManifest.connector_id;
      const ownerToken = await issueOwnerToken(asUrl, 'u1');

      await fetchJson(`${asUrl}/connectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(githubManifest),
      });

      const approved = await approveGrant(asUrl, 'u1', {
        client_id: 'concert_recommendation_app',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Maintain a concert-recommendation profile over time',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists' }],
      });

      const unknownGrantId = 'grant_missing_for_state';

      const unknownGrantGetResp = await fetchJson(
        `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}?grant_id=${encodeURIComponent(unknownGrantId)}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      assert.equal(unknownGrantGetResp.status, 404);
      assert.equal(unknownGrantGetResp.body.error.code, 'not_found');
      assert.match(unknownGrantGetResp.body.error.message, /Unknown grant: grant_missing_for_state/);

      const unknownGrantPutResp = await fetchJson(
        `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}?grant_id=${encodeURIComponent(unknownGrantId)}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ state: { top_artists: { cursor: 'missing_grant_cursor' } } }),
        },
      );
      assert.equal(unknownGrantPutResp.status, 404);
      assert.equal(unknownGrantPutResp.body.error.code, 'not_found');
      assert.match(unknownGrantPutResp.body.error.message, /Unknown grant: grant_missing_for_state/);

      const mismatchedGrantGetResp = await fetchJson(
        `${rsUrl}/v1/state/${encodeURIComponent(githubManifest.connector_id)}?grant_id=${encodeURIComponent(approved.grant.grant_id)}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      assert.equal(mismatchedGrantGetResp.status, 400);
      assert.equal(mismatchedGrantGetResp.body.error.code, 'invalid_request');
      assert.match(
        mismatchedGrantGetResp.body.error.message,
        new RegExp(`Grant '${approved.grant.grant_id}' is not scoped to connector ${githubConnectorKey}`),
      );

      const mismatchedGrantPutResp = await fetchJson(
        `${rsUrl}/v1/state/${encodeURIComponent(githubManifest.connector_id)}?grant_id=${encodeURIComponent(approved.grant.grant_id)}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ state: { pull_requests: { cursor: 'mismatched_grant_cursor' } } }),
        },
      );
      assert.equal(mismatchedGrantPutResp.status, 400);
      assert.equal(mismatchedGrantPutResp.body.error.code, 'invalid_request');
      assert.match(
        mismatchedGrantPutResp.body.error.message,
        new RegExp(`Grant '${approved.grant.grant_id}' is not scoped to connector ${githubConnectorKey}`),
      );

      const grantStateRows = getDb().prepare(`
        SELECT grant_id, connector_id, stream, state_json
        FROM grant_connector_state
        WHERE grant_id IN (?, ?)
      `).all(unknownGrantId, approved.grant.grant_id);
      assert.equal(grantStateRows.length, 0, 'rejected grant-scoped state writes should not create grant_connector_state rows');
    });
  });

  await t.test('grant-scoped polyfill state rejects malformed persisted grant bindings as invalid grants', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');

      const approved = await approveGrant(asUrl, 'u1', {
        client_id: 'concert_recommendation_app',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Maintain a concert-recommendation profile over time',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists' }],
      });

      getDb().prepare(
        'UPDATE grants SET storage_binding_json = ? WHERE grant_id = ?'
      ).run('{"connector_id":', approved.grant.grant_id);

      const malformedGrantGetResp = await fetchJson(
        `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}?grant_id=${encodeURIComponent(approved.grant.grant_id)}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      assert.equal(malformedGrantGetResp.status, 403);
      assert.equal(malformedGrantGetResp.body.error.code, 'grant_invalid');
      assert.match(malformedGrantGetResp.body.error.message, /Grant is malformed or no longer valid/);
      const malformedGrantGetRequestId = malformedGrantGetResp.headers['request-id'];
      const malformedGrantGetTraceId = malformedGrantGetResp.headers['pdpp-reference-trace-id'];
      assert.ok(malformedGrantGetRequestId?.startsWith('req_'));
      assert.ok(malformedGrantGetTraceId?.startsWith('trc_'));

      const { body: malformedGrantTimeline } = await fetchJson(
        `${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`,
      );
      const malformedGrantRequested = (malformedGrantTimeline.data || []).find((event) =>
        event.event_type === 'state.requested'
        && event.object_id === malformedGrantGetRequestId
      );
      assert.ok(malformedGrantRequested, 'grant timeline should include state.requested for malformed grant-scoped state reads');
      assert.equal(malformedGrantRequested.trace_id, malformedGrantGetTraceId);
      assert.equal(malformedGrantRequested.data.state_scope, 'grant');
      assert.equal(malformedGrantRequested.data.operation, 'read');
      assert.equal(malformedGrantRequested.data.source?.kind, 'connector');
      assert.equal(malformedGrantRequested.data.source?.id, SPOTIFY_CONNECTOR_KEY);

      const malformedGrantRejected = (malformedGrantTimeline.data || []).find((event) =>
        event.event_type === 'state.rejected'
        && event.object_id === malformedGrantGetRequestId
      );
      assert.ok(malformedGrantRejected, 'grant timeline should include state.rejected for malformed grant-scoped state reads');
      assert.equal(malformedGrantRejected.trace_id, malformedGrantGetTraceId);
      assert.equal(malformedGrantRejected.data.error?.code, 'grant_invalid');
      assert.match(malformedGrantRejected.data.error?.message || '', /Grant is malformed or no longer valid/);

      const malformedGrantPutResp = await fetchJson(
        `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}?grant_id=${encodeURIComponent(approved.grant.grant_id)}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ state: { top_artists: { cursor: 'malformed_grant_cursor' } } }),
        },
      );
      assert.equal(malformedGrantPutResp.status, 403);
      assert.equal(malformedGrantPutResp.body.error.code, 'grant_invalid');
      assert.match(malformedGrantPutResp.body.error.message, /Grant is malformed or no longer valid/);

      const grantStateRows = getDb().prepare(
        'SELECT grant_id, connector_id, stream, state_json FROM grant_connector_state WHERE grant_id = ?'
      ).all(approved.grant.grant_id);
      assert.equal(grantStateRows.length, 0, 'malformed grant-scoped state writes should not create grant_connector_state rows');
    });
  });

  await t.test('grant-scoped polyfill state stays limited to the grant stream set', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');

      const approved = await approveGrant(asUrl, 'u1', {
        client_id: 'concert_recommendation_app',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Maintain a concert-recommendation profile over time',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists' }],
      });

      // The grant-scoped state read canonicalizes the connector id at the
      // boundary, so it derives the default account connector_instance_id and
      // looks up grant_connector_state rows under the canonical key. Seed both
      // the connector_id column and the instance-id derivation with the
      // canonical key (Decision 1) so the read correlates.
      const grantConnectorInstanceId = makeDefaultAccountConnectorInstanceId('u1', SPOTIFY_CONNECTOR_KEY);
      const insertGrantState = getDb().prepare(`
        INSERT INTO grant_connector_state(grant_id, connector_id, connector_instance_id, stream, state_json, updated_at)
        VALUES(?, ?, ?, ?, ?, ?)
      `);
      insertGrantState.run(approved.grant.grant_id, SPOTIFY_CONNECTOR_KEY, grantConnectorInstanceId, 'top_artists', JSON.stringify({ cursor: 'granted_cursor' }), '2026-04-18T10:00:00.000Z');
      insertGrantState.run(approved.grant.grant_id, SPOTIFY_CONNECTOR_KEY, grantConnectorInstanceId, 'recently_played', JSON.stringify({ cursor: 'hidden_cursor' }), '2026-04-18T11:00:00.000Z');

      const getResp = await fetchJson(
        `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}?grant_id=${encodeURIComponent(approved.grant.grant_id)}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      assert.equal(getResp.status, 200);
      const getRequestId = getResp.headers['request-id'];
      const getTraceId = getResp.headers['pdpp-reference-trace-id'];
      assert.ok(getRequestId?.startsWith('req_'));
      assert.ok(getTraceId?.startsWith('trc_'));
      assert.deepEqual(getResp.body.state, { top_artists: { cursor: 'granted_cursor' } });
      assert.equal(getResp.body.updated_at, '2026-04-18T10:00:00.000Z');
      assert.ok(!('recently_played' in getResp.body.state), 'grant-scoped state reads should hide rows for streams outside the grant');

      const { body: grantTimelineAfterGet } = await fetchJson(
        `${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`,
      );
      const getRequested = (grantTimelineAfterGet.data || []).find((event) =>
        event.event_type === 'state.requested'
        && event.object_id === getRequestId
      );
      assert.ok(getRequested, 'grant timeline should include state.requested for grant-scoped state reads');
      assert.equal(getRequested.trace_id, getTraceId);
      assert.equal(getRequested.data.operation, 'read');
      assert.equal(getRequested.data.state_scope, 'grant');
      assert.equal(getRequested.data.source?.kind, 'connector');
      assert.equal(getRequested.data.source?.id, SPOTIFY_CONNECTOR_KEY);

      const servedEvent = (grantTimelineAfterGet.data || []).find((event) =>
        event.event_type === 'state.served'
        && event.object_id === getRequestId
      );
      assert.ok(servedEvent, 'grant timeline should include state.served for grant-scoped state reads');
      assert.equal(servedEvent.trace_id, getTraceId);
      assert.deepEqual(servedEvent.data.visible_streams, ['top_artists']);
      assert.equal(servedEvent.data.updated_at, '2026-04-18T10:00:00.000Z');

      const validPutResp = await fetchJson(
        `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}?grant_id=${encodeURIComponent(approved.grant.grant_id)}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ state: { top_artists: { cursor: 'updated_granted_cursor' } } }),
        },
      );
      assert.equal(validPutResp.status, 200);
      const validPutRequestId = validPutResp.headers['request-id'];
      const validPutTraceId = validPutResp.headers['pdpp-reference-trace-id'];
      assert.ok(validPutRequestId?.startsWith('req_'));
      assert.ok(validPutTraceId?.startsWith('trc_'));
      assert.deepEqual(validPutResp.body.state, { top_artists: { cursor: 'updated_granted_cursor' } });

      const { body: grantTimelineAfterValidPut } = await fetchJson(
        `${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`,
      );
      const updatedEvent = (grantTimelineAfterValidPut.data || []).find((event) =>
        event.event_type === 'state.updated'
        && event.object_id === validPutRequestId
      );
      assert.ok(updatedEvent, 'grant timeline should include state.updated for successful grant-scoped state writes');
      assert.equal(updatedEvent.trace_id, validPutTraceId);
      assert.deepEqual(updatedEvent.data.requested_streams, ['top_artists']);
      assert.deepEqual(updatedEvent.data.persisted_streams, ['top_artists']);

      const putResp = await fetchJson(
        `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}?grant_id=${encodeURIComponent(approved.grant.grant_id)}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ state: { recently_played: { cursor: 'outside_grant_cursor' } } }),
        },
      );
      assert.equal(putResp.status, 400);
      const rejectedPutRequestId = putResp.headers['request-id'];
      const rejectedPutTraceId = putResp.headers['pdpp-reference-trace-id'];
      assert.ok(rejectedPutRequestId?.startsWith('req_'));
      assert.ok(rejectedPutTraceId?.startsWith('trc_'));
      assert.equal(putResp.body.error.code, 'invalid_request');
      assert.match(
        putResp.body.error.message,
        new RegExp(`Grant '${approved.grant.grant_id}' is not scoped to stream recently_played`),
      );

      const { body: grantTimelineAfterRejectedPut } = await fetchJson(
        `${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`,
      );
      const rejectedEvent = (grantTimelineAfterRejectedPut.data || []).find((event) =>
        event.event_type === 'state.rejected'
        && event.object_id === rejectedPutRequestId
      );
      assert.ok(rejectedEvent, 'grant timeline should include state.rejected for rejected grant-scoped state writes');
      assert.equal(rejectedEvent.trace_id, rejectedPutTraceId);
      assert.deepEqual(rejectedEvent.data.requested_streams, ['recently_played']);
      assert.equal(rejectedEvent.data.error?.code, 'invalid_request');
      assert.match(rejectedEvent.data.error?.message || '', /is not scoped to stream recently_played/);

      const grantStateRows = getDb().prepare(`
        SELECT grant_id, connector_id, stream, state_json
        FROM grant_connector_state
        WHERE grant_id = ?
      `).all(approved.grant.grant_id);
      assert.equal(grantStateRows.length, 2, 'rejected writes should not create new grant-scoped state rows');
      assert.equal(
        JSON.parse(grantStateRows.find((row) => row.stream === 'top_artists').state_json).cursor,
        'updated_granted_cursor',
        'successful in-grant state writes should persist the updated granted stream cursor',
      );
      assert.equal(
        grantStateRows.filter((row) => row.stream === 'recently_played').length,
        1,
        'rejected writes should not mutate existing out-of-grant rows',
      );
    });
  });

  await t.test('grant-scoped polyfill state admits a URL-shaped connector path against a canonically-keyed grant binding', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');

      const approved = await approveGrant(asUrl, 'u1', {
        client_id: 'concert_recommendation_app',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Maintain a concert-recommendation profile over time',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists' }],
      });

      // Approval canonicalizes the grant storage binding to the connector key
      // (`spotify`), but the manifest connector_id — and therefore the path a
      // client constructs from it — is URL-shaped
      // (`https://registry.pdpp.org/connectors/spotify`). Before the
      // canonicalize-connector-keys fix (Decision 1), grant-scoped state
      // admission compared the raw URL-shaped path id against the canonical
      // storage binding and rejected the request with 400 "not scoped to
      // connector". This regression pins that both sides are canonicalized so
      // the URL-shaped path resolves against the canonical binding.
      assert.equal(spotifyManifest.connector_id, 'https://registry.pdpp.org/connectors/spotify');
      const urlShapedPath = `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}?grant_id=${encodeURIComponent(approved.grant.grant_id)}`;
      const canonicalPath = `${rsUrl}/v1/state/${encodeURIComponent(SPOTIFY_CONNECTOR_KEY)}?grant_id=${encodeURIComponent(approved.grant.grant_id)}`;

      const putResp = await fetchJson(urlShapedPath, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ state: { top_artists: { cursor: 'url_shaped_path_cursor' } } }),
      });
      assert.equal(putResp.status, 200, 'PUT against the URL-shaped path must be admitted, not rejected with 400');
      assert.notEqual(putResp.status, 400);
      assert.deepEqual(putResp.body.state, { top_artists: { cursor: 'url_shaped_path_cursor' } });

      const getResp = await fetchJson(urlShapedPath, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(getResp.status, 200, 'GET against the URL-shaped path must round-trip the state written via PUT');
      assert.deepEqual(getResp.body.state, { top_artists: { cursor: 'url_shaped_path_cursor' } });

      // The canonical path resolves to the same grant-scoped state, proving
      // both the URL-shaped and canonical connector ids canonicalize to the
      // same key the binding is stored under.
      const canonicalGetResp = await fetchJson(canonicalPath, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(canonicalGetResp.status, 200);
      assert.deepEqual(canonicalGetResp.body.state, { top_artists: { cursor: 'url_shaped_path_cursor' } });

      const grantStateRows = getDb().prepare(`
        SELECT connector_id, stream, state_json
        FROM grant_connector_state
        WHERE grant_id = ?
      `).all(approved.grant.grant_id);
      assert.equal(grantStateRows.length, 1, 'the URL-shaped PUT should persist exactly one grant-scoped state row');
      assert.equal(grantStateRows[0].connector_id, SPOTIFY_CONNECTOR_KEY, 'grant-scoped state should persist under the canonical connector key');
      assert.equal(grantStateRows[0].stream, 'top_artists');
    });
  });

  await t.test('grant-scoped polyfill state rejects grants missing a valid stream list as invalid grants', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');

      const approved = await approveGrant(asUrl, 'u1', {
        client_id: 'concert_recommendation_app',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Maintain a concert-recommendation profile over time',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists' }],
      });

      const malformedGrant = JSON.parse(JSON.stringify(approved.grant));
      delete malformedGrant.streams;

      getDb().prepare(`
        UPDATE grants
        SET grant_json = ?
        WHERE grant_id = ?
      `).run(JSON.stringify(malformedGrant), approved.grant.grant_id);

      const malformedGetResp = await fetchJson(
        `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}?grant_id=${encodeURIComponent(approved.grant.grant_id)}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      assert.equal(malformedGetResp.status, 403);
      assert.equal(malformedGetResp.body.error.code, 'grant_invalid');
      assert.match(malformedGetResp.body.error.message, /Grant is malformed or no longer valid/);

      const malformedPutResp = await fetchJson(
        `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}?grant_id=${encodeURIComponent(approved.grant.grant_id)}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ state: { top_artists: { cursor: 'malformed_grant_streams_cursor' } } }),
        },
      );
      assert.equal(malformedPutResp.status, 403);
      assert.equal(malformedPutResp.body.error.code, 'grant_invalid');
      assert.match(malformedPutResp.body.error.message, /Grant is malformed or no longer valid/);
    });
  });

  await t.test('grant-scoped polyfill state rejects persisted grants whose stream contract no longer resolves against the manifest', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');

      const approved = await approveGrant(asUrl, 'u1', {
        client_id: 'concert_recommendation_app',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Maintain a concert-recommendation profile over time',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists' }],
      });

      const malformedGrant = JSON.parse(JSON.stringify(approved.grant));
      malformedGrant.streams = [{ name: 'not_in_manifest' }];

      getDb().prepare(`
        UPDATE grants
        SET grant_json = ?
        WHERE grant_id = ?
      `).run(JSON.stringify(malformedGrant), approved.grant.grant_id);

      const malformedGetResp = await fetchJson(
        `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}?grant_id=${encodeURIComponent(approved.grant.grant_id)}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      assert.equal(malformedGetResp.status, 403);
      assert.equal(malformedGetResp.body.error.code, 'grant_invalid');
      assert.match(malformedGetResp.body.error.message, /Grant is malformed or no longer valid/);

      const malformedPutResp = await fetchJson(
        `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}?grant_id=${encodeURIComponent(approved.grant.grant_id)}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ state: { top_artists: { cursor: 'should_not_persist' } } }),
        },
      );
      assert.equal(malformedPutResp.status, 403);
      assert.equal(malformedPutResp.body.error.code, 'grant_invalid');
      assert.match(malformedPutResp.body.error.message, /Grant is malformed or no longer valid/);
    });
  });

  await t.test('grant-scoped polyfill state rejects single_use grants because the runtime keeps state null for them', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');

      const approved = await approveGrant(asUrl, 'u1', {
        client_id: 'concert_recommendation_app',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Generate a one-time concert recommendation snapshot',
        access_mode: 'single_use',
        streams: [{ name: 'top_artists' }],
      });

      const getResp = await fetchJson(
        `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}?grant_id=${encodeURIComponent(approved.grant.grant_id)}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      assert.equal(getResp.status, 400);
      assert.equal(getResp.body.error.code, 'invalid_request');
      assert.match(
        getResp.body.error.message,
        new RegExp(`Grant '${approved.grant.grant_id}' does not support grant-scoped state because access_mode is single_use`),
      );

      const putResp = await fetchJson(
        `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}?grant_id=${encodeURIComponent(approved.grant.grant_id)}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ state: { top_artists: { cursor: 'single_use_grant_cursor' } } }),
        },
      );
      assert.equal(putResp.status, 400);
      assert.equal(putResp.body.error.code, 'invalid_request');
      assert.match(
        putResp.body.error.message,
        new RegExp(`Grant '${approved.grant.grant_id}' does not support grant-scoped state because access_mode is single_use`),
      );

      const grantStateRows = getDb().prepare(`
        SELECT grant_id, connector_id, stream, state_json
        FROM grant_connector_state
        WHERE grant_id = ?
      `).all(approved.grant.grant_id);
      assert.equal(grantStateRows.length, 0, 'single_use grants should not create grant-scoped state rows');
    });
  });

  await t.test('polyfill owner delete routes reject unknown connectors and manifest-unknown streams instead of silently succeeding', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      const missingConnectorId = 'missing_spotify_connector';
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const beforeRecordsResp = await fetch(
        `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}&limit=20`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      assert.equal(beforeRecordsResp.status, 200);
      const beforeRecordsBody = await beforeRecordsResp.json();
      const beforeRecords = beforeRecordsBody.data || [];
      assert.ok(beforeRecords.length > 0, 'expected seeded top_artists records before exercising delete routes');
      const protectedRecordId = beforeRecords[0].id;

      const missingDeleteAllResp = await fetchJson(
        `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(missingConnectorId)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${ownerToken}` },
        },
      );
      assert.equal(missingDeleteAllResp.status, 404);
      assert.equal(missingDeleteAllResp.body.error.code, 'not_found');
      assert.match(missingDeleteAllResp.body.error.message, /Unknown connector: missing_spotify_connector/);
      const missingDeleteAllRequestId = missingDeleteAllResp.headers['request-id'];
      const missingDeleteAllTraceId = missingDeleteAllResp.headers['pdpp-reference-trace-id'];
      assert.ok(missingDeleteAllRequestId?.startsWith('req_'));
      assert.ok(missingDeleteAllTraceId?.startsWith('trc_mut_'));

      const { body: missingDeleteAllTrace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(missingDeleteAllTraceId)}`);
      const missingDeleteAllRequested = missingDeleteAllTrace.data.find((event) =>
        event.event_type === 'mutation.requested'
        && event.object_id === missingDeleteAllRequestId
      );
      assert.ok(missingDeleteAllRequested, 'owner trace should include mutation.requested for rejected unknown-connector delete-all requests');
      assert.equal(missingDeleteAllRequested.stream_id, 'top_artists');
      assert.equal(missingDeleteAllRequested.data.operation, 'delete_stream_records');

      const missingDeleteAllRejected = missingDeleteAllTrace.data.find((event) =>
        event.event_type === 'mutation.rejected'
        && event.object_id === missingDeleteAllRequestId
      );
      assert.ok(missingDeleteAllRejected, 'owner trace should include mutation.rejected for rejected unknown-connector delete-all requests');
      assert.equal(missingDeleteAllRejected.stream_id, 'top_artists');
      assert.equal(missingDeleteAllRejected.data.operation, 'delete_stream_records');
      assert.equal(missingDeleteAllRejected.data.error?.code, 'not_found');
      assert.match(missingDeleteAllRejected.data.error?.message || '', /Unknown connector: missing_spotify_connector/);

      const missingDeleteOneResp = await fetchJson(
        `${rsUrl}/v1/streams/top_artists/records/${encodeURIComponent(protectedRecordId)}?connector_id=${encodeURIComponent(missingConnectorId)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${ownerToken}` },
        },
      );
      assert.equal(missingDeleteOneResp.status, 404);
      assert.equal(missingDeleteOneResp.body.error.code, 'not_found');
      assert.match(missingDeleteOneResp.body.error.message, /Unknown connector: missing_spotify_connector/);

      const unknownStreamDeleteAllResp = await fetchJson(
        `${rsUrl}/v1/streams/not_a_stream/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${ownerToken}` },
        },
      );
      assert.equal(unknownStreamDeleteAllResp.status, 404);
      assert.equal(unknownStreamDeleteAllResp.body.error.code, 'not_found');
      assert.match(
        unknownStreamDeleteAllResp.body.error.message,
        new RegExp(`Stream 'not_a_stream' not found for connector ${SPOTIFY_CONNECTOR_KEY}`),
      );

      const unknownStreamDeleteOneResp = await fetchJson(
        `${rsUrl}/v1/streams/not_a_stream/records/${encodeURIComponent(protectedRecordId)}?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${ownerToken}` },
        },
      );
      assert.equal(unknownStreamDeleteOneResp.status, 404);
      assert.equal(unknownStreamDeleteOneResp.body.error.code, 'not_found');
      assert.match(
        unknownStreamDeleteOneResp.body.error.message,
        new RegExp(`Stream 'not_a_stream' not found for connector ${SPOTIFY_CONNECTOR_KEY}`),
      );

      const afterRecordsResp = await fetch(
        `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}&limit=20`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      assert.equal(afterRecordsResp.status, 200);
      const afterRecordsBody = await afterRecordsResp.json();
      const afterRecords = afterRecordsBody.data || [];
      assert.equal(afterRecords.length, beforeRecords.length, 'rejected delete routes should not remove valid records');
      assert.ok(
        afterRecords.some((record) => record.id === protectedRecordId),
        'rejected delete routes should leave the protected record intact',
      );
    });
  });

  await t.test('polyfill owner ingest and delete routes emit correlated mutation artifacts on success', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const ingestResp = await fetch(`${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          'Content-Type': 'application/x-ndjson',
        },
        body: `${JSON.stringify({
          key: 'artist_trace_success',
          data: { id: 'artist_trace_success', name: 'Trace Success', genres: ['ambient'] },
          emitted_at: new Date().toISOString(),
        })}\n${JSON.stringify({
          key: 'artist_trace_bad_json',
          data: { id: 'artist_trace_bad_json', name: 'Bad Json' },
          emitted_at: new Date().toISOString(),
        }).slice(0, -1)}`,
      });
      assert.equal(ingestResp.status, 200);
      const ingestRequestId = ingestResp.headers.get('Request-Id');
      const ingestTraceId = ingestResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(ingestRequestId?.startsWith('req_'));
      assert.ok(ingestTraceId?.startsWith('trc_mut_'));
      const ingestBody = await ingestResp.json();
      assert.equal(ingestBody.records_accepted, 1);
      assert.equal(ingestBody.records_rejected, 1);

      const { body: ingestTrace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(ingestTraceId)}`);
      const ingestRequested = ingestTrace.data.find((event) =>
        event.event_type === 'mutation.requested'
        && event.object_id === ingestRequestId
      );
      assert.ok(ingestRequested, 'owner trace should include mutation.requested for successful ingest requests');
      assert.equal(ingestRequested.stream_id, 'top_artists');
      assert.equal(ingestRequested.data.operation, 'ingest_records');
      assert.equal(ingestRequested.data.submitted_record_count, 2);
      assert.equal(ingestRequested.data.source?.kind, 'connector');
      assert.equal(ingestRequested.data.source?.id, SPOTIFY_CONNECTOR_KEY);

      const ingestCompleted = ingestTrace.data.find((event) =>
        event.event_type === 'mutation.completed'
        && event.object_id === ingestRequestId
      );
      assert.ok(ingestCompleted, 'owner trace should include mutation.completed for successful ingest requests');
      assert.equal(ingestCompleted.stream_id, 'top_artists');
      assert.equal(ingestCompleted.data.operation, 'ingest_records');
      assert.equal(ingestCompleted.data.records_accepted, 1);
      assert.equal(ingestCompleted.data.records_rejected, 1);
      assert.equal(ingestCompleted.data.error_count, 1);
      assert.equal(ingestCompleted.data.source?.kind, 'connector');
      assert.equal(ingestCompleted.data.source?.id, SPOTIFY_CONNECTOR_KEY);

      const deleteResp = await fetch(
        `${rsUrl}/v1/streams/top_artists/records/${encodeURIComponent('artist_trace_success')}?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${ownerToken}` },
        },
      );
      assert.equal(deleteResp.status, 204);
      const deleteRequestId = deleteResp.headers.get('Request-Id');
      const deleteTraceId = deleteResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(deleteRequestId?.startsWith('req_'));
      assert.ok(deleteTraceId?.startsWith('trc_mut_'));

      const { body: deleteTrace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(deleteTraceId)}`);
      const deleteRequested = deleteTrace.data.find((event) =>
        event.event_type === 'mutation.requested'
        && event.object_id === deleteRequestId
      );
      assert.ok(deleteRequested, 'owner trace should include mutation.requested for successful delete requests');
      assert.equal(deleteRequested.stream_id, 'top_artists');
      assert.equal(deleteRequested.data.operation, 'delete_record');
      assert.equal(deleteRequested.data.requested_record_id, 'artist_trace_success');
      assert.equal(deleteRequested.data.source?.kind, 'connector');
      assert.equal(deleteRequested.data.source?.id, SPOTIFY_CONNECTOR_KEY);

      const deleteCompleted = deleteTrace.data.find((event) =>
        event.event_type === 'mutation.completed'
        && event.object_id === deleteRequestId
      );
      assert.ok(deleteCompleted, 'owner trace should include mutation.completed for successful delete requests');
      assert.equal(deleteCompleted.stream_id, 'top_artists');
      assert.equal(deleteCompleted.data.operation, 'delete_record');
      assert.equal(deleteCompleted.data.requested_record_id, 'artist_trace_success');
      assert.equal(deleteCompleted.data.deleted_record_count, 1);
      assert.equal(deleteCompleted.data.source?.kind, 'connector');
      assert.equal(deleteCompleted.data.source?.id, SPOTIFY_CONNECTOR_KEY);
    });
  });

  await t.test('polyfill owner ingest rejects duplicate connector_id query params instead of normalizing them into mutation scope', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      const duplicateQuery = new URLSearchParams();
      duplicateQuery.append('connector_id', spotifyManifest.connector_id);
      duplicateQuery.append('connector_id', 'unexpected_second_value');

      const rejectedResp = await fetch(`${rsUrl}/v1/ingest/top_artists?${duplicateQuery.toString()}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          'Content-Type': 'application/x-ndjson',
        },
        body: `${JSON.stringify({
          key: 'artist_should_not_ingest',
          data: { id: 'artist_should_not_ingest', name: 'Should Not Ingest' },
          emitted_at: new Date().toISOString(),
        })}\n`,
      });
      assert.equal(rejectedResp.status, 400);
      const rejectedRequestId = rejectedResp.headers.get('Request-Id');
      const rejectedTraceId = rejectedResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(rejectedRequestId?.startsWith('req_'));
      assert.ok(rejectedTraceId?.startsWith('trc_mut_'));
      const rejectedBody = await rejectedResp.json();
      assert.equal(rejectedBody.error.code, 'invalid_request');
      assert.match(rejectedBody.error.message, /connector_id must be a single non-empty string/);

      const { body: trace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(rejectedTraceId)}`);
      const requestedEvent = trace.data.find((event) =>
        event.event_type === 'mutation.requested'
        && event.object_id === rejectedRequestId
      );
      assert.ok(requestedEvent, 'owner trace should include mutation.requested for duplicate connector_id ingest');
      assert.equal(requestedEvent.stream_id, 'top_artists');
      assert.equal(requestedEvent.data.operation, 'ingest_records');
      assert.equal(requestedEvent.data.source, null, 'duplicate connector_id should not be normalized into a connector-shaped mutation source');

      const rejectedEvent = trace.data.find((event) =>
        event.event_type === 'mutation.rejected'
        && event.object_id === rejectedRequestId
      );
      assert.ok(rejectedEvent, 'owner trace should include mutation.rejected for duplicate connector_id ingest');
      assert.equal(rejectedEvent.stream_id, 'top_artists');
      assert.equal(rejectedEvent.data.operation, 'ingest_records');
      assert.equal(rejectedEvent.data.source, null, 'duplicate connector_id should not be normalized into a connector-shaped mutation rejection source');
      assert.equal(rejectedEvent.data.error?.code, 'invalid_request');
      assert.match(rejectedEvent.data.error?.message || '', /connector_id must be a single non-empty string/);
    });
  });

  await t.test('polyfill owner ingest rejects malformed persisted connector manifests instead of drifting into generic failures', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      getDb().prepare(`
        UPDATE connectors
        SET manifest = ?
        WHERE connector_id = ?
      `).run('{"connector_id":"https://registry.pdpp.org/connectors/spotify","streams":[{"name":"top_artists","primary_key":["missing_id"]}]}', SPOTIFY_CONNECTOR_KEY);

      const rejectedResp = await fetchJson(
        `${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            'Content-Type': 'application/x-ndjson',
          },
          body: JSON.stringify({
            key: 'artist_malformed_manifest_ingest',
            data: { id: 'artist_malformed_manifest_ingest', name: 'Should Not Ingest' },
            emitted_at: new Date().toISOString(),
          }),
        },
      );
      assert.equal(rejectedResp.status, 400);
      assert.equal(rejectedResp.body.error.code, 'connector_invalid');
      assert.match(
        rejectedResp.body.error.message,
        new RegExp(`Connector manifest for ${SPOTIFY_CONNECTOR_KEY} is malformed or no longer valid`),
      );
      const rejectedRequestId = rejectedResp.headers['request-id'];
      const rejectedTraceId = rejectedResp.headers['pdpp-reference-trace-id'];
      assert.ok(rejectedRequestId?.startsWith('req_'));
      assert.ok(rejectedTraceId?.startsWith('trc_mut_'));

      const { body: rejectedTrace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(rejectedTraceId)}`);
      const mutationRequested = rejectedTrace.data.find((event) =>
        event.event_type === 'mutation.requested'
        && event.object_id === rejectedRequestId
      );
      assert.ok(mutationRequested, 'owner trace should include mutation.requested for malformed-manifest ingest requests');
      assert.equal(mutationRequested.stream_id, 'top_artists');
      assert.equal(mutationRequested.data.operation, 'ingest_records');
      assert.equal(mutationRequested.data.submitted_record_count, 1);

      const mutationRejected = rejectedTrace.data.find((event) =>
        event.event_type === 'mutation.rejected'
        && event.object_id === rejectedRequestId
      );
      assert.ok(mutationRejected, 'owner trace should include mutation.rejected for malformed-manifest ingest requests');
      assert.equal(mutationRejected.stream_id, 'top_artists');
      assert.equal(mutationRejected.data.operation, 'ingest_records');
      assert.equal(mutationRejected.data.error?.code, 'connector_invalid');
      assert.match(mutationRejected.data.error?.message || '', /Connector manifest .* is malformed or no longer valid/);

      const ownerRecordsResp = await fetchJson(
        `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}&limit=100`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      assert.equal(ownerRecordsResp.status, 400);
      assert.equal(ownerRecordsResp.body.error.code, 'connector_invalid');
    });
  });

  await t.test('polyfill owner delete routes reject malformed persisted connector manifests instead of drifting into generic failures', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const beforeRecordsResp = await fetch(
        `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}&limit=20`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      assert.equal(beforeRecordsResp.status, 200);
      const beforeRecordsBody = await beforeRecordsResp.json();
      const beforeRecords = beforeRecordsBody.data || [];
      assert.ok(beforeRecords.length > 0, 'expected seeded top_artists records before exercising malformed-manifest delete routes');
      const protectedRecordId = beforeRecords[0].id;

      getDb().prepare(`
        UPDATE connectors
        SET manifest = ?
        WHERE connector_id = ?
      `).run('{"connector_id":"https://registry.pdpp.org/connectors/spotify","streams":[{"name":"top_artists","primary_key":["missing_id"]}]}', SPOTIFY_CONNECTOR_KEY);

      const deleteAllResp = await fetchJson(
        `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${ownerToken}` },
        },
      );
      assert.equal(deleteAllResp.status, 400);
      assert.equal(deleteAllResp.body.error.code, 'connector_invalid');
      assert.match(
        deleteAllResp.body.error.message,
        new RegExp(`Connector manifest for ${SPOTIFY_CONNECTOR_KEY} is malformed or no longer valid`),
      );
      const deleteAllRequestId = deleteAllResp.headers['request-id'];
      const deleteAllTraceId = deleteAllResp.headers['pdpp-reference-trace-id'];
      assert.ok(deleteAllRequestId?.startsWith('req_'));
      assert.ok(deleteAllTraceId?.startsWith('trc_mut_'));

      const { body: deleteAllTrace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(deleteAllTraceId)}`);
      const deleteAllRequested = deleteAllTrace.data.find((event) =>
        event.event_type === 'mutation.requested'
        && event.object_id === deleteAllRequestId
      );
      assert.ok(deleteAllRequested, 'owner trace should include mutation.requested for malformed-manifest delete-all requests');
      assert.equal(deleteAllRequested.data.operation, 'delete_stream_records');

      const deleteAllRejected = deleteAllTrace.data.find((event) =>
        event.event_type === 'mutation.rejected'
        && event.object_id === deleteAllRequestId
      );
      assert.ok(deleteAllRejected, 'owner trace should include mutation.rejected for malformed-manifest delete-all requests');
      assert.equal(deleteAllRejected.data.operation, 'delete_stream_records');
      assert.equal(deleteAllRejected.data.error?.code, 'connector_invalid');

      const deleteOneResp = await fetchJson(
        `${rsUrl}/v1/streams/top_artists/records/${encodeURIComponent(protectedRecordId)}?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${ownerToken}` },
        },
      );
      assert.equal(deleteOneResp.status, 400);
      assert.equal(deleteOneResp.body.error.code, 'connector_invalid');
      assert.match(
        deleteOneResp.body.error.message,
        new RegExp(`Connector manifest for ${SPOTIFY_CONNECTOR_KEY} is malformed or no longer valid`),
      );

      const afterRecordsResp = await fetchJson(
        `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}&limit=20`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      assert.equal(afterRecordsResp.status, 400);
      assert.equal(afterRecordsResp.body.error.code, 'connector_invalid');
    });
  });

  await t.test('client stream lists respect grant resource restrictions when reporting counts and last_updated', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const approved = await approveGrant(asUrl, 'u1', {
        client_id: 'concert_recommendation_app',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Recommend concerts based on a chosen artist subset',
        access_mode: 'single_use',
        streams: [{
          name: 'top_artists',
          resources: [
            'spotify:artist:0C0XlULifJtAgn6ZNCW2eu',
            'spotify:artist:1Xyo4u8uXC1ZmMpatF05PJ',
          ],
        }],
      });

      const ownerRecordsResp = await fetch(
        `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}&limit=20`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      assert.equal(ownerRecordsResp.status, 200);
      const ownerRecordsBody = await ownerRecordsResp.json();
      const ownerRecords = ownerRecordsBody.data || [];

      const streamsResp = await fetch(`${rsUrl}/v1/streams`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(streamsResp.status, 200);
      const streamsBody = await streamsResp.json();
      const topArtistsSummary = (streamsBody.data || []).find((stream) => stream.name === 'top_artists');
      assert.ok(topArtistsSummary, 'expected top_artists in the granted stream list');

      const clientRecordsResp = await fetch(`${rsUrl}/v1/streams/top_artists/records?limit=20`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(clientRecordsResp.status, 200);
      const clientRecordsBody = await clientRecordsResp.json();
      const clientRecords = clientRecordsBody.data || [];

      assert.equal(clientRecords.length, 2);
      assert.ok(ownerRecords.length > clientRecords.length, 'resource-restricted grant should expose fewer records than owner access');
      assert.equal(topArtistsSummary.record_count, clientRecords.length);
      assert.deepEqual(
        clientRecords.map((record) => record.id).sort(),
        [
          'spotify:artist:0C0XlULifJtAgn6ZNCW2eu',
          'spotify:artist:1Xyo4u8uXC1ZmMpatF05PJ',
        ].sort(),
      );

      const expectedLastUpdated = clientRecords
        .map((record) => record.emitted_at)
        .sort()
        .at(-1) || null;
      assert.equal(topArtistsSummary.last_updated, expectedLastUpdated);
    });
  });

  await t.test('client stream lists respect grant time_range restrictions when reporting counts and last_updated', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const since = new Date(Date.now() - (4 * 24 * 60 * 60 * 1000)).toISOString();
      const approved = await approveGrant(asUrl, 'u1', {
        client_id: 'concert_recommendation_app',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Recommend concerts from recent listening only',
        access_mode: 'single_use',
        streams: [{
          name: 'top_artists',
          time_range: { since },
        }],
      });

      const ownerRecordsResp = await fetch(
        `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}&limit=20`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      assert.equal(ownerRecordsResp.status, 200);
      const ownerRecordsBody = await ownerRecordsResp.json();
      const ownerRecords = ownerRecordsBody.data || [];

      const streamsResp = await fetch(`${rsUrl}/v1/streams`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(streamsResp.status, 200);
      const streamsBody = await streamsResp.json();
      const topArtistsSummary = (streamsBody.data || []).find((stream) => stream.name === 'top_artists');
      assert.ok(topArtistsSummary, 'expected top_artists in the granted stream list');

      const clientRecordsResp = await fetch(`${rsUrl}/v1/streams/top_artists/records?limit=20`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(clientRecordsResp.status, 200);
      const clientRecordsBody = await clientRecordsResp.json();
      const clientRecords = clientRecordsBody.data || [];

      assert.ok(clientRecords.length > 0, 'time-range-restricted grant should still expose recent records');
      assert.ok(ownerRecords.length > clientRecords.length, 'time-range-restricted grant should expose fewer records than owner access');
      assert.equal(topArtistsSummary.record_count, clientRecords.length);

      const expectedLastUpdated = clientRecords
        .map((record) => record.emitted_at)
        .sort()
        .at(-1) || null;
      assert.equal(topArtistsSummary.last_updated, expectedLastUpdated);
    });
  });

  await t.test('client stream metadata rejects streams outside the grant and preserves the rejection in the timeline', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const approved = await approveGrant(asUrl, 'u1', {
        client_id: 'concert_recommendation_app',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Recommend concerts using top artists only',
        access_mode: 'single_use',
        streams: [{ name: 'top_artists', view: 'basic' }],
      });

      const rejectedResp = await fetch(`${rsUrl}/v1/streams/recently_played`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(rejectedResp.status, 403);
      const rejectedRequestId = rejectedResp.headers.get('Request-Id');
      const rejectedTraceId = rejectedResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(rejectedRequestId?.startsWith('req_'));
      assert.ok(rejectedTraceId, 'rejected client metadata reads should carry a reference trace id');
      const rejectedBody = await rejectedResp.json();
      assert.equal(rejectedBody.error.code, 'grant_stream_not_allowed');
      assert.match(rejectedBody.error.message, /Stream 'recently_played' not in grant/);

      const { body: timeline } = await fetchJson(`${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`);
      const queryReceivedEvent = timeline.data.find((event) =>
        event.event_type === 'query.received'
        && event.object_id === rejectedRequestId
      );
      assert.ok(queryReceivedEvent, 'grant timeline should include query.received for rejected stream metadata reads');
      assert.equal(queryReceivedEvent.trace_id, rejectedTraceId);
      assert.equal(queryReceivedEvent.stream_id, 'recently_played');
      assert.equal(queryReceivedEvent.data.query_shape, 'stream_metadata');
      assert.equal(queryReceivedEvent.data.source?.kind, 'connector');
      assert.equal(queryReceivedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);

      const rejectedEvent = timeline.data.find((event) =>
        event.event_type === 'query.rejected'
        && event.object_id === rejectedRequestId
      );
      assert.ok(rejectedEvent, 'grant timeline should include query.rejected for rejected stream metadata reads');
      assert.equal(rejectedEvent.trace_id, rejectedTraceId);
      assert.equal(rejectedEvent.stream_id, 'recently_played');
      assert.equal(rejectedEvent.data.query_shape, 'stream_metadata');
      assert.equal(rejectedEvent.data.source?.kind, 'connector');
      assert.equal(rejectedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
      assert.equal(rejectedEvent.data.error?.code, 'grant_stream_not_allowed');
      assert.match(rejectedEvent.data.error?.message || '', /Stream 'recently_played' not in grant/);

      const servedEvent = timeline.data.find((event) =>
        event.event_type === 'disclosure.served'
        && event.object_id === rejectedRequestId
      );
      assert.equal(servedEvent, undefined, 'rejected stream metadata reads should not produce disclosure.served');
    });
  });

  await t.test('client record-list rejects streams outside the grant and preserves the rejection in the timeline', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const approved = await approveGrant(asUrl, 'u1', {
        client_id: 'concert_recommendation_app',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Recommend concerts using top artists only',
        access_mode: 'single_use',
        streams: [{ name: 'top_artists', view: 'basic' }],
      });

      const rejectedResp = await fetch(`${rsUrl}/v1/streams/recently_played/records?limit=1`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(rejectedResp.status, 403);
      const rejectedRequestId = rejectedResp.headers.get('Request-Id');
      const rejectedTraceId = rejectedResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(rejectedRequestId?.startsWith('req_'));
      assert.ok(rejectedTraceId, 'rejected client record-list reads should carry a reference trace id');
      const rejectedBody = await rejectedResp.json();
      assert.equal(rejectedBody.error.code, 'grant_stream_not_allowed');
      assert.match(rejectedBody.error.message, /Stream 'recently_played' not in grant/);

      const { body: timeline } = await fetchJson(`${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`);
      const queryReceivedEvent = timeline.data.find((event) =>
        event.event_type === 'query.received'
        && event.object_id === rejectedRequestId
      );
      assert.ok(queryReceivedEvent, 'grant timeline should include query.received for rejected record-list reads');
      assert.equal(queryReceivedEvent.trace_id, rejectedTraceId);
      assert.equal(queryReceivedEvent.stream_id, 'recently_played');
      assert.equal(queryReceivedEvent.data.query_shape, 'record_list');
      assert.equal(queryReceivedEvent.data.source?.kind, 'connector');
      assert.equal(queryReceivedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);

      const rejectedEvent = timeline.data.find((event) =>
        event.event_type === 'query.rejected'
        && event.object_id === rejectedRequestId
      );
      assert.ok(rejectedEvent, 'grant timeline should include query.rejected for rejected record-list reads');
      assert.equal(rejectedEvent.trace_id, rejectedTraceId);
      assert.equal(rejectedEvent.stream_id, 'recently_played');
      assert.equal(rejectedEvent.data.query_shape, 'record_list');
      assert.equal(rejectedEvent.data.error?.code, 'grant_stream_not_allowed');
      assert.match(rejectedEvent.data.error?.message || '', /Stream 'recently_played' not in grant/);

      const servedEvent = timeline.data.find((event) =>
        event.event_type === 'disclosure.served'
        && event.object_id === rejectedRequestId
      );
      assert.equal(servedEvent, undefined, 'rejected record-list reads should not produce disclosure.served');
    });
  });

  await t.test('client record-detail rejects streams outside the grant and preserves the rejection in the timeline', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const ownerListResp = await fetchJson(
        `${rsUrl}/v1/streams/saved_tracks/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}&limit=1`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      const hiddenRecord = ownerListResp.body.data?.[0];
      assert.ok(hiddenRecord, 'expected an owner-visible saved_tracks record outside the client grant');

      const approved = await approveGrant(asUrl, 'u1', {
        client_id: 'concert_recommendation_app',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Recommend concerts using top artists only',
        access_mode: 'single_use',
        streams: [{ name: 'top_artists', view: 'basic' }],
      });

      const rejectedResp = await fetch(`${rsUrl}/v1/streams/saved_tracks/records/${encodeURIComponent(hiddenRecord.id)}`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(rejectedResp.status, 403);
      const rejectedRequestId = rejectedResp.headers.get('Request-Id');
      const rejectedTraceId = rejectedResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(rejectedRequestId?.startsWith('req_'));
      assert.ok(rejectedTraceId, 'rejected client record-detail reads should carry a reference trace id');
      const rejectedBody = await rejectedResp.json();
      assert.equal(rejectedBody.error.code, 'grant_stream_not_allowed');
      assert.match(rejectedBody.error.message, /Stream 'saved_tracks' not in grant/);

      const { body: timeline } = await fetchJson(`${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`);
      const queryReceivedEvent = timeline.data.find((event) =>
        event.event_type === 'query.received'
        && event.object_id === rejectedRequestId
      );
      assert.ok(queryReceivedEvent, 'grant timeline should include query.received for rejected record-detail reads');
      assert.equal(queryReceivedEvent.trace_id, rejectedTraceId);
      assert.equal(queryReceivedEvent.stream_id, 'saved_tracks');
      assert.equal(queryReceivedEvent.data.query_shape, 'record_detail');
      assert.equal(queryReceivedEvent.data.source?.kind, 'connector');
      assert.equal(queryReceivedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);

      const rejectedEvent = timeline.data.find((event) =>
        event.event_type === 'query.rejected'
        && event.object_id === rejectedRequestId
      );
      assert.ok(rejectedEvent, 'grant timeline should include query.rejected for rejected record-detail reads');
      assert.equal(rejectedEvent.trace_id, rejectedTraceId);
      assert.equal(rejectedEvent.stream_id, 'saved_tracks');
      assert.equal(rejectedEvent.data.query_shape, 'record_detail');
      assert.equal(rejectedEvent.data.error?.code, 'grant_stream_not_allowed');
      assert.match(rejectedEvent.data.error?.message || '', /Stream 'saved_tracks' not in grant/);

      const servedEvent = timeline.data.find((event) =>
        event.event_type === 'disclosure.served'
        && event.object_id === rejectedRequestId
      );
      assert.equal(servedEvent, undefined, 'rejected record-detail reads should not produce disclosure.served');
    });
  });

  await t.test('client record detail hides records outside grant resources and preserves the rejection in the timeline', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const approved = await approveGrant(asUrl, 'u1', {
        client_id: 'concert_recommendation_app',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Recommend concerts using a chosen artist subset',
        access_mode: 'single_use',
        streams: [{
          name: 'top_artists',
          resources: [
            'spotify:artist:0C0XlULifJtAgn6ZNCW2eu',
            'spotify:artist:1Xyo4u8uXC1ZmMpatF05PJ',
          ],
        }],
      });

      const rejectedId = 'spotify:artist:6eUKZXaKkcviH0Ku9w2n3V';
      const rejectedResp = await fetch(`${rsUrl}/v1/streams/top_artists/records/${encodeURIComponent(rejectedId)}`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(rejectedResp.status, 404);
      const rejectedRequestId = rejectedResp.headers.get('Request-Id');
      const rejectedTraceId = rejectedResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(rejectedRequestId?.startsWith('req_'));
      assert.ok(rejectedTraceId, 'rejected client record-detail reads should carry a reference trace id');
      const rejectedBody = await rejectedResp.json();
      assert.equal(rejectedBody.error.code, 'not_found');
      assert.match(rejectedBody.error.message, /Record not found/);

      const { body: timeline } = await fetchJson(`${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`);
      const queryReceivedEvent = timeline.data.find((event) =>
        event.event_type === 'query.received'
        && event.object_id === rejectedRequestId
      );
      assert.ok(queryReceivedEvent, 'grant timeline should include query.received for rejected record-detail reads');
      assert.equal(queryReceivedEvent.trace_id, rejectedTraceId);
      assert.equal(queryReceivedEvent.stream_id, 'top_artists');
      assert.equal(queryReceivedEvent.data.query_shape, 'record_detail');
      assert.equal(queryReceivedEvent.data.requested_record_id, rejectedId);
      assert.equal(queryReceivedEvent.data.source?.kind, 'connector');
      assert.equal(queryReceivedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);

      const rejectedEvent = timeline.data.find((event) =>
        event.event_type === 'query.rejected'
        && event.object_id === rejectedRequestId
      );
      assert.ok(rejectedEvent, 'grant timeline should include query.rejected for rejected record-detail reads');
      assert.equal(rejectedEvent.trace_id, rejectedTraceId);
      assert.equal(rejectedEvent.stream_id, 'top_artists');
      assert.equal(rejectedEvent.data.query_shape, 'record_detail');
      assert.equal(rejectedEvent.data.requested_record_id, rejectedId);
      assert.equal(rejectedEvent.data.source?.kind, 'connector');
      assert.equal(rejectedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
      assert.equal(rejectedEvent.data.error?.code, 'not_found');
      assert.match(rejectedEvent.data.error?.message || '', /Record not found/);

      const servedEvent = timeline.data.find((event) =>
        event.event_type === 'disclosure.served'
        && event.object_id === rejectedRequestId
      );
      assert.equal(servedEvent, undefined, 'rejected record-detail reads should not produce disclosure.served');
    });
  });

  await t.test('client record detail hides records outside grant time_range and preserves the rejection in the timeline', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const since = new Date(Date.now() - (4 * 24 * 60 * 60 * 1000)).toISOString();
      const approved = await approveGrant(asUrl, 'u1', {
        client_id: 'concert_recommendation_app',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Recommend concerts from recent listening only',
        access_mode: 'single_use',
        streams: [{
          name: 'top_artists',
          time_range: { since },
        }],
      });

      const ownerRecordsResp = await fetch(
        `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}&limit=20`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      assert.equal(ownerRecordsResp.status, 200);
      const ownerRecordsBody = await ownerRecordsResp.json();
      const ownerRecords = ownerRecordsBody.data || [];

      const clientRecordsResp = await fetch(`${rsUrl}/v1/streams/top_artists/records?limit=20`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(clientRecordsResp.status, 200);
      const clientRecordsBody = await clientRecordsResp.json();
      const clientRecords = clientRecordsBody.data || [];

      const visibleIds = new Set(clientRecords.map((record) => record.id));
      const hiddenRecord = ownerRecords.find((record) => !visibleIds.has(record.id));
      assert.ok(hiddenRecord, 'expected at least one owner-visible record outside the grant time_range');

      const rejectedResp = await fetch(`${rsUrl}/v1/streams/top_artists/records/${encodeURIComponent(hiddenRecord.id)}`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(rejectedResp.status, 404);
      const rejectedRequestId = rejectedResp.headers.get('Request-Id');
      const rejectedTraceId = rejectedResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(rejectedRequestId?.startsWith('req_'));
      assert.ok(rejectedTraceId, 'rejected client time-range record-detail reads should carry a reference trace id');
      const rejectedBody = await rejectedResp.json();
      assert.equal(rejectedBody.error.code, 'not_found');
      assert.match(rejectedBody.error.message, /Record not found/);

      const { body: timeline } = await fetchJson(`${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`);
      const queryReceivedEvent = timeline.data.find((event) =>
        event.event_type === 'query.received'
        && event.object_id === rejectedRequestId
      );
      assert.ok(queryReceivedEvent, 'grant timeline should include query.received for rejected time-range record-detail reads');
      assert.equal(queryReceivedEvent.trace_id, rejectedTraceId);
      assert.equal(queryReceivedEvent.stream_id, 'top_artists');
      assert.equal(queryReceivedEvent.data.query_shape, 'record_detail');
      assert.equal(queryReceivedEvent.data.requested_record_id, hiddenRecord.id);
      assert.equal(queryReceivedEvent.data.source?.kind, 'connector');
      assert.equal(queryReceivedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);

      const rejectedEvent = timeline.data.find((event) =>
        event.event_type === 'query.rejected'
        && event.object_id === rejectedRequestId
      );
      assert.ok(rejectedEvent, 'grant timeline should include query.rejected for rejected time-range record-detail reads');
      assert.equal(rejectedEvent.trace_id, rejectedTraceId);
      assert.equal(rejectedEvent.stream_id, 'top_artists');
      assert.equal(rejectedEvent.data.query_shape, 'record_detail');
      assert.equal(rejectedEvent.data.requested_record_id, hiddenRecord.id);
      assert.equal(rejectedEvent.data.source?.kind, 'connector');
      assert.equal(rejectedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
      assert.equal(rejectedEvent.data.error?.code, 'not_found');
      assert.match(rejectedEvent.data.error?.message || '', /Record not found/);

      const servedEvent = timeline.data.find((event) =>
        event.event_type === 'disclosure.served'
        && event.object_id === rejectedRequestId
      );
      assert.equal(servedEvent, undefined, 'rejected time-range record-detail reads should not produce disclosure.served');
    });
  });

  await t.test('resource-limited client pagination reports has_more only for additional visible records', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const ownerRecordsResp = await fetch(
        `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}&limit=20`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      assert.equal(ownerRecordsResp.status, 200);
      const ownerRecordsBody = await ownerRecordsResp.json();
      const ownerRecords = ownerRecordsBody.data || [];
      const mostRecentVisible = ownerRecords[0];
      assert.ok(mostRecentVisible, 'expected at least one owner-visible record to scope the grant');

      const approved = await approveGrant(asUrl, 'u1', {
        client_id: 'concert_recommendation_app',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Recommend concerts using only the latest permitted artist',
        access_mode: 'single_use',
        streams: [{
          name: 'top_artists',
          resources: [mostRecentVisible.id],
        }],
      });

      const resp = await fetch(`${rsUrl}/v1/streams/top_artists/records?limit=1`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(resp.status, 200);
      const requestId = resp.headers.get('Request-Id');
      const traceId = resp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(requestId?.startsWith('req_'));
      assert.ok(traceId?.startsWith('trc_'));

      const body = await resp.json();
      assert.equal(body.object, 'list');
      assert.equal(body.has_more, false, 'hidden records should not make has_more appear true');
      assert.ok(!body.next_cursor, 'no pagination cursor should be exposed when no additional visible records exist');
      assert.equal(body.data?.length, 1);
      assert.equal(body.data?.[0]?.id, mostRecentVisible.id);

      const { body: timeline } = await fetchJson(`${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`);
      const queryReceivedEvent = timeline.data.find((event) =>
        event.event_type === 'query.received'
        && event.object_id === requestId
      );
      assert.ok(queryReceivedEvent, 'grant timeline should include query.received for the restricted paginated read');
      assert.equal(queryReceivedEvent.trace_id, traceId);
      assert.equal(queryReceivedEvent.stream_id, 'top_artists');
      assert.equal(queryReceivedEvent.data.query_shape, 'record_list');
      assert.equal(queryReceivedEvent.data.source?.kind, 'connector');
      assert.equal(queryReceivedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);

      const servedEvent = timeline.data.find((event) =>
        event.event_type === 'disclosure.served'
        && event.object_id === requestId
      );
      assert.ok(servedEvent, 'grant timeline should include disclosure.served for the restricted paginated read');
      assert.equal(servedEvent.trace_id, traceId);
      assert.equal(servedEvent.stream_id, 'top_artists');
      assert.equal(servedEvent.data.query_shape, 'record_list');
      assert.equal(servedEvent.data.record_count, 1);
      assert.equal(servedEvent.data.has_more, false);
      assert.equal(servedEvent.data.source?.kind, 'connector');
      assert.equal(servedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
    });
  });

  await t.test('client stream metadata remains source-level even when the grant narrows fields', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const approved = await approveGrant(asUrl, 'u1', {
        client_id: 'concert_recommendation_app',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Recommend concerts using the basic top-artist subset',
        access_mode: 'single_use',
        streams: [{
          name: 'top_artists',
          fields: ['id', 'name', 'genres'],
        }],
      });

      const metadataResp = await fetch(`${rsUrl}/v1/streams/top_artists`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(metadataResp.status, 200);
      const metadataBody = await metadataResp.json();
      assert.equal(metadataBody.object, 'stream_metadata');
      const metadataFields = Object.keys(metadataBody.schema.properties || {}).sort();
      assert.ok(metadataFields.includes('id'));
      assert.ok(metadataFields.includes('name'));
      assert.ok(metadataFields.includes('genres'));
      assert.ok(metadataFields.includes('popularity'));
      assert.ok(metadataFields.includes('followers'));
      assert.ok(metadataFields.includes('image_url'));
      assert.ok(metadataFields.includes('source_updated_at'));
      assert.deepEqual((metadataBody.schema.required || []).sort(), ['id', 'name']);
      assert.deepEqual((metadataBody.views || []).map((view) => view.id).sort(), ['basic', 'full']);
      assert.ok('popularity' in (metadataBody.schema.properties || {}));
      assert.ok((metadataBody.views || []).some((view) => view.id === 'full'));
    });
  });

  await t.test('field-limited client grants project record-list and record-detail disclosures to the granted field subset', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const approved = await approveGrant(asUrl, 'u1', {
        client_id: 'concert_recommendation_app',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Recommend concerts using the basic top-artist subset',
        access_mode: 'single_use',
        streams: [{
          name: 'top_artists',
          fields: ['id', 'name', 'genres'],
        }],
      });

      const listResp = await fetch(`${rsUrl}/v1/streams/top_artists/records?limit=1`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(listResp.status, 200);
      const listBody = await listResp.json();
      const firstRecord = listBody.data?.[0];
      assert.ok(firstRecord, 'expected at least one granted record');
      assert.deepEqual(Object.keys(firstRecord.data || {}).sort(), ['genres', 'id', 'name']);
      assert.ok(!('popularity' in (firstRecord.data || {})));
      assert.ok(!('followers' in (firstRecord.data || {})));
      assert.ok(!('image_url' in (firstRecord.data || {})));
      assert.ok(!('source_updated_at' in (firstRecord.data || {})));

      const detailResp = await fetch(`${rsUrl}/v1/streams/top_artists/records/${encodeURIComponent(firstRecord.id)}`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(detailResp.status, 200);
      const detailBody = await detailResp.json();
      assert.equal(detailBody.object, 'record');
      assert.deepEqual(Object.keys(detailBody.data || {}).sort(), ['genres', 'id', 'name']);
      assert.ok(!('popularity' in (detailBody.data || {})));
      assert.ok(!('followers' in (detailBody.data || {})));
      assert.ok(!('image_url' in (detailBody.data || {})));
      assert.ok(!('source_updated_at' in (detailBody.data || {})));
    });
  });

  await t.test('field-limited client grants reject filter fields outside the grant and preserve the rejection in the timeline', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const approved = await approveGrant(asUrl, 'u1', {
        client_id: 'concert_recommendation_app',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Recommend concerts using the basic top-artist subset',
        access_mode: 'single_use',
        streams: [{
          name: 'top_artists',
          fields: ['id', 'name', 'genres'],
        }],
      });

      const rejectedResp = await fetch(`${rsUrl}/v1/streams/top_artists/records?filter[popularity]=96`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(rejectedResp.status, 403);
      const rejectedRequestId = rejectedResp.headers.get('Request-Id');
      const rejectedTraceId = rejectedResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(rejectedRequestId?.startsWith('req_'));
      assert.ok(rejectedTraceId?.startsWith('trc_'));
      const rejectedBody = await rejectedResp.json();
      assert.equal(rejectedBody.error.code, 'field_not_granted');
      assert.match(rejectedBody.error.message, /Filter on field 'popularity' not in grant/);

      const { body: timeline } = await fetchJson(`${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`);
      const queryReceivedEvent = timeline.data.find((event) =>
        event.event_type === 'query.received'
        && event.object_id === rejectedRequestId
      );
      assert.ok(queryReceivedEvent, 'grant timeline should include query.received for rejected filter-based record-list reads');
      assert.equal(queryReceivedEvent.trace_id, rejectedTraceId);
      assert.equal(queryReceivedEvent.stream_id, 'top_artists');
      assert.equal(queryReceivedEvent.data.query_shape, 'record_list');
      assert.equal(queryReceivedEvent.data.source?.kind, 'connector');
      assert.equal(queryReceivedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);

      const rejectedEvent = timeline.data.find((event) =>
        event.event_type === 'query.rejected'
        && event.object_id === rejectedRequestId
      );
      assert.ok(rejectedEvent, 'grant timeline should include query.rejected for rejected filter-based record-list reads');
      assert.equal(rejectedEvent.trace_id, rejectedTraceId);
      assert.equal(rejectedEvent.stream_id, 'top_artists');
      assert.equal(rejectedEvent.data.query_shape, 'record_list');
      assert.equal(rejectedEvent.data.source?.kind, 'connector');
      assert.equal(rejectedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
      assert.equal(rejectedEvent.data.error?.code, 'field_not_granted');
      assert.match(rejectedEvent.data.error?.message || '', /Filter on field 'popularity' not in grant/);

      const servedEvent = timeline.data.find((event) =>
        event.event_type === 'disclosure.served'
        && event.object_id === rejectedRequestId
      );
      assert.equal(servedEvent, undefined, 'rejected filter-based record-list reads should not produce disclosure.served');
    });
  });

  await t.test('field-limited client grants reject manifest views that expand beyond granted fields and preserve the rejection in the timeline', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const approved = await approveGrant(asUrl, 'u1', {
        client_id: 'concert_recommendation_app',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Recommend concerts using the basic top-artist subset',
        access_mode: 'single_use',
        streams: [{
          name: 'top_artists',
          fields: ['id', 'name', 'genres'],
        }],
      });

      const rejectedResp = await fetch(`${rsUrl}/v1/streams/top_artists/records?view=full`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(rejectedResp.status, 403);
      const rejectedRequestId = rejectedResp.headers.get('Request-Id');
      const rejectedTraceId = rejectedResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(rejectedRequestId?.startsWith('req_'));
      assert.ok(rejectedTraceId?.startsWith('trc_'));
      const rejectedBody = await rejectedResp.json();
      assert.equal(rejectedBody.error.code, 'field_not_granted');
      assert.match(rejectedBody.error.message, /View includes fields not in grant: popularity/);

      const { body: timeline } = await fetchJson(`${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`);
      const queryReceivedEvent = timeline.data.find((event) =>
        event.event_type === 'query.received'
        && event.object_id === rejectedRequestId
      );
      assert.ok(queryReceivedEvent, 'grant timeline should include query.received for rejected view-based record-list reads');
      assert.equal(queryReceivedEvent.trace_id, rejectedTraceId);
      assert.equal(queryReceivedEvent.stream_id, 'top_artists');
      assert.equal(queryReceivedEvent.data.query_shape, 'record_list');
      assert.equal(queryReceivedEvent.data.requested_view, 'full');
      assert.equal(queryReceivedEvent.data.source?.kind, 'connector');
      assert.equal(queryReceivedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);

      const rejectedEvent = timeline.data.find((event) =>
        event.event_type === 'query.rejected'
        && event.object_id === rejectedRequestId
      );
      assert.ok(rejectedEvent, 'grant timeline should include query.rejected for rejected view-based record-list reads');
      assert.equal(rejectedEvent.trace_id, rejectedTraceId);
      assert.equal(rejectedEvent.stream_id, 'top_artists');
      assert.equal(rejectedEvent.data.query_shape, 'record_list');
      assert.equal(rejectedEvent.data.requested_view, 'full');
      assert.equal(rejectedEvent.data.source?.kind, 'connector');
      assert.equal(rejectedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
      assert.equal(rejectedEvent.data.error?.code, 'field_not_granted');
      assert.match(rejectedEvent.data.error?.message || '', /View includes fields not in grant: popularity/);

      const servedEvent = timeline.data.find((event) =>
        event.event_type === 'disclosure.served'
        && event.object_id === rejectedRequestId
      );
      assert.equal(servedEvent, undefined, 'rejected view-based record-list reads should not produce disclosure.served');
    });
  });

  await t.test('field-limited client grants project changes_since disclosures to the granted field subset', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const approved = await approveGrant(asUrl, 'u1', {
        client_id: 'concert_recommendation_app',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Maintain a concert-recommendation profile over time using the basic top-artist subset',
        access_mode: 'continuous',
        streams: [{
          name: 'top_artists',
          fields: ['id', 'name', 'genres'],
        }],
      });

      const baseline = await fetchJson(
        `${rsUrl}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(Buffer.from(JSON.stringify({ kind: 'changes_since', version: 0 })).toString('base64'))}`,
        { headers: { Authorization: `Bearer ${approved.token}` } },
      );
      assert.equal(baseline.status, 200);
      const firstRecord = baseline.body.data?.[0];
      assert.ok(firstRecord, 'expected at least one granted record in the baseline changes_since response');
      assert.deepEqual(Object.keys(firstRecord.data || {}).sort(), ['genres', 'id', 'name']);
      assert.ok(!('popularity' in (firstRecord.data || {})));
      assert.ok(!('followers' in (firstRecord.data || {})));
      assert.ok(!('image_url' in (firstRecord.data || {})));
      assert.ok(!('source_updated_at' in (firstRecord.data || {})));

      const ownerRecord = await fetchJson(
        `${rsUrl}/v1/streams/top_artists/records/${encodeURIComponent(firstRecord.id)}?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );

      const hiddenFieldUpdate = {
        key: firstRecord.id,
        data: {
          ...ownerRecord.body.data,
          popularity: 101,
          source_updated_at: new Date().toISOString(),
        },
        emitted_at: new Date().toISOString(),
      };

      await fetchJson(
        `${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            'Content-Type': 'application/x-ndjson',
          },
          body: JSON.stringify(hiddenFieldUpdate),
        },
      );

      const hiddenDelta = await fetchJson(
        `${rsUrl}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(baseline.body.next_changes_since)}`,
        { headers: { Authorization: `Bearer ${approved.token}` } },
      );
      assert.equal(hiddenDelta.status, 200);
      assert.equal(hiddenDelta.body.data.length, 0, 'changes_since should hide deltas that only touch ungranted fields');

      const visibleFieldUpdate = {
        key: firstRecord.id,
        data: {
          ...hiddenFieldUpdate.data,
          genres: [...ownerRecord.body.data.genres, 'touring'],
          source_updated_at: new Date().toISOString(),
        },
        emitted_at: new Date().toISOString(),
      };

      await fetchJson(
        `${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            'Content-Type': 'application/x-ndjson',
          },
          body: JSON.stringify(visibleFieldUpdate),
        },
      );

      const visibleDelta = await fetchJson(
        `${rsUrl}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(hiddenDelta.body.next_changes_since)}`,
        { headers: { Authorization: `Bearer ${approved.token}` } },
      );
      assert.equal(visibleDelta.status, 200);
      assert.equal(visibleDelta.body.data.length, 1);
      assert.equal(visibleDelta.body.data[0].id, firstRecord.id);
      assert.deepEqual(Object.keys(visibleDelta.body.data[0].data || {}).sort(), ['genres', 'id', 'name']);
      assert.ok(!('popularity' in (visibleDelta.body.data[0].data || {})));
      assert.ok(!('followers' in (visibleDelta.body.data[0].data || {})));
      assert.ok(!('image_url' in (visibleDelta.body.data[0].data || {})));
      assert.ok(!('source_updated_at' in (visibleDelta.body.data[0].data || {})));
      assert.deepEqual(visibleDelta.body.data[0].data.genres.at(-1), 'touring');
    });
  });

  await t.test('field-limited client grants reject changes_since filter fields outside the grant and preserve the rejection in the timeline', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const approved = await approveGrant(asUrl, 'u1', {
        client_id: 'concert_recommendation_app',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Maintain a concert-recommendation profile over time using the basic top-artist subset',
        access_mode: 'continuous',
        streams: [{
          name: 'top_artists',
          fields: ['id', 'name', 'genres'],
        }],
      });

      const rejectedResp = await fetch(
        `${rsUrl}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(Buffer.from(JSON.stringify({ kind: 'changes_since', version: 0 })).toString('base64'))}&filter[popularity]=96`,
        { headers: { Authorization: `Bearer ${approved.token}` } },
      );
      assert.equal(rejectedResp.status, 403);
      const rejectedRequestId = rejectedResp.headers.get('Request-Id');
      const rejectedTraceId = rejectedResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(rejectedRequestId?.startsWith('req_'));
      assert.ok(rejectedTraceId?.startsWith('trc_'));
      const rejectedBody = await rejectedResp.json();
      assert.equal(rejectedBody.error.code, 'field_not_granted');
      assert.match(rejectedBody.error.message, /Filter on field 'popularity' not in grant/);

      const { body: timeline } = await fetchJson(`${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`);
      const queryReceivedEvent = timeline.data.find((event) =>
        event.event_type === 'query.received'
        && event.object_id === rejectedRequestId
      );
      assert.ok(queryReceivedEvent, 'grant timeline should include query.received for rejected changes_since filter reads');
      assert.equal(queryReceivedEvent.trace_id, rejectedTraceId);
      assert.equal(queryReceivedEvent.stream_id, 'top_artists');
      assert.equal(queryReceivedEvent.data.query_shape, 'record_list');
      assert.equal(queryReceivedEvent.data.has_changes_since, true);
      assert.equal(queryReceivedEvent.data.source?.kind, 'connector');
      assert.equal(queryReceivedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);

      const rejectedEvent = timeline.data.find((event) =>
        event.event_type === 'query.rejected'
        && event.object_id === rejectedRequestId
      );
      assert.ok(rejectedEvent, 'grant timeline should include query.rejected for rejected changes_since filter reads');
      assert.equal(rejectedEvent.trace_id, rejectedTraceId);
      assert.equal(rejectedEvent.stream_id, 'top_artists');
      assert.equal(rejectedEvent.data.query_shape, 'record_list');
      assert.equal(rejectedEvent.data.has_changes_since, true);
      assert.equal(rejectedEvent.data.source?.kind, 'connector');
      assert.equal(rejectedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
      assert.equal(rejectedEvent.data.error?.code, 'field_not_granted');
      assert.match(rejectedEvent.data.error?.message || '', /Filter on field 'popularity' not in grant/);

      const servedEvent = timeline.data.find((event) =>
        event.event_type === 'disclosure.served'
        && event.object_id === rejectedRequestId
      );
      assert.equal(servedEvent, undefined, 'rejected changes_since filter reads should not produce disclosure.served');
    });
  });

  await t.test('native client query rejections stay correlated on the grant timeline', async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      await seedNorthstar(nativeManifest);

      const approved = await approveGrant(asUrl, 'employee_1', {
        client_id: 'longview',
        source: { kind: 'provider_native', id: nativeManifest.provider_id },
        purpose_code: 'https://pdpp.org/purpose/financial_planning',
        purpose_description: 'Support compensation planning and verification',
        access_mode: 'continuous',
        streams: [{ name: 'pay_statements' }],
      });

      const rejectedResp = await fetch(
        `${rsUrl}/v1/streams/pay_statements/records?view=summary&fields=id`,
        { headers: { Authorization: `Bearer ${approved.token}` } },
      );
      assert.equal(rejectedResp.status, 400);
      const rejectedRequestId = rejectedResp.headers.get('Request-Id');
      const rejectedTraceId = rejectedResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(rejectedRequestId?.startsWith('req_'));
      assert.ok(rejectedTraceId?.startsWith('trc_'));
      const rejectedBody = await rejectedResp.json();
      assert.equal(rejectedBody.error.code, 'invalid_request');

      const { body: timeline } = await fetchJson(`${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`);
      const queryReceivedEvent = timeline.data.find((event) =>
        event.event_type === 'query.received'
        && event.object_id === rejectedRequestId
      );
      assert.ok(queryReceivedEvent, 'grant timeline should include query.received for rejected native client reads');
      assert.equal(queryReceivedEvent.data.query_shape, 'record_list');
      assert.equal(queryReceivedEvent.data.source?.kind, 'provider_native');

      const rejectedEvent = timeline.data.find((event) =>
        event.event_type === 'query.rejected'
        && event.object_id === rejectedRequestId
      );
      assert.ok(rejectedEvent, 'grant timeline should include query.rejected for rejected native client reads');
      assert.equal(rejectedEvent.trace_id, rejectedTraceId);
      assert.equal(rejectedEvent.data.query_shape, 'record_list');
      assert.equal(rejectedEvent.data.source?.kind, 'provider_native');
      assert.equal(rejectedEvent.data.error?.code, 'invalid_request');
      assert.match(rejectedEvent.data.error?.message || '', /view and fields are mutually exclusive/);
    });
  });

  // Regression for owner-review-1 (mount-rs-record-read-operations): the
  // Fastify transport uses `qs.parse`, so repeated `?fields=a&fields=b`
  // produces an array. The previous native route rejected `view + fields`
  // via a truthiness test (`if (req.query.view && req.query.fields)`), so
  // arrays still triggered the mutex. The operation must preserve that
  // behavior; otherwise a client could pass `view=compact` plus repeated
  // `fields=` params and silently drop the view.
  await t.test('record-list rejects view plus repeated fields query params (qs array shape)', async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      await seedNorthstar(nativeManifest);

      const approved = await approveGrant(asUrl, 'employee_1', {
        client_id: 'longview',
        source: { kind: 'provider_native', id: nativeManifest.provider_id },
        purpose_code: 'https://pdpp.org/purpose/financial_planning',
        purpose_description: 'Support compensation planning and verification',
        access_mode: 'continuous',
        streams: [{ name: 'pay_statements' }],
      });

      // Repeated `fields=` produces `fields: ['id', 'employer']` after qs
      // parsing, which is the exact shape the P1 fix guards against.
      const rejectedResp = await fetch(
        `${rsUrl}/v1/streams/pay_statements/records?view=summary&fields=id&fields=employer`,
        { headers: { Authorization: `Bearer ${approved.token}` } },
      );
      assert.equal(rejectedResp.status, 400);
      const rejectedBody = await rejectedResp.json();
      assert.equal(rejectedBody.error.code, 'invalid_request');
      assert.match(rejectedBody.error.message, /view and fields are mutually exclusive/);
    });
  });

  await t.test('native owner query rejections stay correlated on owner traces', async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'employee_1');
      await seedNorthstar(nativeManifest);

      const rejectedResp = await fetch(`${rsUrl}/v1/streams/not_a_stream`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(rejectedResp.status, 404);
      const rejectedRequestId = rejectedResp.headers.get('Request-Id');
      const rejectedTraceId = rejectedResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(rejectedRequestId?.startsWith('req_'));
      assert.ok(rejectedTraceId?.startsWith('trc_qry_'));
      const rejectedBody = await rejectedResp.json();
      assert.equal(rejectedBody.error.code, 'not_found');

      const { body: trace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(rejectedTraceId)}`);
      const queryReceivedEvent = trace.data.find((event) =>
        event.event_type === 'query.received'
        && event.object_id === rejectedRequestId
      );
      assert.ok(queryReceivedEvent, 'owner trace should include query.received for rejected native owner reads');
      assert.equal(queryReceivedEvent.stream_id, 'not_a_stream');
      assert.equal(queryReceivedEvent.data.query_shape, 'stream_metadata');
      assert.equal(queryReceivedEvent.data.source?.kind, 'provider_native');

      const rejectedEvent = trace.data.find((event) =>
        event.event_type === 'query.rejected'
        && event.object_id === rejectedRequestId
      );
      assert.ok(rejectedEvent, 'owner trace should include query.rejected for rejected native owner reads');
      assert.equal(rejectedEvent.stream_id, 'not_a_stream');
      assert.equal(rejectedEvent.data.query_shape, 'stream_metadata');
      assert.equal(rejectedEvent.data.source?.kind, 'provider_native');
      assert.equal(rejectedEvent.data.error?.code, 'not_found');
      assert.match(rejectedEvent.data.error?.message || '', /Stream 'not_a_stream' not found/);
    });
  });

  await t.test('changes_since hides unauthorized-only changes and returns tombstones', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const approved = await approveGrant(asUrl, 'u1', {
        client_id: 'concert_recommendation_app',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Maintain a concert-recommendation profile over time',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists', view: 'basic' }],
      });

      const baseline = await fetchJson(
        `${rsUrl}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(Buffer.from(JSON.stringify({ kind: 'changes_since', version: 0 })).toString('base64'))}`,
        { headers: { Authorization: `Bearer ${approved.token}` } }
      );

      assert.equal(baseline.status, 200);
      assert.equal(baseline.body.data.length, 8);

      const firstId = baseline.body.data[0].id;
      const ownerRecord = await fetchJson(
        `${rsUrl}/v1/streams/top_artists/records/${encodeURIComponent(firstId)}?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } }
      );

      const hiddenFieldUpdate = {
        key: firstId,
        data: {
          ...ownerRecord.body.data,
          popularity: 101,
          source_updated_at: new Date().toISOString(),
        },
        emitted_at: new Date().toISOString(),
      };

      await fetchJson(
        `${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            'Content-Type': 'application/x-ndjson',
          },
          body: JSON.stringify(hiddenFieldUpdate),
        }
      );

      const hiddenDelta = await fetchJson(
        `${rsUrl}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(baseline.body.next_changes_since)}`,
        { headers: { Authorization: `Bearer ${approved.token}` } }
      );

      assert.equal(hiddenDelta.status, 200);
      assert.equal(hiddenDelta.body.data.length, 0);

      const visibleFieldUpdate = {
        key: firstId,
        data: {
          ...hiddenFieldUpdate.data,
          genres: [...ownerRecord.body.data.genres, 'touring'],
          source_updated_at: new Date().toISOString(),
        },
        emitted_at: new Date().toISOString(),
      };

      await fetchJson(
        `${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            'Content-Type': 'application/x-ndjson',
          },
          body: JSON.stringify(visibleFieldUpdate),
        }
      );

      const visibleDelta = await fetchJson(
        `${rsUrl}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(hiddenDelta.body.next_changes_since)}`,
        { headers: { Authorization: `Bearer ${approved.token}` } }
      );

      assert.equal(visibleDelta.status, 200);
      assert.equal(visibleDelta.body.data.length, 1);
      assert.equal(visibleDelta.body.data[0].id, firstId);
      assert.deepEqual(visibleDelta.body.data[0].data.genres.at(-1), 'touring');

      const deletedId = baseline.body.data[1].id;
      const deleted = await fetch(`${rsUrl}/v1/streams/top_artists/records/${encodeURIComponent(deletedId)}?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${ownerToken}` },
      });

      assert.equal(deleted.status, 204);

      const tombstoneDelta = await fetchJson(
        `${rsUrl}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(visibleDelta.body.next_changes_since)}`,
        { headers: { Authorization: `Bearer ${approved.token}` } }
      );

      assert.equal(tombstoneDelta.status, 200);
      assert.equal(tombstoneDelta.body.data.length, 1);
      assert.equal(tombstoneDelta.body.data[0].deleted, true);
      assert.equal(tombstoneDelta.body.data[0].id, deletedId);
    });
  });

  await t.test('resource-limited changes_since pagination reports has_more only for additional visible changes', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const ownerRecordsResp = await fetch(
        `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}&limit=20`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      assert.equal(ownerRecordsResp.status, 200);
      const ownerRecordsBody = await ownerRecordsResp.json();
      const ownerRecords = ownerRecordsBody.data || [];
      const visibleRecord = ownerRecords.at(-1);
      assert.ok(visibleRecord, 'expected at least one owner-visible record to scope the changes_since grant');

      const approved = await approveGrant(asUrl, 'u1', {
        client_id: 'concert_recommendation_app',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Recommend concerts using only one permitted artist change stream',
        access_mode: 'single_use',
        streams: [{
          name: 'top_artists',
          resources: [visibleRecord.id],
        }],
      });

      const cursor = Buffer.from(JSON.stringify({ kind: 'changes_since', version: 0 })).toString('base64');
      const resp = await fetch(
        `${rsUrl}/v1/streams/top_artists/records?limit=1&changes_since=${encodeURIComponent(cursor)}`,
        { headers: { Authorization: `Bearer ${approved.token}` } },
      );
      assert.equal(resp.status, 200);
      const requestId = resp.headers.get('Request-Id');
      const traceId = resp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(requestId?.startsWith('req_'));
      assert.ok(traceId?.startsWith('trc_'));

      const body = await resp.json();
      assert.equal(body.object, 'list');
      assert.equal(body.has_more, false, 'hidden change groups should not make has_more appear true');
      assert.ok(!body.next_cursor, 'no pagination cursor should be exposed when no additional visible changes exist');
      assert.ok(body.next_changes_since, 'changes_since responses should still advance the bookmark');
      assert.equal(body.data?.length, 1);
      assert.equal(body.data?.[0]?.id, visibleRecord.id);

      const { body: timeline } = await fetchJson(`${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`);
      const queryReceivedEvent = timeline.data.find((event) =>
        event.event_type === 'query.received'
        && event.object_id === requestId
      );
      assert.ok(queryReceivedEvent, 'grant timeline should include query.received for the restricted changes_since read');
      assert.equal(queryReceivedEvent.trace_id, traceId);
      assert.equal(queryReceivedEvent.stream_id, 'top_artists');
      assert.equal(queryReceivedEvent.data.query_shape, 'record_list');
      assert.equal(queryReceivedEvent.data.has_changes_since, true);
      assert.equal(queryReceivedEvent.data.source?.kind, 'connector');
      assert.equal(queryReceivedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);

      const servedEvent = timeline.data.find((event) =>
        event.event_type === 'disclosure.served'
        && event.object_id === requestId
      );
      assert.ok(servedEvent, 'grant timeline should include disclosure.served for the restricted changes_since read');
      assert.equal(servedEvent.trace_id, traceId);
      assert.equal(servedEvent.stream_id, 'top_artists');
      assert.equal(servedEvent.data.query_shape, 'record_list');
      assert.equal(servedEvent.data.record_count, 1);
      assert.equal(servedEvent.data.has_more, false);
      assert.equal(servedEvent.data.has_next_changes_since, true);
      assert.equal(servedEvent.data.source?.kind, 'connector');
      assert.equal(servedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
    });
  });

  await t.test('changes_since still returns a record when an authorized change is followed by an unauthorized change before sync', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const approved = await approveGrant(asUrl, 'u1', {
        client_id: 'concert_recommendation_app',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Maintain a concert-recommendation profile over time',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists', view: 'basic' }],
      });

      const baseline = await fetchJson(
        `${rsUrl}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(Buffer.from(JSON.stringify({ kind: 'changes_since', version: 0 })).toString('base64'))}`,
        { headers: { Authorization: `Bearer ${approved.token}` } }
      );

      assert.equal(baseline.status, 200);
      assert.ok(baseline.body.data.length >= 3);

      const targetId = baseline.body.data[2].id;
      const ownerRecord = await fetchJson(
        `${rsUrl}/v1/streams/top_artists/records/${encodeURIComponent(targetId)}?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } }
      );

      const authorizedUpdate = {
        key: targetId,
        data: {
          ...ownerRecord.body.data,
          genres: [...ownerRecord.body.data.genres, 'journal-proof'],
          source_updated_at: new Date().toISOString(),
        },
        emitted_at: new Date().toISOString(),
      };

      await fetchJson(
        `${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            'Content-Type': 'application/x-ndjson',
          },
          body: JSON.stringify(authorizedUpdate),
        }
      );

      const unauthorizedUpdate = {
        key: targetId,
        data: {
          ...authorizedUpdate.data,
          popularity: 777,
          source_updated_at: new Date().toISOString(),
        },
        emitted_at: new Date().toISOString(),
      };

      await fetchJson(
        `${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            'Content-Type': 'application/x-ndjson',
          },
          body: JSON.stringify(unauthorizedUpdate),
        }
      );

      const delta = await fetchJson(
        `${rsUrl}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(baseline.body.next_changes_since)}`,
        { headers: { Authorization: `Bearer ${approved.token}` } }
      );

      assert.equal(delta.status, 200);
      assert.equal(delta.body.data.length, 1);
      assert.equal(delta.body.data[0].id, targetId);
      assert.equal(delta.body.data[0].data.genres.at(-1), 'journal-proof');
      assert.equal('popularity' in delta.body.data[0].data, false);
    });
  });

  await t.test('single_use grants issue one token but allow reuse of that token until expiry', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const approved = await approveGrant(asUrl, 'u1', {
        client_id: 'concert_recommendation_app',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'One-time recommendation bootstrap',
        access_mode: 'single_use',
        streams: [{ name: 'top_artists', view: 'basic' }],
      });

      const first = await fetchJson(`${rsUrl}/v1/streams/top_artists/records?limit=1`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(first.status, 200);
      assert.equal(first.body.data.length, 1);
      assert.ok(first.body.next_cursor);

      const second = await fetchJson(
        `${rsUrl}/v1/streams/top_artists/records?limit=1&cursor=${encodeURIComponent(first.body.next_cursor)}`,
        {
          headers: { Authorization: `Bearer ${approved.token}` },
        }
      );
      assert.equal(second.status, 200);
      assert.equal(second.body.data.length, 1);
      assert.notEqual(second.body.data[0].id, first.body.data[0].id);
    });
  });

  await t.test('changes_since cursors expire with HTTP 410 when history is pruned', async () => {
    try {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, 'u1');
        await seedSpotify(rsUrl, spotifyManifest, ownerToken);

        const approved = await approveGrant(asUrl, 'u1', {
          client_id: 'concert_recommendation_app',
          source: { kind: 'connector', id: spotifyManifest.connector_id },
          purpose_code: 'https://pdpp.org/purpose/personalization',
          purpose_description: 'Incremental sync with cursor expiry',
          access_mode: 'continuous',
          streams: [{ name: 'top_artists', view: 'basic' }],
        });

        const baseline = await fetchJson(
          `${rsUrl}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(Buffer.from(JSON.stringify({ kind: 'changes_since', version: 0 })).toString('base64'))}`,
          { headers: { Authorization: `Bearer ${approved.token}` } }
        );
        assert.equal(baseline.status, 200);

        process.env.PDPP_CHANGE_HISTORY_LIMIT = '2';

        const firstId = baseline.body.data[0].id;
        const ownerRecord = await fetchJson(
          `${rsUrl}/v1/streams/top_artists/records/${encodeURIComponent(firstId)}?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
          { headers: { Authorization: `Bearer ${ownerToken}` } }
        );

        for (let i = 0; i < 3; i++) {
          const update = {
            key: firstId,
            data: {
              ...ownerRecord.body.data,
              genres: [...ownerRecord.body.data.genres, `delta-${i}`],
              source_updated_at: new Date(Date.now() + i * 1000).toISOString(),
            },
            emitted_at: new Date(Date.now() + i * 1000).toISOString(),
          };

          const ingest = await fetch(
            `${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${ownerToken}`,
                'Content-Type': 'application/x-ndjson',
              },
              body: JSON.stringify(update),
            }
          );
          assert.equal(ingest.status, 200);
        }

        const expired = await fetchJson(
          `${rsUrl}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(baseline.body.next_changes_since)}`,
          { headers: { Authorization: `Bearer ${approved.token}` } }
        );
        assert.equal(expired.status, 410);
        assert.equal(expired.body.error.code, 'cursor_expired');
      });
    } finally {
      delete process.env.PDPP_CHANGE_HISTORY_LIMIT;
    }
  });

  await t.test('revoked grants fail with grant_revoked', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const approved = await approveGrant(asUrl, 'u1', {
        client_id: 'concert_recommendation_app',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Revocation test',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists', view: 'basic' }],
      });

      await fetchJson(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${approved.token}`,
        },
      });

      const { body: timeline } = await fetchJson(
        `${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`,
      );

      const revoked = await fetchJson(`${rsUrl}/v1/streams/top_artists/records?limit=1`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });

      assert.equal(revoked.status, 403);
      assert.equal(revoked.body.error.code, 'grant_revoked');
      assert.ok(revoked.headers['request-id']?.startsWith('req_'));
      assert.equal(revoked.headers['pdpp-reference-trace-id'], timeline.trace_id);
    });
  });

  await t.test('expired grants fail with grant_expired and preserve correlation headers', async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      await seedNorthstar(nativeManifest);

      const approved = await approveGrant(asUrl, 'employee_1', {
        client_id: 'longview',
        source: { kind: 'provider_native', id: nativeManifest.provider_id },
        purpose_code: 'https://pdpp.org/purpose/financial_planning',
        purpose_description: 'Expiry correlation test',
        access_mode: 'continuous',
        streams: [{ name: 'pay_statements' }],
      });

      const { body: timeline } = await fetchJson(
        `${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`,
      );

      getDb().prepare(`
        UPDATE tokens
        SET expires_at = ?
        WHERE token_id = ?
      `).run(new Date(Date.now() - 60_000).toISOString(), approved.token);

      const expired = await fetchJson(`${rsUrl}/v1/streams/pay_statements/records?limit=1`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });

      assert.equal(expired.status, 403);
      assert.equal(expired.body.error.code, 'grant_expired');
      assert.ok(expired.headers['request-id']?.startsWith('req_'));
      assert.equal(expired.headers['pdpp-reference-trace-id'], timeline.trace_id);
    });
  });

  await t.test('auth-gate client read failures emit correlated query.rejected artifacts on the grant timeline', async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      await seedNorthstar(nativeManifest);

      for (const scenario of [
        {
          inactiveReason: 'grant_invalid',
          mutate: async (approved) => {
            getDb().prepare(`
              UPDATE grants
              SET storage_binding_json = NULL
              WHERE grant_id = ?
            `).run(approved.grant.grant_id);
          },
        },
        {
          inactiveReason: 'grant_revoked',
          mutate: async (approved) => {
            await fetchJson(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
              method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${approved.token}`,
        },
            });
          },
        },
        {
          inactiveReason: 'grant_expired',
          mutate: async (approved) => {
            getDb().prepare(`
              UPDATE tokens
              SET expires_at = ?
              WHERE token_id = ?
            `).run(new Date(Date.now() - 60_000).toISOString(), approved.token);
          },
        },
      ]) {
        const approved = await approveGrant(asUrl, 'employee_1', {
          client_id: 'longview',
          source: { kind: 'provider_native', id: nativeManifest.provider_id },
          purpose_code: 'https://pdpp.org/purpose/financial_planning',
          purpose_description: `Auth-gate ${scenario.inactiveReason} correlation test`,
          access_mode: 'continuous',
          streams: [{ name: 'pay_statements' }],
        });

        await scenario.mutate(approved);

        const rejected = await fetchJson(`${rsUrl}/v1/streams`, {
          headers: { Authorization: `Bearer ${approved.token}` },
        });

        assert.equal(rejected.status, 403);
        assert.equal(rejected.body.error.code, scenario.inactiveReason);
        assert.ok(rejected.headers['request-id']?.startsWith('req_'));
        assert.ok(rejected.headers['pdpp-reference-trace-id']?.startsWith('trc_'));

        const { body: timeline } = await fetchJson(
          `${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`,
        );
        const rejectedEvent = (timeline.data || []).find(
          (event) =>
            event.event_type === 'query.rejected' &&
            event.object_id === rejected.headers['request-id'] &&
            event.data?.query_shape === 'stream_list' &&
            event.data?.auth_gate === true,
        );

        assert.ok(rejectedEvent, `grant timeline should include auth-gate query.rejected for ${scenario.inactiveReason}`);
        assert.equal(rejectedEvent.trace_id, rejected.headers['pdpp-reference-trace-id']);
        assert.equal(rejectedEvent.data?.error?.code, scenario.inactiveReason);
      }
    });
  });

  await t.test('auth-gate query.rejected artifacts preserve query_shape and stream_id across client read routes', async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      await seedNorthstar(nativeManifest);

      const approved = await approveGrant(asUrl, 'employee_1', {
        client_id: 'longview',
        source: { kind: 'provider_native', id: nativeManifest.provider_id },
        purpose_code: 'https://pdpp.org/purpose/financial_planning',
        purpose_description: 'Auth-gate route-shape correlation test',
        access_mode: 'continuous',
        streams: [{ name: 'pay_statements' }],
      });

      getDb().prepare(`
        UPDATE grants
        SET storage_binding_json = NULL
        WHERE grant_id = ?
      `).run(approved.grant.grant_id);

      const changesSince = Buffer.from(JSON.stringify({ kind: 'changes_since', version: 0 })).toString('base64');

      const routeExpectations = [
        {
          path: '/v1/streams',
          queryShape: 'stream_list',
          streamId: null,
        },
        {
          path: '/v1/streams/pay_statements',
          queryShape: 'stream_metadata',
          streamId: 'pay_statements',
        },
        {
          path: `/v1/streams/pay_statements/records?limit=1&changes_since=${encodeURIComponent(changesSince)}`,
          queryShape: 'record_list',
          streamId: 'pay_statements',
          hasChangesSince: true,
          limit: 1,
        },
        {
          path: '/v1/streams/pay_statements/records/ps_2026_04_15',
          queryShape: 'record_detail',
          streamId: 'pay_statements',
          requestedRecordId: 'ps_2026_04_15',
        },
      ];

      const observed = [];
      for (const route of routeExpectations) {
        const rejected = await fetchJson(`${rsUrl}${route.path}`, {
          headers: { Authorization: `Bearer ${approved.token}` },
        });

        assert.equal(rejected.status, 403);
        assert.equal(rejected.body.error.code, 'grant_invalid');
        assert.ok(rejected.headers['request-id']?.startsWith('req_'));
        assert.ok(rejected.headers['pdpp-reference-trace-id']?.startsWith('trc_'));
        observed.push({
          ...route,
          requestId: rejected.headers['request-id'],
          traceId: rejected.headers['pdpp-reference-trace-id'],
        });
      }

      const { body: timeline } = await fetchJson(
        `${asUrl}/_ref/grants/${encodeURIComponent(approved.grant.grant_id)}/timeline`,
      );

      for (const route of observed) {
        const queryReceivedEvent = (timeline.data || []).find(
          (event) =>
            event.event_type === 'query.received' &&
            event.object_id === route.requestId &&
            event.data?.query_shape === route.queryShape &&
            event.data?.auth_gate === true,
        );
        const rejectedEvent = (timeline.data || []).find(
          (event) =>
            event.event_type === 'query.rejected' &&
            event.object_id === route.requestId &&
            event.data?.query_shape === route.queryShape &&
            event.data?.auth_gate === true,
        );

        assert.ok(queryReceivedEvent, `grant timeline should include auth-gate query.received for ${route.queryShape}`);
        assert.equal(queryReceivedEvent.trace_id, route.traceId);
        assert.equal(queryReceivedEvent.stream_id ?? null, route.streamId);
        assert.equal(queryReceivedEvent.data?.has_changes_since ?? null, route.hasChangesSince ?? null);
        assert.equal(queryReceivedEvent.data?.limit ?? null, route.limit ?? null);
        assert.equal(queryReceivedEvent.data?.requested_record_id ?? null, route.requestedRecordId ?? null);
        assert.ok(rejectedEvent, `grant timeline should include auth-gate query.rejected for ${route.queryShape}`);
        assert.equal(rejectedEvent.trace_id, route.traceId);
        assert.equal(rejectedEvent.stream_id ?? null, route.streamId);
        assert.equal(rejectedEvent.data?.has_changes_since ?? null, route.hasChangesSince ?? null);
        assert.equal(rejectedEvent.data?.limit ?? null, route.limit ?? null);
        assert.equal(rejectedEvent.data?.requested_record_id ?? null, route.requestedRecordId ?? null);
        assert.equal(rejectedEvent.data?.error?.code, 'grant_invalid');
      }
    });
  });

  await t.test('runtime stages STATE and only commits it when requested', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');

      const uncommittedRun = await runConnector({
        connectorPath: join(REFERENCE_IMPL_DIR, 'connectors/seed/index.js'),
        connectorId: spotifyManifest.connector_id,
        ownerToken,
        manifest: spotifyManifest,
        state: null,
        collectionMode: 'full_refresh',
        persistState: false,
        rsUrl,
      });

      assert.deepEqual(uncommittedRun.checkpoint_summary, {
        mode: 'checkpointed_streaming',
        commit_status: 'disabled',
        records_flushed: 21,
        buffered_records_dropped: 0,
        state_streams_staged: 2,
        state_streams_committed: 0,
      });

      const noState = await loadSyncState(spotifyManifest.connector_id, ownerToken, { rsUrl });
      assert.deepEqual(noState, {});

      const committedRun = await runConnector({
        connectorPath: join(REFERENCE_IMPL_DIR, 'connectors/seed/index.js'),
        connectorId: spotifyManifest.connector_id,
        ownerToken,
        manifest: spotifyManifest,
        state: null,
        collectionMode: 'full_refresh',
        persistState: true,
        rsUrl,
      });

      assert.deepEqual(committedRun.checkpoint_summary, {
        mode: 'checkpointed_streaming',
        commit_status: 'committed',
        records_flushed: 21,
        buffered_records_dropped: 0,
        state_streams_staged: 2,
        state_streams_committed: 2,
      });

      const persistedState = await loadSyncState(spotifyManifest.connector_id, ownerToken, { rsUrl });
      assert.ok(persistedState.top_artists);
      assert.ok(persistedState.saved_tracks);
    });
  });
});
