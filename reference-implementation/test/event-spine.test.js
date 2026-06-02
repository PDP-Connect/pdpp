import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { startServer } from '../server/index.js';
import { canonicalConnectorKey } from '../server/connector-key.js';
import { closeDb, getDb, initDb } from '../server/db.js';
import { ingestRecord } from '../server/records.js';
import { runConnector } from '../runtime/index.js';
import { emitSpineEvent } from '../lib/spine.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');
const TEST_DCR_INITIAL_ACCESS_TOKEN = 'pdpp-reference-test-initial-access-token';
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

async function closeHttpServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
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
    body: new URLSearchParams({ user_code: device.user_code, subject_id: subjectId }).toString(),
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
    const registerResp = await fetch(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spotifyManifest),
    });
    assert.equal(registerResp.status, 201);

    await fn({ asUrl, rsUrl, spotifyManifest });
  } finally {
    await closeServer(server);
  }
}

async function registerDynamicClient(asUrl, metadata, initialAccessToken = TEST_DCR_INITIAL_ACCESS_TOKEN) {
  return fetchJson(`${asUrl}/oauth/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${initialAccessToken}`,
    },
    body: JSON.stringify(metadata),
  });
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

async function seedSpotify(rsUrl, manifest, ownerToken) {
  return runConnector({
    connectorPath: join(REFERENCE_IMPL_DIR, 'connectors/seed/index.js'),
    connectorId: manifest.connector_id,
    ownerToken,
    manifest,
    state: null,
    collectionMode: 'full_refresh',
    rsUrl,
  });
}

async function seedNorthstar(nativeManifest) {
  const connectorId = nativeManifest.storage_binding.connector_id;
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
  ];

  for (const record of records) {
    await ingestRecord(connectorId, record);
  }
}

test('event spine', async (t) => {
  await t.test('migrates pre-source-column spine rows without losing row counts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdpp-spine-migration-'));
    const dbPath = join(dir, 'legacy.sqlite');
    const oldDb = new Database(dbPath);

    try {
      oldDb.exec(`
        CREATE TABLE spine_events (
          event_id         TEXT PRIMARY KEY,
          event_seq        INTEGER,
          event_type       TEXT NOT NULL,
          occurred_at      TEXT NOT NULL,
          recorded_at      TEXT NOT NULL,
          scenario_id      TEXT NOT NULL,
          trace_id         TEXT NOT NULL,
          actor_type       TEXT NOT NULL,
          actor_id         TEXT NOT NULL,
          subject_type     TEXT,
          subject_id       TEXT,
          object_type      TEXT NOT NULL,
          object_id        TEXT NOT NULL,
          status           TEXT NOT NULL,
          request_id       TEXT,
          grant_id         TEXT,
          run_id           TEXT,
          provider_id      TEXT,
          client_id        TEXT,
          stream_id        TEXT,
          token_id         TEXT,
          interaction_id   TEXT,
          data_json        TEXT NOT NULL,
          version          TEXT NOT NULL
        )
      `);
      const insert = oldDb.prepare(`
        INSERT INTO spine_events (
          event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
          actor_type, actor_id, object_type, object_id, status, provider_id, data_json, version
        )
        VALUES (@event_id, @event_seq, @event_type, @occurred_at, @recorded_at, @scenario_id, @trace_id,
          @actor_type, @actor_id, @object_type, @object_id, @status, @provider_id, @data_json, @version)
      `);
      insert.run({
        event_id: 'evt_connector_legacy',
        event_seq: 1,
        event_type: 'query.received',
        occurred_at: '2026-04-01T00:00:00Z',
        recorded_at: '2026-04-01T00:00:01Z',
        scenario_id: 'scn_test',
        trace_id: 'trc_test',
        actor_type: 'client',
        actor_id: 'client_a',
        object_type: 'query',
        object_id: 'req_a',
        status: 'succeeded',
        provider_id: null,
        data_json: JSON.stringify({
          source: { binding_kind: 'connector', connector_id: 'conn_legacy' },
        }),
        version: 'spine.v1',
      });
      insert.run({
        event_id: 'evt_native_legacy',
        event_seq: 2,
        event_type: 'grant.issued',
        occurred_at: '2026-04-01T00:00:02Z',
        recorded_at: '2026-04-01T00:00:03Z',
        scenario_id: 'scn_test',
        trace_id: 'trc_test',
        actor_type: 'authorization_server',
        actor_id: 'pdpp_reference',
        object_type: 'grant',
        object_id: 'grant_native',
        status: 'succeeded',
        provider_id: 'provider_legacy',
        data_json: JSON.stringify({
          source: { binding_kind: 'provider_native', provider_id: 'provider_legacy' },
        }),
        version: 'spine.v1',
      });
      insert.run({
        event_id: 'evt_runtime_source_scalar',
        event_seq: 3,
        event_type: 'run.completed',
        occurred_at: '2026-04-01T00:00:04Z',
        recorded_at: '2026-04-01T00:00:05Z',
        scenario_id: 'scn_test',
        trace_id: 'trc_test',
        actor_type: 'runtime',
        actor_id: 'conn_runtime_fallback',
        object_type: 'run',
        object_id: 'run_runtime_fallback',
        status: 'succeeded',
        provider_id: null,
        data_json: JSON.stringify({ source: 'connector-payload-label' }),
        version: 'spine.v1',
      });
      oldDb.close();

      const migrations = [];
      initDb(dbPath, { onSchemaMigration: (event) => migrations.push(event) });
      const db = getDb();
      const columns = db.prepare('PRAGMA table_info(spine_events)').all().map((row) => row.name);
      const rowCount = db.prepare('SELECT COUNT(*) AS count FROM spine_events').get().count;

      // Boot performs only the bounded, idempotent schema DDL: it adds the
      // source columns and index and drops the superseded provider_id column,
      // preserving the row count. It NO LONGER backfills source values — the
      // unbounded per-row backfill that scanned the whole table on every boot
      // was moved to an explicit operator maintenance script. Legacy rows
      // therefore keep NULL source columns after boot; reads derive source
      // from data_json. See openspec/changes/harden-startup-data-backfills.
      const backfilledCount = db.prepare(
        'SELECT COUNT(*) AS count FROM spine_events WHERE source_kind IS NOT NULL OR source_id IS NOT NULL'
      ).get().count;

      assert.equal(rowCount, 3);
      assert.equal(backfilledCount, 0, 'boot must not backfill legacy source values');
      assert.equal(columns.includes('provider_id'), false);
      assert.ok(columns.includes('source_kind'));
      assert.ok(columns.includes('source_id'));
      assert.equal(migrations[0]?.rowCount, 3);
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('migrates pre-event-seq spine rows before creating event_seq indexes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdpp-spine-event-seq-migration-'));
    const dbPath = join(dir, 'legacy.sqlite');
    const oldDb = new Database(dbPath);

    try {
      oldDb.exec(`
        CREATE TABLE spine_events (
          event_id         TEXT PRIMARY KEY,
          event_type       TEXT NOT NULL,
          occurred_at      TEXT NOT NULL,
          recorded_at      TEXT NOT NULL,
          scenario_id      TEXT NOT NULL,
          trace_id         TEXT NOT NULL,
          actor_type       TEXT NOT NULL,
          actor_id         TEXT NOT NULL,
          subject_type     TEXT,
          subject_id       TEXT,
          object_type      TEXT NOT NULL,
          object_id        TEXT NOT NULL,
          status           TEXT NOT NULL,
          request_id       TEXT,
          grant_id         TEXT,
          run_id           TEXT,
          source_kind      TEXT,
          source_id        TEXT,
          client_id        TEXT,
          stream_id        TEXT,
          token_id         TEXT,
          interaction_id   TEXT,
          data_json        TEXT NOT NULL,
          version          TEXT NOT NULL
        );

        INSERT INTO spine_events (
          event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
          actor_type, actor_id, object_type, object_id, status, run_id,
          source_kind, source_id, data_json, version
        )
        VALUES (
          'evt_legacy_without_event_seq',
          'run.completed',
          '2026-04-01T00:00:00Z',
          '2026-04-01T00:00:01Z',
          'scn_test',
          'trc_test',
          'runtime',
          'conn_legacy',
          'run',
          'run_legacy',
          'succeeded',
          'run_legacy',
          'connector',
          'conn_legacy',
          '{"source":{"kind":"connector","id":"conn_legacy"}}',
          'spine.v1'
        );
      `);
      oldDb.close();

      initDb(dbPath);
      const db = getDb();
      const columns = db.prepare('PRAGMA table_info(spine_events)').all().map((row) => row.name);
      const indexes = db.prepare('PRAGMA index_list(spine_events)').all().map((row) => row.name);
      const row = db.prepare('SELECT event_seq FROM spine_events WHERE event_id = ?').get('evt_legacy_without_event_seq');

      assert.ok(columns.includes('event_seq'));
      assert.equal(row.event_seq, 1);
      assert.ok(indexes.includes('idx_spine_events_run_terminal'));
      assert.ok(indexes.includes('idx_spine_events_seq'));
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('captures dynamic client registration success and rejection as trace artifacts', async () => {
    await withHarness(async ({ asUrl }) => {
      const registration = await registerDynamicClient(asUrl, {
        client_name: 'Dynamic Longview',
        redirect_uris: ['https://longview.example/callback'],
        token_endpoint_auth_method: 'none',
      });

      assert.equal(registration.status, 201);
      const successRequestId = registration.headers['request-id'];
      const successTraceId = registration.headers['pdpp-reference-trace-id'];
      assert.ok(successRequestId?.startsWith('req_'));
      assert.ok(successTraceId?.startsWith('trc_'));

      const { body: successTrace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(successTraceId)}`);
      const registeredEvent = (successTrace.data || []).find((event) => event.event_type === 'client.registered');
      assert.ok(registeredEvent, 'expected client.registered event');
      assert.equal(registeredEvent.request_id, successRequestId);
      assert.equal(registeredEvent.trace_id, successTraceId);
      assert.equal(registeredEvent.object_id, registration.body.client_id);
      assert.equal(registeredEvent.client_id, registration.body.client_id);
      assert.equal(registeredEvent.data?.client_name, 'Dynamic Longview');
      assert.equal(registeredEvent.data?.token_endpoint_auth_method, 'none');
      assert.equal(registeredEvent.data?.redirect_uri_count, 1);

      const rejectedResp = await fetch(`${asUrl}/oauth/register`, {
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
      assert.equal(rejectedResp.status, 401);
      const rejectedRequestId = rejectedResp.headers.get('Request-Id');
      const rejectedTraceId = rejectedResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(rejectedRequestId?.startsWith('req_'));
      assert.ok(rejectedTraceId?.startsWith('trc_'));

      const { body: rejectedTrace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(rejectedTraceId)}`);
      const rejectedEvent = (rejectedTrace.data || []).find((event) => event.event_type === 'client.register_rejected');
      assert.ok(rejectedEvent, 'expected client.register_rejected event');
      assert.equal(rejectedEvent.request_id, rejectedRequestId);
      assert.equal(rejectedEvent.trace_id, rejectedTraceId);
      assert.equal(rejectedEvent.object_id, rejectedRequestId);
      assert.equal(rejectedEvent.data?.requested_client_name, 'Rejected Client');
      assert.equal(rejectedEvent.data?.requested_token_endpoint_auth_method, 'none');
      assert.equal(rejectedEvent.data?.error?.code, 'invalid_client');
    });
  });

  await t.test('captures a grant trace through disclosure and revocation', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const initiateResp = await fetch(`${asUrl}/oauth/par`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'concert_recommendation_app',
          authorization_details: [
            {
              type: 'https://pdpp.org/data-access',
              source: { kind: 'connector', id: spotifyManifest.connector_id },
              purpose_code: 'https://pdpp.org/purpose/personalization',
              purpose_description: 'Recommend concerts based on recent listening history',
              access_mode: 'single_use',
              streams: [{ name: 'top_artists', view: 'basic' }],
            },
          ],
        }),
      });
      assert.equal(initiateResp.status, 201);
      const initiateRequestId = initiateResp.headers.get('Request-Id');
      const initiateTraceId = initiateResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(initiateRequestId?.startsWith('req_'));
      assert.ok(initiateTraceId?.startsWith('trc_'));
      const initiate = await initiateResp.json();

      const approveResp = await fetch(`${asUrl}/consent/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_uri: initiate.request_uri, subject_id: 'u1' }),
      });
      assert.equal(approveResp.status, 200);
      const approval = await approveResp.json();

      const queryResp = await fetch(
        `${rsUrl}/v1/streams/top_artists/records?limit=3`,
        { headers: { Authorization: `Bearer ${approval.token}` } },
      );
      assert.equal(queryResp.status, 200);
      const queryBody = await queryResp.json();
      assert.ok(Array.isArray(queryBody.data));

      const revokeResp = await fetch(`${asUrl}/grants/${approval.grant.grant_id}/revoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${approval.token}`,
        },
      });
      assert.equal(revokeResp.status, 200);
      const revokeRequestId = revokeResp.headers.get('Request-Id');
      const revokeTraceId = revokeResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(revokeRequestId?.startsWith('req_'));

      const { body: grantTimeline } = await fetchJson(`${asUrl}/_ref/grants/${encodeURIComponent(approval.grant.grant_id)}/timeline`);
      const grantIssued = (grantTimeline.data || []).find((event) => event.event_type === 'grant.issued');
      assert.ok(grantIssued, 'expected grant.issued event');
      assert.equal(grantTimeline.grant_id, approval.grant.grant_id);
      assert.equal(revokeTraceId, grantIssued.trace_id);

      const { body: traceTimeline } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(grantIssued.trace_id)}`);
      const traceTypes = (traceTimeline.data || []).map((event) => event.event_type);
      assert.deepEqual(
        traceTypes.filter((eventType) => [
          'request.submitted',
          'consent.approved',
          'grant.issued',
          'token.issued',
          'query.received',
          'disclosure.served',
          'grant.revoked',
        ].includes(eventType)),
        [
          'request.submitted',
          'consent.approved',
          'grant.issued',
          'token.issued',
          'query.received',
          'disclosure.served',
          'grant.revoked',
        ],
      );

      for (const eventType of ['request.submitted', 'consent.approved', 'grant.issued', 'token.issued', 'grant.revoked']) {
        const event = (traceTimeline.data || []).find((entry) => entry.event_type === eventType);
        assert.ok(event, `expected ${eventType} event`);
        assert.equal(event.data?.source?.kind, 'connector');
        assert.equal(event.data?.source?.id, canonicalConnectorKey(spotifyManifest.connector_id));
        assert.ok(!('connector_id' in (event.data || {})), `${eventType} should use source descriptors instead of raw connector_id`);
        if (eventType === 'request.submitted') {
          assert.equal(event.request_id, initiateRequestId);
          assert.equal(event.trace_id, initiateTraceId);
        }
        if (eventType === 'grant.revoked') {
          assert.equal(event.request_id, revokeRequestId);
        }
      }

      const tokenIssued = (traceTimeline.data || []).find((event) => event.event_type === 'token.issued');
      assert.equal(tokenIssued.data?.issuance_path, 'grant_approval');
    });
  });

  await t.test('captures consent denial on the original staged provider-connect trace', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiateResp = await fetch(`${asUrl}/oauth/par`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'concert_recommendation_app',
          authorization_details: [
            {
              type: 'https://pdpp.org/data-access',
              source: { kind: 'connector', id: spotifyManifest.connector_id },
              purpose_code: 'https://pdpp.org/purpose/personalization',
              purpose_description: 'Recommend concerts based on recent listening history',
              access_mode: 'single_use',
              streams: [{ name: 'top_artists', view: 'basic' }],
            },
          ],
        }),
      });
      assert.equal(initiateResp.status, 201);
      const requestId = initiateResp.headers.get('Request-Id');
      const traceId = initiateResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(requestId?.startsWith('req_'));
      assert.ok(traceId?.startsWith('trc_'));
      const initiate = await initiateResp.json();

      const denyResp = await fetch(`${asUrl}/consent/deny`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_uri: initiate.request_uri }),
      });
      assert.equal(denyResp.status, 200);
      assert.equal(denyResp.headers.get('Request-Id'), requestId);
      assert.equal(denyResp.headers.get('PDPP-Reference-Trace-Id'), traceId);
      const denyBody = await denyResp.text();
      assert.match(denyBody, /Access Denied/);

      const { body: traceTimeline } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(traceId)}`);
      const submittedEvent = (traceTimeline.data || []).find((event) =>
        event.event_type === 'request.submitted'
        && event.request_id === requestId
      );
      assert.ok(submittedEvent, 'expected request.submitted for staged provider-connect request');

      const deniedEvent = (traceTimeline.data || []).find((event) =>
        event.event_type === 'consent.denied'
        && event.request_id === requestId
      );
      assert.ok(deniedEvent, 'expected consent.denied for consent-shell denial');
      assert.equal(deniedEvent.client_id, 'concert_recommendation_app');
      assert.equal(deniedEvent.object_type, 'pending_consent');
      assert.equal(deniedEvent.status, 'denied');
      assert.equal(deniedEvent.data?.source?.kind, 'connector');
      assert.equal(deniedEvent.data?.source?.id, canonicalConnectorKey(spotifyManifest.connector_id));

      const grantIssuedEvent = (traceTimeline.data || []).find((event) => event.event_type === 'grant.issued');
      assert.equal(grantIssuedEvent, undefined, 'denied consent should not issue a grant');
    });
  });

  await t.test('captures owner device start, polling, approval, and owner-token issuance on one trace', async () => {
    await withHarness(async ({ asUrl }) => {
      const deviceResp = await fetch(`${asUrl}/oauth/device_authorization`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: 'cli_longview' }).toString(),
      });
      assert.equal(deviceResp.status, 200);

      const requestId = deviceResp.headers.get('Request-Id');
      const traceId = deviceResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(requestId?.startsWith('req_'));
      assert.ok(traceId?.startsWith('trc_'));

      const deviceBody = await deviceResp.json();

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
          subject_id: 'u1',
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

      const { body: traceTimeline } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(traceId)}`);

      // device_code / user_code are bearer-equivalent on owner_device_auth
      // (harden-reference-auth-surfaces §7) and are redacted on public _ref
      // reads. Internal correlation by request_id, client_id, and
      // issuance_path remains intact.
      const submittedEvent = (traceTimeline.data || []).find((event) =>
        event.event_type === 'request.submitted'
        && event.object_type === 'owner_device_auth'
        && event.data?.issuance_path === 'owner_device_flow'
      );
      assert.ok(submittedEvent, 'expected request.submitted for owner device start');
      assert.equal(submittedEvent.request_id, requestId);
      assert.equal(submittedEvent.client_id, 'cli_longview');
      assert.equal(submittedEvent.object_type, 'owner_device_auth');
      assert.equal(submittedEvent.object_id, '<redacted-device-code>');
      assert.equal(submittedEvent.data?.user_code, '<redacted-bearer>');

      const approvedEvent = (traceTimeline.data || []).find((event) =>
        event.event_type === 'consent.approved'
        && event.object_type === 'owner_device_auth'
      );
      assert.ok(approvedEvent, 'expected consent.approved for owner device approval');
      assert.equal(approvedEvent.request_id, requestId);
      assert.equal(approvedEvent.client_id, 'cli_longview');
      assert.equal(approvedEvent.object_id, '<redacted-device-code>');
      assert.equal(approvedEvent.data?.user_code, '<redacted-bearer>');

      const tokenIssuedEvent = (traceTimeline.data || []).find((event) =>
        event.event_type === 'token.issued'
        && event.data?.issuance_path === 'owner_device_flow'
      );
      assert.ok(tokenIssuedEvent, 'expected token.issued for owner device exchange');
      assert.equal(tokenIssuedEvent.request_id, requestId);
      assert.equal(tokenIssuedEvent.client_id, 'cli_longview');
      assert.equal(tokenIssuedEvent.data?.user_code, '<redacted-bearer>');
    });
  });

  await t.test('captures owner device denial on one trace', async () => {
    await withHarness(async ({ asUrl }) => {
      const deviceResp = await fetch(`${asUrl}/oauth/device_authorization`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: 'cli_longview' }).toString(),
      });
      assert.equal(deviceResp.status, 200);

      const requestId = deviceResp.headers.get('Request-Id');
      const traceId = deviceResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(requestId?.startsWith('req_'));
      assert.ok(traceId?.startsWith('trc_'));

      const deviceBody = await deviceResp.json();

      const denyResp = await fetch(`${asUrl}/device/deny`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          user_code: deviceBody.user_code,
          subject_id: 'u1',
        }).toString(),
      });
      assert.equal(denyResp.status, 200);

      const exchangeResp = await fetch(`${asUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceBody.device_code,
          client_id: 'cli_longview',
        }).toString(),
      });
      assert.equal(exchangeResp.status, 400);
      assert.equal(exchangeResp.headers.get('Request-Id'), requestId);
      assert.equal(exchangeResp.headers.get('PDPP-Reference-Trace-Id'), traceId);
      const exchangeBody = await exchangeResp.json();
      assert.equal(exchangeBody.error, 'access_denied');

      const { body: traceTimeline } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(traceId)}`);

      const submittedEvent = (traceTimeline.data || []).find((event) =>
        event.event_type === 'request.submitted'
        && event.object_type === 'owner_device_auth'
        && event.data?.issuance_path === 'owner_device_flow'
      );
      assert.ok(submittedEvent, 'expected request.submitted for owner device start');
      assert.equal(submittedEvent.request_id, requestId);
      assert.equal(submittedEvent.client_id, 'cli_longview');
      assert.equal(submittedEvent.object_id, '<redacted-device-code>');
      assert.equal(submittedEvent.data?.user_code, '<redacted-bearer>');

      const rejectedEvent = (traceTimeline.data || []).find((event) =>
        event.event_type === 'request.rejected'
        && event.request_id === requestId
      );
      assert.ok(rejectedEvent, 'expected request.rejected for owner device denial');
      assert.equal(rejectedEvent.client_id, 'cli_longview');
      assert.equal(rejectedEvent.object_type, 'owner_device_auth');
      assert.equal(rejectedEvent.object_id, '<redacted-device-code>');
      assert.equal(rejectedEvent.data?.issuance_path, 'owner_device_flow');
      assert.equal(rejectedEvent.data?.user_code, '<redacted-bearer>');
      assert.equal(rejectedEvent.data?.error?.code, 'access_denied');
      assert.match(rejectedEvent.data?.error?.message || '', /denied the request/);
    });
  });

  await t.test('captures rejected connector grant reads on the grant trace and timeline', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const { body: initiate } = await fetchJson(`${asUrl}/oauth/par`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'concert_recommendation_app',
          authorization_details: [
            {
              type: 'https://pdpp.org/data-access',
              source: { kind: 'connector', id: spotifyManifest.connector_id },
              purpose_code: 'https://pdpp.org/purpose/personalization',
              purpose_description: 'Recommend concerts based on recent listening history',
              access_mode: 'single_use',
              streams: [{ name: 'top_artists', view: 'basic' }],
            },
          ],
        }),
      });

      const approveResp = await fetch(`${asUrl}/consent/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_uri: initiate.request_uri, subject_id: 'u1' }),
      });
      assert.equal(approveResp.status, 200);
      const approval = await approveResp.json();

      const rejectedResp = await fetch(
        `${rsUrl}/v1/streams/top_artists/records?view=basic&fields=id`,
        { headers: { Authorization: `Bearer ${approval.token}` } },
      );
      assert.equal(rejectedResp.status, 400);
      const requestId = rejectedResp.headers.get('Request-Id');
      const traceId = rejectedResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(requestId?.startsWith('req_'));
      assert.ok(traceId?.startsWith('trc_'));

      const { body: grantTimeline } = await fetchJson(`${asUrl}/_ref/grants/${encodeURIComponent(approval.grant.grant_id)}/timeline`);
      const { body: traceTimeline } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(traceId)}`);

      for (const timeline of [grantTimeline, traceTimeline]) {
        const queryReceived = (timeline.data || []).find((event) =>
          event.event_type === 'query.received'
          && event.object_id === requestId
        );
        assert.ok(queryReceived, 'expected query.received for rejected connector grant read');
        assert.equal(queryReceived.data.query_shape, 'record_list');
        assert.equal(queryReceived.data.source?.kind, 'connector');
        assert.equal(queryReceived.data.source?.id, canonicalConnectorKey(spotifyManifest.connector_id));
        assert.ok(!('connector_id' in (queryReceived.data || {})));

        const rejected = (timeline.data || []).find((event) =>
          event.event_type === 'query.rejected'
          && event.object_id === requestId
        );
        assert.ok(rejected, 'expected query.rejected for rejected connector grant read');
        assert.equal(rejected.data.query_shape, 'record_list');
        assert.equal(rejected.data.source?.kind, 'connector');
        assert.equal(rejected.data.source?.id, canonicalConnectorKey(spotifyManifest.connector_id));
        assert.equal(rejected.data.error?.code, 'invalid_request');
        assert.match(rejected.data.error?.message || '', /view and fields are mutually exclusive/);
        assert.ok(!('connector_id' in (rejected.data || {})));
      }
    });
  });

  await t.test('captures unknown-field connector grant reads on the grant trace and timeline', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const { body: initiate } = await fetchJson(`${asUrl}/oauth/par`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'concert_recommendation_app',
          authorization_details: [
            {
              type: 'https://pdpp.org/data-access',
              source: { kind: 'connector', id: spotifyManifest.connector_id },
              purpose_code: 'https://pdpp.org/purpose/personalization',
              purpose_description: 'Recommend concerts based on recent listening history',
              access_mode: 'single_use',
              streams: [{ name: 'saved_tracks', fields: ['id', 'name'] }],
            },
          ],
        }),
      });

      const approveResp = await fetch(`${asUrl}/consent/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_uri: initiate.request_uri, subject_id: 'u1' }),
      });
      assert.equal(approveResp.status, 200);
      const approval = await approveResp.json();

      const rejectedResp = await fetch(
        `${rsUrl}/v1/streams/saved_tracks/records?fields=id,not_a_real_field`,
        { headers: { Authorization: `Bearer ${approval.token}` } },
      );
      assert.equal(rejectedResp.status, 400);
      const requestId = rejectedResp.headers.get('Request-Id');
      const traceId = rejectedResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(requestId?.startsWith('req_'));
      assert.ok(traceId?.startsWith('trc_'));

      const { body: grantTimeline } = await fetchJson(`${asUrl}/_ref/grants/${encodeURIComponent(approval.grant.grant_id)}/timeline`);
      const { body: traceTimeline } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(traceId)}`);

      for (const timeline of [grantTimeline, traceTimeline]) {
        const queryReceived = (timeline.data || []).find((event) =>
          event.event_type === 'query.received'
          && event.object_id === requestId
        );
        assert.ok(queryReceived, 'expected query.received for rejected connector unknown-field read');
        assert.equal(queryReceived.data.query_shape, 'record_list');
        assert.equal(queryReceived.data.source?.kind, 'connector');
        assert.equal(queryReceived.data.source?.id, canonicalConnectorKey(spotifyManifest.connector_id));
        assert.ok(!('connector_id' in (queryReceived.data || {})));

        const rejected = (timeline.data || []).find((event) =>
          event.event_type === 'query.rejected'
          && event.object_id === requestId
        );
        assert.ok(rejected, 'expected query.rejected for rejected connector unknown-field read');
        assert.equal(rejected.data.query_shape, 'record_list');
        assert.equal(rejected.data.source?.kind, 'connector');
        assert.equal(rejected.data.source?.id, canonicalConnectorKey(spotifyManifest.connector_id));
        assert.equal(rejected.data.error?.code, 'unknown_field');
        assert.match(rejected.data.error?.message || '', /Unknown field: not_a_real_field/);
        assert.ok(!('connector_id' in (rejected.data || {})));
      }
    });
  });

  await t.test('captures rejected native reads on grant timelines and owner traces', async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      await seedNorthstar(nativeManifest);

      const parResp = await fetch(`${asUrl}/oauth/par`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'longview',
          authorization_details: [
            {
              type: 'https://pdpp.org/data-access',
              source: { kind: 'provider_native', id: nativeManifest.provider_id },
              purpose_code: 'https://pdpp.org/purpose/financial_planning',
              purpose_description: 'Support compensation planning and verification',
              access_mode: 'continuous',
              streams: [{ name: 'pay_statements' }],
            },
          ],
        }),
      });
      assert.equal(parResp.status, 201);
      const initiate = await parResp.json();

      const consentResp = await fetch(`${asUrl}/consent/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_uri: initiate.request_uri, subject_id: 'employee_1' }),
      });
      assert.equal(consentResp.status, 200);
      const approval = await consentResp.json();

      const clientRejectedResp = await fetch(
        `${rsUrl}/v1/streams/pay_statements/records?view=summary&fields=id`,
        { headers: { Authorization: `Bearer ${approval.token}` } },
      );
      assert.equal(clientRejectedResp.status, 400);
      const clientRequestId = clientRejectedResp.headers.get('Request-Id');
      assert.ok(clientRequestId?.startsWith('req_'));

      const { body: grantTimeline } = await fetchJson(`${asUrl}/_ref/grants/${encodeURIComponent(approval.grant.grant_id)}/timeline`);
      const clientRejected = (grantTimeline.data || []).find((event) =>
        event.event_type === 'query.rejected'
        && event.object_id === clientRequestId
      );
      assert.ok(clientRejected, 'expected query.rejected for rejected native client read');
      assert.equal(clientRejected.data.query_shape, 'record_list');
      assert.equal(clientRejected.data.source?.kind, 'provider_native');
      assert.equal(clientRejected.data.source?.id, nativeManifest.provider_id);
      assert.equal(clientRejected.data.error?.code, 'invalid_request');
      assert.ok(!('connector_id' in (clientRejected.data || {})));

      const ownerToken = await issueOwnerToken(asUrl, 'employee_1');
      const ownerRejectedResp = await fetch(`${rsUrl}/v1/streams/not_a_stream`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(ownerRejectedResp.status, 404);
      const ownerRequestId = ownerRejectedResp.headers.get('Request-Id');
      const ownerTraceId = ownerRejectedResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(ownerRequestId?.startsWith('req_'));
      assert.ok(ownerTraceId?.startsWith('trc_qry_'));

      const { body: ownerTrace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(ownerTraceId)}`);
      const ownerRejected = (ownerTrace.data || []).find((event) =>
        event.event_type === 'query.rejected'
        && event.object_id === ownerRequestId
      );
      assert.ok(ownerRejected, 'expected query.rejected for rejected native owner read');
      assert.equal(ownerRejected.stream_id, 'not_a_stream');
      assert.equal(ownerRejected.data.query_shape, 'stream_metadata');
      assert.equal(ownerRejected.data.source?.kind, 'provider_native');
      assert.equal(ownerRejected.data.source?.id, nativeManifest.provider_id);
      assert.equal(ownerRejected.data.error?.code, 'not_found');
      assert.ok(!('connector_id' in (ownerRejected.data || {})));
    });
  });

  await t.test('stores connector and native source identities in queryable spine columns', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'employee_1');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const nativeProviderId = 'provider_native_spine_column_test';
      await emitSpineEvent({
        event_type: 'test.native_source',
        actor_type: 'provider_native',
        actor_id: nativeProviderId,
        object_type: 'test',
        object_id: 'native_source',
        data: { source: { kind: 'provider_native', id: nativeProviderId } },
      });

      const db = getDb();
      const connectorRows = db.prepare(
        'SELECT COUNT(*) AS count FROM spine_events WHERE source_kind = ? AND source_id = ?'
      ).get('connector', SPOTIFY_CONNECTOR_KEY);
      const nativeRows = db.prepare(
        'SELECT COUNT(*) AS count FROM spine_events WHERE source_kind = ? AND source_id = ?'
      ).get('provider_native', nativeProviderId);
      const nullSourceIds = db.prepare(
        "SELECT COUNT(*) AS count FROM spine_events WHERE source_kind IS NOT NULL AND (source_id IS NULL OR source_id = '')"
      ).get();

      assert.ok(connectorRows.count > 0, 'expected connector events to be queryable by source_kind/source_id');
      assert.ok(nativeRows.count > 0, 'expected native events to be queryable by source_kind/source_id');
      assert.equal(nullSourceIds.count, 0, 'sourced spine rows must always carry source_id');
    });
  });

  await t.test('captures auth-gate client read failures on grant traces with auth-gate query.received artifacts', async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      await seedNorthstar(nativeManifest);

      const parResp = await fetch(`${asUrl}/oauth/par`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'longview',
          authorization_details: [
            {
              type: 'https://pdpp.org/data-access',
              source: { kind: 'provider_native', id: nativeManifest.provider_id },
              purpose_code: 'https://pdpp.org/purpose/financial_planning',
              purpose_description: 'Trace auth-gate failures for native client reads',
              access_mode: 'continuous',
              streams: [{ name: 'pay_statements' }],
            },
          ],
        }),
      });
      assert.equal(parResp.status, 201);
      const initiate = await parResp.json();

      const consentResp = await fetch(`${asUrl}/consent/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_uri: initiate.request_uri, subject_id: 'employee_1' }),
      });
      assert.equal(consentResp.status, 200);
      const approval = await consentResp.json();

      const { body: grantTimelineBefore } = await fetchJson(
        `${asUrl}/_ref/grants/${encodeURIComponent(approval.grant.grant_id)}/timeline`,
      );
      const issuedEvent = (grantTimelineBefore.data || []).find((event) => event.event_type === 'grant.issued');
      assert.ok(issuedEvent, 'expected grant.issued event');

      getDb().prepare('UPDATE grants SET storage_binding_json = NULL WHERE grant_id = ?').run(approval.grant.grant_id);

      const rejectedResp = await fetch(`${rsUrl}/v1/streams`, {
        headers: { Authorization: `Bearer ${approval.token}` },
      });
      assert.equal(rejectedResp.status, 403);
      const requestId = rejectedResp.headers.get('Request-Id');
      const traceId = rejectedResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(requestId?.startsWith('req_'));
      assert.equal(traceId, issuedEvent.trace_id);

      const { body: grantTimelineAfter } = await fetchJson(
        `${asUrl}/_ref/grants/${encodeURIComponent(approval.grant.grant_id)}/timeline`,
      );
      const { body: traceTimeline } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(traceId)}`);

      for (const timeline of [grantTimelineAfter, traceTimeline]) {
        const received = (timeline.data || []).find((event) =>
          event.event_type === 'query.received'
          && event.object_id === requestId,
        );
        assert.ok(received, 'expected auth-gate query.received artifact');
        assert.equal(received.trace_id, traceId);
        assert.equal(received.stream_id, null);
        assert.equal(received.data.query_shape, 'stream_list');
        assert.equal(received.data.auth_gate, true);

        const rejected = (timeline.data || []).find((event) =>
          event.event_type === 'query.rejected'
          && event.object_id === requestId,
        );
        assert.ok(rejected, 'expected auth-gate query.rejected artifact');
        assert.equal(rejected.trace_id, traceId);
        assert.equal(rejected.stream_id, null);
        assert.equal(rejected.data.query_shape, 'stream_list');
        assert.equal(rejected.data.auth_gate, true);
        assert.equal(rejected.data.error?.code, 'grant_invalid');
      }
    });
  });

  await t.test('captures successful owner ingest and delete artifacts on owner traces', async () => {
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
          key: 'event_spine_owner_mutation_success',
          data: { id: 'event_spine_owner_mutation_success', name: 'Event Spine Success', genres: ['idm'] },
          emitted_at: new Date().toISOString(),
        })}\n${JSON.stringify({
          key: 'event_spine_owner_mutation_bad_json',
          data: { id: 'event_spine_owner_mutation_bad_json', name: 'Broken' },
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
      const ingestRequested = (ingestTrace.data || []).find((event) =>
        event.event_type === 'mutation.requested'
        && event.object_id === ingestRequestId,
      );
      assert.ok(ingestRequested, 'expected mutation.requested for successful owner ingest');
      assert.equal(ingestRequested.stream_id, 'top_artists');
      assert.equal(ingestRequested.data.operation, 'ingest_records');
      assert.equal(ingestRequested.data.submitted_record_count, 2);
      assert.equal(ingestRequested.data.source?.kind, 'connector');
      assert.equal(ingestRequested.data.source?.id, SPOTIFY_CONNECTOR_KEY);
      assert.ok(!('connector_id' in (ingestRequested.data || {})));

      const ingestCompleted = (ingestTrace.data || []).find((event) =>
        event.event_type === 'mutation.completed'
        && event.object_id === ingestRequestId,
      );
      assert.ok(ingestCompleted, 'expected mutation.completed for successful owner ingest');
      assert.equal(ingestCompleted.stream_id, 'top_artists');
      assert.equal(ingestCompleted.data.operation, 'ingest_records');
      assert.equal(ingestCompleted.data.records_accepted, 1);
      assert.equal(ingestCompleted.data.records_rejected, 1);
      assert.equal(ingestCompleted.data.error_count, 1);
      assert.equal(ingestCompleted.data.source?.kind, 'connector');
      assert.equal(ingestCompleted.data.source?.id, SPOTIFY_CONNECTOR_KEY);
      assert.ok(!('connector_id' in (ingestCompleted.data || {})));

      const deleteResp = await fetch(
        `${rsUrl}/v1/streams/top_artists/records/${encodeURIComponent('event_spine_owner_mutation_success')}?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
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
      const deleteRequested = (deleteTrace.data || []).find((event) =>
        event.event_type === 'mutation.requested'
        && event.object_id === deleteRequestId,
      );
      assert.ok(deleteRequested, 'expected mutation.requested for successful owner delete');
      assert.equal(deleteRequested.stream_id, 'top_artists');
      assert.equal(deleteRequested.data.operation, 'delete_record');
      assert.equal(deleteRequested.data.requested_record_id, 'event_spine_owner_mutation_success');
      assert.equal(deleteRequested.data.source?.kind, 'connector');
      assert.equal(deleteRequested.data.source?.id, SPOTIFY_CONNECTOR_KEY);
      assert.ok(!('connector_id' in (deleteRequested.data || {})));

      const deleteCompleted = (deleteTrace.data || []).find((event) =>
        event.event_type === 'mutation.completed'
        && event.object_id === deleteRequestId,
      );
      assert.ok(deleteCompleted, 'expected mutation.completed for successful owner delete');
      assert.equal(deleteCompleted.stream_id, 'top_artists');
      assert.equal(deleteCompleted.data.operation, 'delete_record');
      assert.equal(deleteCompleted.data.requested_record_id, 'event_spine_owner_mutation_success');
      assert.equal(deleteCompleted.data.deleted_record_count, 1);
      assert.equal(deleteCompleted.data.source?.kind, 'connector');
      assert.equal(deleteCompleted.data.source?.id, SPOTIFY_CONNECTOR_KEY);
      assert.ok(!('connector_id' in (deleteCompleted.data || {})));
    });
  });

  await t.test('captures rejected owner mutation artifacts on owner traces', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');

      const rejectedResp = await fetch(
        `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent('missing_spotify_connector')}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${ownerToken}` },
        },
      );
      assert.equal(rejectedResp.status, 404);
      const requestId = rejectedResp.headers.get('Request-Id');
      const traceId = rejectedResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(requestId?.startsWith('req_'));
      assert.ok(traceId?.startsWith('trc_mut_'));

      const { body: trace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(traceId)}`);
      const requested = (trace.data || []).find((event) =>
        event.event_type === 'mutation.requested'
        && event.object_id === requestId,
      );
      assert.ok(requested, 'expected mutation.requested for rejected owner delete');
      assert.equal(requested.stream_id, 'top_artists');
      assert.equal(requested.data.operation, 'delete_stream_records');

      const rejected = (trace.data || []).find((event) =>
        event.event_type === 'mutation.rejected'
        && event.object_id === requestId,
      );
      assert.ok(rejected, 'expected mutation.rejected for rejected owner delete');
      assert.equal(rejected.stream_id, 'top_artists');
      assert.equal(rejected.data.operation, 'delete_stream_records');
      assert.equal(rejected.data.error?.code, 'not_found');
      assert.match(rejected.data.error?.message || '', /Unknown connector: missing_spotify_connector/);
    });
  });

  await t.test('captures owner state artifacts on owner traces', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');

      const updateResp = await fetch(`${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ state: { top_artists: { cursor: 'owner_trace_cursor' } } }),
      });
      assert.equal(updateResp.status, 200);
      const updateRequestId = updateResp.headers.get('Request-Id');
      const updateTraceId = updateResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(updateRequestId?.startsWith('req_'));
      assert.ok(updateTraceId?.startsWith('trc_state'));

      const { body: updateTrace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(updateTraceId)}`);
      const updateRequested = (updateTrace.data || []).find((event) =>
        event.event_type === 'state.requested'
        && event.object_id === updateRequestId,
      );
      assert.ok(updateRequested, 'expected state.requested for owner state write');
      assert.equal(updateRequested.data.state_scope, 'owner');
      assert.equal(updateRequested.data.operation, 'write');
      assert.deepEqual(updateRequested.data.requested_streams, ['top_artists']);
      assert.equal(updateRequested.data.source?.kind, 'connector');
      assert.equal(updateRequested.data.source?.id, SPOTIFY_CONNECTOR_KEY);

      const updated = (updateTrace.data || []).find((event) =>
        event.event_type === 'state.updated'
        && event.object_id === updateRequestId,
      );
      assert.ok(updated, 'expected state.updated for owner state write');
      assert.deepEqual(updated.data.persisted_streams, ['top_artists']);

      const getResp = await fetch(`${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(getResp.status, 200);
      const getRequestId = getResp.headers.get('Request-Id');
      const getTraceId = getResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(getRequestId?.startsWith('req_'));
      assert.ok(getTraceId?.startsWith('trc_state'));
      const getBody = await getResp.json();
      assert.deepEqual(getBody.state, { top_artists: { cursor: 'owner_trace_cursor' } });

      const { body: getTrace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(getTraceId)}`);
      const served = (getTrace.data || []).find((event) =>
        event.event_type === 'state.served'
        && event.object_id === getRequestId,
      );
      assert.ok(served, 'expected state.served for owner state read');
      assert.deepEqual(served.data.visible_streams, ['top_artists']);

      const rejectedResp = await fetch(`${rsUrl}/v1/state/${encodeURIComponent('missing_spotify_connector')}`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(rejectedResp.status, 404);
      const rejectedRequestId = rejectedResp.headers.get('Request-Id');
      const rejectedTraceId = rejectedResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(rejectedRequestId?.startsWith('req_'));
      assert.ok(rejectedTraceId?.startsWith('trc_state'));

      const { body: rejectedTrace } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(rejectedTraceId)}`);
      const rejected = (rejectedTrace.data || []).find((event) =>
        event.event_type === 'state.rejected'
        && event.object_id === rejectedRequestId,
      );
      assert.ok(rejected, 'expected state.rejected for rejected owner state read');
      assert.equal(rejected.data.state_scope, 'owner');
      assert.equal(rejected.data.operation, 'read');
      assert.equal(rejected.data.error?.code, 'not_found');
      assert.match(rejected.data.error?.message || '', /Unknown connector: missing_spotify_connector/);
    });
  });

  await t.test('captures grant-scoped state artifacts on grant timelines', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      const parResp = await fetch(`${asUrl}/oauth/par`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'concert_recommendation_app',
          authorization_details: [
            {
              type: 'https://pdpp.org/data-access',
              source: { kind: 'connector', id: spotifyManifest.connector_id },
              purpose_code: 'https://pdpp.org/purpose/personalization',
              purpose_description: 'Maintain grant-scoped state for trace inspection',
              access_mode: 'continuous',
              streams: [{ name: 'top_artists' }],
            },
          ],
        }),
      });
      assert.equal(parResp.status, 201);
      const initiate = await parResp.json();

      const consentResp = await fetch(`${asUrl}/consent/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_uri: initiate.request_uri, subject_id: 'u1' }),
      });
      assert.equal(consentResp.status, 200);
      const approval = await consentResp.json();

      const updateResp = await fetch(
        `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}?grant_id=${encodeURIComponent(approval.grant.grant_id)}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ state: { top_artists: { cursor: 'grant_trace_cursor' } } }),
        },
      );
      assert.equal(updateResp.status, 200);
      const updateRequestId = updateResp.headers.get('Request-Id');
      const updateTraceId = updateResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(updateRequestId?.startsWith('req_'));
      assert.ok(updateTraceId?.startsWith('trc_'));

      const { body: timelineAfterUpdate } = await fetchJson(`${asUrl}/_ref/grants/${encodeURIComponent(approval.grant.grant_id)}/timeline`);
      const updateRequested = (timelineAfterUpdate.data || []).find((event) =>
        event.event_type === 'state.requested'
        && event.object_id === updateRequestId,
      );
      assert.ok(updateRequested, 'expected state.requested for grant-scoped state write');
      assert.equal(updateRequested.trace_id, updateTraceId);
      assert.equal(updateRequested.data.state_scope, 'grant');
      assert.equal(updateRequested.data.operation, 'write');
      assert.deepEqual(updateRequested.data.requested_streams, ['top_artists']);

      const updated = (timelineAfterUpdate.data || []).find((event) =>
        event.event_type === 'state.updated'
        && event.object_id === updateRequestId,
      );
      assert.ok(updated, 'expected state.updated for grant-scoped state write');
      assert.equal(updated.trace_id, updateTraceId);
      assert.deepEqual(updated.data.persisted_streams, ['top_artists']);

      const getResp = await fetch(
        `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}?grant_id=${encodeURIComponent(approval.grant.grant_id)}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      assert.equal(getResp.status, 200);
      const getRequestId = getResp.headers.get('Request-Id');
      const getTraceId = getResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(getRequestId?.startsWith('req_'));
      assert.ok(getTraceId?.startsWith('trc_'));

      const { body: timelineAfterGet } = await fetchJson(`${asUrl}/_ref/grants/${encodeURIComponent(approval.grant.grant_id)}/timeline`);
      const served = (timelineAfterGet.data || []).find((event) =>
        event.event_type === 'state.served'
        && event.object_id === getRequestId,
      );
      assert.ok(served, 'expected state.served for grant-scoped state read');
      assert.equal(served.trace_id, getTraceId);
      assert.deepEqual(served.data.visible_streams, ['top_artists']);

      const rejectedResp = await fetch(
        `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}?grant_id=${encodeURIComponent(approval.grant.grant_id)}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ state: { recently_played: { cursor: 'outside_grant_cursor' } } }),
        },
      );
      assert.equal(rejectedResp.status, 400);
      const rejectedRequestId = rejectedResp.headers.get('Request-Id');
      const rejectedTraceId = rejectedResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(rejectedRequestId?.startsWith('req_'));
      assert.ok(rejectedTraceId?.startsWith('trc_'));

      const { body: timelineAfterRejectedPut } = await fetchJson(`${asUrl}/_ref/grants/${encodeURIComponent(approval.grant.grant_id)}/timeline`);
      const rejected = (timelineAfterRejectedPut.data || []).find((event) =>
        event.event_type === 'state.rejected'
        && event.object_id === rejectedRequestId,
      );
      assert.ok(rejected, 'expected state.rejected for rejected grant-scoped state write');
      assert.equal(rejected.trace_id, rejectedTraceId);
      assert.equal(rejected.data.state_scope, 'grant');
      assert.equal(rejected.data.operation, 'write');
      assert.deepEqual(rejected.data.requested_streams, ['recently_played']);
      assert.equal(rejected.data.error?.code, 'invalid_request');
      assert.match(rejected.data.error?.message || '', /is not scoped to stream recently_played/);
    });
  });

  await t.test('captures run lifecycle events for a seeded connector run', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      const result = await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      assert.ok(result.run_id, 'expected run_id in runConnector result');
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const runTypes = (runTimeline.data || []).map((event) => event.event_type);
      assert.equal(runTimeline.run_id, result.run_id);

      assert.ok(runTypes.includes('run.started'));
      assert.ok(runTypes.includes('run.progress_reported'));
      assert.ok(runTypes.includes('run.batch_ingested'));
      assert.ok(runTypes.includes('run.state_staged'));
      assert.ok(runTypes.includes('run.state_advanced'));
      assert.ok(runTypes.includes('run.completed'));
      assert.ok(!runTypes.includes('run.failed'));

      const startedIndex = runTypes.indexOf('run.started');
      const stateStagedIndex = runTypes.indexOf('run.state_staged');
      const stateAdvancedIndex = runTypes.indexOf('run.state_advanced');
      const completedIndex = runTypes.indexOf('run.completed');
      assert.ok(startedIndex !== -1 && completedIndex !== -1 && startedIndex < completedIndex);
      assert.ok(startedIndex < stateStagedIndex, 'run.state_staged should follow run.started');
      assert.ok(stateStagedIndex < stateAdvancedIndex, 'run.state_advanced should follow run.state_staged');

      for (const event of runTimeline.data || []) {
        if (!String(event.event_type || '').startsWith('run.')) continue;
        if (!event.data) continue;
        assert.equal(event.data.source?.kind, 'connector');
        assert.equal(event.data.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.ok(!('connector_id' in event.data), `${event.event_type} should use source descriptors instead of raw connector_id`);
      }

      const stagedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.state_staged');
      const startedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.started');
      assert.ok(startedEvent, 'expected run.started event');
      assert.equal(startedEvent.data.collection_mode, 'full_refresh');
      assert.equal(startedEvent.data.persist_state, true);
      assert.equal(startedEvent.data.state_commit_intent, 'commit_on_success');
      assert.deepEqual(startedEvent.data.bindings, {
        network: {},
        filesystem: {},
        browser: {},
        interactive: {},
      });
      assert.deepEqual(startedEvent.data.scope, {
        streams: [
          { name: 'top_artists' },
          { name: 'saved_tracks' },
          { name: 'recently_played' },
        ],
      });
      assert.deepEqual(startedEvent.data.scope_streams, ['top_artists', 'saved_tracks', 'recently_played']);
      assert.equal(stagedEvent.data.checkpoint_mode, 'checkpointed_streaming');
      assert.equal(stagedEvent.data.state_commit_intent, 'commit_on_success');

      const progressEvents = (runTimeline.data || []).filter((event) => event.event_type === 'run.progress_reported');
      assert.ok(progressEvents.length >= 3, 'expected seed run progress to be durable in the run timeline');
      assert.ok(progressEvents.some((event) => event.data.stream === 'top_artists'));

      const completedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.completed');
      assert.equal(completedEvent.data.checkpoint_mode, 'checkpointed_streaming');
      assert.equal(completedEvent.data.checkpoint_commit_status, 'committed');
      assert.equal(completedEvent.data.buffered_records_dropped, 0);
    });
  });

  await t.test('captures per-stream checkpoint commit counts for multi-stream successful runs', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    const manifest = {
      connector_id: 'event-spine-multi-stream-checkpoint-test',
      version: '0.1.0',
      streams: [
        {
          name: 'items',
          primary_key: ['id'],
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              value: { type: 'string' },
            },
            required: ['id'],
          },
        },
        {
          name: 'other_items',
          primary_key: ['id'],
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              value: { type: 'string' },
            },
            required: ['id'],
          },
        },
      ],
    };

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-event-spine-multi-stream-commit-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: 'multi_stream_item',
    data: { id: 'multi_stream_item', value: 'items value' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'items',
    cursor: { cursor: 'items_cursor' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'other_items',
    key: 'multi_stream_other_item',
    data: { id: 'multi_stream_other_item', value: 'other value' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'other_items',
    cursor: { cursor: 'other_items_cursor' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 2,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf8');

    try {
      const registerResp = await fetch(`${asUrl}/connectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(manifest),
      });
      assert.equal(registerResp.status, 201);

      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      const result = await runConnector({
        connectorPath,
        connectorId: manifest.connector_id,
        ownerToken,
        manifest,
        state: null,
        collectionMode: 'incremental',
        persistState: true,
        rsUrl,
        onInteraction: async () => ({}),
      });

      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const stagedEvents = (runTimeline.data || []).filter((event) => event.event_type === 'run.state_staged');
      const advancedEvents = (runTimeline.data || []).filter((event) => event.event_type === 'run.state_advanced');

      assert.equal(stagedEvents.length, 2);
      assert.equal(advancedEvents.length, 2);
      assert.deepEqual(
        stagedEvents
          .map((event) => event.data.state_streams_staged)
          .sort((a, b) => a - b),
        [1, 2],
      );
      assert.deepEqual(
        advancedEvents
          .map((event) => event.data.state_streams_committed)
          .sort((a, b) => a - b),
        [1, 2],
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('captures partial checkpoint commit failures after DONE(succeeded)', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const asUrl = `http://localhost:${server.asPort}`;
    const manifest = {
      connector_id: 'https://registry.pdpp.org/connectors/event-spine-partial-checkpoint-failure-test',
      version: '0.1.0',
      streams: [
        {
          name: 'items',
          primary_key: ['id'],
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              value: { type: 'string' },
            },
            required: ['id'],
          },
        },
        {
          name: 'other_items',
          primary_key: ['id'],
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              value: { type: 'string' },
            },
            required: ['id'],
          },
        },
      ],
    };

    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-event-spine-partial-checkpoint-failure-'));
    const connectorPath = join(tmpDir, 'connector.mjs');
    writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: 'partial_checkpoint_item',
    data: { id: 'partial_checkpoint_item', value: 'items value' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'items',
    cursor: { cursor: 'items_cursor_partial_commit' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'other_items',
    key: 'partial_checkpoint_other_item',
    data: { id: 'partial_checkpoint_other_item', value: 'other value' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'other_items',
    cursor: { cursor: 'other_items_cursor_partial_commit' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 2,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf8');

    const committedState = [];
    let stateWriteCount = 0;
    const rsServer = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'POST' && url.pathname.startsWith('/v1/ingest/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ records_accepted: 1, records_rejected: 0 }));
        return;
      }

      if (req.method === 'PUT' && url.pathname === `/v1/state/${encodeURIComponent(manifest.connector_id)}`) {
        let body = '';
        for await (const chunk of req) body += chunk;
        stateWriteCount += 1;
        const payload = JSON.parse(body || '{}');
        if (stateWriteCount === 1) {
          committedState.push(payload.state);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'simulated_state_write_failure' }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });

    try {
      await new Promise((resolve) => rsServer.listen(0, resolve));
      const rsPort = rsServer.address().port;

      const registerResp = await fetch(`${asUrl}/connectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(manifest),
      });
      assert.equal(registerResp.status, 201);

      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      let rejected = null;
      await assert.rejects(
        async () => {
          await runConnector({
            connectorPath,
            connectorId: manifest.connector_id,
            ownerToken,
            manifest,
            state: null,
            collectionMode: 'incremental',
            persistState: true,
            rsUrl: `http://localhost:${rsPort}`,
            onInteraction: async () => ({}),
          });
        },
        (err) => {
          rejected = err;
          assert.equal(err.failure_reason, 'runtime_error');
          assert.equal(err.terminal_reason, 'runtime_error');
          assert.equal(err.checkpoint_summary.state_streams_staged, 2);
          assert.equal(err.checkpoint_summary.state_streams_committed, 1);
          return true;
        },
      );

      assert.deepEqual(committedState, [{ items: { cursor: 'items_cursor_partial_commit' } }]);
      const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
      const runTypes = (runTimeline.data || []).map((event) => event.event_type);
      assert.ok(runTypes.includes('run.state_staged'));
      assert.ok(runTypes.includes('run.state_advanced'));
      assert.ok(runTypes.includes('run.state_commit_failed'));
      assert.ok(runTypes.includes('run.failed'));
      assert.ok(!runTypes.includes('run.completed'));

      const advancedEvents = (runTimeline.data || []).filter((event) => event.event_type === 'run.state_advanced');
      assert.equal(advancedEvents.length, 1);
      assert.equal(advancedEvents[0].stream_id, 'items');
      assert.equal(advancedEvents[0].data.state_streams_committed, 1);

      const commitFailedEvents = (runTimeline.data || []).filter((event) => event.event_type === 'run.state_commit_failed');
      assert.equal(commitFailedEvents.length, 1);
      assert.equal(commitFailedEvents[0].stream_id, 'other_items');
      assert.deepEqual(commitFailedEvents[0].data.cursor, { cursor: 'other_items_cursor_partial_commit' });
      assert.equal(commitFailedEvents[0].data.state_streams_staged, 2);
      assert.equal(commitFailedEvents[0].data.state_streams_committed, 1);
      assert.match(commitFailedEvents[0].data.error_message, /State persistence failed for other_items: 500/);

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'expected run.failed event for partial checkpoint commit failure');
      assert.equal(failedEvent.data.reason, 'runtime_error');
      assert.equal(failedEvent.data.checkpoint_commit_status, 'partially_committed');
      assert.equal(failedEvent.data.state_streams_staged, 2);
      assert.equal(failedEvent.data.state_streams_committed, 1);

      for (const event of [...advancedEvents, failedEvent]) {
        assert.equal(event.data.source?.kind, 'connector');
        assert.equal(event.data.source?.id, manifest.connector_id);
        assert.ok(!('connector_id' in event.data), `${event.event_type} should use source descriptors instead of raw connector_id`);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeHttpServer(rsServer);
      await closeServer(server);
    }
  });

  await t.test('captures runtime authentication failures from ingest', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-event-spine-runtime-auth-failure-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'top_artists',
    key: 'runtime_auth_failure_event',
    data: { id: 'runtime_auth_failure_event', value: 'before auth failure' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 1,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf8');

      const rsServer = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (req.method === 'POST' && url.pathname === '/v1/ingest/top_artists') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: {
              message: 'Invalid or expired token',
            },
          }));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
      });

      try {
        await new Promise((resolve) => rsServer.listen(0, resolve));
        const rsPort = rsServer.address().port;

        let rejected = null;
        await assert.rejects(
          async () => {
            await runConnector({
              connectorPath,
              connectorId: spotifyManifest.connector_id,
              ownerToken: 'invalid_owner_token',
              manifest: spotifyManifest,
              state: null,
              collectionMode: 'full_refresh',
              rsUrl: `http://localhost:${rsPort}`,
            });
          },
          (err) => {
            rejected = err;
            assert.equal(err.failure_reason, 'authentication_error');
            assert.equal(err.terminal_reason, 'authentication_error');
            return true;
          },
        );

        const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
        const runTypes = (runTimeline.data || []).map((event) => event.event_type);
        assert.ok(runTypes.includes('run.failed'));
        assert.ok(!runTypes.includes('run.completed'));

        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
        assert.ok(failedEvent, 'expected run.failed event');
        assert.equal(failedEvent.data?.source?.kind, 'connector');
        assert.equal(failedEvent.data?.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(failedEvent.data?.reason, 'authentication_error');
        assert.equal(failedEvent.data?.records_emitted, 1);
        assert.equal(failedEvent.data?.records_flushed, 0);
        assert.equal(failedEvent.data?.buffered_records_dropped, 1);
        assert.equal(failedEvent.data?.checkpoint_commit_status, 'not_committed');
      } finally {
        await closeHttpServer(rsServer);
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('captures runtime permission failures from state persistence', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-event-spine-runtime-permission-failure-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'top_artists',
    key: 'runtime_permission_failure_event',
    data: { id: 'runtime_permission_failure_event', value: 'before permission failure' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'top_artists',
    cursor: { cursor: 'runtime_permission_failure_cursor' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 1,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf8');

      const rsServer = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (req.method === 'POST' && url.pathname === '/v1/ingest/top_artists') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ records_accepted: 1, records_rejected: 0 }));
          return;
        }

        if (req.method === 'PUT' && url.pathname === `/v1/state/${encodeURIComponent(SPOTIFY_CONNECTOR_KEY)}`) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: {
              message: 'Owner token required',
            },
          }));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
      });

      try {
        await new Promise((resolve) => rsServer.listen(0, resolve));
        const rsPort = rsServer.address().port;

        let rejected = null;
        await assert.rejects(
          async () => {
            await runConnector({
              connectorPath,
              connectorId: spotifyManifest.connector_id,
              ownerToken: 'client_token_instead_of_owner',
              manifest: spotifyManifest,
              state: null,
              collectionMode: 'incremental',
              persistState: true,
              rsUrl: `http://localhost:${rsPort}`,
            });
          },
          (err) => {
            rejected = err;
            assert.equal(err.failure_reason, 'permission_error');
            assert.equal(err.terminal_reason, 'permission_error');
            return true;
          },
        );

        const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
        const stagedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.state_staged');
        assert.ok(stagedEvent, 'expected run.state_staged event before permission failure');

        const advancedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.state_advanced');
        assert.equal(advancedEvent, undefined, 'permission failure should not commit checkpoint state');

        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
        assert.ok(failedEvent, 'expected run.failed event');
        assert.equal(failedEvent.data?.source?.kind, 'connector');
        assert.equal(failedEvent.data?.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(failedEvent.data?.reason, 'permission_error');
        assert.equal(failedEvent.data?.records_emitted, 1);
        assert.equal(failedEvent.data?.records_flushed, 1);
        assert.equal(failedEvent.data?.buffered_records_dropped, 0);
        assert.equal(failedEvent.data?.checkpoint_commit_status, 'not_committed');
        assert.equal(failedEvent.data?.state_streams_staged, 1);
        assert.equal(failedEvent.data?.state_streams_committed, 0);
      } finally {
        await closeHttpServer(rsServer);
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('captures deterministic runtime connector_invalid failures from ingest', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-event-spine-runtime-connector-invalid-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'top_artists',
    key: 'runtime_connector_invalid_event',
    data: { id: 'runtime_connector_invalid_event', value: 'before connector invalid' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 1,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf8');

      const rsServer = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (req.method === 'POST' && url.pathname === '/v1/ingest/top_artists') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: {
              type: 'invalid_request_error',
              code: 'connector_invalid',
              message: 'Connector manifest is malformed',
            },
          }));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
      });

      try {
        await new Promise((resolve) => rsServer.listen(0, resolve));
        const rsPort = rsServer.address().port;

        let rejected = null;
        await assert.rejects(
          async () => {
            await runConnector({
              connectorPath,
              connectorId: spotifyManifest.connector_id,
              ownerToken: 'owner_token',
              manifest: spotifyManifest,
              state: null,
              collectionMode: 'full_refresh',
              rsUrl: `http://localhost:${rsPort}`,
            });
          },
          (err) => {
            rejected = err;
            assert.equal(err.failure_reason, 'connector_invalid');
            assert.equal(err.terminal_reason, 'connector_invalid');
            return true;
          },
        );

        const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
        assert.ok(failedEvent, 'expected run.failed event');
        assert.equal(failedEvent.data?.source?.kind, 'connector');
        assert.equal(failedEvent.data?.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(failedEvent.data?.reason, 'connector_invalid');
        assert.equal(failedEvent.data?.records_emitted, 1);
        assert.equal(failedEvent.data?.records_flushed, 0);
        assert.equal(failedEvent.data?.buffered_records_dropped, 1);
        assert.equal(failedEvent.data?.checkpoint_commit_status, 'not_committed');
      } finally {
        await closeHttpServer(rsServer);
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('captures retryable runtime rate_limit_error failures from ingest', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-event-spine-runtime-rate-limit-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'top_artists',
    key: 'runtime_rate_limit_event',
    data: { id: 'runtime_rate_limit_event', value: 'before rate limit' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 1,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf8');

      const rsServer = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (req.method === 'POST' && url.pathname === '/v1/ingest/top_artists') {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: {
              message: 'Too many requests',
            },
          }));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
      });

      try {
        await new Promise((resolve) => rsServer.listen(0, resolve));
        const rsPort = rsServer.address().port;

        let rejected = null;
        await assert.rejects(
          async () => {
            await runConnector({
              connectorPath,
              connectorId: spotifyManifest.connector_id,
              ownerToken: 'owner_token',
              manifest: spotifyManifest,
              state: null,
              collectionMode: 'full_refresh',
              rsUrl: `http://localhost:${rsPort}`,
            });
          },
          (err) => {
            rejected = err;
            assert.equal(err.failure_reason, 'rate_limit_error');
            assert.equal(err.terminal_reason, 'rate_limit_error');
            return true;
          },
        );

        const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
        assert.ok(failedEvent, 'expected run.failed event');
        assert.equal(failedEvent.data?.source?.kind, 'connector');
        assert.equal(failedEvent.data?.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(failedEvent.data?.reason, 'rate_limit_error');
        assert.equal(failedEvent.data?.records_emitted, 1);
        assert.equal(failedEvent.data?.records_flushed, 0);
        assert.equal(failedEvent.data?.buffered_records_dropped, 1);
        assert.equal(failedEvent.data?.checkpoint_commit_status, 'not_committed');
      } finally {
        await closeHttpServer(rsServer);
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('captures terminal counter mismatch failures after DONE(succeeded)', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-event-spine-terminal-counter-mismatch-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'top_artists',
    key: 'terminal_counter_mismatch_event',
    data: { id: 'terminal_counter_mismatch_event', value: 'before terminal mismatch' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'top_artists',
    cursor: { cursor: 'terminal_counter_mismatch_cursor' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 2,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf8');

      try {
        let rejected = null;
        await assert.rejects(
          async () => {
            await runConnector({
              connectorPath,
              connectorId: spotifyManifest.connector_id,
              ownerToken,
              manifest: spotifyManifest,
              state: null,
              collectionMode: 'incremental',
              persistState: true,
              rsUrl,
              onInteraction: async () => ({}),
            });
          },
          (err) => {
            rejected = err;
            assert.equal(err.failure_reason, 'connector_protocol_violation');
            assert.equal(err.terminal_reason, 'connector_protocol_violation');
            assert.match(err.message, /Connector reported records_emitted 2 but runtime observed 1/);
            assert.equal(err.checkpoint_summary.records_flushed, 1);
            assert.equal(err.checkpoint_summary.state_streams_staged, 1);
            assert.equal(err.checkpoint_summary.state_streams_committed, 0);
            return true;
          },
        );

        const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
        const runTypes = (runTimeline.data || []).map((event) => event.event_type);
        assert.ok(runTypes.includes('run.state_staged'));
        assert.ok(runTypes.includes('run.failed'));
        assert.ok(!runTypes.includes('run.state_advanced'));
        assert.ok(!runTypes.includes('run.completed'));

        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
        assert.ok(failedEvent, 'expected run.failed event for terminal counter mismatch');
        assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
        assert.equal(failedEvent.data.records_emitted, 1);
        assert.equal(failedEvent.data.reported_records_emitted, 2);
        assert.equal(failedEvent.data.records_flushed, 1);
        assert.equal(failedEvent.data.state_streams_staged, 1);
        assert.equal(failedEvent.data.state_streams_committed, 0);
        assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');

        for (const event of (runTimeline.data || []).filter((entry) => ['run.state_staged', 'run.failed'].includes(entry.event_type))) {
          assert.equal(event.data.source?.kind, 'connector');
          assert.equal(event.data.source?.id, SPOTIFY_CONNECTOR_KEY);
          assert.ok(!('connector_id' in event.data), `${event.event_type} should use source descriptors instead of raw connector_id`);
        }
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('captures connector-declared terminal error details on failed runs', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-event-spine-terminal-error-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'top_artists',
    key: 'terminal_error_event',
    data: { id: 'terminal_error_event', value: 'before terminal failure' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'failed',
    records_emitted: 1,
    error: { message: 'Remote provider rate limit', retryable: true },
  }) + '\\n');
  rl.close();
  process.exit(1);
});
`, 'utf8');

      try {
        const result = await runConnector({
          connectorPath,
          connectorId: spotifyManifest.connector_id,
          ownerToken,
          manifest: spotifyManifest,
          state: null,
          collectionMode: 'full_refresh',
          rsUrl,
          onInteraction: async () => ({}),
        });

        assert.equal(result.status, 'failed');
        assert.equal(result.terminal_reason, 'connector_reported_failed');
        assert.deepEqual(result.connector_error, {
          message: 'Remote provider rate limit',
          retryable: true,
        });

        const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
        const runTypes = (runTimeline.data || []).map((event) => event.event_type);
        assert.ok(!runTypes.includes('run.completed'));
        assert.ok(runTypes.includes('run.failed'));

        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
        assert.ok(failedEvent, 'expected run.failed event');
        assert.equal(failedEvent.data.source?.kind, 'connector');
        assert.equal(failedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(failedEvent.data.reason, 'connector_reported_failed');
        assert.equal(failedEvent.data.connector_error_message, 'Remote provider rate limit');
        assert.equal(failedEvent.data.connector_error_retryable, true);
        assert.equal(failedEvent.data.buffered_records_dropped, 1);
        assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('captures connector-declared terminal error details on cancelled runs', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-event-spine-terminal-cancelled-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'top_artists',
    key: 'terminal_cancelled_event',
    data: { id: 'terminal_cancelled_event', value: 'before terminal cancellation' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'cancelled',
    records_emitted: 1,
    error: { message: 'User denied follow-up verification', retryable: false },
  }) + '\\n');
  rl.close();
  process.exit(1);
});
`, 'utf8');

      try {
        const result = await runConnector({
          connectorPath,
          connectorId: spotifyManifest.connector_id,
          ownerToken,
          manifest: spotifyManifest,
          state: null,
          collectionMode: 'full_refresh',
          rsUrl,
          onInteraction: async () => ({}),
        });

        assert.equal(result.status, 'cancelled');
        assert.equal(result.terminal_reason, 'connector_reported_cancelled');
        assert.deepEqual(result.connector_error, {
          message: 'User denied follow-up verification',
          retryable: false,
        });

        const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
        const runTypes = (runTimeline.data || []).map((event) => event.event_type);
        assert.ok(!runTypes.includes('run.completed'));
        assert.ok(runTypes.includes('run.failed'));

        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
        assert.ok(failedEvent, 'expected run.failed event');
        assert.equal(failedEvent.status, 'cancelled');
        assert.equal(failedEvent.data.source?.kind, 'connector');
        assert.equal(failedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(failedEvent.data.reason, 'connector_reported_cancelled');
        assert.equal(failedEvent.data.connector_error_message, 'User denied follow-up verification');
        assert.equal(failedEvent.data.connector_error_retryable, false);
        assert.equal(failedEvent.data.buffered_records_dropped, 1);
        assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('captures contradictory DONE(succeeded)+error protocol violations without recording success artifacts', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-event-spine-done-succeeded-error-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 0,
    error: { message: 'contradictory terminal detail', retryable: false },
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf8');

      try {
        let rejected = null;
        await assert.rejects(
          runConnector({
            connectorPath,
            connectorId: spotifyManifest.connector_id,
            ownerToken,
            manifest: spotifyManifest,
            state: null,
            collectionMode: 'full_refresh',
            rsUrl,
            onInteraction: async () => ({}),
          }),
          (err) => {
            rejected = err;
            assert.equal(err.failure_reason, 'connector_protocol_violation');
            assert.match(err.message, /succeeded runs must not include terminal error details/);
            assert.equal(err.connector_error, null);
            return true;
          },
        );

        const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
        const runTypes = (runTimeline.data || []).map((event) => event.event_type);
        assert.ok(!runTypes.includes('run.completed'));
        assert.ok(runTypes.includes('run.failed'));

        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
        assert.ok(failedEvent, 'expected run.failed event');
        assert.equal(failedEvent.data.source?.kind, 'connector');
        assert.equal(failedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
        assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
        assert.ok(!('connector_error_message' in failedEvent.data));
        assert.ok(!('connector_error_retryable' in failedEvent.data));
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('captures post-DONE protocol violations as failed run timelines without completed artifacts', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-event-spine-post-done-violation-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'top_artists',
    key: 'before_done_violation_event',
    data: { id: 'before_done_violation_event', value: 'before_done' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'top_artists',
    cursor: { cursor: 'cursor_before_done_violation_event' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 1,
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'top_artists',
    key: 'after_done_violation_event',
    data: { id: 'after_done_violation_event', value: 'after_done' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf8');

      try {
        let rejected = null;
        await assert.rejects(
          runConnector({
            connectorPath,
            connectorId: spotifyManifest.connector_id,
            ownerToken,
            manifest: spotifyManifest,
            state: null,
            collectionMode: 'incremental',
            persistState: true,
            rsUrl,
            onInteraction: async () => ({}),
          }),
          (err) => {
            rejected = err;
            assert.equal(err.failure_reason, 'connector_protocol_violation');
            return true;
          },
        );

        const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
        const runTypes = (runTimeline.data || []).map((event) => event.event_type);
        assert.ok(runTypes.includes('run.state_staged'));
        assert.ok(!runTypes.includes('run.state_advanced'));
        assert.ok(!runTypes.includes('run.completed'));
        assert.ok(runTypes.includes('run.failed'));

        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
        assert.ok(failedEvent, 'expected run.failed event');
        assert.equal(failedEvent.data.source?.kind, 'connector');
        assert.equal(failedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
        assert.equal(failedEvent.data.records_flushed, 1);
        assert.equal(failedEvent.data.buffered_records_dropped, 0);
        assert.equal(failedEvent.data.state_streams_staged, 1);
        assert.equal(failedEvent.data.state_streams_committed, 0);
        assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('captures post-DONE progress protocol violations without recording progress artifacts', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-event-spine-post-done-progress-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 0,
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'PROGRESS',
    stream: 'top_artists',
    message: 'after done should be rejected',
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf8');

      try {
        let rejected = null;
        await assert.rejects(
          runConnector({
            connectorPath,
            connectorId: spotifyManifest.connector_id,
            ownerToken,
            manifest: spotifyManifest,
            state: null,
            collectionMode: 'incremental',
            persistState: true,
            rsUrl,
            onInteraction: async () => ({}),
          }),
          (err) => {
            rejected = err;
            assert.equal(err.failure_reason, 'connector_protocol_violation');
            return true;
          },
        );

        const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
        const runTypes = (runTimeline.data || []).map((event) => event.event_type);
        assert.ok(!runTypes.includes('run.completed'));
        assert.ok(!runTypes.includes('run.progress_reported'));
        assert.ok(runTypes.includes('run.failed'));

        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
        assert.ok(failedEvent, 'expected run.failed event');
        assert.equal(failedEvent.data.source?.kind, 'connector');
        assert.equal(failedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
        assert.equal(failedEvent.data.records_flushed, 0);
        assert.equal(failedEvent.data.buffered_records_dropped, 0);
        assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('captures undeclared-stream progress protocol violations without recording progress artifacts', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-event-spine-undeclared-progress-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'PROGRESS',
    stream: 'undeclared_stream',
    message: 'undeclared progress should be rejected',
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf8');

      try {
        let rejected = null;
        await assert.rejects(
          runConnector({
            connectorPath,
            connectorId: spotifyManifest.connector_id,
            ownerToken,
            manifest: spotifyManifest,
            state: null,
            collectionMode: 'incremental',
            persistState: true,
            rsUrl,
            onInteraction: async () => ({}),
          }),
          (err) => {
            rejected = err;
            assert.equal(err.failure_reason, 'connector_protocol_violation');
            assert.match(err.message, /PROGRESS for undeclared stream/);
            return true;
          },
        );

        const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
        const runTypes = (runTimeline.data || []).map((event) => event.event_type);
        assert.ok(!runTypes.includes('run.progress_reported'));
        assert.ok(runTypes.includes('run.failed'));

        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
        assert.ok(failedEvent, 'expected run.failed event');
        assert.equal(failedEvent.data.source?.kind, 'connector');
        assert.equal(failedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
        assert.equal(failedEvent.data.records_flushed, 0);
        assert.equal(failedEvent.data.buffered_records_dropped, 0);
        assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('captures post-DONE interaction protocol violations without recording interaction artifacts', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-event-spine-post-done-interaction-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 0,
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'INTERACTION',
    request_id: 'after_done_interaction_event',
    kind: 'manual_action',
    message: 'after done should be rejected',
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf8');

      try {
        let rejected = null;
        await assert.rejects(
          runConnector({
            connectorPath,
            connectorId: spotifyManifest.connector_id,
            ownerToken,
            manifest: spotifyManifest,
            state: null,
            collectionMode: 'incremental',
            persistState: true,
            rsUrl,
            onInteraction: async () => ({
              type: 'INTERACTION_RESPONSE',
              request_id: 'after_done_interaction_event',
              status: 'success',
            }),
          }),
          (err) => {
            rejected = err;
            assert.equal(err.failure_reason, 'connector_protocol_violation');
            return true;
          },
        );

        const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
        const runTypes = (runTimeline.data || []).map((event) => event.event_type);
        assert.ok(!runTypes.includes('run.completed'));
        assert.ok(!runTypes.includes('run.interaction_required'));
        assert.ok(!runTypes.includes('run.interaction_completed'));
        assert.ok(runTypes.includes('run.failed'));

        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
        assert.ok(failedEvent, 'expected run.failed event');
        assert.equal(failedEvent.data.source?.kind, 'connector');
        assert.equal(failedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
        assert.equal(failedEvent.data.records_flushed, 0);
        assert.equal(failedEvent.data.buffered_records_dropped, 0);
        assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('captures post-DONE skip-result protocol violations without recording skip artifacts', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-event-spine-post-done-skip-result-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 0,
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'SKIP_RESULT',
    stream: 'top_artists',
    reason: 'after_done',
    message: 'after done should be rejected',
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf8');

      try {
        let rejected = null;
        await assert.rejects(
          runConnector({
            connectorPath,
            connectorId: spotifyManifest.connector_id,
            ownerToken,
            manifest: spotifyManifest,
            state: null,
            collectionMode: 'incremental',
            persistState: true,
            rsUrl,
            onInteraction: async () => ({}),
          }),
          (err) => {
            rejected = err;
            assert.equal(err.failure_reason, 'connector_protocol_violation');
            return true;
          },
        );

        const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
        const runTypes = (runTimeline.data || []).map((event) => event.event_type);
        assert.ok(!runTypes.includes('run.completed'));
        assert.ok(!runTypes.includes('run.stream_skipped'));
        assert.ok(runTypes.includes('run.failed'));

        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
        assert.ok(failedEvent, 'expected run.failed event');
        assert.equal(failedEvent.data.source?.kind, 'connector');
        assert.equal(failedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
        assert.equal(failedEvent.data.records_flushed, 0);
        assert.equal(failedEvent.data.buffered_records_dropped, 0);
        assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('captures undeclared-stream skip-result protocol violations without recording skip artifacts', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-event-spine-undeclared-skip-result-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'SKIP_RESULT',
    stream: 'undeclared_stream',
    reason: 'rate_limited',
    message: 'undeclared skip should be rejected',
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf8');

      try {
        let rejected = null;
        await assert.rejects(
          runConnector({
            connectorPath,
            connectorId: spotifyManifest.connector_id,
            ownerToken,
            manifest: spotifyManifest,
            state: null,
            collectionMode: 'incremental',
            persistState: true,
            rsUrl,
            onInteraction: async () => ({}),
          }),
          (err) => {
            rejected = err;
            assert.equal(err.failure_reason, 'connector_protocol_violation');
            assert.match(err.message, /SKIP_RESULT for undeclared stream/);
            return true;
          },
        );

        const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
        const runTypes = (runTimeline.data || []).map((event) => event.event_type);
        assert.ok(!runTypes.includes('run.stream_skipped'));
        assert.ok(runTypes.includes('run.failed'));

        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
        assert.ok(failedEvent, 'expected run.failed event');
        assert.equal(failedEvent.data.source?.kind, 'connector');
        assert.equal(failedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
        assert.equal(failedEvent.data.records_flushed, 0);
        assert.equal(failedEvent.data.buffered_records_dropped, 0);
        assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('captures post-DONE state protocol violations without recording checkpoint artifacts', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-event-spine-post-done-state-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 0,
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'top_artists',
    cursor: { after: 'after_done_state' },
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`, 'utf8');

      try {
        let rejected = null;
        await assert.rejects(
          runConnector({
            connectorPath,
            connectorId: spotifyManifest.connector_id,
            ownerToken,
            manifest: spotifyManifest,
            state: null,
            collectionMode: 'incremental',
            persistState: true,
            rsUrl,
            onInteraction: async () => ({}),
          }),
          (err) => {
            rejected = err;
            assert.equal(err.failure_reason, 'connector_protocol_violation');
            return true;
          },
        );

        const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
        const runTypes = (runTimeline.data || []).map((event) => event.event_type);
        assert.ok(!runTypes.includes('run.completed'));
        assert.ok(!runTypes.includes('run.state_staged'));
        assert.ok(!runTypes.includes('run.state_advanced'));
        assert.ok(runTypes.includes('run.failed'));

        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
        assert.ok(failedEvent, 'expected run.failed event');
        assert.equal(failedEvent.data.source?.kind, 'connector');
        assert.equal(failedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
        assert.equal(failedEvent.data.records_flushed, 0);
        assert.equal(failedEvent.data.buffered_records_dropped, 0);
        assert.equal(failedEvent.data.state_streams_staged, 0);
        assert.equal(failedEvent.data.state_streams_committed, 0);
        assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('captures post-DONE invalid JSONL protocol violations without recording completion artifacts', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-event-spine-post-done-invalid-jsonl-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 0,
  }) + '\\n');
  process.stdout.write('this is not valid jsonl after done\\n');
  rl.close();
  process.exit(0);
});
`, 'utf8');

      try {
        let rejected = null;
        await assert.rejects(
          runConnector({
            connectorPath,
            connectorId: spotifyManifest.connector_id,
            ownerToken,
            manifest: spotifyManifest,
            state: null,
            collectionMode: 'incremental',
            persistState: true,
            rsUrl,
            onInteraction: async () => ({}),
          }),
          (err) => {
            rejected = err;
            assert.equal(err.failure_reason, 'connector_protocol_violation');
            assert.match(err.message, /Connector emitted invalid JSONL after DONE:/);
            return true;
          },
        );

        const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
        const runTypes = (runTimeline.data || []).map((event) => event.event_type);
        assert.ok(!runTypes.includes('run.completed'));
        assert.ok(runTypes.includes('run.failed'));

        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
        assert.ok(failedEvent, 'expected run.failed event');
        assert.equal(failedEvent.data.source?.kind, 'connector');
        assert.equal(failedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
        assert.equal(failedEvent.data.records_flushed, 0);
        assert.equal(failedEvent.data.buffered_records_dropped, 0);
        assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('captures undeclared-stream interaction protocol violations without recording interaction artifacts', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-event-spine-undeclared-interaction-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'INTERACTION',
    request_id: 'undeclared_stream_interaction_event',
    stream: 'ghost',
    kind: 'manual_action',
    message: 'undeclared stream interactions should be rejected',
  }) + '\\n');
  rl.close();
});
`, 'utf8');

      try {
        let rejected = null;
        await assert.rejects(
          runConnector({
            connectorPath,
            connectorId: spotifyManifest.connector_id,
            ownerToken,
            manifest: spotifyManifest,
            state: null,
            collectionMode: 'incremental',
            persistState: true,
            rsUrl,
            onInteraction: async () => ({
              type: 'INTERACTION_RESPONSE',
              request_id: 'undeclared_stream_interaction_event',
              status: 'success',
            }),
          }),
          (err) => {
            rejected = err;
            assert.equal(err.failure_reason, 'connector_protocol_violation');
            assert.match(err.message, /INTERACTION for undeclared stream/);
            return true;
          },
        );

        const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
        const runTypes = (runTimeline.data || []).map((event) => event.event_type);
        assert.ok(!runTypes.includes('run.interaction_required'));
        assert.ok(!runTypes.includes('run.interaction_completed'));
        assert.ok(!runTypes.includes('run.completed'));
        assert.ok(runTypes.includes('run.failed'));

        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');
        assert.ok(failedEvent, 'expected run.failed event');
        assert.equal(failedEvent.data.source?.kind, 'connector');
        assert.equal(failedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
        assert.equal(failedEvent.data.records_flushed, 0);
        assert.equal(failedEvent.data.buffered_records_dropped, 0);
        assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('captures interaction lifecycle events with source descriptors', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-event-spine-interaction-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
let started = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START' && !started) {
    started = true;
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'int_evt_1',
      kind: 'credentials',
      message: 'Need a token',
      schema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] },
      timeout_seconds: 300
    }) + '\\n');
    return;
  }
  if (msg.type === 'INTERACTION_RESPONSE') {
    process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
    rl.close();
    process.exit(0);
  }
});
`, 'utf8');

      try {
        const result = await runConnector({
          connectorPath,
          connectorId: spotifyManifest.connector_id,
          ownerToken,
          manifest: spotifyManifest,
          state: null,
          collectionMode: 'full_refresh',
          rsUrl,
          onInteraction: async (interaction) => ({
            type: 'INTERACTION_RESPONSE',
            request_id: interaction.request_id,
            status: 'success',
            data: { token: 'super_secret_token' },
          }),
        });

        const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
        const interactionRequired = (runTimeline.data || []).find((event) => event.event_type === 'run.interaction_required');
        const interactionCompleted = (runTimeline.data || []).find((event) => event.event_type === 'run.interaction_completed');
        assert.ok(interactionRequired, 'expected run.interaction_required event');
        assert.ok(interactionCompleted, 'expected run.interaction_completed event');
        assert.equal(interactionRequired.data.kind, 'credentials');
        assert.equal(interactionRequired.data.stream, null);
        assert.equal(interactionRequired.data.message, 'Need a token');
        assert.deepEqual(interactionRequired.data.schema, {
          type: 'object',
          properties: { token: { type: 'string' } },
          required: ['token'],
        });
        assert.equal(interactionRequired.data.timeout_seconds, 300);
        assert.equal(interactionCompleted.data.kind, 'credentials');
        assert.equal(interactionCompleted.data.stream, null);

        for (const event of [interactionRequired, interactionCompleted]) {
          assert.equal(event.data.source?.kind, 'connector');
          assert.equal(event.data.source?.id, SPOTIFY_CONNECTOR_KEY);
          assert.ok(!('connector_id' in event.data), `${event.event_type} should use source descriptors instead of raw connector_id`);
        }

        const serializedTimeline = JSON.stringify(runTimeline.data || []);
        assert.ok(!serializedTimeline.includes('super_secret_token'), 'interaction timelines should not persist INTERACTION_RESPONSE secret values');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('captures interaction timeout lifecycle events', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-event-spine-interaction-timeout-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
let started = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START' && !started) {
    started = true;
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'int_evt_timeout',
      kind: 'credentials',
      message: 'Need a token',
      schema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] },
      timeout_seconds: 0.05
    }) + '\\n');
    return;
  }
  if (msg.type === 'INTERACTION_RESPONSE') {
    process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
    rl.close();
    process.exit(0);
  }
});
`, 'utf8');

      try {
        const result = await runConnector({
          connectorPath,
          connectorId: spotifyManifest.connector_id,
          ownerToken,
          manifest: spotifyManifest,
          state: null,
          collectionMode: 'full_refresh',
          rsUrl,
          onInteraction: async () => new Promise(() => {}),
        });

        const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
        const interactionRequired = (runTimeline.data || []).find((event) => event.event_type === 'run.interaction_required');
        const interactionCompleted = (runTimeline.data || []).find((event) => event.event_type === 'run.interaction_completed');
        assert.ok(interactionRequired, 'expected run.interaction_required event');
        assert.ok(interactionCompleted, 'expected run.interaction_completed event');
        assert.equal(interactionCompleted.status, 'timeout');
        assert.equal(interactionCompleted.data.status, 'timeout');
        assert.equal(interactionRequired.data.message, 'Need a token');
        assert.equal(interactionRequired.data.timeout_seconds, 0.05);
        assert.equal(interactionCompleted.data.kind, 'credentials');
        assert.equal(interactionCompleted.data.stream, null);

        for (const event of [interactionRequired, interactionCompleted]) {
          assert.equal(event.data.source?.kind, 'connector');
          assert.equal(event.data.source?.id, SPOTIFY_CONNECTOR_KEY);
          assert.ok(!('connector_id' in event.data), `${event.event_type} should use source descriptors instead of raw connector_id`);
        }
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('captures interaction cancelled lifecycle events', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-event-spine-interaction-cancelled-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
let started = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START' && !started) {
    started = true;
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'int_evt_cancelled',
      kind: 'credentials',
      message: 'Need a token',
      schema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] },
      timeout_seconds: 300
    }) + '\\n');
    return;
  }
  if (msg.type === 'INTERACTION_RESPONSE') {
    process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
    rl.close();
    process.exit(0);
  }
});
`, 'utf8');

      try {
        const result = await runConnector({
          connectorPath,
          connectorId: spotifyManifest.connector_id,
          ownerToken,
          manifest: spotifyManifest,
          state: null,
          collectionMode: 'full_refresh',
          rsUrl,
          onInteraction: async () => {
            throw new Error('user aborted interaction');
          },
        });

        const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
        const interactionRequired = (runTimeline.data || []).find((event) => event.event_type === 'run.interaction_required');
        const interactionCompleted = (runTimeline.data || []).find((event) => event.event_type === 'run.interaction_completed');
        assert.ok(interactionRequired, 'expected run.interaction_required event');
        assert.ok(interactionCompleted, 'expected run.interaction_completed event');
        assert.equal(interactionCompleted.status, 'cancelled');
        assert.equal(interactionCompleted.data.status, 'cancelled');
        assert.equal(interactionRequired.data.message, 'Need a token');
        assert.equal(interactionRequired.data.timeout_seconds, 300);
        assert.equal(interactionCompleted.data.kind, 'credentials');
        assert.equal(interactionCompleted.data.stream, null);

        for (const event of [interactionRequired, interactionCompleted]) {
          assert.equal(event.data.source?.kind, 'connector');
          assert.equal(event.data.source?.id, SPOTIFY_CONNECTOR_KEY);
          assert.ok(!('connector_id' in event.data), `${event.event_type} should use source descriptors instead of raw connector_id`);
        }
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('captures blocked interaction protocol violations without recording completion', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-event-spine-interaction-blocked-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
process.on('SIGTERM', () => process.exit(1));
const rl = createInterface({ input: process.stdin });
let started = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START' && !started) {
    started = true;
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'int_evt_blocked_1',
      kind: 'credentials',
      message: 'Need a token',
      schema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] },
      timeout_seconds: 300
    }) + '\\n');
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        type: 'INTERACTION',
        request_id: 'int_evt_blocked_2',
        kind: 'confirmation',
        message: 'Should never be admitted',
        schema: { type: 'object' },
        timeout_seconds: 300
      }) + '\\n');
    }, 10);
  }
});
`, 'utf8');

      try {
        let rejected = null;
        await assert.rejects(
          async () => {
            await runConnector({
              connectorPath,
              connectorId: spotifyManifest.connector_id,
              ownerToken,
              manifest: spotifyManifest,
              state: null,
              collectionMode: 'full_refresh',
              rsUrl,
              onInteraction: async () => new Promise(() => {}),
            });
          },
          (err) => {
            rejected = err;
            assert.equal(err.message, 'Connector emitted INTERACTION while waiting for INTERACTION_RESPONSE');
            assert.equal(err.failure_reason, 'connector_protocol_violation');
            return true;
          },
        );

        const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
        const interactionRequiredEvents = (runTimeline.data || []).filter((event) => event.event_type === 'run.interaction_required');
        const interactionCompletedEvents = (runTimeline.data || []).filter((event) => event.event_type === 'run.interaction_completed');
        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');

        assert.equal(interactionRequiredEvents.length, 1, 'only the first interaction should reach the event spine');
        assert.equal(interactionCompletedEvents.length, 0, 'blocked interaction violations should not record completion');
        assert.ok(failedEvent, 'expected run.failed event for blocked interaction protocol violation');
        assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
        assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');

        for (const event of [...interactionRequiredEvents, failedEvent]) {
          assert.equal(event.data.source?.kind, 'connector');
          assert.equal(event.data.source?.id, SPOTIFY_CONNECTOR_KEY);
          assert.ok(!('connector_id' in event.data), `${event.event_type} should use source descriptors instead of raw connector_id`);
        }
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('captures blocked interaction state violations without recording checkpoint artifacts', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-event-spine-interaction-state-blocked-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
process.on('SIGTERM', () => process.exit(1));
const rl = createInterface({ input: process.stdin });
let started = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START' && !started) {
    started = true;
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'int_evt_blocked_state_1',
      kind: 'credentials',
      message: 'Need a token',
      schema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] },
      timeout_seconds: 300
    }) + '\\n');
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        type: 'STATE',
        stream: 'top_artists',
        cursor: { after: 'should_not_stage' }
      }) + '\\n');
    }, 10);
  }
});
`, 'utf8');

      try {
        let rejected = null;
        await assert.rejects(
          async () => {
            await runConnector({
              connectorPath,
              connectorId: spotifyManifest.connector_id,
              ownerToken,
              manifest: spotifyManifest,
              state: null,
              collectionMode: 'incremental',
              persistState: true,
              rsUrl,
              onInteraction: async () => new Promise(() => {}),
            });
          },
          (err) => {
            rejected = err;
            assert.equal(err.message, 'Connector emitted STATE while waiting for INTERACTION_RESPONSE');
            assert.equal(err.failure_reason, 'connector_protocol_violation');
            return true;
          },
        );

        const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
        const interactionRequiredEvents = (runTimeline.data || []).filter((event) => event.event_type === 'run.interaction_required');
        const interactionCompletedEvents = (runTimeline.data || []).filter((event) => event.event_type === 'run.interaction_completed');
        const stateStagedEvents = (runTimeline.data || []).filter((event) => event.event_type === 'run.state_staged');
        const stateAdvancedEvents = (runTimeline.data || []).filter((event) => event.event_type === 'run.state_advanced');
        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');

        assert.equal(interactionRequiredEvents.length, 1, 'only the first interaction should reach the event spine');
        assert.equal(interactionCompletedEvents.length, 0, 'blocked interaction state violations should not record completion');
        assert.equal(stateStagedEvents.length, 0, 'blocked interaction state violations should not stage checkpoints');
        assert.equal(stateAdvancedEvents.length, 0, 'blocked interaction state violations should not commit checkpoints');
        assert.ok(failedEvent, 'expected run.failed event for blocked interaction state protocol violation');
        assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
        assert.equal(failedEvent.data.state_streams_staged, 0);
        assert.equal(failedEvent.data.state_streams_committed, 0);
        assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');

        for (const event of [...interactionRequiredEvents, failedEvent]) {
          assert.equal(event.data.source?.kind, 'connector');
          assert.equal(event.data.source?.id, SPOTIFY_CONNECTOR_KEY);
          assert.ok(!('connector_id' in event.data), `${event.event_type} should use source descriptors instead of raw connector_id`);
        }
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('captures blocked interaction progress violations without recording progress artifacts', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-event-spine-interaction-progress-blocked-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
process.on('SIGTERM', () => process.exit(1));
const rl = createInterface({ input: process.stdin });
let started = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START' && !started) {
    started = true;
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'int_evt_blocked_progress_1',
      kind: 'credentials',
      message: 'Need a token',
      schema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] },
      timeout_seconds: 300
    }) + '\\n');
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        type: 'PROGRESS',
        stream: 'top_artists',
        message: 'should_not_be_recorded'
      }) + '\\n');
    }, 10);
  }
});
`, 'utf8');

      try {
        let rejected = null;
        await assert.rejects(
          async () => {
            await runConnector({
              connectorPath,
              connectorId: spotifyManifest.connector_id,
              ownerToken,
              manifest: spotifyManifest,
              state: null,
              collectionMode: 'full_refresh',
              rsUrl,
              onInteraction: async () => new Promise(() => {}),
            });
          },
          (err) => {
            rejected = err;
            assert.equal(err.message, 'Connector emitted PROGRESS while waiting for INTERACTION_RESPONSE');
            assert.equal(err.failure_reason, 'connector_protocol_violation');
            return true;
          },
        );

        const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
        const interactionRequiredEvents = (runTimeline.data || []).filter((event) => event.event_type === 'run.interaction_required');
        const interactionCompletedEvents = (runTimeline.data || []).filter((event) => event.event_type === 'run.interaction_completed');
        const progressEvents = (runTimeline.data || []).filter((event) => event.event_type === 'run.progress_reported');
        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');

        assert.equal(interactionRequiredEvents.length, 1, 'only the first interaction should reach the event spine');
        assert.equal(interactionCompletedEvents.length, 0, 'blocked interaction progress violations should not record completion');
        assert.equal(progressEvents.length, 0, 'blocked interaction progress violations should not record progress');
        assert.ok(failedEvent, 'expected run.failed event for blocked interaction progress protocol violation');
        assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
        assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');

        for (const event of [...interactionRequiredEvents, failedEvent]) {
          assert.equal(event.data.source?.kind, 'connector');
          assert.equal(event.data.source?.id, SPOTIFY_CONNECTOR_KEY);
          assert.ok(!('connector_id' in event.data), `${event.event_type} should use source descriptors instead of raw connector_id`);
        }
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('captures blocked interaction skip-result violations without recording skip artifacts', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-event-spine-interaction-skip-blocked-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
process.on('SIGTERM', () => process.exit(1));
const rl = createInterface({ input: process.stdin });
let started = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START' && !started) {
    started = true;
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'int_evt_blocked_skip_1',
      kind: 'credentials',
      message: 'Need a token',
      schema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] },
      timeout_seconds: 300
    }) + '\\n');
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        type: 'SKIP_RESULT',
        stream: 'top_artists',
        reason: 'should_not_be_recorded',
        message: 'blocked by pending interaction'
      }) + '\\n');
    }, 10);
  }
});
`, 'utf8');

      try {
        let rejected = null;
        await assert.rejects(
          async () => {
            await runConnector({
              connectorPath,
              connectorId: spotifyManifest.connector_id,
              ownerToken,
              manifest: spotifyManifest,
              state: null,
              collectionMode: 'full_refresh',
              rsUrl,
              onInteraction: async () => new Promise(() => {}),
            });
          },
          (err) => {
            rejected = err;
            assert.equal(err.message, 'Connector emitted SKIP_RESULT while waiting for INTERACTION_RESPONSE');
            assert.equal(err.failure_reason, 'connector_protocol_violation');
            return true;
          },
        );

        const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
        const interactionRequiredEvents = (runTimeline.data || []).filter((event) => event.event_type === 'run.interaction_required');
        const interactionCompletedEvents = (runTimeline.data || []).filter((event) => event.event_type === 'run.interaction_completed');
        const skippedEvents = (runTimeline.data || []).filter((event) => event.event_type === 'run.stream_skipped');
        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');

        assert.equal(interactionRequiredEvents.length, 1, 'only the first interaction should reach the event spine');
        assert.equal(interactionCompletedEvents.length, 0, 'blocked interaction skip-result violations should not record completion');
        assert.equal(skippedEvents.length, 0, 'blocked interaction skip-result violations should not record skip artifacts');
        assert.ok(failedEvent, 'expected run.failed event for blocked interaction skip-result protocol violation');
        assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
        assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');

        for (const event of [...interactionRequiredEvents, failedEvent]) {
          assert.equal(event.data.source?.kind, 'connector');
          assert.equal(event.data.source?.id, SPOTIFY_CONNECTOR_KEY);
          assert.ok(!('connector_id' in event.data), `${event.event_type} should use source descriptors instead of raw connector_id`);
        }
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('captures blocked interaction terminal violations without recording completion or terminal success artifacts', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-event-spine-interaction-done-blocked-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
process.on('SIGTERM', () => process.exit(1));
const rl = createInterface({ input: process.stdin });
let started = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START' && !started) {
    started = true;
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'int_evt_blocked_done_1',
      kind: 'credentials',
      message: 'Need a token',
      schema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] },
      timeout_seconds: 300
    }) + '\\n');
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        type: 'DONE',
        status: 'succeeded',
        records_emitted: 0
      }) + '\\n');
    }, 10);
  }
});
`, 'utf8');

      try {
        let rejected = null;
        await assert.rejects(
          async () => {
            await runConnector({
              connectorPath,
              connectorId: spotifyManifest.connector_id,
              ownerToken,
              manifest: spotifyManifest,
              state: null,
              collectionMode: 'full_refresh',
              rsUrl,
              onInteraction: async () => new Promise(() => {}),
            });
          },
          (err) => {
            rejected = err;
            assert.equal(err.message, 'Connector emitted DONE while waiting for INTERACTION_RESPONSE');
            assert.equal(err.failure_reason, 'connector_protocol_violation');
            return true;
          },
        );

        const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
        const interactionRequiredEvents = (runTimeline.data || []).filter((event) => event.event_type === 'run.interaction_required');
        const interactionCompletedEvents = (runTimeline.data || []).filter((event) => event.event_type === 'run.interaction_completed');
        const completedEvents = (runTimeline.data || []).filter((event) => event.event_type === 'run.completed');
        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');

        assert.equal(interactionRequiredEvents.length, 1, 'only the initial interaction should reach the event spine');
        assert.equal(interactionCompletedEvents.length, 0, 'blocked interaction terminal violations should not record completion');
        assert.equal(completedEvents.length, 0, 'blocked interaction terminal violations should not record run.completed');
        assert.ok(failedEvent, 'expected run.failed event for blocked interaction terminal protocol violation');
        assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
        assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');

        for (const event of [...interactionRequiredEvents, failedEvent]) {
          assert.equal(event.data.source?.kind, 'connector');
          assert.equal(event.data.source?.id, SPOTIFY_CONNECTOR_KEY);
          assert.ok(!('connector_id' in event.data), `${event.event_type} should use source descriptors instead of raw connector_id`);
        }
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('captures blocked interaction invalid JSONL violations without recording completion artifacts', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'u1');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-event-spine-interaction-invalid-jsonl-blocked-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
process.on('SIGTERM', () => process.exit(1));
const rl = createInterface({ input: process.stdin });
let started = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START' && !started) {
    started = true;
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'int_evt_blocked_invalid_jsonl_1',
      kind: 'credentials',
      message: 'Need a token',
      schema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] },
      timeout_seconds: 300
    }) + '\\n');
    setTimeout(() => {
      process.stdout.write('this is not valid jsonl while waiting\\n');
    }, 10);
  }
});
`, 'utf8');

      try {
        let rejected = null;
        await assert.rejects(
          async () => {
            await runConnector({
              connectorPath,
              connectorId: spotifyManifest.connector_id,
              ownerToken,
              manifest: spotifyManifest,
              state: null,
              collectionMode: 'full_refresh',
              rsUrl,
              onInteraction: async () => new Promise(() => {}),
            });
          },
          (err) => {
            rejected = err;
            assert.match(err.message, /Connector emitted invalid JSONL while waiting for INTERACTION_RESPONSE:/);
            assert.equal(err.failure_reason, 'connector_protocol_violation');
            return true;
          },
        );

        const { body: runTimeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(rejected.run_id)}/timeline`);
        const interactionRequiredEvents = (runTimeline.data || []).filter((event) => event.event_type === 'run.interaction_required');
        const interactionCompletedEvents = (runTimeline.data || []).filter((event) => event.event_type === 'run.interaction_completed');
        const completedEvents = (runTimeline.data || []).filter((event) => event.event_type === 'run.completed');
        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === 'run.failed');

        assert.equal(interactionRequiredEvents.length, 1, 'only the initial interaction should reach the event spine');
        assert.equal(interactionCompletedEvents.length, 0, 'blocked interaction invalid JSONL should not record completion');
        assert.equal(completedEvents.length, 0, 'blocked interaction invalid JSONL should not record run.completed');
        assert.ok(failedEvent, 'expected run.failed event for blocked interaction invalid JSONL');
        assert.equal(failedEvent.data.reason, 'connector_protocol_violation');
        assert.equal(failedEvent.data.checkpoint_commit_status, 'not_committed');

        for (const event of [...interactionRequiredEvents, failedEvent]) {
          assert.equal(event.data.source?.kind, 'connector');
          assert.equal(event.data.source?.id, SPOTIFY_CONNECTOR_KEY);
          assert.ok(!('connector_id' in event.data), `${event.event_type} should use source descriptors instead of raw connector_id`);
        }
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
