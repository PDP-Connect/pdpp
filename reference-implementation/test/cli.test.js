import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { startServer } from '../server/index.js';
import { parsePendingConsentRequestUri } from '../server/auth.js';
import { getDb } from '../server/db.js';
import { ingestRecord } from '../server/records.js';
import { runConnector } from '../runtime/index.js';

const execFile = promisify(execFileCallback);

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');
const CLI_PATH = join(REFERENCE_IMPL_DIR, 'cli/index.js');
const TEST_DCR_INITIAL_ACCESS_TOKEN = 'pdpp-reference-test-initial-access-token';


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
  return { status: resp.status, body };
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
  const dir = mkdtempSync(join(tmpdir(), 'pdpp-cli-db-'));
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
          ...(params.connector_id ? { connector_id: params.connector_id } : {}),
          ...(params.provider_id ? { provider_id: params.provider_id } : {}),
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

async function updateRegisteredClientRow(clientId, updates) {
  const setParts = [];
  const binds = [];
  for (const key of ['metadata_json', 'token_endpoint_auth_method']) {
    if (Object.hasOwn(updates, key)) {
      setParts.push(`${key} = ?`);
      binds.push(updates[key]);
    }
  }
  assert.ok(binds.length, 'expected registered client row updates');

  getDb().prepare(
    `UPDATE oauth_clients SET ${setParts.join(', ')} WHERE client_id = ?`
  ).run(...binds, clientId);
}

async function mutatePendingConsentRequest(requestUri, mutate) {
  const deviceCode = parsePendingConsentRequestUri(requestUri);
  assert.ok(deviceCode, 'request_uri should decode to a pending device code');

  const rows = getDb().prepare(`
    SELECT params_json
    FROM pending_consents
    WHERE device_code = ?
  `).all(deviceCode);
  assert.equal(rows.length, 1);

  const request = JSON.parse(rows[0].params_json);
  mutate(request);

  getDb().prepare(`
    UPDATE pending_consents
    SET params_json = ?
    WHERE device_code = ?
  `).run(JSON.stringify(request), deviceCode);
}

async function readPendingConsentTraceContext(requestUri) {
  const deviceCode = parsePendingConsentRequestUri(requestUri);
  assert.ok(deviceCode, 'request_uri should decode to a pending device code');

  const rows = getDb().prepare(`
    SELECT request_id, trace_id, scenario_id
    FROM pending_consents
    WHERE device_code = ?
  `).all(deviceCode);
  assert.equal(rows.length, 1);
  return rows[0];
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

async function issueNorthstarClientGrant(asUrl, nativeManifest, subjectId = 'cli_owner') {
  return approveGrant(asUrl, subjectId, {
    client_id: 'longview',
    provider_id: nativeManifest.provider_id,
    purpose_code: 'https://pdpp.org/purpose/financial_planning',
    purpose_description: 'Support compensation planning and verification',
    access_mode: 'continuous',
    streams: [{ name: 'pay_statements' }],
  });
}

async function approveGrant(asUrl, subjectId, params) {
  const { body: initiate } = await startGrantRequest(asUrl, params);

  const { body: approved } = await approveGrantRequest(asUrl, initiate.request_uri, subjectId);

  return approved;
}

async function withMalformedPolyfillClientGrant(fn) {
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

    const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
    await seedSpotify(rsUrl, spotifyManifest, ownerToken);
    const ownerRecordListResp = await fetchJson(
      `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}&limit=1`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    const visibleRecord = ownerRecordListResp.body.data?.[0];
    assert.ok(visibleRecord, 'expected an owner-visible top_artists record before corrupting the grant binding');

    const approved = await approveGrant(asUrl, 'cli_owner', {
      client_id: 'concert_recommendation_app',
      connector_id: spotifyManifest.connector_id,
      purpose_code: 'https://pdpp.org/purpose/concert_recommendation',
      purpose_description: 'Recommend concerts and nearby live events',
      access_mode: 'continuous',
      streams: [{ name: 'top_artists' }],
    });

    const missingConnectorId = 'missing_spotify_connector';
    const remappedGrant = JSON.parse(JSON.stringify(approved.grant));
    remappedGrant.source = {
      binding_kind: 'connector',
      connector_id: missingConnectorId,
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

    await fn({ asUrl, rsUrl, approved, visibleRecord, missingConnectorId });
  } finally {
    await closeServer(server);
    cleanup();
  }
}

function assertMalformedPolyfillClientArtifacts({
  events,
  requestId,
  traceId,
  streamId = null,
  queryShape,
  requestedRecordId = null,
  missingConnectorId,
  label,
  stderr = '',
}) {
  const queryReceived = (events || []).find((event) =>
    event.event_type === 'query.received' && event.object_id === requestId
  );
  assert.ok(queryReceived, `artifacts should include query.received for malformed polyfill client ${label}`);
  assert.equal(queryReceived.trace_id, traceId);
  assert.equal(queryReceived.data?.query_shape, queryShape);
  assert.equal(queryReceived.data?.source?.binding_kind, 'connector');
  assert.equal(queryReceived.data?.source?.connector_id, missingConnectorId);
  if (streamId) {
    assert.equal(queryReceived.stream_id, streamId);
  }
  if (requestedRecordId) {
    assert.equal(queryReceived.data?.requested_record_id, requestedRecordId);
  }

  const rejectedEvent = (events || []).find((event) =>
    event.event_type === 'query.rejected' && event.object_id === requestId
  );
  assert.ok(rejectedEvent, `artifacts should include query.rejected for malformed polyfill client ${label}`);
  assert.equal(rejectedEvent.trace_id, traceId);
  assert.equal(rejectedEvent.data?.query_shape, queryShape);
  assert.equal(rejectedEvent.data?.source?.binding_kind, 'connector');
  assert.equal(rejectedEvent.data?.source?.connector_id, missingConnectorId);
  assert.equal(rejectedEvent.data?.error?.code, 'not_found');
  assert.match(rejectedEvent.data?.error?.message || '', /Unknown connector: missing_spotify_connector/);
  if (streamId) {
    assert.equal(rejectedEvent.stream_id, streamId);
  }

  const servedEvent = (events || []).find((event) =>
    event.event_type === 'disclosure.served' && event.object_id === requestId
  );
  assert.equal(servedEvent, undefined, `malformed polyfill client ${label} should not produce disclosure.served`);
  assert.equal(stderr, '');
}

async function runCli(args, env = {}) {
  const { stdout, stderr } = await execFile(process.execPath, [CLI_PATH, ...args], {
    cwd: REFERENCE_IMPL_DIR,
    env: {
      ...process.env,
      PDPP_AS_URL: '',
      PDPP_RS_URL: '',
      AS_URL: '',
      RS_URL: '',
      ...env,
    },
  });

  let json = null;
  if (stdout) {
    try {
      json = JSON.parse(stdout);
    } catch {
      json = null;
    }
  }

  return {
    stdout,
    stderr,
    json,
  };
}


async function runCliExpectFailure(args, env = {}) {
  try {
    await execFile(process.execPath, [CLI_PATH, ...args], {
      cwd: REFERENCE_IMPL_DIR,
      env: {
        ...process.env,
        PDPP_AS_URL: '',
        PDPP_RS_URL: '',
        AS_URL: '',
        RS_URL: '',
        ...env,
      },
    });
    assert.fail('Expected CLI command to fail');
  } catch (error) {
    return {
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      code: error.code,
    };
  }
}

async function waitForRegex(getText, regex, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = getText().match(regex);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${regex}`);
}

test('PDPP CLI smoke', async (t) => {
  await t.test('auth introspect returns owner token metadata', async () => {
    await withHarness(async ({ asUrl, rsUrl }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      const result = await runCli(
        ['auth', 'introspect', '--rs-url', rsUrl, '--token', ownerToken, '--format', 'json'],
      );

      assert.equal(result.json.active, true);
      assert.equal(result.json.pdpp_token_kind, 'owner');
      assert.equal(result.json.subject_id, 'cli_owner');
      assert.equal(result.stderr, '');
    });
  });

  await t.test('auth introspect preserves the current native client grant shape without storage-binding leakage', async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      await seedNorthstar(nativeManifest);
      const approved = await issueNorthstarClientGrant(asUrl, nativeManifest);

      const result = await runCli(
        ['auth', 'introspect', '--rs-url', rsUrl, '--token', approved.token, '--format', 'json'],
      );

      assert.equal(result.json.active, true);
      assert.equal(result.json.pdpp_token_kind, 'client');
      assert.equal(result.json.grant_id, approved.grant.grant_id);
      assert.equal(result.json.client_id, approved.grant.client.client_id);
      assert.equal(result.json.subject_id, 'cli_owner');
      assert.ok(typeof result.json.trace_id === 'string' && result.json.trace_id.startsWith('trc_'));
      assert.ok(typeof result.json.scenario_id === 'string' && result.json.scenario_id.startsWith('scn_'));
      assert.equal(result.json.grant.source.binding_kind, 'provider_native');
      assert.equal(result.json.grant.source.provider_id, nativeManifest.provider_id);
      assert.equal('grant_storage_binding' in result.json, false);
      assert.equal(result.stderr, '');
    });
  });

  await t.test('auth introspect preserves grant_invalid client context', async () => {
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
      const approved = await issueNorthstarClientGrant(asUrl, nativeManifest);

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

      const result = await runCli(
        ['auth', 'introspect', '--rs-url', rsUrl, '--token', approved.token, '--format', 'json'],
      );

      assert.equal(result.json.active, false);
      assert.equal(result.json.inactive_reason, 'grant_invalid');
      assert.equal(result.json.grant_id, approved.grant.grant_id);
      assert.equal(result.json.client_id, approved.grant.client.client_id);
      assert.equal(result.json.subject_id, 'cli_owner');
      assert.ok(typeof result.json.trace_id === 'string' && result.json.trace_id.startsWith('trc_'));
      assert.ok(typeof result.json.scenario_id === 'string' && result.json.scenario_id.startsWith('scn_'));
      assert.equal(result.stderr, '');
    } finally {
      await closeServer(server);
      cleanup();
    }
  });

  await t.test('auth introspect preserves grant_revoked client context', async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      await seedNorthstar(nativeManifest);
      const approved = await issueNorthstarClientGrant(asUrl, nativeManifest);

      await fetchJson(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const result = await runCli(
        ['auth', 'introspect', '--rs-url', rsUrl, '--token', approved.token, '--format', 'json'],
      );

      assert.equal(result.json.active, false);
      assert.equal(result.json.inactive_reason, 'grant_revoked');
      assert.equal(result.json.grant_id, approved.grant.grant_id);
      assert.equal(result.json.client_id, approved.grant.client.client_id);
      assert.equal(result.json.subject_id, 'cli_owner');
      assert.ok(typeof result.json.trace_id === 'string' && result.json.trace_id.startsWith('trc_'));
      assert.ok(typeof result.json.scenario_id === 'string' && result.json.scenario_id.startsWith('scn_'));
      assert.equal(result.stderr, '');
    });
  });

  await t.test('auth introspect preserves grant_expired client context', async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      await seedNorthstar(nativeManifest);
      const approved = await issueNorthstarClientGrant(asUrl, nativeManifest);

      getDb().prepare(`
        UPDATE tokens
        SET expires_at = ?
        WHERE token_id = ?
      `).run(new Date(Date.now() - 60_000).toISOString(), approved.token);

      const result = await runCli(
        ['auth', 'introspect', '--rs-url', rsUrl, '--token', approved.token, '--format', 'json'],
      );

      assert.equal(result.json.active, false);
      assert.equal(result.json.inactive_reason, 'grant_expired');
      assert.equal(result.json.grant_id, approved.grant.grant_id);
      assert.equal(result.json.client_id, approved.grant.client.client_id);
      assert.equal(result.json.subject_id, 'cli_owner');
      assert.ok(typeof result.json.trace_id === 'string' && result.json.trace_id.startsWith('trc_'));
      assert.ok(typeof result.json.scenario_id === 'string' && result.json.scenario_id.startsWith('scn_'));
      assert.equal(result.stderr, '');
    });
  });

  await t.test('auth login completes a real owner device flow', async () => {
    await withHarness(async ({ asUrl, rsUrl }) => {
      const proc = spawn(
        process.execPath,
        [CLI_PATH, 'auth', 'login', '--rs-url', rsUrl, '--client-id', 'cli_longview', '--timeout-seconds', '15', '--format', 'json'],
        {
          cwd: REFERENCE_IMPL_DIR,
          env: { ...process.env, PDPP_AS_URL: '', PDPP_RS_URL: '', AS_URL: '', RS_URL: '' },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );

      let stdout = '';
      let stderr = '';
      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => { stdout += chunk; });
      proc.stderr.on('data', (chunk) => { stderr += chunk; });

      const codeMatch = await waitForRegex(() => stderr, /User code: ([A-Z0-9]+)/);
      const userCode = codeMatch[1];

      const approveResp = await fetch(`${asUrl}/device/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          user_code: userCode,
          subject_id: 'cli_owner',
        }).toString(),
      });
      assert.equal(approveResp.status, 200);

      const exitCode = await new Promise((resolve, reject) => {
        proc.on('error', reject);
        proc.on('close', resolve);
      });

      assert.equal(exitCode, 0, stderr);
      const loginResult = JSON.parse(stdout);
      assert.equal(loginResult.token_type, 'Bearer');
      assert.ok(loginResult.access_token);

      const introspection = await runCli(
        ['auth', 'introspect', '--as-url', asUrl, '--token', loginResult.access_token, '--format', 'json'],
      );
      assert.equal(introspection.json.active, true);
      assert.equal(introspection.json.pdpp_token_kind, 'owner');
      assert.equal(introspection.json.subject_id, 'cli_owner');
      assert.ok(loginResult.request_id?.startsWith('req_'));
      assert.ok(loginResult.reference_trace_id?.startsWith('trc_'));
      assert.match(stderr, /Verification URI:/);
    });
  });

  await t.test('auth login fails honestly when the owner denies the device flow', async () => {
    await withHarness(async ({ asUrl, rsUrl }) => {
      const proc = spawn(
        process.execPath,
        [CLI_PATH, 'auth', 'login', '--rs-url', rsUrl, '--client-id', 'cli_longview', '--timeout-seconds', '15', '--format', 'json'],
        {
          cwd: REFERENCE_IMPL_DIR,
          env: { ...process.env, PDPP_AS_URL: '', PDPP_RS_URL: '', AS_URL: '', RS_URL: '' },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );

      let stdout = '';
      let stderr = '';
      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => { stdout += chunk; });
      proc.stderr.on('data', (chunk) => { stderr += chunk; });

      const codeMatch = await waitForRegex(() => stderr, /User code: ([A-Z0-9]+)/);
      const userCode = codeMatch[1];

      const denyResp = await fetch(`${asUrl}/device/deny`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          user_code: userCode,
          subject_id: 'cli_owner',
        }).toString(),
      });
      assert.equal(denyResp.status, 200);

      const exitCode = await new Promise((resolve, reject) => {
        proc.on('error', reject);
        proc.on('close', resolve);
      });

      assert.notEqual(exitCode, 0);
      assert.equal(stdout, '');
      assert.match(stderr, /Verification URI:/);
      assert.match(stderr, /The resource owner denied the request/);
      assert.match(stderr, /Request ID: req_/);
      assert.match(stderr, /Reference trace ID: trc_/);
    });
  });

  await t.test('auth login fails honestly when the owner device client row is malformed', async () => {
    await withHarness(async ({ rsUrl }) => {
      await updateRegisteredClientRow('cli_longview', {
        metadata_json: '{',
      });

      const result = await runCliExpectFailure(
        ['auth', 'login', '--rs-url', rsUrl, '--client-id', 'cli_longview', '--timeout-seconds', '15', '--format', 'json'],
      );

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /Registered client cli_longview is malformed or no longer valid/);
      assert.match(result.stderr, /Request ID: req_/);
      assert.match(result.stderr, /Reference trace ID: trc_/);
    });
  });

  await t.test('trace show keeps owner device artifacts inspectable', async () => {
    await withHarness(async ({ asUrl, rsUrl }) => {
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
      const device = await deviceResp.json();

      const approveResp = await fetch(`${asUrl}/device/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          user_code: device.user_code,
          subject_id: 'cli_owner',
        }).toString(),
      });
      assert.equal(approveResp.status, 200);

      const exchangeResp = await fetch(`${asUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: device.device_code,
          client_id: 'cli_longview',
        }).toString(),
      });
      assert.equal(exchangeResp.status, 200);

      const result = await runCli(
        ['trace', 'show', traceId, '--rs-url', rsUrl, '--format', 'json'],
      );

      assert.equal(result.json.object, 'trace');
      assert.equal(result.json.trace_id, traceId);

      const requestSubmitted = (result.json.data || []).find((event) =>
        event.event_type === 'request.submitted'
        && event.data?.issuance_path === 'owner_device_flow'
      );
      assert.ok(requestSubmitted, 'trace show should include owner-device request.submitted');
      assert.equal(requestSubmitted.request_id, requestId);
      assert.equal(requestSubmitted.client_id, 'cli_longview');
      assert.equal(requestSubmitted.object_id, device.device_code);
      assert.equal(requestSubmitted.data?.user_code, device.user_code);

      const approved = (result.json.data || []).find((event) =>
        event.event_type === 'consent.approved'
        && event.object_id === device.device_code
      );
      assert.ok(approved, 'trace show should include owner-device consent.approved');
      assert.equal(approved.request_id, requestId);
      assert.equal(approved.client_id, 'cli_longview');
      assert.equal(approved.data?.user_code, device.user_code);

      const tokenIssued = (result.json.data || []).find((event) =>
        event.event_type === 'token.issued'
        && event.data?.issuance_path === 'owner_device_flow'
      );
      assert.ok(tokenIssued, 'trace show should include owner-device token.issued');
      assert.equal(tokenIssued.request_id, requestId);
      assert.equal(tokenIssued.client_id, 'cli_longview');
      assert.equal(tokenIssued.data?.user_code, device.user_code);
      assert.equal(result.stderr, '');
    });
  });

  await t.test('trace show keeps denied owner device artifacts inspectable', async () => {
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
      const device = await deviceResp.json();

      const denyResp = await fetch(`${asUrl}/device/deny`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          user_code: device.user_code,
          subject_id: 'cli_owner',
        }).toString(),
      });
      assert.equal(denyResp.status, 200);

      const exchangeResp = await fetch(`${asUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: device.device_code,
          client_id: 'cli_longview',
        }).toString(),
      });
      assert.equal(exchangeResp.status, 400);

      const result = await runCli(
        ['trace', 'show', traceId, '--as-url', asUrl, '--format', 'json'],
      );

      assert.equal(result.json.object, 'trace');
      assert.equal(result.json.trace_id, traceId);

      const rejected = (result.json.data || []).find((event) =>
        event.event_type === 'request.rejected'
        && event.request_id === requestId
      );
      assert.ok(rejected, 'trace show should include request.rejected for owner-device denial');
      assert.equal(rejected.client_id, 'cli_longview');
      assert.equal(rejected.object_id, device.device_code);
      assert.equal(rejected.data?.issuance_path, 'owner_device_flow');
      assert.equal(rejected.data?.user_code, device.user_code);
      assert.equal(rejected.data?.error?.code, 'access_denied');
      assert.match(rejected.data?.error?.message || '', /denied the request/);
      assert.equal(result.stderr, '');
    });
  });

  await t.test('trace show keeps rejected owner device start artifacts inspectable', async () => {
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
      assert.ok(requestId?.startsWith('req_'));
      assert.ok(traceId?.startsWith('trc_'));

      const result = await runCli(
        ['trace', 'show', traceId, '--as-url', asUrl, '--format', 'json'],
      );

      assert.equal(result.json.object, 'trace');
      assert.equal(result.json.trace_id, traceId);

      const rejected = (result.json.data || []).find((event) =>
        event.event_type === 'request.rejected'
        && event.request_id === requestId
      );
      assert.ok(rejected, 'trace show should include request.rejected for owner-device start failures');
      assert.equal(rejected.client_id, 'cli_longview');
      assert.equal(rejected.data?.issuance_path, 'owner_device_flow');
      assert.equal(rejected.data?.error?.code, 'invalid_client');
      assert.match(rejected.data?.error?.message || '', /malformed or no longer valid/);
      assert.equal(result.stderr, '');
    });
  });

  await t.test('provider show summarizes discovery metadata from the RS', async () => {
    await withHarness(async ({ asUrl, rsUrl }) => {
      const result = await runCli(
        ['provider', 'show', '--rs-url', rsUrl, '--format', 'json'],
      );

      assert.equal(result.json.object, 'provider_metadata');
      assert.equal(result.json.resource_server, rsUrl);
      assert.equal(result.json.authorization_server, asUrl);
      assert.deepEqual(result.json.authorization_servers_advertised, [asUrl]);
      assert.equal(result.json.authorization_server_advertised, true);
      assert.equal(result.json.resource_name, 'PDPP Reference Provider Resource Server');
      assert.equal(result.json.pdpp_self_export_supported, true);
      assert.equal(result.json.device_authorization_supported, true);
      assert.equal(result.json.pushed_authorization_request_supported, true);
      assert.equal(result.json.pushed_authorization_request_endpoint, `${asUrl}/oauth/par`);
      assert.equal(result.json.registration_endpoint, `${asUrl}/oauth/register`);
      assert.equal('authorization_endpoint' in result.json, false);
      assert.equal('response_types_supported' in result.json, false);
      assert.equal('code_challenge_methods_supported' in result.json, false);
      assert.deepEqual(result.json.token_endpoint_auth_methods_supported, ['none']);
      assert.ok(result.json.pdpp_provider_connect_capabilities.includes('owner_self_export'));
      assert.ok(result.json.pdpp_provider_connect_capabilities.includes('third_party_client_connect'));
      assert.deepEqual(result.json.pdpp_registration_modes_supported, ['dynamic', 'pre_registered_public']);
      assert.equal(result.stderr, '');
    });
  });

  await t.test('provider register creates a protected dynamic client registration', async () => {
    await withHarness(async ({ asUrl, rsUrl }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-register-'));
      const requestPath = join(tmpDir, 'client.json');
      writeFileSync(requestPath, JSON.stringify({
        client_name: 'Dynamic Longview',
        redirect_uris: ['https://longview.example/callback'],
        client_uri: 'https://longview.example',
        policy_uri: 'https://longview.example/privacy',
        tos_uri: 'https://longview.example/terms',
        token_endpoint_auth_method: 'none',
      }, null, 2));

      const result = await runCli(
        ['provider', 'register', requestPath, '--rs-url', rsUrl, '--initial-access-token', TEST_DCR_INITIAL_ACCESS_TOKEN, '--format', 'json'],
      );

      assert.ok(typeof result.json.client_id === 'string' && result.json.client_id.startsWith('cli_'));
      assert.equal(result.json.client_name, 'Dynamic Longview');
      assert.equal(result.json.token_endpoint_auth_method, 'none');
      assert.deepEqual(result.json.redirect_uris, ['https://longview.example/callback']);
      assert.ok(typeof result.json.request_id === 'string' && result.json.request_id.startsWith('req_'));
      assert.ok(typeof result.json.reference_trace_id === 'string' && result.json.reference_trace_id.startsWith('trc_'));

      const trace = await runCli(
        ['trace', 'show', result.json.reference_trace_id, '--as-url', asUrl, '--format', 'json'],
      );
      const registeredEvent = (trace.json.data || []).find((event) => event.event_type === 'client.registered');
      assert.ok(registeredEvent, 'trace show should include client.registered after provider register');
      assert.equal(registeredEvent.request_id, result.json.request_id);
      assert.equal(registeredEvent.trace_id, result.json.reference_trace_id);
      assert.equal(registeredEvent.object_id, result.json.client_id);
      assert.equal(registeredEvent.data?.client_name, 'Dynamic Longview');
      assert.equal(result.stderr, '');
    });
  });

  await t.test('provider register failures preserve correlation ids and stay inspectable through trace show', async () => {
    await withHarness(async ({ asUrl, rsUrl }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-register-invalid-token-'));
      const requestPath = join(tmpDir, 'client.json');
      writeFileSync(requestPath, JSON.stringify({
        client_name: 'Rejected Client',
        token_endpoint_auth_method: 'none',
      }, null, 2));

      const result = await runCliExpectFailure(
        ['provider', 'register', requestPath, '--rs-url', rsUrl, '--initial-access-token', 'wrong-token', '--format', 'json'],
      );

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /Invalid initial access token/);
      const requestId = result.stderr.match(/Request ID: (req_[A-Za-z0-9]+)/)?.[1] || null;
      const traceId = result.stderr.match(/Reference trace ID: (trc_[A-Za-z0-9]+)/)?.[1] || null;
      assert.ok(requestId, 'provider register failure should surface a request id on stderr');
      assert.ok(traceId, 'provider register failure should surface a reference trace id on stderr');

      const trace = await runCli(
        ['trace', 'show', traceId, '--as-url', asUrl, '--format', 'json'],
      );
      const rejectedEvent = (trace.json.data || []).find((event) => event.event_type === 'client.register_rejected');
      assert.ok(rejectedEvent, 'trace show should include client.register_rejected for provider register failures');
      assert.equal(rejectedEvent.request_id, requestId);
      assert.equal(rejectedEvent.trace_id, traceId);
      assert.equal(rejectedEvent.data?.requested_client_name, 'Rejected Client');
      assert.equal(rejectedEvent.data?.requested_token_endpoint_auth_method, 'none');
      assert.equal(rejectedEvent.data?.error?.code, 'invalid_client');
    });
  });

  await t.test('provider register malformed URI failures preserve correlation ids and stay inspectable through trace show', async () => {
    await withHarness(async ({ asUrl, rsUrl }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-register-invalid-uri-trace-'));
      try {
        const requestPath = join(tmpDir, 'client.json');
        writeFileSync(requestPath, JSON.stringify({
          client_name: 'Rejected URI Client',
          token_endpoint_auth_method: 'none',
          redirect_uris: ['not a uri'],
        }, null, 2));

        const result = await runCliExpectFailure(
          ['provider', 'register', requestPath, '--rs-url', rsUrl, '--initial-access-token', TEST_DCR_INITIAL_ACCESS_TOKEN, '--format', 'json'],
        );

        assert.notEqual(result.code, 0);
        assert.match(result.stderr, /redirect_uris must be a valid absolute URI/);
        const requestId = result.stderr.match(/Request ID: (req_[A-Za-z0-9]+)/)?.[1] || null;
        const traceId = result.stderr.match(/Reference trace ID: (trc_[A-Za-z0-9]+)/)?.[1] || null;
        assert.ok(requestId, 'malformed URI registration failure should surface a request id on stderr');
        assert.ok(traceId, 'malformed URI registration failure should surface a reference trace id on stderr');

        const trace = await runCli(
          ['trace', 'show', traceId, '--as-url', asUrl, '--format', 'json'],
        );
        const rejectedEvent = (trace.json.data || []).find((event) => event.event_type === 'client.register_rejected');
        assert.ok(rejectedEvent, 'trace show should include client.register_rejected for malformed URI registration failures');
        assert.equal(rejectedEvent.request_id, requestId);
        assert.equal(rejectedEvent.trace_id, traceId);
        assert.equal(rejectedEvent.data?.requested_client_name, 'Rejected URI Client');
        assert.equal(rejectedEvent.data?.requested_token_endpoint_auth_method, 'none');
        assert.equal(rejectedEvent.data?.error?.code, 'invalid_client_metadata');
        assert.match(rejectedEvent.data?.error?.message || '', /redirect_uris must be a valid absolute URI/);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('provider register fails honestly for unsupported token_endpoint_auth_method values', async () => {
    await withHarness(async ({ rsUrl }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-register-unsupported-auth-method-'));
      const requestPath = join(tmpDir, 'client.json');
      writeFileSync(requestPath, JSON.stringify({
        client_name: 'Too Broad Longview',
        token_endpoint_auth_method: 'client_secret_basic',
      }, null, 2));

      const result = await runCliExpectFailure(
        ['provider', 'register', requestPath, '--rs-url', rsUrl, '--initial-access-token', TEST_DCR_INITIAL_ACCESS_TOKEN, '--format', 'json'],
      );

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /Unsupported token_endpoint_auth_method: client_secret_basic/);
    });
  });

  await t.test('provider register fails honestly for unsupported launch-profile metadata like application_type', async () => {
    await withHarness(async ({ rsUrl }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-register-unsupported-profile-metadata-'));
      const requestPath = join(tmpDir, 'client.json');
      writeFileSync(requestPath, JSON.stringify({
        client_name: 'Native Longview',
        token_endpoint_auth_method: 'none',
        application_type: 'native',
      }, null, 2));

      const result = await runCliExpectFailure(
        ['provider', 'register', requestPath, '--rs-url', rsUrl, '--initial-access-token', TEST_DCR_INITIAL_ACCESS_TOKEN, '--format', 'json'],
      );

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /application_type metadata is not supported/i);
    });
  });

  await t.test('provider register fails honestly for unsupported launch-profile grant_types and response_types metadata', async () => {
    await withHarness(async ({ rsUrl }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-register-unsupported-flow-metadata-'));
      try {
        const unsupportedGrantTypesPath = join(tmpDir, 'unsupported-grant-types.json');
        writeFileSync(unsupportedGrantTypesPath, JSON.stringify({
          client_name: 'Grant Types Longview',
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code'],
        }, null, 2));

        const unsupportedGrantTypesResult = await runCliExpectFailure(
          ['provider', 'register', unsupportedGrantTypesPath, '--rs-url', rsUrl, '--initial-access-token', TEST_DCR_INITIAL_ACCESS_TOKEN, '--format', 'json'],
        );

        assert.notEqual(unsupportedGrantTypesResult.code, 0);
        assert.match(unsupportedGrantTypesResult.stderr, /grant_types metadata is not supported/i);

        const unsupportedResponseTypesPath = join(tmpDir, 'unsupported-response-types.json');
        writeFileSync(unsupportedResponseTypesPath, JSON.stringify({
          client_name: 'Response Types Longview',
          token_endpoint_auth_method: 'none',
          response_types: ['code'],
        }, null, 2));

        const unsupportedResponseTypesResult = await runCliExpectFailure(
          ['provider', 'register', unsupportedResponseTypesPath, '--rs-url', rsUrl, '--initial-access-token', TEST_DCR_INITIAL_ACCESS_TOKEN, '--format', 'json'],
        );

        assert.notEqual(unsupportedResponseTypesResult.code, 0);
        assert.match(unsupportedResponseTypesResult.stderr, /response_types metadata is not supported/i);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('provider register fails honestly for unsupported client metadata extension fields', async () => {
    await withHarness(async ({ rsUrl }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-register-unsupported-metadata-'));
      const requestPath = join(tmpDir, 'client.json');
      writeFileSync(requestPath, JSON.stringify({
        client_name: 'Extension Longview',
        token_endpoint_auth_method: 'none',
        jwks_uri: 'https://client.example/jwks.json',
        scope: 'openid profile',
      }, null, 2));

      const result = await runCliExpectFailure(
        ['provider', 'register', requestPath, '--rs-url', rsUrl, '--initial-access-token', TEST_DCR_INITIAL_ACCESS_TOKEN, '--format', 'json'],
      );

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /Unsupported client metadata fields: jwks_uri, scope/);
    });
  });

  await t.test('provider register fails honestly for malformed URI metadata fields', async () => {
    await withHarness(async ({ rsUrl }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-register-invalid-uri-metadata-'));
      try {
        const invalidRedirectUrisPath = join(tmpDir, 'invalid-redirect-uris.json');
        writeFileSync(invalidRedirectUrisPath, JSON.stringify({
          client_name: 'Broken Redirect Client',
          token_endpoint_auth_method: 'none',
          redirect_uris: ['not a uri'],
        }, null, 2));

        const invalidRedirectUrisResult = await runCliExpectFailure(
          ['provider', 'register', invalidRedirectUrisPath, '--rs-url', rsUrl, '--initial-access-token', TEST_DCR_INITIAL_ACCESS_TOKEN, '--format', 'json'],
        );

        assert.notEqual(invalidRedirectUrisResult.code, 0);
        assert.match(invalidRedirectUrisResult.stderr, /redirect_uris must be a valid absolute URI/);

        const invalidClientUriPath = join(tmpDir, 'invalid-client-uri.json');
        writeFileSync(invalidClientUriPath, JSON.stringify({
          client_name: 'Broken Client URI',
          token_endpoint_auth_method: 'none',
          client_uri: 'still not a uri',
        }, null, 2));

        const invalidClientUriResult = await runCliExpectFailure(
          ['provider', 'register', invalidClientUriPath, '--rs-url', rsUrl, '--initial-access-token', TEST_DCR_INITIAL_ACCESS_TOKEN, '--format', 'json'],
        );

        assert.notEqual(invalidClientUriResult.code, 0);
        assert.match(invalidClientUriResult.stderr, /client_uri must be a valid absolute URI/);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('inspect manifest handles native provider manifests and normalizes primary_key display', async () => {
    const manifestPath = join(REFERENCE_IMPL_DIR, 'manifests/northstar-hr.json');
    const result = await runCli(
      ['inspect', 'manifest', manifestPath, '--format', 'json'],
    );

    assert.ok(Array.isArray(result.json));
    const payStatements = result.json.find((stream) => stream.stream === 'pay_statements');
    assert.equal(payStatements.source_kind, 'provider_native');
    assert.equal(payStatements.source_id, 'northstar_hr');
    assert.equal(payStatements.primary_key, 'statement_id');
    assert.equal(result.stderr, '');
  });

  await t.test('inspect manifest rejects malformed native storage_binding instead of masking it', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-manifest-invalid-native-storage-'));
    const manifestPath = join(tmpDir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify({
      provider_id: 'northstar_hr',
      storage_binding: {
        connector_id: 'northstar_hr_native',
        debug_context: 'should_not_be_accepted',
      },
      version: '0.1.0',
      name: 'Northstar HR',
      streams: [
        {
          name: 'pay_statements',
          semantics: 'urn:pdpp:stream:pay_statements',
          primary_key: 'statement_id',
          schema: {
            type: 'object',
            properties: {
              statement_id: { type: 'string' },
            },
          },
        },
      ],
    }, null, 2));

    const result = await runCliExpectFailure(
      ['inspect', 'manifest', manifestPath, '--format', 'json'],
    );

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /manifest\.storage_binding must include only connector_id/);
  });

  await t.test('inspect manifest rejects connector manifests that include native-only storage_binding', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-manifest-connector-storage-binding-'));
    const manifestPath = join(tmpDir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify({
      connector_id: 'https://registry.pdpp.org/connectors/spotify',
      storage_binding: {
        connector_id: 'spotify_native_storage',
      },
      version: '1.0.0',
      display_name: 'Spotify',
      streams: [
        {
          name: 'top_artists',
          semantics: 'mutable_state',
          primary_key: 'id',
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
            },
          },
        },
      ],
    }, null, 2));

    const result = await runCliExpectFailure(
      ['inspect', 'manifest', manifestPath, '--format', 'json'],
    );

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /connector manifests must not include storage_binding/);
  });

  await t.test('inspect request renders the current normalized request shape', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-request-'));
    const requestPath = join(tmpDir, 'normalized-request.json');
    writeFileSync(requestPath, JSON.stringify({
      request_kind: 'pdpp_selection_request',
      request_version: 'reference.v1',
      client: {
        client_id: 'longview',
        client_display: { name: 'Longview' },
      },
      selection: {
        type: 'https://pdpp.org/data-access',
        purpose_code: 'https://pdpp.org/purpose/financial_planning',
        access_mode: 'continuous',
        streams: [{ name: 'pay_statements' }, { name: 'equity_grants' }],
      },
      source_binding: {
        binding_kind: 'provider_native',
        provider_id: 'northstar_hr',
      },
      storage_binding: {
        connector_id: 'northstar_hr_native',
      },
    }, null, 2));

    const result = await runCli(
      ['inspect', 'request', requestPath, '--format', 'json'],
    );

    assert.equal(result.json.client_display, 'Longview');
    assert.equal(result.json.purpose_code, 'https://pdpp.org/purpose/financial_planning');
    assert.equal(result.json.access_mode, 'continuous');
    assert.equal(result.json.source_kind, 'provider_native');
    assert.equal(result.json.source_id, 'northstar_hr');
    assert.equal(result.json.streams, 'pay_statements, equity_grants');
    assert.equal(result.stderr, '');
  });

  await t.test('inspect request rejects malformed source_binding instead of masking it', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-request-invalid-'));
    const requestPath = join(tmpDir, 'malformed-request.json');
    writeFileSync(requestPath, JSON.stringify({
      request_kind: 'pdpp_selection_request',
      request_version: 'reference.v1',
      client: {
        client_id: 'longview',
        client_display: { name: 'Longview' },
      },
      selection: {
        type: 'https://pdpp.org/data-access',
        purpose_code: 'https://pdpp.org/purpose/financial_planning',
        access_mode: 'continuous',
        streams: [{ name: 'pay_statements' }],
      },
      source_binding: {
        connector_id: 'northstar_hr_native',
      },
      storage_binding: {
        connector_id: 'northstar_hr_native',
      },
    }, null, 2));

    const result = await runCliExpectFailure(
      ['inspect', 'request', requestPath, '--format', 'json'],
    );

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /request\.source_binding\.binding_kind must be 'connector' or 'provider_native'/);
  });

  await t.test('inspect request rejects malformed storage_binding instead of masking it', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-request-invalid-storage-'));
    const requestPath = join(tmpDir, 'malformed-request.json');
    writeFileSync(requestPath, JSON.stringify({
      request_kind: 'pdpp_selection_request',
      request_version: 'reference.v1',
      client: {
        client_id: 'longview',
        client_display: { name: 'Longview' },
      },
      selection: {
        type: 'https://pdpp.org/data-access',
        purpose_code: 'https://pdpp.org/purpose/financial_planning',
        access_mode: 'continuous',
        streams: [{ name: 'pay_statements' }],
      },
      source_binding: {
        binding_kind: 'connector',
        connector_id: 'northstar_hr_native',
      },
      storage_binding: {
        connector_id: 'northstar_hr_native',
        debug_context: 'should_not_be_accepted',
      },
    }, null, 2));

    const result = await runCliExpectFailure(
      ['inspect', 'request', requestPath, '--format', 'json'],
    );

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /request\.storage_binding must include only connector_id/);
  });

  await t.test('inspect request rejects connector and storage binding mismatches instead of masking them', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-request-mismatched-storage-'));
    const requestPath = join(tmpDir, 'mismatched-request.json');
    writeFileSync(requestPath, JSON.stringify({
      request_kind: 'pdpp_selection_request',
      request_version: 'reference.v1',
      client: {
        client_id: 'longview',
        client_display: { name: 'Longview' },
      },
      selection: {
        type: 'https://pdpp.org/data-access',
        purpose_code: 'https://pdpp.org/purpose/financial_planning',
        access_mode: 'continuous',
        streams: [{ name: 'pay_statements' }],
      },
      source_binding: {
        binding_kind: 'connector',
        connector_id: 'northstar_hr_native',
      },
      storage_binding: {
        connector_id: 'other_storage_connector',
      },
    }, null, 2));

    const result = await runCliExpectFailure(
      ['inspect', 'request', requestPath, '--format', 'json'],
    );

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /request\.source_binding\.connector_id must match request\.storage_binding\.connector_id/);
  });

  await t.test('inspect grant renders current grant source and client display fields', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-grant-'));
    const grantPath = join(tmpDir, 'grant.json');
    writeFileSync(grantPath, JSON.stringify({
      grant_id: 'grt_test',
      client: {
        client_id: 'longview',
        client_display: { name: 'Longview' },
      },
      subject: { id: 'employee_1' },
      source: {
        binding_kind: 'provider_native',
        provider_id: 'northstar_hr',
      },
      access_mode: 'continuous',
      purpose_code: 'https://pdpp.org/purpose/financial_planning',
      streams: [{ name: 'pay_statements' }, { name: 'equity_grants' }],
      expires_at: null,
    }, null, 2));

    const result = await runCli(
      ['inspect', 'grant', grantPath, '--format', 'json'],
    );

    assert.equal(result.json.grant_id, 'grt_test');
    assert.equal(result.json.client_id, 'longview');
    assert.equal(result.json.client_display, 'Longview');
    assert.equal(result.json.subject_id, 'employee_1');
    assert.equal(result.json.access_mode, 'continuous');
    assert.equal(result.json.purpose_code, 'https://pdpp.org/purpose/financial_planning');
    assert.equal(result.json.source_kind, 'provider_native');
    assert.equal(result.json.source_id, 'northstar_hr');
    assert.equal(result.json.streams, 'pay_statements, equity_grants');
    assert.equal(result.stderr, '');
  });

  await t.test('inspect grant rejects malformed source instead of masking it', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-grant-invalid-'));
    const grantPath = join(tmpDir, 'malformed-grant.json');
    writeFileSync(grantPath, JSON.stringify({
      grant_id: 'grt_test',
      client: {
        client_id: 'longview',
        client_display: { name: 'Longview' },
      },
      subject: { id: 'employee_1' },
      source: {
        connector_id: 'northstar_hr_native',
      },
      access_mode: 'continuous',
      purpose_code: 'https://pdpp.org/purpose/financial_planning',
      streams: [{ name: 'pay_statements' }],
      expires_at: null,
    }, null, 2));

    const result = await runCliExpectFailure(
      ['inspect', 'grant', grantPath, '--format', 'json'],
    );

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /grant\.source\.binding_kind must be 'connector' or 'provider_native'/);
  });

  await t.test('inspect grant rejects malformed optional grant_storage_binding instead of masking it', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-grant-invalid-storage-'));
    const grantPath = join(tmpDir, 'malformed-grant.json');
    writeFileSync(grantPath, JSON.stringify({
      grant_id: 'grt_test',
      client: {
        client_id: 'longview',
        client_display: { name: 'Longview' },
      },
      subject: { id: 'employee_1' },
      source: {
        binding_kind: 'connector',
        connector_id: 'northstar_hr_native',
      },
      grant_storage_binding: {
        connector_id: 'northstar_hr_native',
        debug_context: 'should_not_be_accepted',
      },
      access_mode: 'continuous',
      purpose_code: 'https://pdpp.org/purpose/financial_planning',
      streams: [{ name: 'pay_statements' }],
      expires_at: null,
    }, null, 2));

    const result = await runCliExpectFailure(
      ['inspect', 'grant', grantPath, '--format', 'json'],
    );

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /grant\.grant_storage_binding must include only connector_id/);
  });

  await t.test('inspect grant rejects connector and grant_storage_binding mismatches instead of masking them', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-grant-mismatched-storage-'));
    const grantPath = join(tmpDir, 'mismatched-grant.json');
    writeFileSync(grantPath, JSON.stringify({
      grant_id: 'grt_test',
      client: {
        client_id: 'longview',
        client_display: { name: 'Longview' },
      },
      subject: { id: 'employee_1' },
      source: {
        binding_kind: 'connector',
        connector_id: 'northstar_hr_native',
      },
      grant_storage_binding: {
        connector_id: 'other_storage_connector',
      },
      access_mode: 'continuous',
      purpose_code: 'https://pdpp.org/purpose/financial_planning',
      streams: [{ name: 'pay_statements' }],
      expires_at: null,
    }, null, 2));

    const result = await runCliExpectFailure(
      ['inspect', 'grant', grantPath, '--format', 'json'],
    );

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /grant\.source\.connector_id must match grant\.grant_storage_binding\.connector_id/);
  });

  await t.test('grant start accepts a dynamically registered client', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-dcr-grant-'));
      const registrationPath = join(tmpDir, 'client.json');
      writeFileSync(registrationPath, JSON.stringify({
        client_name: 'Dynamic Longview',
        client_uri: 'https://longview.example',
        policy_uri: 'https://longview.example/privacy',
        tos_uri: 'https://longview.example/terms',
        token_endpoint_auth_method: 'none',
      }, null, 2));

      const registration = await runCli(
        ['provider', 'register', registrationPath, '--rs-url', rsUrl, '--initial-access-token', TEST_DCR_INITIAL_ACCESS_TOKEN, '--format', 'json'],
      );

      const requestPath = join(tmpDir, 'request.json');
      writeFileSync(requestPath, JSON.stringify({
        client_id: registration.json.client_id,
        authorization_details: [
          {
            type: 'https://pdpp.org/data-access',
            connector_id: spotifyManifest.connector_id,
            purpose_code: 'compensation_planning',
            purpose_description: 'Compare pay, equity, and benefits data',
            access_mode: 'single_use',
            streams: [{ name: 'saved_tracks', fields: ['id', 'name'] }],
          },
        ],
      }, null, 2));

      const result = await runCli(
        ['grant', 'start', requestPath, '--as-url', asUrl, '--format', 'json'],
      );

      assert.ok(typeof result.json.request_uri === 'string' && result.json.request_uri.startsWith('urn:pdpp:pending-consent:'));
      assert.ok(typeof result.json.authorization_url === 'string' && result.json.authorization_url.includes('/consent?request_uri='));
      assert.equal(result.stderr, '');
    });
  });

  await t.test('grant start fails honestly when the registered client row is malformed before PAR staging', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-dcr-grant-invalid-'));
      const registrationPath = join(tmpDir, 'client.json');
      writeFileSync(registrationPath, JSON.stringify({
        client_name: 'Dynamic Longview',
        token_endpoint_auth_method: 'none',
      }, null, 2));

      const registration = await runCli(
        ['provider', 'register', registrationPath, '--rs-url', rsUrl, '--initial-access-token', TEST_DCR_INITIAL_ACCESS_TOKEN, '--format', 'json'],
      );

      await updateRegisteredClientRow(registration.json.client_id, {
        metadata_json: '{',
      });

      const requestPath = join(tmpDir, 'request.json');
      writeFileSync(requestPath, JSON.stringify({
        client_id: registration.json.client_id,
        authorization_details: [
          {
            type: 'https://pdpp.org/data-access',
            connector_id: spotifyManifest.connector_id,
            purpose_code: 'compensation_planning',
            purpose_description: 'Compare pay, equity, and benefits data',
            access_mode: 'single_use',
            streams: [{ name: 'saved_tracks', fields: ['id', 'name'] }],
          },
        ],
      }, null, 2));

      const result = await runCliExpectFailure(
        ['grant', 'start', requestPath, '--as-url', asUrl, '--format', 'json'],
      );

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /Registered client .* malformed or no longer valid/);
      assert.match(result.stderr, /Request ID: req_/);
      assert.match(result.stderr, /Reference trace ID: trc_/);
    });
  });

  await t.test('trace show keeps rejected provider-connect start artifacts inspectable', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-dcr-grant-trace-invalid-'));
      const registrationPath = join(tmpDir, 'client.json');
      writeFileSync(registrationPath, JSON.stringify({
        client_name: 'Dynamic Longview',
        token_endpoint_auth_method: 'none',
      }, null, 2));

      const registration = await runCli(
        ['provider', 'register', registrationPath, '--rs-url', rsUrl, '--initial-access-token', TEST_DCR_INITIAL_ACCESS_TOKEN, '--format', 'json'],
      );

      await updateRegisteredClientRow(registration.json.client_id, {
        metadata_json: '{',
      });

      const rejectedResp = await fetch(`${asUrl}/oauth/par`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: registration.json.client_id,
          authorization_details: [
            {
              type: 'https://pdpp.org/data-access',
              connector_id: spotifyManifest.connector_id,
              purpose_code: 'compensation_planning',
              purpose_description: 'Compare pay, equity, and benefits data',
              access_mode: 'single_use',
              streams: [{ name: 'saved_tracks', fields: ['id', 'name'] }],
            },
          ],
        }),
      });
      assert.equal(rejectedResp.status, 400);
      const requestId = rejectedResp.headers.get('Request-Id');
      const traceId = rejectedResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(requestId?.startsWith('req_'));
      assert.ok(traceId?.startsWith('trc_'));

      const result = await runCli(
        ['trace', 'show', traceId, '--as-url', asUrl, '--format', 'json'],
      );

      assert.equal(result.json.object, 'trace');
      assert.equal(result.json.trace_id, traceId);

      const rejected = (result.json.data || []).find((event) =>
        event.event_type === 'request.rejected'
        && event.request_id === requestId
      );
      assert.ok(rejected, 'trace show should include request.rejected for provider-connect start failures');
      assert.equal(rejected.client_id, registration.json.client_id);
      assert.equal(rejected.data?.error?.code, 'invalid_client');
      assert.match(rejected.data?.error?.message || '', /malformed or no longer valid/);
      assert.equal(result.stderr, '');
    });
  });

  await t.test('trace show keeps consent-time deleted-client drift artifacts inspectable', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-consent-trace-deleted-client-'));
      const registrationPath = join(tmpDir, 'client.json');
      writeFileSync(registrationPath, JSON.stringify({
        client_name: 'Transient Longview',
        token_endpoint_auth_method: 'none',
      }, null, 2));

      const registration = await runCli(
        ['provider', 'register', registrationPath, '--rs-url', rsUrl, '--initial-access-token', TEST_DCR_INITIAL_ACCESS_TOKEN, '--format', 'json'],
      );

      const initiate = await startGrantRequest(asUrl, {
        client_id: registration.json.client_id,
        connector_id: spotifyManifest.connector_id,
        purpose_code: 'compensation_planning',
        purpose_description: 'Compare pay, equity, and benefits data',
        access_mode: 'single_use',
        streams: [{ name: 'saved_tracks', fields: ['id', 'name'] }],
      });
      assert.equal(initiate.status, 201);

      getDb().prepare(`DELETE FROM oauth_clients WHERE client_id = ?`).run(registration.json.client_id);

      const consentResp = await fetch(
        `${asUrl}/consent?request_uri=${encodeURIComponent(initiate.body.request_uri)}`,
      );
      assert.equal(consentResp.status, 400);
      const requestId = consentResp.headers.get('Request-Id');
      const traceId = consentResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(requestId?.startsWith('req_'));
      assert.ok(traceId?.startsWith('trc_'));

      const result = await runCli(
        ['trace', 'show', traceId, '--as-url', asUrl, '--format', 'json'],
      );

      assert.equal(result.json.object, 'trace');
      assert.equal(result.json.trace_id, traceId);

      const rejected = (result.json.data || []).find((event) =>
        event.event_type === 'request.rejected'
        && event.request_id === requestId
      );
      assert.ok(rejected, 'trace show should include request.rejected for consent-time deleted-client drift');
      assert.equal(rejected.object_type, 'pending_consent');
      assert.equal(rejected.client_id, registration.json.client_id);
      assert.equal(rejected.data?.source?.binding_kind, 'connector');
      assert.equal(rejected.data?.source?.connector_id, spotifyManifest.connector_id);
      assert.equal(rejected.data?.error?.code, 'invalid_client');
      assert.match(rejected.data?.error?.message || '', /Unknown client_id/);
      assert.equal(result.stderr, '');
    });
  });

  await t.test('trace show keeps approval artifacts on the original staged trace when persisted pending trace-context drifts', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiate = await startGrantRequest(asUrl, {
        client_id: 'longview',
        connector_id: spotifyManifest.connector_id,
        purpose_code: 'compensation_planning',
        purpose_description: 'Compare pay, equity, and benefits data',
        access_mode: 'single_use',
        streams: [{ name: 'saved_tracks', fields: ['id', 'name'] }],
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

      const approveResp = await approveGrantRequest(asUrl, initiate.body.request_uri, 'u1');
      assert.equal(approveResp.status, 200);

      const result = await runCli(
        ['trace', 'show', stagedTraceId, '--as-url', asUrl, '--format', 'json'],
      );

      assert.equal(result.json.object, 'trace');
      assert.equal(result.json.trace_id, stagedTraceId);

      const approved = (result.json.data || []).find((event) =>
        event.event_type === 'consent.approved'
        && event.request_id === stagedRequestId
      );
      assert.ok(approved, 'trace show should keep consent.approved on the original staged trace');
      assert.equal(approved.data?.source?.binding_kind, 'connector');
      assert.equal(approved.data?.source?.connector_id, spotifyManifest.connector_id);

      const grantIssued = (result.json.data || []).find((event) =>
        event.event_type === 'grant.issued'
        && event.request_id === stagedRequestId
      );
      assert.ok(grantIssued, 'trace show should keep grant.issued on the original staged trace');
      assert.equal(grantIssued.data?.source?.binding_kind, 'connector');
      assert.equal(grantIssued.data?.source?.connector_id, spotifyManifest.connector_id);

      const tokenIssued = (result.json.data || []).find((event) =>
        event.event_type === 'token.issued'
        && event.request_id === stagedRequestId
      );
      assert.ok(tokenIssued, 'trace show should keep token.issued on the original staged trace');
      assert.equal(tokenIssued.data?.source?.binding_kind, 'connector');
      assert.equal(tokenIssued.data?.source?.connector_id, spotifyManifest.connector_id);
      assert.equal(tokenIssued.data?.issuance_path, 'grant_approval');
      assert.equal(result.stderr, '');
    });
  });

  await t.test('trace show keeps native consent approval artifacts inspectable without connector leakage', async () => {
    await withNativeHarness(async ({ asUrl, nativeManifest }) => {
      const initiate = await startGrantRequest(asUrl, {
        client_id: 'longview',
        provider_id: nativeManifest.provider_id,
        purpose_code: 'https://pdpp.org/purpose/financial_planning',
        purpose_description: 'Support compensation planning and verification',
        access_mode: 'single_use',
        streams: [{ name: 'pay_statements' }],
      });
      assert.equal(initiate.status, 201);
      const stagedTrace = await readPendingConsentTraceContext(initiate.body.request_uri);
      const stagedRequestId = stagedTrace.request_id;
      const stagedTraceId = stagedTrace.trace_id;
      assert.ok(stagedRequestId?.startsWith('req_'));
      assert.ok(stagedTraceId?.startsWith('trc_'));

      const approveResp = await approveGrantRequest(asUrl, initiate.body.request_uri, 'employee_1');
      assert.equal(approveResp.status, 200);

      const result = await runCli(
        ['trace', 'show', stagedTraceId, '--as-url', asUrl, '--format', 'json'],
      );

      assert.equal(result.json.object, 'trace');
      assert.equal(result.json.trace_id, stagedTraceId);

      const approved = (result.json.data || []).find((event) =>
        event.event_type === 'consent.approved'
        && event.request_id === stagedRequestId
      );
      assert.ok(approved, 'trace show should keep consent.approved on the original staged native trace');
      assert.equal(approved.data?.source?.binding_kind, 'provider_native');
      assert.equal(approved.data?.source?.provider_id, nativeManifest.provider_id);
      assert.ok(!('connector_id' in (approved.data || {})));
      assert.ok(!('storage_connector_id' in (approved.data || {})));

      const grantIssued = (result.json.data || []).find((event) =>
        event.event_type === 'grant.issued'
        && event.request_id === stagedRequestId
      );
      assert.ok(grantIssued, 'trace show should keep grant.issued on the original staged native trace');
      assert.equal(grantIssued.data?.source?.binding_kind, 'provider_native');
      assert.equal(grantIssued.data?.source?.provider_id, nativeManifest.provider_id);
      assert.ok(!('connector_id' in (grantIssued.data || {})));
      assert.ok(!('storage_connector_id' in (grantIssued.data || {})));

      const tokenIssued = (result.json.data || []).find((event) =>
        event.event_type === 'token.issued'
        && event.request_id === stagedRequestId
      );
      assert.ok(tokenIssued, 'trace show should keep token.issued on the original staged native trace');
      assert.equal(tokenIssued.data?.source?.binding_kind, 'provider_native');
      assert.equal(tokenIssued.data?.source?.provider_id, nativeManifest.provider_id);
      assert.equal(tokenIssued.data?.issuance_path, 'grant_approval');
      assert.ok(!('connector_id' in (tokenIssued.data || {})));
      assert.ok(!('storage_connector_id' in (tokenIssued.data || {})));
      assert.equal(result.stderr, '');
    });
  });

  await t.test('trace show keeps request rejection on the original staged trace when persisted pending bindings drift out of contract', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiate = await startGrantRequest(asUrl, {
        client_id: 'longview',
        connector_id: spotifyManifest.connector_id,
        purpose_code: 'https://pdpp.org/purpose/financial_planning',
        purpose_description: 'Compare pay, equity, and benefits data',
        access_mode: 'single_use',
        streams: [{ name: 'saved_tracks', fields: ['id', 'name'] }],
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

      const approveResp = await approveGrantRequest(asUrl, initiate.body.request_uri, 'u1');
      assert.equal(approveResp.status, 400);

      const result = await runCli(
        ['trace', 'show', stagedTraceId, '--as-url', asUrl, '--format', 'json'],
      );

      assert.equal(result.json.object, 'trace');
      assert.equal(result.json.trace_id, stagedTraceId);

      const rejected = (result.json.data || []).find((event) =>
        event.event_type === 'request.rejected'
        && event.request_id === stagedRequestId
      );
      assert.ok(rejected, 'trace show should keep request.rejected on the original staged trace');
      assert.equal(rejected.data?.source?.binding_kind, 'connector');
      assert.equal(rejected.data?.source?.connector_id, spotifyManifest.connector_id);
      assert.equal(result.stderr, '');
    });
  });

  await t.test('trace show keeps malformed pending source-binding rejection artifacts truthful instead of reconstructing connector source', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiate = await startGrantRequest(asUrl, {
        client_id: 'longview',
        connector_id: spotifyManifest.connector_id,
        purpose_code: 'https://pdpp.org/purpose/financial_planning',
        purpose_description: 'Compare pay, equity, and benefits data',
        access_mode: 'single_use',
        streams: [{ name: 'saved_tracks', fields: ['id', 'name'] }],
      });
      assert.equal(initiate.status, 201);
      const stagedTrace = await readPendingConsentTraceContext(initiate.body.request_uri);
      const stagedRequestId = stagedTrace.request_id;
      const stagedTraceId = stagedTrace.trace_id;

      await mutatePendingConsentRequest(initiate.body.request_uri, (request) => {
        request.source_binding = {
          connector_id: request.source_binding.connector_id,
        };
      });

      const approveResp = await approveGrantRequest(asUrl, initiate.body.request_uri, 'u1');
      assert.equal(approveResp.status, 400);

      const result = await runCli(
        ['trace', 'show', stagedTraceId, '--as-url', asUrl, '--format', 'json'],
      );

      assert.equal(result.json.object, 'trace');
      assert.equal(result.json.trace_id, stagedTraceId);

      const rejected = (result.json.data || []).find((event) =>
        event.event_type === 'request.rejected'
        && event.request_id === stagedRequestId
      );
      assert.ok(rejected, 'trace show should keep request.rejected on the original staged trace');
      assert.equal(rejected.data?.source, null);
      assert.equal(result.stderr, '');
    });
  });

  await t.test('trace show keeps consent-time native manifest drift artifacts inspectable', async () => {
    await withNativeHarness(async ({ asUrl, nativeManifest }) => {
      const initiate = await startGrantRequest(asUrl, {
        client_id: 'longview',
        provider_id: nativeManifest.provider_id,
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
      const requestId = consentResp.headers.get('Request-Id');
      const traceId = consentResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(requestId?.startsWith('req_'));
      assert.ok(traceId?.startsWith('trc_'));

      const result = await runCli(
        ['trace', 'show', traceId, '--as-url', asUrl, '--format', 'json'],
      );

      assert.equal(result.json.object, 'trace');
      assert.equal(result.json.trace_id, traceId);

      const rejected = (result.json.data || []).find((event) =>
        event.event_type === 'request.rejected'
        && event.request_id === requestId
      );
      assert.ok(rejected, 'trace show should include request.rejected for consent-time native manifest drift');
      assert.equal(rejected.object_type, 'pending_consent');
      assert.equal(rejected.client_id, 'longview');
      assert.equal(rejected.data?.source?.binding_kind, 'provider_native');
      assert.equal(rejected.data?.source?.provider_id, nativeManifest.provider_id);
      assert.equal(rejected.data?.error?.code, 'invalid_request');
      assert.match(rejected.data?.error?.message || '', /Pending consent request manifest_version '999\.0\.0' does not match current manifest version/);
      assert.equal(result.stderr, '');
    });
  });

  await t.test('trace show keeps consent-denied provider-connect traces inspectable', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiate = await startGrantRequest(asUrl, {
        client_id: 'longview',
        connector_id: spotifyManifest.connector_id,
        purpose_code: 'compensation_planning',
        purpose_description: 'Compare pay, equity, and benefits data',
        access_mode: 'single_use',
        streams: [{ name: 'saved_tracks', fields: ['id', 'name'] }],
      });
      assert.equal(initiate.status, 201);
      const stagedTrace = await readPendingConsentTraceContext(initiate.body.request_uri);
      const requestId = stagedTrace.request_id;
      const traceId = stagedTrace.trace_id;
      assert.ok(requestId?.startsWith('req_'));
      assert.ok(traceId?.startsWith('trc_'));

      const denyResp = await denyGrantRequest(asUrl, initiate.body.request_uri);
      assert.equal(denyResp.status, 200);
      assert.equal(denyResp.headers['request-id'], requestId);
      assert.equal(denyResp.headers['pdpp-reference-trace-id'], traceId);
      assert.match(denyResp.body, /Access Denied/);

      const result = await runCli(
        ['trace', 'show', traceId, '--as-url', asUrl, '--format', 'json'],
      );

      assert.equal(result.json.object, 'trace');
      assert.equal(result.json.trace_id, traceId);

      const denied = (result.json.data || []).find((event) =>
        event.event_type === 'consent.denied'
        && event.request_id === requestId
      );
      assert.ok(denied, 'trace show should include consent.denied for staged provider-connect denial');
      assert.equal(denied.client_id, 'longview');
      assert.equal(denied.object_type, 'pending_consent');
      assert.equal(denied.status, 'denied');
      assert.equal(denied.data?.source?.binding_kind, 'connector');
      assert.equal(denied.data?.source?.connector_id, spotifyManifest.connector_id);
      assert.equal(result.stderr, '');
    });
  });

  await t.test('trace show keeps consent-denied native provider-connect traces inspectable without connector leakage', async () => {
    await withNativeHarness(async ({ asUrl, nativeManifest }) => {
      const initiate = await startGrantRequest(asUrl, {
        client_id: 'longview',
        provider_id: nativeManifest.provider_id,
        purpose_code: 'https://pdpp.org/purpose/financial_planning',
        purpose_description: 'Support compensation planning and verification',
        access_mode: 'single_use',
        streams: [{ name: 'pay_statements' }],
      });
      assert.equal(initiate.status, 201);
      const stagedTrace = await readPendingConsentTraceContext(initiate.body.request_uri);
      const requestId = stagedTrace.request_id;
      const traceId = stagedTrace.trace_id;
      assert.ok(requestId?.startsWith('req_'));
      assert.ok(traceId?.startsWith('trc_'));

      const denyResp = await denyGrantRequest(asUrl, initiate.body.request_uri);
      assert.equal(denyResp.status, 200);
      assert.equal(denyResp.headers['request-id'], requestId);
      assert.equal(denyResp.headers['pdpp-reference-trace-id'], traceId);
      assert.match(denyResp.body, /Access Denied/);

      const result = await runCli(
        ['trace', 'show', traceId, '--as-url', asUrl, '--format', 'json'],
      );

      assert.equal(result.json.object, 'trace');
      assert.equal(result.json.trace_id, traceId);

      const denied = (result.json.data || []).find((event) =>
        event.event_type === 'consent.denied'
        && event.request_id === requestId
      );
      assert.ok(denied, 'trace show should include consent.denied for staged native provider-connect denial');
      assert.equal(denied.client_id, 'longview');
      assert.equal(denied.object_type, 'pending_consent');
      assert.equal(denied.status, 'denied');
      assert.equal(denied.data?.source?.binding_kind, 'provider_native');
      assert.equal(denied.data?.source?.provider_id, nativeManifest.provider_id);
      assert.ok(!('connector_id' in (denied.data || {})));
      assert.ok(!('storage_connector_id' in (denied.data || {})));
      assert.equal(result.stderr, '');
    });
  });


  await t.test('grant start stages a PDPP request through /oauth/par', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-grant-'));
      const requestPath = join(tmpDir, 'request.json');
      writeFileSync(requestPath, JSON.stringify({
        client_id: 'cli_longview',
        client_display: { name: 'Longview', verified: true },
        authorization_details: [
          {
            type: 'https://pdpp.org/data-access',
            connector_id: spotifyManifest.connector_id,
            purpose_code: 'compensation_planning',
            purpose_description: 'Compare pay, equity, and benefits data',
            access_mode: 'single_use',
            streams: [
              { name: 'saved_tracks', fields: ['id', 'name'] },
            ],
          },
        ],
      }, null, 2));

      const result = await runCli(
        ['grant', 'start', requestPath, '--rs-url', rsUrl, '--format', 'json'],
      );

      assert.ok(typeof result.json.request_uri === 'string' && result.json.request_uri.startsWith('urn:pdpp:pending-consent:'));
      assert.ok(typeof result.json.authorization_url === 'string' && result.json.authorization_url.includes('/consent?request_uri='));
      assert.equal(typeof result.json.expires_in, 'number');
      assert.ok(typeof result.json.request_id === 'string' && result.json.request_id.startsWith('req_'));
      assert.ok(typeof result.json.reference_trace_id === 'string' && result.json.reference_trace_id.startsWith('trc_'));

      const trace = await runCli(
        ['trace', 'show', result.json.reference_trace_id, '--rs-url', rsUrl, '--format', 'json'],
      );
      const submittedEvent = (trace.json.data || []).find((event) => event.event_type === 'request.submitted');
      assert.ok(submittedEvent, 'trace show should include request.submitted after CLI grant start');
      assert.equal(submittedEvent.request_id, result.json.request_id);
      assert.equal(submittedEvent.trace_id, result.json.reference_trace_id);
      assert.equal(result.stderr, '');
    });
  });

  await t.test('grant start can discover the AS from PDPP_RS_URL', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-grant-env-rs-'));
      const requestPath = join(tmpDir, 'request.json');
      writeFileSync(requestPath, JSON.stringify({
        client_id: 'cli_longview',
        client_display: { name: 'Longview', verified: true },
        authorization_details: [
          {
            type: 'https://pdpp.org/data-access',
            connector_id: spotifyManifest.connector_id,
            purpose_code: 'compensation_planning',
            purpose_description: 'Compare pay, equity, and benefits data',
            access_mode: 'single_use',
            streams: [{ name: 'saved_tracks', fields: ['id', 'name'] }],
          },
        ],
      }, null, 2));

      const result = await runCli(
        ['grant', 'start', requestPath, '--format', 'json'],
        { PDPP_RS_URL: rsUrl },
      );

      assert.ok(typeof result.json.request_uri === 'string' && result.json.request_uri.startsWith('urn:pdpp:pending-consent:'));
      assert.ok(typeof result.json.reference_trace_id === 'string' && result.json.reference_trace_id.startsWith('trc_'));

      const trace = await runCli(
        ['trace', 'show', result.json.reference_trace_id, '--format', 'json'],
        { PDPP_RS_URL: rsUrl },
      );
      const submittedEvent = (trace.json.data || []).find((event) => event.event_type === 'request.submitted');
      assert.ok(submittedEvent, 'trace show should still inspect grant-start traces when only PDPP_RS_URL is set');
      assert.equal(submittedEvent.trace_id, result.json.reference_trace_id);
      assert.equal(result.stderr, '');
    });
  });

  await t.test('grant start stages a native-provider PDPP request through /oauth/par', async () => {
    await withNativeHarness(async ({ asUrl, nativeManifest }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-native-grant-'));
      const requestPath = join(tmpDir, 'request.json');
      writeFileSync(requestPath, JSON.stringify({
        client_id: 'cli_longview',
        client_display: { name: 'Longview', verified: true },
        authorization_details: [
          {
            type: 'https://pdpp.org/data-access',
            provider_id: nativeManifest.provider_id,
            purpose_code: 'https://pdpp.org/purpose/financial_planning',
            purpose_description: 'Compare pay, equity, and benefits data',
            access_mode: 'single_use',
            streams: [
              { name: 'pay_statements', view: 'summary' },
            ],
          },
        ],
      }, null, 2));

      const result = await runCli(
        ['grant', 'start', requestPath, '--as-url', asUrl, '--format', 'json'],
      );

      assert.ok(typeof result.json.request_uri === 'string' && result.json.request_uri.startsWith('urn:pdpp:pending-consent:'));
      assert.ok(typeof result.json.authorization_url === 'string' && result.json.authorization_url.includes('/consent?request_uri='));
      assert.equal(typeof result.json.expires_in, 'number');
      assert.equal(result.stderr, '');
    });
  });

  await t.test('grant start fails honestly for unsupported broader OAuth request fields', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-grant-unsupported-request-fields-'));
      const requestPath = join(tmpDir, 'request.json');
      writeFileSync(requestPath, JSON.stringify({
        client_id: 'cli_longview',
        redirect_uri: 'https://client.example/callback',
        response_type: 'code',
        authorization_details: [
          {
            type: 'https://pdpp.org/data-access',
            connector_id: spotifyManifest.connector_id,
            purpose_code: 'compensation_planning',
            purpose_description: 'Compare pay, equity, and benefits data',
            access_mode: 'single_use',
            streams: [{ name: 'saved_tracks', fields: ['id', 'name'] }],
          },
        ],
      }, null, 2));

      const result = await runCliExpectFailure(
        ['grant', 'start', requestPath, '--as-url', asUrl, '--format', 'json'],
      );

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /Unsupported request fields: redirect_uri, response_type/);
    });
  });

  await t.test('grant start fails honestly for contradictory stream selections', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-grant-contradictory-stream-selection-'));
      const requestPath = join(tmpDir, 'request.json');
      writeFileSync(requestPath, JSON.stringify({
        client_id: 'cli_longview',
        authorization_details: [
          {
            type: 'https://pdpp.org/data-access',
            connector_id: spotifyManifest.connector_id,
            purpose_code: 'compensation_planning',
            purpose_description: 'Compare pay, equity, and benefits data',
            access_mode: 'single_use',
            streams: [{ name: 'saved_tracks', view: 'basic', fields: ['id', 'name'] }],
          },
        ],
      }, null, 2));

      const result = await runCliExpectFailure(
        ['grant', 'start', requestPath, '--as-url', asUrl, '--format', 'json'],
      );

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /Stream 'saved_tracks' view and fields are mutually exclusive/);
    });
  });

  await t.test('grant revoke surfaces correlation metadata in CLI output and timeline artifacts', async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      await seedNorthstar(nativeManifest);
      const approved = await issueNorthstarClientGrant(asUrl, nativeManifest);

      const result = await runCli(
        ['grant', 'revoke', approved.grant.grant_id, '--rs-url', rsUrl, '--format', 'json'],
      );

      assert.equal(result.json.revoked, true);
      assert.ok(typeof result.json.request_id === 'string' && result.json.request_id.startsWith('req_'));
      assert.ok(typeof result.json.reference_trace_id === 'string' && result.json.reference_trace_id.startsWith('trc_'));

      const timeline = await runCli(
        ['grant', 'timeline', approved.grant.grant_id, '--rs-url', rsUrl, '--format', 'json'],
      );
      const revokedEvent = (timeline.json.data || []).find((event) => event.event_type === 'grant.revoked');
      assert.ok(revokedEvent, 'grant timeline should include grant.revoked after CLI revocation');
      assert.equal(revokedEvent.request_id, result.json.request_id);
      assert.equal(revokedEvent.trace_id, result.json.reference_trace_id);
    });
  });

  await t.test('grant revoke failures surface correlation ids and stay inspectable through timeline and trace readers', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const approved = await approveGrant(asUrl, 'u1', {
        client_id: 'longview',
        connector_id: spotifyManifest.connector_id,
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Maintain a concert-recommendation profile over time',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists', view: 'basic' }],
      });

      const malformedGrant = JSON.parse(JSON.stringify(approved.grant));
      malformedGrant.source = {
        ...malformedGrant.source,
        storage_connector_id: 'leaky_storage_connector',
        debug_context: 'should_not_escape',
      };

      getDb().prepare(`
        UPDATE grants
        SET grant_json = ?,
            storage_binding_json = ?
        WHERE grant_id = ?
      `).run(JSON.stringify(malformedGrant), JSON.stringify({
              connector_id: spotifyManifest.connector_id,
              debug_context: 'should_not_escape',
            }), approved.grant.grant_id);

      const result = await runCliExpectFailure(
        ['grant', 'revoke', approved.grant.grant_id, '--as-url', asUrl, '--format', 'json'],
      );

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /Grant is malformed or no longer valid/);
      const requestId = result.stderr.match(/Request ID: (req_[A-Za-z0-9]+)/)?.[1] || null;
      const traceId = result.stderr.match(/Reference trace ID: (trc_[A-Za-z0-9]+)/)?.[1] || null;
      assert.ok(requestId, 'grant revoke failure should surface a request id on stderr');
      assert.ok(traceId, 'grant revoke failure should surface a reference trace id on stderr');

      const timeline = await runCli(
        ['grant', 'timeline', approved.grant.grant_id, '--as-url', asUrl, '--format', 'json'],
      );
      const rejectedFromTimeline = (timeline.json.data || []).find((event) =>
        event.event_type === 'grant.revoke_rejected' && event.object_id === approved.grant.grant_id
      );
      assert.ok(rejectedFromTimeline, 'grant timeline should include grant.revoke_rejected for malformed grant revocation');
      assert.equal(rejectedFromTimeline.request_id, requestId);
      assert.equal(rejectedFromTimeline.trace_id, traceId);
      assert.equal(rejectedFromTimeline.data?.error?.code, 'grant_invalid');

      const trace = await runCli(
        ['trace', 'show', traceId, '--as-url', asUrl, '--format', 'json'],
      );
      const rejectedFromTrace = (trace.json.data || []).find((event) =>
        event.event_type === 'grant.revoke_rejected' && event.object_id === approved.grant.grant_id
      );
      assert.ok(rejectedFromTrace, 'trace show should include grant.revoke_rejected for malformed grant revocation');
      assert.equal(rejectedFromTrace.request_id, requestId);
      assert.equal(rejectedFromTrace.trace_id, traceId);
      assert.equal(rejectedFromTrace.data?.error?.code, 'grant_invalid');
    });
  });

  await t.test('removed helper routes stay removed', async () => {
    await withHarness(async ({ asUrl }) => {
      const ownerTokenResp = await fetch(`${asUrl}/owner-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject_id: 'u1' }),
      });
      assert.equal(ownerTokenResp.status, 404);

      const helperTokenResp = await fetch(`${asUrl}/grants/grt_fake/tokens`, {
        method: 'POST',
      });
      assert.equal(helperTokenResp.status, 404);
    });
  });

  await t.test('provider register fails without the protected initial access token', async () => {
    await withHarness(async ({ rsUrl }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-register-fail-'));
      const requestPath = join(tmpDir, 'client.json');
      writeFileSync(requestPath, JSON.stringify({
        client_name: 'Rejected Client',
        token_endpoint_auth_method: 'none',
      }, null, 2));

      const result = await runCliExpectFailure(
        ['provider', 'register', requestPath, '--rs-url', rsUrl, '--initial-access-token', 'wrong-token', '--format', 'json'],
      );

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /Invalid initial access token/);
    });
  });


  await t.test('grant start fails honestly when a polyfill provider receives a native-provider request', async () => {
    await withHarness(async ({ asUrl }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-bad-grant-'));
      const requestPath = join(tmpDir, 'request.json');
      writeFileSync(requestPath, JSON.stringify({
        client_id: 'cli_longview',
        client_display: { name: 'Longview', verified: true },
        authorization_details: [
          {
            type: 'https://pdpp.org/data-access',
            provider_id: 'northstar_hr',
            purpose_code: 'https://pdpp.org/purpose/financial_planning',
            purpose_description: 'Compare pay, equity, and benefits data',
            access_mode: 'single_use',
            streams: [
              { name: 'pay_statements', fields: ['gross_pay', 'net_pay'] },
            ],
          },
        ],
      }, null, 2));

      const result = await runCliExpectFailure(
        ['grant', 'start', requestPath, '--as-url', asUrl, '--format', 'json'],
      );

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /include connector_id for polyfill access or provider_id for native provider access/);
    });
  });

  await t.test('grant start fails honestly when a native provider request names an unknown provider_id', async () => {
    await withNativeHarness(async ({ asUrl }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-native-provider-id-mismatch-'));
      const requestPath = join(tmpDir, 'request.json');
      writeFileSync(requestPath, JSON.stringify({
        client_id: 'cli_longview',
        client_display: { name: 'Longview', verified: true },
        authorization_details: [
          {
            type: 'https://pdpp.org/data-access',
            provider_id: 'wrong_provider',
            purpose_code: 'https://pdpp.org/purpose/financial_planning',
            purpose_description: 'Compare pay, equity, and benefits data',
            access_mode: 'single_use',
            streams: [
              { name: 'pay_statements', fields: ['gross_pay', 'net_pay'] },
            ],
          },
        ],
      }, null, 2));

      const result = await runCliExpectFailure(
        ['grant', 'start', requestPath, '--as-url', asUrl, '--format', 'json'],
      );

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /Unknown native provider/);
    });
  });

  await t.test('grant start fails honestly when a native provider request includes both connector_id and provider_id', async () => {
    await withNativeHarness(async ({ asUrl }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-native-binding-conflict-'));
      const requestPath = join(tmpDir, 'request.json');
      writeFileSync(requestPath, JSON.stringify({
        client_id: 'cli_longview',
        client_display: { name: 'Longview', verified: true },
        authorization_details: [
          {
            type: 'https://pdpp.org/data-access',
            connector_id: 'spotify',
            provider_id: 'northstar_hr',
            purpose_code: 'https://pdpp.org/purpose/financial_planning',
            purpose_description: 'Compare pay, equity, and benefits data',
            access_mode: 'single_use',
            streams: [
              { name: 'pay_statements', fields: ['gross_pay', 'net_pay'] },
            ],
          },
        ],
      }, null, 2));

      const result = await runCliExpectFailure(
        ['grant', 'start', requestPath, '--as-url', asUrl, '--format', 'json'],
      );

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /must not include both connector_id and provider_id/);
    });
  });

  await t.test('provider show exposes native provider naming from RS metadata', async () => {
    await withNativeHarness(async ({ rsUrl }) => {
      const result = await runCli(
        ['provider', 'show', '--rs-url', rsUrl, '--format', 'json'],
      );

      assert.equal(result.json.object, 'provider_metadata');
      assert.equal(result.json.resource_name, 'Northstar HR Resource Server');
      assert.equal(result.stderr, '');
    });
  });

  await t.test('agent bootstrap uses the reference-local DCR default without an explicit token', async () => {
    const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    const cacheRoot = mkdtempSync(join(tmpdir(), 'pdpp-agent-bootstrap-'));

    try {
      const result = await runCli([
        'agent',
        'bootstrap',
        '--as-url',
        asUrl,
        '--rs-url',
        rsUrl,
        '--cache-root',
        cacheRoot,
        '--format',
        'json',
      ]);

      assert.equal(result.json.bootstrapped, true);
      assert.equal(result.json.as_url, asUrl);
      assert.equal(result.json.rs_url, rsUrl);
      assert.equal(typeof result.json.client_id, 'string');
      assert.match(result.stderr, /Registered client:/);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  await t.test('discovery-based login can immediately export owner data', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const bootstrapOwnerToken = await issueOwnerToken(asUrl, 'cli_owner');
      await seedSpotify(rsUrl, spotifyManifest, bootstrapOwnerToken);

      const proc = spawn(
        process.execPath,
        [CLI_PATH, 'auth', 'login', '--rs-url', rsUrl, '--client-id', 'cli_longview', '--timeout-seconds', '15', '--format', 'json'],
        {
          cwd: REFERENCE_IMPL_DIR,
          env: { ...process.env, PDPP_AS_URL: '', PDPP_RS_URL: '', AS_URL: '', RS_URL: '' },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );

      let stdout = '';
      let stderr = '';
      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => { stdout += chunk; });
      proc.stderr.on('data', (chunk) => { stderr += chunk; });

      const codeMatch = await waitForRegex(() => stderr, /User code: ([A-Z0-9]+)/);
      const userCode = codeMatch[1];

      const approveResp = await fetch(`${asUrl}/device/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          user_code: userCode,
          subject_id: 'cli_owner',
        }).toString(),
      });
      assert.equal(approveResp.status, 200);

      const exitCode = await new Promise((resolve, reject) => {
        proc.on('error', reject);
        proc.on('close', resolve);
      });

      assert.equal(exitCode, 0, stderr);
      const loginResult = JSON.parse(stdout);
      assert.ok(loginResult.access_token);

      const exportResult = await runCli(
        ['owner', 'export', 'top_artists', '--connector-id', spotifyManifest.connector_id, '--rs-url', rsUrl, '--format', 'jsonl'],
        { PDPP_OWNER_TOKEN: loginResult.access_token },
      );

      const lines = exportResult.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      assert.ok(lines.length > 0);
      assert.ok(lines.some((row) => row.data?.name === 'Radiohead'));
      assert.equal(exportResult.stderr, '');
    });
  });

  await t.test('grant timeline returns the reference timeline for an issued grant', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);
      const approved = await approveGrant(asUrl, 'cli_owner', {
        client_id: 'concert_recommendation_app',
        connector_id: spotifyManifest.connector_id,
        client_display: { name: 'Concert Recommendation App' },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Recommend concerts based on listening history',
        access_mode: 'single_use',
        streams: [{ name: 'top_artists', view: 'basic' }],
      });

      const result = await runCli(
        ['grant', 'timeline', approved.grant.grant_id, '--rs-url', rsUrl, '--format', 'json'],
      );

      assert.equal(result.json.object, 'grant_timeline');
      assert.equal(result.json.grant_id, approved.grant.grant_id);
      assert.ok(Array.isArray(result.json.data));
      assert.ok(result.json.data.some((event) => event.event_type === 'grant.issued'));
      assert.ok(result.json.data.some((event) => event.event_type === 'token.issued'));
      assert.equal(result.stderr, '');
    });
  });

  await t.test('grant timeline keeps grant-scoped state artifacts inspectable', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      const approved = await approveGrant(asUrl, 'cli_owner', {
        client_id: 'concert_recommendation_app',
        connector_id: spotifyManifest.connector_id,
        client_display: { name: 'Concert Recommendation App' },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Maintain grant-scoped state through the CLI timeline reader',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists' }],
      });

      const updateResp = await fetch(
        `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}?grant_id=${encodeURIComponent(approved.grant.grant_id)}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ state: { top_artists: { cursor: 'cli_grant_timeline_cursor' } } }),
        },
      );
      assert.equal(updateResp.status, 200);
      const updateRequestId = updateResp.headers.get('Request-Id');
      assert.ok(updateRequestId?.startsWith('req_'));

      const updateTimeline = await runCli(
        ['grant', 'timeline', approved.grant.grant_id, '--as-url', asUrl, '--format', 'json'],
      );
      const stateRequested = (updateTimeline.json.data || []).find((event) =>
        event.event_type === 'state.requested' && event.object_id === updateRequestId
      );
      assert.ok(stateRequested, 'grant timeline should include state.requested for grant-scoped writes');
      assert.equal(stateRequested.data?.state_scope, 'grant');
      assert.equal(stateRequested.data?.operation, 'write');
      assert.deepEqual(stateRequested.data?.requested_streams, ['top_artists']);

      const stateUpdated = (updateTimeline.json.data || []).find((event) =>
        event.event_type === 'state.updated' && event.object_id === updateRequestId
      );
      assert.ok(stateUpdated, 'grant timeline should include state.updated for grant-scoped writes');
      assert.deepEqual(stateUpdated.data?.persisted_streams, ['top_artists']);

      const rejectedResp = await fetch(
        `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}?grant_id=${encodeURIComponent(approved.grant.grant_id)}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ state: { saved_tracks: { cursor: 'outside_grant' } } }),
        },
      );
      assert.equal(rejectedResp.status, 400);
      const rejectedRequestId = rejectedResp.headers.get('Request-Id');
      assert.ok(rejectedRequestId?.startsWith('req_'));

      const rejectedTimeline = await runCli(
        ['grant', 'timeline', approved.grant.grant_id, '--as-url', asUrl, '--format', 'json'],
      );
      const stateRejected = (rejectedTimeline.json.data || []).find((event) =>
        event.event_type === 'state.rejected' && event.object_id === rejectedRequestId
      );
      assert.ok(stateRejected, 'grant timeline should include state.rejected for grant-scoped write failures');
      assert.equal(stateRejected.data?.state_scope, 'grant');
      assert.equal(stateRejected.data?.operation, 'write');
      assert.equal(stateRejected.data?.error?.code, 'invalid_request');
      assert.match(stateRejected.data?.error?.message || '', /is not scoped to stream saved_tracks/);
    });
  });

  await t.test('grant timeline keeps native revocation artifacts inspectable without connector leakage', async () => {
    await withNativeHarness(async ({ asUrl, nativeManifest }) => {
      const approved = await issueNorthstarClientGrant(asUrl, nativeManifest, 'cli_owner');

      const revokeResp = await fetchJson(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      assert.equal(revokeResp.status, 200);

      const result = await runCli(
        ['grant', 'timeline', approved.grant.grant_id, '--as-url', asUrl, '--format', 'json'],
      );

      assert.equal(result.json.object, 'grant_timeline');
      assert.equal(result.json.grant_id, approved.grant.grant_id);

      const revokedEvent = (result.json.data || []).find((event) => event.event_type === 'grant.revoked');
      assert.ok(revokedEvent, 'grant timeline should include grant.revoked after native revocation');
      assert.equal(revokedEvent.data?.source?.binding_kind, 'provider_native');
      assert.equal(revokedEvent.data?.source?.provider_id, nativeManifest.provider_id);
      assert.ok(!('connector_id' in (revokedEvent.data || {})), 'native revoked event should not expose connector_id');
      assert.ok(!('storage_connector_id' in (revokedEvent.data || {})), 'native revoked event should not expose storage connector ids');
      assert.equal(result.stderr, '');
    });
  });

  await t.test('grant timeline keeps malformed native revocation rejections provider-first when source identity is still valid', async () => {
    await withNativeHarness(async ({ asUrl, nativeManifest }) => {
      const approved = await issueNorthstarClientGrant(asUrl, nativeManifest, 'cli_owner');

      getDb().prepare(`
        UPDATE grants
        SET storage_binding_json = ?
        WHERE grant_id = ?
      `).run(JSON.stringify({
          connector_id: nativeManifest.storage_binding.connector_id,
          debug_context: 'should_not_escape',
        }), approved.grant.grant_id);

      const result = await runCliExpectFailure(
        ['grant', 'revoke', approved.grant.grant_id, '--as-url', asUrl, '--format', 'json'],
      );

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /Grant is malformed or no longer valid/);
      const requestId = result.stderr.match(/Request ID: (req_[A-Za-z0-9]+)/)?.[1] || null;
      const traceId = result.stderr.match(/Reference trace ID: (trc_[A-Za-z0-9]+)/)?.[1] || null;
      assert.ok(requestId, 'grant revoke failure should surface a request id on stderr');
      assert.ok(traceId, 'grant revoke failure should surface a reference trace id on stderr');

      const timeline = await runCli(
        ['grant', 'timeline', approved.grant.grant_id, '--as-url', asUrl, '--format', 'json'],
      );
      const rejectedEvent = (timeline.json.data || []).find((event) =>
        event.event_type === 'grant.revoke_rejected' && event.object_id === approved.grant.grant_id
      );
      assert.ok(rejectedEvent, 'grant timeline should include grant.revoke_rejected for malformed native revocation');
      assert.equal(rejectedEvent.request_id, requestId);
      assert.equal(rejectedEvent.trace_id, traceId);
      assert.equal(rejectedEvent.data?.source?.binding_kind, 'provider_native');
      assert.equal(rejectedEvent.data?.source?.provider_id, nativeManifest.provider_id);
      assert.ok(!('connector_id' in (rejectedEvent.data || {})), 'native revoke rejection should not expose connector_id');
      assert.ok(!('storage_connector_id' in (rejectedEvent.data || {})), 'native revoke rejection should not expose storage connector ids');
      assert.equal(rejectedEvent.data?.error?.code, 'grant_invalid');
    });
  });

  await t.test('grant timeline keeps native issuance artifacts inspectable without connector leakage', async () => {
    await withNativeHarness(async ({ asUrl, nativeManifest }) => {
      const approved = await issueNorthstarClientGrant(asUrl, nativeManifest, 'cli_owner');

      const result = await runCli(
        ['grant', 'timeline', approved.grant.grant_id, '--as-url', asUrl, '--format', 'json'],
      );

      assert.equal(result.json.object, 'grant_timeline');
      assert.equal(result.json.grant_id, approved.grant.grant_id);

      const grantIssued = (result.json.data || []).find((event) => event.event_type === 'grant.issued');
      assert.ok(grantIssued, 'grant timeline should include grant.issued for native approval');
      assert.equal(grantIssued.data?.source?.binding_kind, 'provider_native');
      assert.equal(grantIssued.data?.source?.provider_id, nativeManifest.provider_id);
      assert.ok(!('connector_id' in (grantIssued.data || {})), 'native grant-issued event should not expose connector_id');
      assert.ok(!('storage_connector_id' in (grantIssued.data || {})), 'native grant-issued event should not expose storage connector ids');

      const tokenIssued = (result.json.data || []).find((event) => event.event_type === 'token.issued');
      assert.ok(tokenIssued, 'grant timeline should include token.issued for native approval');
      assert.equal(tokenIssued.data?.source?.binding_kind, 'provider_native');
      assert.equal(tokenIssued.data?.source?.provider_id, nativeManifest.provider_id);
      assert.equal(tokenIssued.data?.issuance_path, 'grant_approval');
      assert.ok(!('connector_id' in (tokenIssued.data || {})), 'native token-issued event should not expose connector_id');
      assert.ok(!('storage_connector_id' in (tokenIssued.data || {})), 'native token-issued event should not expose storage connector ids');
      assert.equal(result.stderr, '');
    });
  });

  await t.test('grant timeline keeps rejected native client query artifacts inspectable without connector leakage', async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      await seedNorthstar(nativeManifest);

      const approved = await approveGrant(asUrl, 'employee_1', {
        client_id: 'longview',
        provider_id: nativeManifest.provider_id,
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
      assert.match(rejectedBody.error.message, /view and fields are mutually exclusive/);

      const timeline = await runCli(
        ['grant', 'timeline', approved.grant.grant_id, '--as-url', asUrl, '--format', 'json'],
      );

      const queryReceived = (timeline.json.data || []).find((event) =>
        event.event_type === 'query.received' && event.object_id === rejectedRequestId
      );
      assert.ok(queryReceived, 'grant timeline should include query.received for rejected native client reads');
      assert.equal(queryReceived.trace_id, rejectedTraceId);
      assert.equal(queryReceived.stream_id, 'pay_statements');
      assert.equal(queryReceived.data?.query_shape, 'record_list');
      assert.equal(queryReceived.data?.source?.binding_kind, 'provider_native');
      assert.equal(queryReceived.data?.source?.provider_id, nativeManifest.provider_id);
      assert.ok(!('connector_id' in (queryReceived.data || {})));
      assert.ok(!('storage_connector_id' in (queryReceived.data || {})));

      const rejectedEvent = (timeline.json.data || []).find((event) =>
        event.event_type === 'query.rejected' && event.object_id === rejectedRequestId
      );
      assert.ok(rejectedEvent, 'grant timeline should include query.rejected for rejected native client reads');
      assert.equal(rejectedEvent.trace_id, rejectedTraceId);
      assert.equal(rejectedEvent.stream_id, 'pay_statements');
      assert.equal(rejectedEvent.data?.query_shape, 'record_list');
      assert.equal(rejectedEvent.data?.source?.binding_kind, 'provider_native');
      assert.equal(rejectedEvent.data?.source?.provider_id, nativeManifest.provider_id);
      assert.ok(!('connector_id' in (rejectedEvent.data || {})));
      assert.ok(!('storage_connector_id' in (rejectedEvent.data || {})));
      assert.equal(rejectedEvent.data?.error?.code, 'invalid_request');
      assert.match(rejectedEvent.data?.error?.message || '', /view and fields are mutually exclusive/);
      assert.equal(timeline.stderr, '');
    });
  });

  await t.test('grant timeline keeps malformed polyfill client stream-list artifacts inspectable', async () => {
    await withMalformedPolyfillClientGrant(async ({ asUrl, rsUrl, approved, missingConnectorId }) => {
      const result = await runCliExpectFailure(
        ['query', 'streams', '--rs-url', rsUrl],
        { PDPP_CLIENT_TOKEN: approved.token },
      );

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /Unknown connector: missing_spotify_connector/);
      const requestId = result.stderr.match(/Request ID: (req_[A-Za-z0-9_]+)/)?.[1];
      const traceId = result.stderr.match(/Reference trace ID: (trc_[A-Za-z0-9_]+)/)?.[1];
      assert.ok(requestId, 'malformed polyfill client stream-list read should surface a request id on stderr');
      assert.ok(traceId, 'malformed polyfill client stream-list read should surface a reference trace id on stderr');

      const timeline = await runCli(
        ['grant', 'timeline', approved.grant.grant_id, '--as-url', asUrl, '--format', 'json'],
      );

      assertMalformedPolyfillClientArtifacts({
        events: timeline.json.data,
        requestId,
        traceId,
        queryShape: 'stream_list',
        missingConnectorId,
        label: 'stream-list reads',
        stderr: timeline.stderr,
      });
    });
  });

  await t.test('grant timeline keeps malformed polyfill client stream-metadata artifacts inspectable', async () => {
    await withMalformedPolyfillClientGrant(async ({ asUrl, rsUrl, approved, missingConnectorId }) => {
      const rejectedResp = await fetch(`${rsUrl}/v1/streams/top_artists`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(rejectedResp.status, 404);
      const requestId = rejectedResp.headers.get('Request-Id');
      const traceId = rejectedResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(requestId?.startsWith('req_'), 'malformed polyfill client stream-metadata read should surface a request id');
      assert.ok(traceId?.startsWith('trc_'), 'malformed polyfill client stream-metadata read should surface a reference trace id');
      const rejectedBody = await rejectedResp.json();
      assert.equal(rejectedBody.error.code, 'not_found');
      assert.match(rejectedBody.error.message, /Unknown connector: missing_spotify_connector/);

      const timeline = await runCli(
        ['grant', 'timeline', approved.grant.grant_id, '--as-url', asUrl, '--format', 'json'],
      );

      assertMalformedPolyfillClientArtifacts({
        events: timeline.json.data,
        requestId,
        traceId,
        streamId: 'top_artists',
        queryShape: 'stream_metadata',
        missingConnectorId,
        label: 'stream-metadata reads',
        stderr: timeline.stderr,
      });
    });
  });

  await t.test('grant timeline keeps malformed polyfill client record-list artifacts inspectable', async () => {
    await withMalformedPolyfillClientGrant(async ({ asUrl, rsUrl, approved, missingConnectorId }) => {
      const result = await runCliExpectFailure(
        ['query', 'records', 'top_artists', '--rs-url', rsUrl, '--format', 'json'],
        { PDPP_CLIENT_TOKEN: approved.token },
      );

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /Unknown connector: missing_spotify_connector/);
      const requestId = result.stderr.match(/Request ID: (req_[A-Za-z0-9_]+)/)?.[1];
      const traceId = result.stderr.match(/Reference trace ID: (trc_[A-Za-z0-9_]+)/)?.[1];
      assert.ok(requestId, 'malformed polyfill client record-list read should surface a request id on stderr');
      assert.ok(traceId, 'malformed polyfill client record-list read should surface a reference trace id on stderr');

      const timeline = await runCli(
        ['grant', 'timeline', approved.grant.grant_id, '--as-url', asUrl, '--format', 'json'],
      );

      assertMalformedPolyfillClientArtifacts({
        events: timeline.json.data,
        requestId,
        traceId,
        streamId: 'top_artists',
        queryShape: 'record_list',
        missingConnectorId,
        label: 'record-list reads',
        stderr: timeline.stderr,
      });
    });
  });

  await t.test('grant timeline keeps malformed polyfill client record-detail artifacts inspectable', async () => {
    await withMalformedPolyfillClientGrant(async ({ asUrl, rsUrl, approved, visibleRecord, missingConnectorId }) => {
      const result = await runCliExpectFailure(
        ['query', 'get', 'top_artists', visibleRecord.id, '--rs-url', rsUrl],
        { PDPP_CLIENT_TOKEN: approved.token },
      );

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /Unknown connector: missing_spotify_connector/);
      const requestId = result.stderr.match(/Request ID: (req_[A-Za-z0-9_]+)/)?.[1];
      const traceId = result.stderr.match(/Reference trace ID: (trc_[A-Za-z0-9_]+)/)?.[1];
      assert.ok(requestId, 'malformed polyfill client record-detail read should surface a request id on stderr');
      assert.ok(traceId, 'malformed polyfill client record-detail read should surface a reference trace id on stderr');

      const timeline = await runCli(
        ['grant', 'timeline', approved.grant.grant_id, '--as-url', asUrl, '--format', 'json'],
      );

      assertMalformedPolyfillClientArtifacts({
        events: timeline.json.data,
        requestId,
        traceId,
        streamId: 'top_artists',
        queryShape: 'record_detail',
        requestedRecordId: visibleRecord.id,
        missingConnectorId,
        label: 'record-detail reads',
        stderr: timeline.stderr,
      });
    });
  });

  await t.test('trace show keeps malformed polyfill client query artifacts inspectable', async () => {
    const scenarios = [
      {
        label: 'stream-list reads',
        queryShape: 'stream_list',
        trigger: ({ rsUrl, approved }) =>
          runCliExpectFailure(['query', 'streams', '--rs-url', rsUrl], { PDPP_CLIENT_TOKEN: approved.token }),
      },
      {
        label: 'stream-metadata reads',
        queryShape: 'stream_metadata',
        streamId: 'top_artists',
        trigger: async ({ rsUrl, approved }) => {
          const rejectedResp = await fetch(`${rsUrl}/v1/streams/top_artists`, {
            headers: { Authorization: `Bearer ${approved.token}` },
          });
          assert.equal(rejectedResp.status, 404);
          const rejectedBody = await rejectedResp.json();
          assert.equal(rejectedBody.error.code, 'not_found');
          assert.match(rejectedBody.error.message, /Unknown connector: missing_spotify_connector/);
          return {
            stderr: '',
            requestId: rejectedResp.headers.get('Request-Id'),
            traceId: rejectedResp.headers.get('PDPP-Reference-Trace-Id'),
          };
        },
      },
      {
        label: 'record-list reads',
        queryShape: 'record_list',
        streamId: 'top_artists',
        trigger: ({ rsUrl, approved }) =>
          runCliExpectFailure(['query', 'records', 'top_artists', '--rs-url', rsUrl, '--format', 'json'], {
            PDPP_CLIENT_TOKEN: approved.token,
          }),
      },
      {
        label: 'record-detail reads',
        queryShape: 'record_detail',
        streamId: 'top_artists',
        trigger: ({ rsUrl, approved, visibleRecord }) =>
          runCliExpectFailure(['query', 'get', 'top_artists', visibleRecord.id, '--rs-url', rsUrl], {
            PDPP_CLIENT_TOKEN: approved.token,
          }),
        requestedRecordId: ({ visibleRecord }) => visibleRecord.id,
      },
    ];

    for (const scenario of scenarios) {
      await withMalformedPolyfillClientGrant(async ({ asUrl, rsUrl, approved, visibleRecord, missingConnectorId }) => {
        const failure = await scenario.trigger({ rsUrl, approved, visibleRecord });
        assert.match(failure.stderr || 'Unknown connector: missing_spotify_connector', /Unknown connector: missing_spotify_connector/);
        const requestId = failure.requestId || failure.stderr?.match(/Request ID: (req_[A-Za-z0-9_]+)/)?.[1];
        const traceId = failure.traceId || failure.stderr?.match(/Reference trace ID: (trc_[A-Za-z0-9_]+)/)?.[1];
        assert.ok(requestId, `malformed polyfill client ${scenario.label} should surface a request id`);
        assert.ok(traceId, `malformed polyfill client ${scenario.label} should surface a reference trace id`);

        const trace = await runCli(
          ['trace', 'show', traceId, '--as-url', asUrl, '--format', 'json'],
        );

        assertMalformedPolyfillClientArtifacts({
          events: trace.json.data,
          requestId,
          traceId,
          streamId: scenario.streamId,
          queryShape: scenario.queryShape,
          requestedRecordId: typeof scenario.requestedRecordId === 'function' ? scenario.requestedRecordId({ visibleRecord }) : null,
          missingConnectorId,
          label: scenario.label,
          stderr: trace.stderr,
        });
      });
    }
  });

  await t.test('grant timeline keeps rejected field-limited changes_since filter artifacts inspectable', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const approved = await approveGrant(asUrl, 'cli_owner', {
        client_id: 'concert_recommendation_app',
        connector_id: spotifyManifest.connector_id,
        client_display: { name: 'Concert Recommendation App' },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Maintain a concert-recommendation profile over time using the basic top-artist subset',
        access_mode: 'continuous',
        streams: [{
          name: 'top_artists',
          fields: ['id', 'name', 'genres'],
        }],
      });

      const changesSince = Buffer.from(JSON.stringify({ kind: 'changes_since', version: 0 })).toString('base64');
      const rejectedResp = await fetch(
        `${rsUrl}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(changesSince)}&filter[popularity]=96`,
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

      const timeline = await runCli(
        ['grant', 'timeline', approved.grant.grant_id, '--as-url', asUrl, '--format', 'json'],
      );

      const queryReceived = (timeline.json.data || []).find((event) =>
        event.event_type === 'query.received' && event.object_id === rejectedRequestId
      );
      assert.ok(queryReceived, 'grant timeline should include query.received for rejected changes_since filter reads');
      assert.equal(queryReceived.trace_id, rejectedTraceId);
      assert.equal(queryReceived.stream_id, 'top_artists');
      assert.equal(queryReceived.data?.query_shape, 'record_list');
      assert.equal(queryReceived.data?.has_changes_since, true);
      assert.equal(queryReceived.data?.source?.binding_kind, 'connector');
      assert.equal(queryReceived.data?.source?.connector_id, spotifyManifest.connector_id);

      const rejectedEvent = (timeline.json.data || []).find((event) =>
        event.event_type === 'query.rejected' && event.object_id === rejectedRequestId
      );
      assert.ok(rejectedEvent, 'grant timeline should include query.rejected for rejected changes_since filter reads');
      assert.equal(rejectedEvent.trace_id, rejectedTraceId);
      assert.equal(rejectedEvent.stream_id, 'top_artists');
      assert.equal(rejectedEvent.data?.query_shape, 'record_list');
      assert.equal(rejectedEvent.data?.has_changes_since, true);
      assert.equal(rejectedEvent.data?.source?.binding_kind, 'connector');
      assert.equal(rejectedEvent.data?.source?.connector_id, spotifyManifest.connector_id);
      assert.equal(rejectedEvent.data?.error?.code, 'field_not_granted');
      assert.match(rejectedEvent.data?.error?.message || '', /Filter on field 'popularity' not in grant/);

      const servedEvent = (timeline.json.data || []).find((event) =>
        event.event_type === 'disclosure.served' && event.object_id === rejectedRequestId
      );
      assert.equal(servedEvent, undefined, 'rejected changes_since filter reads should not produce disclosure.served');
      assert.equal(timeline.stderr, '');
    });
  });

  await t.test('grant timeline keeps rejected record-detail resource boundaries inspectable', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const approved = await approveGrant(asUrl, 'cli_owner', {
        client_id: 'concert_recommendation_app',
        connector_id: spotifyManifest.connector_id,
        client_display: { name: 'Concert Recommendation App' },
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
      assert.ok(rejectedTraceId?.startsWith('trc_'));
      const rejectedBody = await rejectedResp.json();
      assert.equal(rejectedBody.error.code, 'not_found');
      assert.match(rejectedBody.error.message, /Record not found/);

      const timeline = await runCli(
        ['grant', 'timeline', approved.grant.grant_id, '--as-url', asUrl, '--format', 'json'],
      );

      const queryReceived = (timeline.json.data || []).find((event) =>
        event.event_type === 'query.received' && event.object_id === rejectedRequestId
      );
      assert.ok(queryReceived, 'grant timeline should include query.received for rejected record-detail reads');
      assert.equal(queryReceived.trace_id, rejectedTraceId);
      assert.equal(queryReceived.stream_id, 'top_artists');
      assert.equal(queryReceived.data?.query_shape, 'record_detail');
      assert.equal(queryReceived.data?.requested_record_id, rejectedId);
      assert.equal(queryReceived.data?.source?.binding_kind, 'connector');
      assert.equal(queryReceived.data?.source?.connector_id, spotifyManifest.connector_id);

      const rejectedEvent = (timeline.json.data || []).find((event) =>
        event.event_type === 'query.rejected' && event.object_id === rejectedRequestId
      );
      assert.ok(rejectedEvent, 'grant timeline should include query.rejected for rejected record-detail reads');
      assert.equal(rejectedEvent.trace_id, rejectedTraceId);
      assert.equal(rejectedEvent.stream_id, 'top_artists');
      assert.equal(rejectedEvent.data?.query_shape, 'record_detail');
      assert.equal(rejectedEvent.data?.requested_record_id, rejectedId);
      assert.equal(rejectedEvent.data?.source?.binding_kind, 'connector');
      assert.equal(rejectedEvent.data?.source?.connector_id, spotifyManifest.connector_id);
      assert.equal(rejectedEvent.data?.error?.code, 'not_found');
      assert.match(rejectedEvent.data?.error?.message || '', /Record not found/);

      const servedEvent = (timeline.json.data || []).find((event) =>
        event.event_type === 'disclosure.served' && event.object_id === rejectedRequestId
      );
      assert.equal(servedEvent, undefined, 'rejected record-detail reads should not produce disclosure.served');
      assert.equal(timeline.stderr, '');
    });
  });

  await t.test('grant timeline keeps rejected stream-boundary client reads inspectable across metadata, record-list, and record-detail routes', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const ownerListResp = await fetchJson(
        `${rsUrl}/v1/streams/saved_tracks/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}&limit=1`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      const hiddenRecord = ownerListResp.body.data?.[0];
      assert.ok(hiddenRecord, 'expected an owner-visible saved_tracks record outside the client grant');

      const approved = await approveGrant(asUrl, 'cli_owner', {
        client_id: 'concert_recommendation_app',
        connector_id: spotifyManifest.connector_id,
        client_display: { name: 'Concert Recommendation App' },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Recommend concerts using top artists only',
        access_mode: 'single_use',
        streams: [{ name: 'top_artists', view: 'basic' }],
      });

      const scenarios = [
        {
          label: 'stream-metadata reads',
          streamId: 'recently_played',
          queryShape: 'stream_metadata',
          expectStatus: 403,
          expectedCode: 'grant_stream_not_allowed',
          expectedMessage: /Stream 'recently_played' not in grant/,
          trigger: () => fetch(`${rsUrl}/v1/streams/recently_played`, {
            headers: { Authorization: `Bearer ${approved.token}` },
          }),
        },
        {
          label: 'record-list reads',
          streamId: 'recently_played',
          queryShape: 'record_list',
          expectStatus: 403,
          expectedCode: 'grant_stream_not_allowed',
          expectedMessage: /Stream 'recently_played' not in grant/,
          trigger: () => fetch(`${rsUrl}/v1/streams/recently_played/records?limit=1`, {
            headers: { Authorization: `Bearer ${approved.token}` },
          }),
        },
        {
          label: 'record-detail reads',
          streamId: 'saved_tracks',
          queryShape: 'record_detail',
          requestedRecordId: hiddenRecord.id,
          expectStatus: 403,
          expectedCode: 'grant_stream_not_allowed',
          expectedMessage: /Stream 'saved_tracks' not in grant/,
          trigger: () => fetch(`${rsUrl}/v1/streams/saved_tracks/records/${encodeURIComponent(hiddenRecord.id)}`, {
            headers: { Authorization: `Bearer ${approved.token}` },
          }),
        },
      ];

      for (const scenario of scenarios) {
        const rejectedResp = await scenario.trigger();
        assert.equal(rejectedResp.status, scenario.expectStatus);
        const rejectedRequestId = rejectedResp.headers.get('Request-Id');
        const rejectedTraceId = rejectedResp.headers.get('PDPP-Reference-Trace-Id');
        assert.ok(rejectedRequestId?.startsWith('req_'));
        assert.ok(rejectedTraceId?.startsWith('trc_'));
        const rejectedBody = await rejectedResp.json();
        assert.equal(rejectedBody.error.code, scenario.expectedCode);
        assert.match(rejectedBody.error.message, scenario.expectedMessage);

        const timeline = await runCli(
          ['grant', 'timeline', approved.grant.grant_id, '--as-url', asUrl, '--format', 'json'],
        );

        const queryReceived = (timeline.json.data || []).find((event) =>
          event.event_type === 'query.received' && event.object_id === rejectedRequestId
        );
        assert.ok(queryReceived, `grant timeline should include query.received for rejected ${scenario.label}`);
        assert.equal(queryReceived.trace_id, rejectedTraceId);
        assert.equal(queryReceived.stream_id, scenario.streamId);
        assert.equal(queryReceived.data?.query_shape, scenario.queryShape);
        assert.equal(queryReceived.data?.requested_record_id ?? null, scenario.requestedRecordId ?? null);
        assert.equal(queryReceived.data?.source?.binding_kind, 'connector');
        assert.equal(queryReceived.data?.source?.connector_id, spotifyManifest.connector_id);

        const rejectedEvent = (timeline.json.data || []).find((event) =>
          event.event_type === 'query.rejected' && event.object_id === rejectedRequestId
        );
        assert.ok(rejectedEvent, `grant timeline should include query.rejected for rejected ${scenario.label}`);
        assert.equal(rejectedEvent.trace_id, rejectedTraceId);
        assert.equal(rejectedEvent.stream_id, scenario.streamId);
        assert.equal(rejectedEvent.data?.query_shape, scenario.queryShape);
        assert.equal(rejectedEvent.data?.requested_record_id ?? null, scenario.requestedRecordId ?? null);
        assert.equal(rejectedEvent.data?.source?.binding_kind, 'connector');
        assert.equal(rejectedEvent.data?.source?.connector_id, spotifyManifest.connector_id);
        assert.equal(rejectedEvent.data?.error?.code, scenario.expectedCode);
        assert.match(rejectedEvent.data?.error?.message || '', scenario.expectedMessage);

        const servedEvent = (timeline.json.data || []).find((event) =>
          event.event_type === 'disclosure.served' && event.object_id === rejectedRequestId
        );
        assert.equal(servedEvent, undefined, `rejected ${scenario.label} should not produce disclosure.served`);
        assert.equal(timeline.stderr, '');
      }
    });
  });

  await t.test('grant timeline keeps rejected record-detail time-range boundaries inspectable', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const since = new Date(Date.now() - (4 * 24 * 60 * 60 * 1000)).toISOString();
      const approved = await approveGrant(asUrl, 'cli_owner', {
        client_id: 'concert_recommendation_app',
        connector_id: spotifyManifest.connector_id,
        client_display: { name: 'Concert Recommendation App' },
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
      assert.ok(rejectedTraceId?.startsWith('trc_'));
      const rejectedBody = await rejectedResp.json();
      assert.equal(rejectedBody.error.code, 'not_found');
      assert.match(rejectedBody.error.message, /Record not found/);

      const timeline = await runCli(
        ['grant', 'timeline', approved.grant.grant_id, '--as-url', asUrl, '--format', 'json'],
      );

      const queryReceived = (timeline.json.data || []).find((event) =>
        event.event_type === 'query.received' && event.object_id === rejectedRequestId
      );
      assert.ok(queryReceived, 'grant timeline should include query.received for rejected time-range record-detail reads');
      assert.equal(queryReceived.trace_id, rejectedTraceId);
      assert.equal(queryReceived.stream_id, 'top_artists');
      assert.equal(queryReceived.data?.query_shape, 'record_detail');
      assert.equal(queryReceived.data?.requested_record_id, hiddenRecord.id);
      assert.equal(queryReceived.data?.source?.binding_kind, 'connector');
      assert.equal(queryReceived.data?.source?.connector_id, spotifyManifest.connector_id);

      const rejectedEvent = (timeline.json.data || []).find((event) =>
        event.event_type === 'query.rejected' && event.object_id === rejectedRequestId
      );
      assert.ok(rejectedEvent, 'grant timeline should include query.rejected for rejected time-range record-detail reads');
      assert.equal(rejectedEvent.trace_id, rejectedTraceId);
      assert.equal(rejectedEvent.stream_id, 'top_artists');
      assert.equal(rejectedEvent.data?.query_shape, 'record_detail');
      assert.equal(rejectedEvent.data?.requested_record_id, hiddenRecord.id);
      assert.equal(rejectedEvent.data?.source?.binding_kind, 'connector');
      assert.equal(rejectedEvent.data?.source?.connector_id, spotifyManifest.connector_id);
      assert.equal(rejectedEvent.data?.error?.code, 'not_found');
      assert.match(rejectedEvent.data?.error?.message || '', /Record not found/);

      const servedEvent = (timeline.json.data || []).find((event) =>
        event.event_type === 'disclosure.served' && event.object_id === rejectedRequestId
      );
      assert.equal(servedEvent, undefined, 'rejected time-range record-detail reads should not produce disclosure.served');
      assert.equal(timeline.stderr, '');
    });
  });

  await t.test('run timeline keeps successful checkpointed run artifacts inspectable', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      const result = await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      assert.ok(result.run_id, 'seed run should expose run_id');

      const timeline = await runCli(
        ['run', 'timeline', result.run_id, '--rs-url', rsUrl, '--format', 'json'],
      );

      assert.equal(timeline.json.object, 'run_timeline');
      assert.equal(timeline.json.run_id, result.run_id);
      assert.ok(Array.isArray(timeline.json.data));

      const runStarted = (timeline.json.data || []).find((event) => event.event_type === 'run.started');
      assert.ok(runStarted, 'run timeline should include run.started');
      assert.equal(runStarted.data?.collection_mode, 'full_refresh');
      assert.equal(runStarted.data?.state_commit_intent, 'commit_on_success');
      assert.deepEqual(runStarted.data?.scope_streams, ['top_artists', 'saved_tracks', 'recently_played']);

      const stagedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.state_staged');
      assert.ok(stagedEvent, 'run timeline should include run.state_staged');
      assert.equal(stagedEvent.data?.checkpoint_mode, 'checkpointed_streaming');

      const advancedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.state_advanced');
      assert.ok(advancedEvent, 'run timeline should include run.state_advanced');

      const progressEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.progress_reported');
      assert.ok(progressEvent, 'run timeline should include run.progress_reported');

      const completedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.completed');
      assert.ok(completedEvent, 'run timeline should include run.completed');
      assert.equal(completedEvent.data?.checkpoint_commit_status, 'committed');
      assert.equal(completedEvent.data?.buffered_records_dropped, 0);
      assert.equal(timeline.stderr, '');
    });
  });

  await t.test('run timeline can discover the AS from PDPP_RS_URL', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      const result = await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const timeline = await runCli(
        ['run', 'timeline', result.run_id, '--format', 'json'],
        { PDPP_RS_URL: rsUrl },
      );

      assert.equal(timeline.json.object, 'run_timeline');
      assert.equal(timeline.json.run_id, result.run_id);
      assert.ok((timeline.json.data || []).some((event) => event.event_type === 'run.completed'));
      assert.equal(timeline.stderr, '');
    });
  });

  await t.test('run timeline keeps skipped-stream artifacts inspectable', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-run-skipped-stream-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
        console.log(JSON.stringify({
          type: 'SKIP_RESULT',
          stream: 'saved_tracks',
          reason: 'rate_limited',
          message: 'Platform returned 429',
        }));
        console.log(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }));
      `);

      try {
        const result = await runConnector({
          connectorPath,
          connectorId: spotifyManifest.connector_id,
          ownerToken,
          manifest: spotifyManifest,
          state: null,
          collectionMode: 'full_refresh',
          rsUrl,
        });

        assert.ok(result.run_id, 'skip-only run should expose run_id');

        const timeline = await runCli(
          ['run', 'timeline', result.run_id, '--as-url', asUrl, '--format', 'json'],
        );

        assert.equal(timeline.json.object, 'run_timeline');
        assert.equal(timeline.json.run_id, result.run_id);

        const skippedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.stream_skipped');
        assert.ok(skippedEvent, 'run timeline should include run.stream_skipped');
        assert.equal(skippedEvent.status, 'skipped');
        assert.equal(skippedEvent.stream_id, 'saved_tracks');
        assert.equal(skippedEvent.data?.source?.binding_kind, 'connector');
        assert.equal(skippedEvent.data?.source?.connector_id, spotifyManifest.connector_id);
        assert.equal(skippedEvent.data?.reason, 'rate_limited');
        assert.equal(skippedEvent.data?.message, 'Platform returned 429');

        const completedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.completed');
        assert.ok(completedEvent, 'run timeline should still include run.completed');
        assert.equal(completedEvent.data?.checkpoint_commit_status, 'committed');
        assert.equal(timeline.stderr, '');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('run timeline keeps interaction artifacts inspectable without leaking response secrets', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-run-interaction-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'cli_run_interaction',
      stream: 'saved_tracks',
      kind: 'credentials',
      message: 'Need a platform token',
      schema: {
        type: 'object',
        properties: {
          token: { type: 'string', format: 'password' },
        },
        required: ['token'],
      },
      timeout_seconds: 30,
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
          onInteraction: async (msg) => ({
            type: 'INTERACTION_RESPONSE',
            request_id: msg.request_id,
            status: 'success',
            data: { token: 'super_secret_token' },
          }),
        });

        assert.ok(result.run_id, 'interaction run should expose run_id');

        const timeline = await runCli(
          ['run', 'timeline', result.run_id, '--as-url', asUrl, '--format', 'json'],
        );

        assert.equal(timeline.json.object, 'run_timeline');
        assert.equal(timeline.json.run_id, result.run_id);

        const interactionRequired = (timeline.json.data || []).find((event) => event.event_type === 'run.interaction_required');
        assert.ok(interactionRequired, 'run timeline should include run.interaction_required');
        assert.equal(interactionRequired.data?.source?.binding_kind, 'connector');
        assert.equal(interactionRequired.data?.source?.connector_id, spotifyManifest.connector_id);
        assert.equal(interactionRequired.data?.kind, 'credentials');
        assert.equal(interactionRequired.data?.stream, 'saved_tracks');

        const interactionCompleted = (timeline.json.data || []).find((event) => event.event_type === 'run.interaction_completed');
        assert.ok(interactionCompleted, 'run timeline should include run.interaction_completed');
        assert.equal(interactionCompleted.data?.status, 'success');
        assert.equal(interactionCompleted.data?.stream, 'saved_tracks');

        const serializedTimeline = JSON.stringify(timeline.json);
        assert.ok(!serializedTimeline.includes('super_secret_token'), 'run timeline should not persist interaction response secrets');
        assert.equal(timeline.stderr, '');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('run timeline keeps interaction timeout artifacts inspectable', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-run-interaction-timeout-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'cli_run_interaction_timeout',
      stream: 'saved_tracks',
      kind: 'credentials',
      message: 'Need a platform token',
      schema: {
        type: 'object',
        properties: {
          token: { type: 'string', format: 'password' },
        },
        required: ['token'],
      },
      timeout_seconds: 0.05,
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

        assert.ok(result.run_id, 'timeout interaction run should expose run_id');

        const timeline = await runCli(
          ['run', 'timeline', result.run_id, '--as-url', asUrl, '--format', 'json'],
        );

        const interactionCompleted = (timeline.json.data || []).find((event) => event.event_type === 'run.interaction_completed');
        assert.ok(interactionCompleted, 'run timeline should include run.interaction_completed for timed out interactions');
        assert.equal(interactionCompleted.status, 'timeout');
        assert.equal(interactionCompleted.data?.status, 'timeout');
        assert.equal(interactionCompleted.data?.stream, 'saved_tracks');
        assert.equal(timeline.stderr, '');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('run timeline keeps interaction cancelled artifacts inspectable', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-run-interaction-cancelled-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'cli_run_interaction_cancelled',
      stream: 'saved_tracks',
      kind: 'credentials',
      message: 'Need a platform token',
      schema: {
        type: 'object',
        properties: {
          token: { type: 'string', format: 'password' },
        },
        required: ['token'],
      },
      timeout_seconds: 300,
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

        assert.ok(result.run_id, 'cancelled interaction run should expose run_id');

        const timeline = await runCli(
          ['run', 'timeline', result.run_id, '--as-url', asUrl, '--format', 'json'],
        );

        const interactionCompleted = (timeline.json.data || []).find((event) => event.event_type === 'run.interaction_completed');
        assert.ok(interactionCompleted, 'run timeline should include run.interaction_completed for cancelled interactions');
        assert.equal(interactionCompleted.status, 'cancelled');
        assert.equal(interactionCompleted.data?.status, 'cancelled');
        assert.equal(interactionCompleted.data?.stream, 'saved_tracks');
        assert.equal(timeline.stderr, '');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('run timeline keeps invalid interaction-handler response failures inspectable', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-run-interaction-invalid-response-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'INTERACTION',
    request_id: 'cli_run_interaction_invalid_response',
    stream: 'saved_tracks',
    kind: 'credentials',
    message: 'Need a platform token',
    schema: {
      type: 'object',
      properties: {
        token: { type: 'string', format: 'password' },
      },
      required: ['token'],
    },
    timeout_seconds: 300,
  }) + '\\n');
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
            onInteraction: async (msg) => ({
              type: 'NOT_INTERACTION_RESPONSE',
              request_id: msg.request_id,
              status: 'success',
            }),
          }),
          (err) => {
            rejected = err;
            assert.equal(err.failure_reason, 'interaction_handler_invalid_response');
            assert.ok(err.run_id, 'invalid interaction handler response should expose run_id');
            return true;
          },
        );

        const timeline = await runCli(
          ['run', 'timeline', rejected.run_id, '--as-url', asUrl, '--format', 'json'],
        );

        assert.equal(timeline.json.object, 'run_timeline');
        assert.equal(timeline.json.run_id, rejected.run_id);

        const interactionRequired = (timeline.json.data || []).find((event) => event.event_type === 'run.interaction_required');
        assert.ok(interactionRequired, 'run timeline should include run.interaction_required before invalid handler responses fail the run');
        assert.equal(interactionRequired.data?.stream, 'saved_tracks');

        const interactionCompleted = (timeline.json.data || []).find((event) => event.event_type === 'run.interaction_completed');
        assert.equal(interactionCompleted, undefined, 'invalid handler responses should fail before run.interaction_completed is recorded');

        const failedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.failed');
        assert.ok(failedEvent, 'run timeline should include run.failed for invalid handler responses');
        assert.equal(failedEvent.data?.reason, 'interaction_handler_invalid_response');
        assert.equal(failedEvent.data?.records_flushed, 0);
        assert.equal(failedEvent.data?.buffered_records_dropped, 0);
        assert.equal(failedEvent.data?.checkpoint_commit_status, 'not_committed');
        assert.equal(timeline.stderr, '');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('run timeline keeps malformed INTERACTION envelope failures inspectable without interaction artifacts', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-run-interaction-invalid-envelope-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'INTERACTION',
    request_id: 'cli_run_interaction_invalid_envelope',
    kind: 'mystery',
    message: 'This should fail before entering the durable interaction timeline',
    schema: { type: 'object' },
    timeout_seconds: 300,
  }) + '\\n');
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
            onInteraction: async () => ({
              type: 'INTERACTION_RESPONSE',
              request_id: 'cli_run_interaction_invalid_envelope',
              status: 'success',
              data: {},
            }),
          }),
          (err) => {
            rejected = err;
            assert.equal(err.failure_reason, 'connector_protocol_violation');
            assert.match(err.message, /invalid INTERACTION.kind/);
            assert.ok(err.run_id, 'malformed interaction envelope should expose run_id');
            return true;
          },
        );

        const timeline = await runCli(
          ['run', 'timeline', rejected.run_id, '--as-url', asUrl, '--format', 'json'],
        );

        assert.equal(timeline.json.object, 'run_timeline');
        assert.equal(timeline.json.run_id, rejected.run_id);
        assert.ok(!(timeline.json.data || []).some((event) => event.event_type === 'run.interaction_required'));
        assert.ok(!(timeline.json.data || []).some((event) => event.event_type === 'run.interaction_completed'));

        const failedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.failed');
        assert.ok(failedEvent, 'run timeline should include run.failed for malformed interaction envelopes');
        assert.equal(failedEvent.data?.reason, 'connector_protocol_violation');
        assert.equal(failedEvent.data?.records_flushed, 0);
        assert.equal(failedEvent.data?.buffered_records_dropped, 0);
        assert.equal(failedEvent.data?.checkpoint_commit_status, 'not_committed');
        assert.equal(timeline.stderr, '');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('run timeline keeps malformed INTERACTION schema failures inspectable without interaction artifacts', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-run-interaction-invalid-schema-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'INTERACTION',
    request_id: 'cli_run_interaction_invalid_schema',
    kind: 'manual_action',
    message: 'This should fail before entering the durable interaction timeline',
    schema: ['not-an-object'],
    timeout_seconds: 300,
  }) + '\\n');
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
            onInteraction: async () => ({
              type: 'INTERACTION_RESPONSE',
              request_id: 'cli_run_interaction_invalid_schema',
              status: 'success',
              data: {},
            }),
          }),
          (err) => {
            rejected = err;
            assert.equal(err.failure_reason, 'connector_protocol_violation');
            assert.match(err.message, /invalid INTERACTION\.schema/);
            assert.ok(err.run_id, 'malformed INTERACTION schema should expose run_id');
            return true;
          },
        );

        const timeline = await runCli(
          ['run', 'timeline', rejected.run_id, '--as-url', asUrl, '--format', 'json'],
        );

        assert.equal(timeline.json.object, 'run_timeline');
        assert.equal(timeline.json.run_id, rejected.run_id);
        assert.ok(!(timeline.json.data || []).some((event) => event.event_type === 'run.interaction_required'));
        assert.ok(!(timeline.json.data || []).some((event) => event.event_type === 'run.interaction_completed'));

        const failedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.failed');
        assert.ok(failedEvent, 'run timeline should include run.failed for malformed INTERACTION schema values');
        assert.equal(failedEvent.data?.reason, 'connector_protocol_violation');
        assert.equal(failedEvent.data?.records_flushed, 0);
        assert.equal(failedEvent.data?.buffered_records_dropped, 0);
        assert.equal(failedEvent.data?.checkpoint_commit_status, 'not_committed');
        assert.equal(timeline.stderr, '');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('run timeline keeps malformed PROGRESS envelope failures inspectable without progress artifacts', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-run-progress-invalid-envelope-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'PROGRESS',
    stream: 'top_artists',
    message: 42,
  }) + '\\n');
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
          }),
          (err) => {
            rejected = err;
            assert.equal(err.failure_reason, 'connector_protocol_violation');
            assert.ok(err.run_id, 'malformed PROGRESS envelope should expose run_id');
            return true;
          },
        );

        const timeline = await runCli(
          ['run', 'timeline', rejected.run_id, '--as-url', asUrl, '--format', 'json'],
        );

        assert.equal(timeline.json.object, 'run_timeline');
        assert.equal(timeline.json.run_id, rejected.run_id);
        assert.ok(!(timeline.json.data || []).some((event) => event.event_type === 'run.progress_reported'));

        const failedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.failed');
        assert.ok(failedEvent, 'run timeline should include run.failed for malformed PROGRESS envelopes');
        assert.equal(failedEvent.data?.reason, 'connector_protocol_violation');
        assert.equal(failedEvent.data?.records_flushed, 0);
        assert.equal(failedEvent.data?.buffered_records_dropped, 0);
        assert.equal(failedEvent.data?.checkpoint_commit_status, 'not_committed');
        assert.equal(timeline.stderr, '');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('run timeline keeps malformed PROGRESS total failures inspectable without progress artifacts', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-run-progress-invalid-total-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'PROGRESS',
    stream: 'top_artists',
    message: 'still malformed',
    count: 1,
    total: -3,
  }) + '\\n');
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
          }),
          (err) => {
            rejected = err;
            assert.equal(err.failure_reason, 'connector_protocol_violation');
            assert.match(err.message, /invalid PROGRESS\.total/);
            assert.ok(err.run_id, 'malformed PROGRESS total should expose run_id');
            return true;
          },
        );

        const timeline = await runCli(
          ['run', 'timeline', rejected.run_id, '--as-url', asUrl, '--format', 'json'],
        );

        assert.equal(timeline.json.object, 'run_timeline');
        assert.equal(timeline.json.run_id, rejected.run_id);
        assert.ok(!(timeline.json.data || []).some((event) => event.event_type === 'run.progress_reported'));

        const failedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.failed');
        assert.ok(failedEvent, 'run timeline should include run.failed for malformed PROGRESS totals');
        assert.equal(failedEvent.data?.reason, 'connector_protocol_violation');
        assert.equal(failedEvent.data?.records_flushed, 0);
        assert.equal(failedEvent.data?.buffered_records_dropped, 0);
        assert.equal(failedEvent.data?.checkpoint_commit_status, 'not_committed');
        assert.equal(timeline.stderr, '');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('run timeline keeps undeclared-stream PROGRESS failures inspectable without progress artifacts', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-run-progress-undeclared-stream-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'PROGRESS',
    stream: 'ghost_stream',
    message: 'wrong stream should fail',
  }) + '\\n');
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
          }),
          (err) => {
            rejected = err;
            assert.equal(err.failure_reason, 'connector_protocol_violation');
            assert.match(err.message, /PROGRESS for undeclared stream/);
            assert.ok(err.run_id, 'undeclared-stream PROGRESS failure should expose run_id');
            return true;
          },
        );

        const timeline = await runCli(
          ['run', 'timeline', rejected.run_id, '--as-url', asUrl, '--format', 'json'],
        );

        assert.equal(timeline.json.object, 'run_timeline');
        assert.equal(timeline.json.run_id, rejected.run_id);
        assert.ok(!(timeline.json.data || []).some((event) => event.event_type === 'run.progress_reported'));

        const failedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.failed');
        assert.ok(failedEvent, 'run timeline should include run.failed for undeclared-stream PROGRESS envelopes');
        assert.equal(failedEvent.data?.reason, 'connector_protocol_violation');
        assert.equal(failedEvent.data?.records_flushed, 0);
        assert.equal(failedEvent.data?.buffered_records_dropped, 0);
        assert.equal(failedEvent.data?.checkpoint_commit_status, 'not_committed');
        assert.equal(timeline.stderr, '');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('run timeline keeps malformed SKIP_RESULT envelope failures inspectable without skip artifacts', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-run-skip-invalid-envelope-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'SKIP_RESULT',
    stream: 'saved_tracks',
    reason: '',
    message: 'missing reason content should fail',
  }) + '\\n');
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
          }),
          (err) => {
            rejected = err;
            assert.equal(err.failure_reason, 'connector_protocol_violation');
            assert.ok(err.run_id, 'malformed SKIP_RESULT envelope should expose run_id');
            return true;
          },
        );

        const timeline = await runCli(
          ['run', 'timeline', rejected.run_id, '--as-url', asUrl, '--format', 'json'],
        );

        assert.equal(timeline.json.object, 'run_timeline');
        assert.equal(timeline.json.run_id, rejected.run_id);
        assert.ok(!(timeline.json.data || []).some((event) => event.event_type === 'run.stream_skipped'));

        const failedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.failed');
        assert.ok(failedEvent, 'run timeline should include run.failed for malformed SKIP_RESULT envelopes');
        assert.equal(failedEvent.data?.reason, 'connector_protocol_violation');
        assert.equal(failedEvent.data?.records_flushed, 0);
        assert.equal(failedEvent.data?.buffered_records_dropped, 0);
        assert.equal(failedEvent.data?.checkpoint_commit_status, 'not_committed');
        assert.equal(timeline.stderr, '');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('run timeline keeps undeclared-stream SKIP_RESULT failures inspectable without skip artifacts', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-run-skip-undeclared-stream-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'SKIP_RESULT',
    stream: 'ghost_stream',
    reason: 'rate_limited',
    message: 'wrong stream should fail',
  }) + '\\n');
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
          }),
          (err) => {
            rejected = err;
            assert.equal(err.failure_reason, 'connector_protocol_violation');
            assert.match(err.message, /SKIP_RESULT for undeclared stream/);
            assert.ok(err.run_id, 'undeclared-stream SKIP_RESULT failure should expose run_id');
            return true;
          },
        );

        const timeline = await runCli(
          ['run', 'timeline', rejected.run_id, '--as-url', asUrl, '--format', 'json'],
        );

        assert.equal(timeline.json.object, 'run_timeline');
        assert.equal(timeline.json.run_id, rejected.run_id);
        assert.ok(!(timeline.json.data || []).some((event) => event.event_type === 'run.stream_skipped'));

        const failedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.failed');
        assert.ok(failedEvent, 'run timeline should include run.failed for undeclared-stream SKIP_RESULT envelopes');
        assert.equal(failedEvent.data?.reason, 'connector_protocol_violation');
        assert.equal(failedEvent.data?.records_flushed, 0);
        assert.equal(failedEvent.data?.buffered_records_dropped, 0);
        assert.equal(failedEvent.data?.checkpoint_commit_status, 'not_committed');
        assert.equal(timeline.stderr, '');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('run timeline keeps pending-interaction protocol violations inspectable without fabricating blocked artifacts', async (t) => {
    const scenarios = [
      {
        name: 'RECORD while waiting for INTERACTION_RESPONSE',
        emitted: `process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'saved_tracks',
    record: {
      key: 'blocked_record',
      data: { id: 'blocked_record', name: 'Blocked Record' },
      emitted_at: '2026-04-18T00:00:00Z',
    },
  }) + '\\n');`,
        expectedMessage: 'Connector emitted RECORD while waiting for INTERACTION_RESPONSE',
      },
      {
        name: 'STATE while waiting for INTERACTION_RESPONSE',
        emitted: `process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'saved_tracks',
    value: { cursor: 'blocked_cursor' },
  }) + '\\n');`,
        expectedMessage: 'Connector emitted STATE while waiting for INTERACTION_RESPONSE',
      },
      {
        name: 'PROGRESS while waiting for INTERACTION_RESPONSE',
        emitted: `process.stdout.write(JSON.stringify({
    type: 'PROGRESS',
    stream: 'saved_tracks',
    message: 'blocked progress',
  }) + '\\n');`,
        expectedMessage: 'Connector emitted PROGRESS while waiting for INTERACTION_RESPONSE',
      },
      {
        name: 'SKIP_RESULT while waiting for INTERACTION_RESPONSE',
        emitted: `process.stdout.write(JSON.stringify({
    type: 'SKIP_RESULT',
    stream: 'saved_tracks',
    reason: 'rate_limited',
    message: 'blocked skip',
  }) + '\\n');`,
        expectedMessage: 'Connector emitted SKIP_RESULT while waiting for INTERACTION_RESPONSE',
      },
      {
        name: 'INTERACTION while waiting for INTERACTION_RESPONSE',
        emitted: `process.stdout.write(JSON.stringify({
    type: 'INTERACTION',
    request_id: 'cli_run_interaction_pending_second',
    stream: 'saved_tracks',
    kind: 'credentials',
    message: 'second interaction should fail',
    schema: { type: 'object', properties: { token: { type: 'string' } } },
    timeout_seconds: 300,
  }) + '\\n');`,
        expectedMessage: 'Connector emitted INTERACTION while waiting for INTERACTION_RESPONSE',
      },
      {
        name: 'DONE while waiting for INTERACTION_RESPONSE',
        emitted: `process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 0,
  }) + '\\n');`,
        expectedMessage: 'Connector emitted DONE while waiting for INTERACTION_RESPONSE',
      },
      {
        name: 'invalid JSONL while waiting for INTERACTION_RESPONSE',
        emitted: `process.stdout.write('{this-is-not-json}\\n');`,
        expectedMessage: /Connector emitted invalid JSONL while waiting for INTERACTION_RESPONSE:/,
      },
    ];

    for (const scenario of scenarios) {
      await t.test(scenario.name, async () => {
        await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
          const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
          const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-run-pending-interaction-'));
          const connectorPath = join(tmpDir, 'connector.mjs');
          writeFileSync(connectorPath, `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'INTERACTION',
    request_id: 'cli_run_interaction_pending',
    stream: 'saved_tracks',
    kind: 'credentials',
    message: 'Need a platform token',
    schema: {
      type: 'object',
      properties: {
        token: { type: 'string', format: 'password' },
      },
      required: ['token'],
    },
    timeout_seconds: 300,
  }) + '\\n');
  ${scenario.emitted}
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
                onInteraction: async () => new Promise(() => {}),
              }),
              (err) => {
                rejected = err;
                assert.equal(err.failure_reason, 'connector_protocol_violation');
                if (scenario.expectedMessage instanceof RegExp) {
                  assert.match(err.message, scenario.expectedMessage);
                } else {
                  assert.equal(err.message, scenario.expectedMessage);
                }
                assert.ok(err.run_id, `${scenario.name} should expose run_id`);
                return true;
              },
            );

            const timeline = await runCli(
              ['run', 'timeline', rejected.run_id, '--as-url', asUrl, '--format', 'json'],
            );

            assert.equal(timeline.json.object, 'run_timeline');
            assert.equal(timeline.json.run_id, rejected.run_id);

            const interactionRequiredEvents = (timeline.json.data || []).filter((event) => event.event_type === 'run.interaction_required');
            assert.equal(interactionRequiredEvents.length, 1, 'pending-interaction violations should preserve the first interaction request only');
            assert.ok(!(timeline.json.data || []).some((event) => event.event_type === 'run.interaction_completed'));
            assert.ok(!(timeline.json.data || []).some((event) => event.event_type === 'run.progress_reported'));
            assert.ok(!(timeline.json.data || []).some((event) => event.event_type === 'run.stream_skipped'));
            assert.ok(!(timeline.json.data || []).some((event) => event.event_type === 'run.state_staged'));
            assert.ok(!(timeline.json.data || []).some((event) => event.event_type === 'run.state_advanced'));
            assert.ok(!(timeline.json.data || []).some((event) => event.event_type === 'run.completed'));

            const failedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.failed');
            assert.ok(failedEvent, 'run timeline should include run.failed for pending-interaction protocol violations');
            assert.equal(failedEvent.data?.reason, 'connector_protocol_violation');
            assert.equal(failedEvent.data?.records_flushed, 0);
            assert.equal(failedEvent.data?.buffered_records_dropped, 0);
            assert.equal(failedEvent.data?.checkpoint_commit_status, 'not_committed');
            assert.equal(timeline.stderr, '');
          } finally {
            rmSync(tmpDir, { recursive: true, force: true });
          }
        });
      });
    }
  });

  await t.test('run timeline keeps failed checkpoint artifacts inspectable', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-run-failed-'));
      const connectorPath = join(tmpDir, 'connector.mjs');
      writeFileSync(connectorPath, `
        console.log(JSON.stringify({ type: 'RECORD', stream: 'top_artists', record: { key: 'cli_run_failed', data: { id: 'cli_run_failed', name: 'CLI Failed Artist' }, emitted_at: '2026-04-18T00:00:00Z' } }));
        console.log(JSON.stringify({ type: 'STATE', stream: 'top_artists', value: { cursor: 'cli_failed_cursor' } }));
        process.exit(1);
      `);

      const result = await runConnector({
        connectorPath,
        connectorId: spotifyManifest.connector_id,
        ownerToken,
        manifest: spotifyManifest,
        state: null,
        collectionMode: 'incremental',
        rsUrl,
      });

      assert.ok(result.run_id, 'failed run should expose run_id');

      const timeline = await runCli(
        ['run', 'timeline', result.run_id, '--as-url', asUrl, '--format', 'json'],
      );

      assert.equal(timeline.json.object, 'run_timeline');
      assert.equal(timeline.json.run_id, result.run_id);
      assert.ok(Array.isArray(timeline.json.data));

      const runStarted = (timeline.json.data || []).find((event) => event.event_type === 'run.started');
      assert.ok(runStarted, 'run timeline should include run.started for failed runs');
      assert.equal(runStarted.data?.collection_mode, 'incremental');

      const stagedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.state_staged');
      assert.ok(stagedEvent, 'run timeline should include run.state_staged for failed runs');

      const failedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'run timeline should include run.failed');
      assert.equal(failedEvent.data?.checkpoint_commit_status, 'not_committed');
      assert.equal(failedEvent.data?.state_streams_staged, 1);
      assert.equal(failedEvent.data?.state_streams_committed, 0);

      const completedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.completed');
      assert.equal(completedEvent, undefined, 'failed run timeline should not include run.completed');
      assert.equal(timeline.stderr, '');
    });
  });

  await t.test('run timeline keeps runtime authentication failures from ingest inspectable', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-run-authentication-error-'));
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
    key: 'cli_runtime_authentication_error',
    data: { id: 'cli_runtime_authentication_error', value: 'before auth failure' },
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
            return true;
          },
        );

        const timeline = await runCli(
          ['run', 'timeline', rejected.run_id, '--as-url', asUrl, '--format', 'json'],
        );

        const failedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.failed');
        assert.ok(failedEvent, 'run timeline should include run.failed for runtime authentication failures');
        assert.equal(failedEvent.data?.source?.binding_kind, 'connector');
        assert.equal(failedEvent.data?.source?.connector_id, spotifyManifest.connector_id);
        assert.equal(failedEvent.data?.reason, 'authentication_error');
        assert.equal(failedEvent.data?.records_emitted, 1);
        assert.equal(failedEvent.data?.records_flushed, 0);
        assert.equal(failedEvent.data?.buffered_records_dropped, 1);
        assert.equal(failedEvent.data?.checkpoint_commit_status, 'not_committed');
        assert.equal(timeline.stderr, '');
      } finally {
        await closeHttpServer(rsServer);
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('run timeline keeps runtime permission failures from state persistence inspectable', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-run-permission-error-'));
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
    key: 'cli_runtime_permission_error',
    data: { id: 'cli_runtime_permission_error', value: 'before permission failure' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'top_artists',
    cursor: { cursor: 'cli_runtime_permission_error_cursor' },
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

        if (req.method === 'PUT' && url.pathname === `/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}`) {
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
            return true;
          },
        );

        const timeline = await runCli(
          ['run', 'timeline', rejected.run_id, '--as-url', asUrl, '--format', 'json'],
        );

        const stagedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.state_staged');
        assert.ok(stagedEvent, 'run timeline should include run.state_staged before runtime permission failures');

        const advancedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.state_advanced');
        assert.equal(advancedEvent, undefined, 'runtime permission failures should not commit checkpoint state');

        const failedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.failed');
        assert.ok(failedEvent, 'run timeline should include run.failed for runtime permission failures');
        assert.equal(failedEvent.data?.source?.binding_kind, 'connector');
        assert.equal(failedEvent.data?.source?.connector_id, spotifyManifest.connector_id);
        assert.equal(failedEvent.data?.reason, 'permission_error');
        assert.equal(failedEvent.data?.records_emitted, 1);
        assert.equal(failedEvent.data?.records_flushed, 1);
        assert.equal(failedEvent.data?.buffered_records_dropped, 0);
        assert.equal(failedEvent.data?.checkpoint_commit_status, 'not_committed');
        assert.equal(failedEvent.data?.state_streams_staged, 1);
        assert.equal(failedEvent.data?.state_streams_committed, 0);
        assert.equal(timeline.stderr, '');
      } finally {
        await closeHttpServer(rsServer);
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('run timeline keeps deterministic runtime connector_invalid failures inspectable', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-run-connector-invalid-'));
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
    key: 'cli_runtime_connector_invalid',
    data: { id: 'cli_runtime_connector_invalid', value: 'before connector invalid' },
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
            return true;
          },
        );

        const timeline = await runCli(
          ['run', 'timeline', rejected.run_id, '--as-url', asUrl, '--format', 'json'],
        );

        const failedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.failed');
        assert.ok(failedEvent, 'run timeline should include run.failed for deterministic runtime connector_invalid failures');
        assert.equal(failedEvent.data?.source?.binding_kind, 'connector');
        assert.equal(failedEvent.data?.source?.connector_id, spotifyManifest.connector_id);
        assert.equal(failedEvent.data?.reason, 'connector_invalid');
        assert.equal(failedEvent.data?.records_emitted, 1);
        assert.equal(failedEvent.data?.records_flushed, 0);
        assert.equal(failedEvent.data?.buffered_records_dropped, 1);
        assert.equal(failedEvent.data?.checkpoint_commit_status, 'not_committed');
        assert.equal(timeline.stderr, '');
      } finally {
        await closeHttpServer(rsServer);
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('run timeline keeps retryable runtime rate_limit_error failures inspectable', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-run-rate-limit-error-'));
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
    key: 'cli_runtime_rate_limit_error',
    data: { id: 'cli_runtime_rate_limit_error', value: 'before rate limit' },
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
            return true;
          },
        );

        const timeline = await runCli(
          ['run', 'timeline', rejected.run_id, '--as-url', asUrl, '--format', 'json'],
        );

        const failedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.failed');
        assert.ok(failedEvent, 'run timeline should include run.failed for retryable runtime rate_limit_error failures');
        assert.equal(failedEvent.data?.source?.binding_kind, 'connector');
        assert.equal(failedEvent.data?.source?.connector_id, spotifyManifest.connector_id);
        assert.equal(failedEvent.data?.reason, 'rate_limit_error');
        assert.equal(failedEvent.data?.records_emitted, 1);
        assert.equal(failedEvent.data?.records_flushed, 0);
        assert.equal(failedEvent.data?.buffered_records_dropped, 1);
        assert.equal(failedEvent.data?.checkpoint_commit_status, 'not_committed');
        assert.equal(timeline.stderr, '');
      } finally {
        await closeHttpServer(rsServer);
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('run timeline keeps connector-declared terminal error details inspectable on failed runs', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-run-terminal-error-'));
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
    key: 'cli_terminal_error',
    data: { id: 'cli_terminal_error', value: 'before terminal failure' },
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

        const timeline = await runCli(
          ['run', 'timeline', result.run_id, '--as-url', asUrl, '--format', 'json'],
        );

        const failedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.failed');
        assert.ok(failedEvent, 'run timeline should include run.failed for connector-declared failures');
        assert.equal(failedEvent.data?.source?.binding_kind, 'connector');
        assert.equal(failedEvent.data?.source?.connector_id, spotifyManifest.connector_id);
        assert.equal(failedEvent.data?.reason, 'connector_reported_failed');
        assert.equal(failedEvent.data?.connector_error_message, 'Remote provider rate limit');
        assert.equal(failedEvent.data?.connector_error_retryable, true);
        assert.equal(failedEvent.data?.checkpoint_commit_status, 'not_committed');

        const completedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.completed');
        assert.equal(completedEvent, undefined, 'connector-declared failed runs should not include run.completed');
        assert.equal(timeline.stderr, '');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('run timeline keeps connector-declared terminal error details inspectable on cancelled runs', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-run-terminal-cancelled-'));
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
    key: 'cli_terminal_cancelled',
    data: { id: 'cli_terminal_cancelled', value: 'before terminal cancellation' },
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

        const timeline = await runCli(
          ['run', 'timeline', result.run_id, '--as-url', asUrl, '--format', 'json'],
        );

        const failedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.failed');
        assert.ok(failedEvent, 'run timeline should include run.failed for connector-declared cancellations');
        assert.equal(failedEvent.status, 'cancelled');
        assert.equal(failedEvent.data?.source?.binding_kind, 'connector');
        assert.equal(failedEvent.data?.source?.connector_id, spotifyManifest.connector_id);
        assert.equal(failedEvent.data?.reason, 'connector_reported_cancelled');
        assert.equal(failedEvent.data?.connector_error_message, 'User denied follow-up verification');
        assert.equal(failedEvent.data?.connector_error_retryable, false);
        assert.equal(failedEvent.data?.checkpoint_commit_status, 'not_committed');

        const completedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.completed');
        assert.equal(completedEvent, undefined, 'connector-declared cancelled runs should not include run.completed');
        assert.equal(timeline.stderr, '');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('run timeline keeps terminal counter mismatch protocol-violation details inspectable', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-run-terminal-counter-mismatch-'));
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
    key: 'cli_terminal_counter_mismatch',
    data: { id: 'cli_terminal_counter_mismatch', value: 'before mismatch' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'top_artists',
    cursor: { cursor: 'cli_terminal_counter_mismatch_cursor' },
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
            return true;
          },
        );

        const timeline = await runCli(
          ['run', 'timeline', rejected.run_id, '--as-url', asUrl, '--format', 'json'],
        );

        const stagedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.state_staged');
        assert.ok(stagedEvent, 'run timeline should include run.state_staged before terminal counter mismatch failure');

        const advancedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.state_advanced');
        assert.equal(advancedEvent, undefined, 'terminal counter mismatch should not commit checkpoint state');

        const failedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.failed');
        assert.ok(failedEvent, 'run timeline should include run.failed for terminal counter mismatch');
        assert.equal(failedEvent.data?.source?.binding_kind, 'connector');
        assert.equal(failedEvent.data?.source?.connector_id, spotifyManifest.connector_id);
        assert.equal(failedEvent.data?.reason, 'connector_protocol_violation');
        assert.equal(failedEvent.data?.records_emitted, 1);
        assert.equal(failedEvent.data?.reported_records_emitted, 2);
        assert.equal(failedEvent.data?.records_flushed, 1);
        assert.equal(failedEvent.data?.checkpoint_commit_status, 'not_committed');
        assert.equal(failedEvent.data?.state_streams_staged, 1);
        assert.equal(failedEvent.data?.state_streams_committed, 0);
        assert.equal(timeline.stderr, '');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('run timeline keeps invalid DONE status protocol violations inspectable', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-run-invalid-done-status-'));
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
    key: 'cli_invalid_done_status',
    data: { id: 'cli_invalid_done_status', value: 'before invalid done status' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'top_artists',
    cursor: { cursor: 'cli_invalid_done_status_cursor' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'mystery',
    records_emitted: 1,
  }) + '\\n');
  rl.close();
  process.exit(1);
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
            return true;
          },
        );

        const timeline = await runCli(
          ['run', 'timeline', rejected.run_id, '--as-url', asUrl, '--format', 'json'],
        );

        const stagedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.state_staged');
        assert.ok(stagedEvent, 'run timeline should include run.state_staged before invalid DONE.status failure');

        const advancedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.state_advanced');
        assert.equal(advancedEvent, undefined, 'invalid DONE.status should not commit checkpoint state');

        const completedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.completed');
        assert.equal(completedEvent, undefined, 'invalid DONE.status should not emit run.completed');

        const failedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.failed');
        assert.ok(failedEvent, 'run timeline should include run.failed for invalid DONE.status');
        assert.equal(failedEvent.data?.source?.binding_kind, 'connector');
        assert.equal(failedEvent.data?.source?.connector_id, spotifyManifest.connector_id);
        assert.equal(failedEvent.data?.reason, 'connector_protocol_violation');
        assert.equal(failedEvent.data?.records_emitted, 1);
        assert.equal(failedEvent.data?.records_flushed, 1);
        assert.equal(failedEvent.data?.buffered_records_dropped, 0);
        assert.equal(failedEvent.data?.state_streams_staged, 1);
        assert.equal(failedEvent.data?.state_streams_committed, 0);
        assert.equal(failedEvent.data?.checkpoint_commit_status, 'not_committed');
        assert.equal(timeline.stderr, '');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('run timeline keeps DONE and exit-code mismatch protocol violations inspectable', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      const scenarios = [
        {
          name: 'DONE(succeeded) exiting non-zero',
          tmpPrefix: 'pdpp-cli-run-done-succeeded-exit-mismatch-',
          recordKey: 'cli_done_succeeded_exit_mismatch',
          doneStatus: 'succeeded',
          recordsEmitted: 1,
          exitCode: 1,
          expectedExitCode: 1,
        },
        {
          name: 'DONE(failed) exiting zero',
          tmpPrefix: 'pdpp-cli-run-done-failed-exit-mismatch-',
          recordKey: 'cli_done_failed_exit_mismatch',
          doneStatus: 'failed',
          recordsEmitted: 1,
          exitCode: 0,
          expectedExitCode: 0,
        },
      ];

      for (const scenario of scenarios) {
        const tmpDir = mkdtempSync(join(tmpdir(), scenario.tmpPrefix));
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
    key: '${scenario.recordKey}',
    data: { id: '${scenario.recordKey}', value: 'before exit mismatch' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'top_artists',
    cursor: { cursor: '${scenario.recordKey}_cursor' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: '${scenario.doneStatus}',
    records_emitted: ${scenario.recordsEmitted},
  }) + '\\n');
  rl.close();
  process.exit(${scenario.exitCode});
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
              return true;
            },
          );

          const timeline = await runCli(
            ['run', 'timeline', rejected.run_id, '--as-url', asUrl, '--format', 'json'],
          );

          const stagedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.state_staged');
          assert.ok(stagedEvent, `run timeline should include run.state_staged for ${scenario.name}`);

          const advancedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.state_advanced');
          assert.equal(advancedEvent, undefined, `${scenario.name} should not commit checkpoint state`);

          const completedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.completed');
          assert.equal(completedEvent, undefined, `${scenario.name} should not emit run.completed`);

          const failedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.failed');
          assert.ok(failedEvent, `run timeline should include run.failed for ${scenario.name}`);
          assert.equal(failedEvent.data?.source?.binding_kind, 'connector');
          assert.equal(failedEvent.data?.source?.connector_id, spotifyManifest.connector_id);
          assert.equal(failedEvent.data?.reason, 'connector_protocol_violation');
          assert.equal(failedEvent.data?.exit_code, scenario.expectedExitCode);
          assert.equal(failedEvent.data?.records_flushed, 1);
          assert.equal(failedEvent.data?.buffered_records_dropped, 0);
          assert.equal(failedEvent.data?.state_streams_staged, 1);
          assert.equal(failedEvent.data?.state_streams_committed, 0);
          assert.equal(failedEvent.data?.checkpoint_commit_status, 'not_committed');
          assert.equal(timeline.stderr, '');
        } finally {
          rmSync(tmpDir, { recursive: true, force: true });
        }
      }
    });
  });

  await t.test('run timeline keeps contradictory success-terminal error violations inspectable without surfacing connector error details', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-run-done-succeeded-error-'));
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
    error: { message: 'should_not_be_allowed', retryable: true },
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
              collectionMode: 'full_refresh',
              rsUrl,
              onInteraction: async () => ({}),
            });
          },
          (err) => {
            rejected = err;
            assert.equal(err.failure_reason, 'connector_protocol_violation');
            return true;
          },
        );

        const timeline = await runCli(
          ['run', 'timeline', rejected.run_id, '--as-url', asUrl, '--format', 'json'],
        );

        const completedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.completed');
        assert.equal(completedEvent, undefined, 'contradictory success-terminal errors should not emit run.completed');

        const failedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.failed');
        assert.ok(failedEvent, 'run timeline should include run.failed for contradictory success-terminal errors');
        assert.equal(failedEvent.data?.source?.binding_kind, 'connector');
        assert.equal(failedEvent.data?.source?.connector_id, spotifyManifest.connector_id);
        assert.equal(failedEvent.data?.reason, 'connector_protocol_violation');
        assert.equal(failedEvent.data?.checkpoint_commit_status, 'not_committed');
        assert.ok(!('connector_error_message' in failedEvent.data), 'protocol-violation timeline should not surface contradictory DONE.error details');
        assert.ok(!('connector_error_retryable' in failedEvent.data), 'protocol-violation timeline should not surface contradictory DONE.error details');
        assert.equal(timeline.stderr, '');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('run timeline keeps post-DONE protocol violations inspectable without completed artifacts', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-run-post-done-violation-'));
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
    key: 'cli_post_done_violation_before',
    data: { id: 'cli_post_done_violation_before', value: 'before_done' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'top_artists',
    cursor: { cursor: 'cli_post_done_violation_cursor' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 1,
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'top_artists',
    key: 'cli_post_done_violation_after',
    data: { id: 'cli_post_done_violation_after', value: 'after_done' },
    emitted_at: new Date().toISOString(),
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
            return true;
          },
        );

        const timeline = await runCli(
          ['run', 'timeline', rejected.run_id, '--as-url', asUrl, '--format', 'json'],
        );

        const stagedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.state_staged');
        assert.ok(stagedEvent, 'run timeline should include run.state_staged before post-DONE protocol failure');

        const advancedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.state_advanced');
        assert.equal(advancedEvent, undefined, 'post-DONE protocol violation should not commit checkpoint state');

        const completedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.completed');
        assert.equal(completedEvent, undefined, 'post-DONE protocol violation should not leave a completed artifact');

        const failedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.failed');
        assert.ok(failedEvent, 'run timeline should include run.failed for post-DONE protocol violations');
        assert.equal(failedEvent.data?.source?.binding_kind, 'connector');
        assert.equal(failedEvent.data?.source?.connector_id, spotifyManifest.connector_id);
        assert.equal(failedEvent.data?.reason, 'connector_protocol_violation');
        assert.equal(failedEvent.data?.records_flushed, 1);
        assert.equal(failedEvent.data?.buffered_records_dropped, 0);
        assert.equal(failedEvent.data?.state_streams_staged, 1);
        assert.equal(failedEvent.data?.state_streams_committed, 0);
        assert.equal(failedEvent.data?.checkpoint_commit_status, 'not_committed');
        assert.equal(timeline.stderr, '');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  await t.test('run timeline keeps partial checkpoint commit artifacts inspectable', async () => {
    const manifest = {
      connector_id: 'https://registry.pdpp.org/connectors/cli-run-partial-checkpoint-test',
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
    const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-cli-run-partial-checkpoint-'));
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

    const server = await startServer({
    quiet: true,
      asPort: 0,
      rsPort: 0,
      dbPath: ':memory:',
      dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    });
    const asUrl = `http://localhost:${server.asPort}`;
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

      const registerResp = await fetchJson(`${asUrl}/connectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(manifest),
      });
      assert.equal(registerResp.status, 201);

      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
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
          assert.equal(err.checkpoint_summary.state_streams_staged, 2);
          assert.equal(err.checkpoint_summary.state_streams_committed, 1);
          return true;
        },
      );

      assert.deepEqual(committedState, [{ items: { cursor: 'items_cursor_partial_commit' } }]);
      assert.ok(rejected?.run_id, 'partial checkpoint failure should expose run_id');

      const timeline = await runCli(
        ['run', 'timeline', rejected.run_id, '--as-url', asUrl, '--format', 'json'],
      );

      assert.equal(timeline.json.object, 'run_timeline');
      assert.equal(timeline.json.run_id, rejected.run_id);

      const advancedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.state_advanced');
      assert.ok(advancedEvent, 'run timeline should include run.state_advanced for the committed stream');
      assert.equal(advancedEvent.stream_id, 'items');
      assert.equal(advancedEvent.data?.state_streams_committed, 1);

      const commitFailedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.state_commit_failed');
      assert.ok(commitFailedEvent, 'run timeline should include run.state_commit_failed');
      assert.equal(commitFailedEvent.stream_id, 'other_items');
      assert.deepEqual(commitFailedEvent.data?.cursor, { cursor: 'other_items_cursor_partial_commit' });
      assert.equal(commitFailedEvent.data?.state_streams_staged, 2);
      assert.equal(commitFailedEvent.data?.state_streams_committed, 1);
      assert.match(commitFailedEvent.data?.error_message || '', /State persistence failed for other_items: 500/);

      const failedEvent = (timeline.json.data || []).find((event) => event.event_type === 'run.failed');
      assert.ok(failedEvent, 'run timeline should include run.failed for partial checkpoint failures');
      assert.equal(failedEvent.data?.reason, 'runtime_error');
      assert.equal(failedEvent.data?.checkpoint_commit_status, 'partially_committed');
      assert.equal(failedEvent.data?.state_streams_staged, 2);
      assert.equal(failedEvent.data?.state_streams_committed, 1);
      assert.equal(timeline.stderr, '');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      await closeHttpServer(rsServer);
      await closeServer(server);
    }
  });

  await t.test('trace show returns the enclosing trace for an issued grant', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);
      const approved = await approveGrant(asUrl, 'cli_owner', {
        client_id: 'concert_recommendation_app',
        connector_id: spotifyManifest.connector_id,
        client_display: { name: 'Concert Recommendation App' },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Recommend concerts based on listening history',
        access_mode: 'single_use',
        streams: [{ name: 'top_artists', view: 'basic' }],
      });

      const timeline = await runCli(
        ['grant', 'timeline', approved.grant.grant_id, '--rs-url', rsUrl, '--format', 'json'],
      );
      const traceId = timeline.json.trace_id;
      assert.ok(traceId);

      const result = await runCli(
        ['trace', 'show', traceId, '--rs-url', rsUrl, '--format', 'json'],
      );

      assert.equal(result.json.object, 'trace');
      assert.equal(result.json.trace_id, traceId);
      assert.ok(Array.isArray(result.json.data));
      assert.ok(result.json.data.some((event) => event.event_type === 'grant.issued'));
      assert.ok(result.json.data.some((event) => event.event_type === 'token.issued'));
      assert.equal(result.stderr, '');
    });
  });

  await t.test('trace show keeps owner mutation artifacts inspectable', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');

      const ingestResp = await fetch(`${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          'Content-Type': 'application/x-ndjson',
        },
        body: [
          JSON.stringify({
            key: 'cli_trace_owner_mutation',
            data: { id: 'cli_trace_owner_mutation', name: 'CLI Trace Artist' },
            emitted_at: '2026-04-18T00:00:00Z',
          }),
          '{"bad":',
        ].join('\n'),
      });
      assert.equal(ingestResp.status, 200);
      const ingestTraceId = ingestResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(ingestTraceId?.startsWith('trc_mut_'));

      const ingestTrace = await runCli(
        ['trace', 'show', ingestTraceId, '--as-url', asUrl, '--format', 'json'],
      );
      const ingestRequested = (ingestTrace.json.data || []).find((event) => event.event_type === 'mutation.requested');
      assert.ok(ingestRequested, 'trace show should include mutation.requested for owner ingest');
      assert.equal(ingestRequested.data?.operation, 'ingest_records');
      assert.equal(ingestRequested.data?.source?.binding_kind, 'connector');
      assert.equal(ingestRequested.data?.source?.connector_id, spotifyManifest.connector_id);

      const ingestCompleted = (ingestTrace.json.data || []).find((event) => event.event_type === 'mutation.completed');
      assert.ok(ingestCompleted, 'trace show should include mutation.completed for owner ingest');
      assert.equal(ingestCompleted.data?.records_accepted, 1);
      assert.equal(ingestCompleted.data?.records_rejected, 1);

      const rejectedDeleteResp = await fetch(
        `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent('missing_spotify_connector')}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${ownerToken}` },
        },
      );
      assert.equal(rejectedDeleteResp.status, 404);
      const rejectedDeleteTraceId = rejectedDeleteResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(rejectedDeleteTraceId?.startsWith('trc_mut_'));

      const rejectedDeleteTrace = await runCli(
        ['trace', 'show', rejectedDeleteTraceId, '--as-url', asUrl, '--format', 'json'],
      );
      const rejectedDelete = (rejectedDeleteTrace.json.data || []).find((event) => event.event_type === 'mutation.rejected');
      assert.ok(rejectedDelete, 'trace show should include mutation.rejected for owner delete failures');
      assert.equal(rejectedDelete.data?.operation, 'delete_stream_records');
      assert.equal(rejectedDelete.data?.error?.code, 'not_found');
      assert.match(rejectedDelete.data?.error?.message || '', /Unknown connector: missing_spotify_connector/);
    });
  });

  await t.test('trace show keeps malformed polyfill owner mutation artifacts inspectable', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      getDb().prepare(`
        UPDATE connectors
        SET manifest = ?
        WHERE connector_id = ?
      `).run('{"connector_id":"https://registry.pdpp.org/connectors/spotify","streams":[{"name":"top_artists","primary_key":["missing_id"]}]}', spotifyManifest.connector_id);

      const rejectedResp = await fetch(
        `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${ownerToken}` },
        },
      );
      assert.equal(rejectedResp.status, 400);
      const rejectedBody = await rejectedResp.json();
      assert.equal(rejectedBody.error.code, 'connector_invalid');
      assert.match(
        rejectedBody.error.message,
        new RegExp(`Connector manifest for ${spotifyManifest.connector_id} is malformed or no longer valid`),
      );
      const requestId = rejectedResp.headers.get('Request-Id');
      const traceId = rejectedResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(requestId, 'malformed polyfill owner mutation should surface a request id');
      assert.ok(traceId, 'malformed polyfill owner mutation should surface a reference trace id');

      const trace = await runCli(
        ['trace', 'show', traceId, '--as-url', asUrl, '--format', 'json'],
      );

      const mutationRejected = (trace.json.data || []).find((event) =>
        event.event_type === 'mutation.rejected' && event.object_id === requestId
      );
      assert.ok(mutationRejected, 'trace show should include mutation.rejected for malformed polyfill owner mutations');
      assert.equal(mutationRejected.data?.operation, 'delete_stream_records');
      assert.equal(mutationRejected.data?.source?.binding_kind, 'connector');
      assert.equal(mutationRejected.data?.source?.connector_id, spotifyManifest.connector_id);
      assert.equal(mutationRejected.data?.error?.code, 'connector_invalid');
      assert.match(
        mutationRejected.data?.error?.message || '',
        new RegExp(`Connector manifest for ${spotifyManifest.connector_id} is malformed or no longer valid`),
      );
    });
  });

  await t.test('trace show keeps owner state artifacts inspectable', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');

      const updateResp = await fetch(`${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ state: { top_artists: { cursor: 'cli_trace_state_cursor' } } }),
      });
      assert.equal(updateResp.status, 200);
      const updateTraceId = updateResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(updateTraceId?.startsWith('trc_state'));

      const updateTrace = await runCli(
        ['trace', 'show', updateTraceId, '--as-url', asUrl, '--format', 'json'],
      );
      const stateRequested = (updateTrace.json.data || []).find((event) => event.event_type === 'state.requested');
      assert.ok(stateRequested, 'trace show should include state.requested for owner state writes');
      assert.equal(stateRequested.data?.state_scope, 'owner');
      assert.equal(stateRequested.data?.operation, 'write');
      assert.deepEqual(stateRequested.data?.requested_streams, ['top_artists']);
      assert.equal(stateRequested.data?.source?.binding_kind, 'connector');
      assert.equal(stateRequested.data?.source?.connector_id, spotifyManifest.connector_id);

      const stateUpdated = (updateTrace.json.data || []).find((event) => event.event_type === 'state.updated');
      assert.ok(stateUpdated, 'trace show should include state.updated for owner state writes');
      assert.deepEqual(stateUpdated.data?.persisted_streams, ['top_artists']);

      const rejectedResp = await fetch(`${rsUrl}/v1/state/${encodeURIComponent('missing_spotify_connector')}`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(rejectedResp.status, 404);
      const rejectedTraceId = rejectedResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(rejectedTraceId?.startsWith('trc_state'));

      const rejectedTrace = await runCli(
        ['trace', 'show', rejectedTraceId, '--as-url', asUrl, '--format', 'json'],
      );
      const stateRejected = (rejectedTrace.json.data || []).find((event) => event.event_type === 'state.rejected');
      assert.ok(stateRejected, 'trace show should include state.rejected for owner state failures');
      assert.equal(stateRejected.data?.state_scope, 'owner');
      assert.equal(stateRejected.data?.operation, 'read');
      assert.equal(stateRejected.data?.error?.code, 'not_found');
      assert.match(stateRejected.data?.error?.message || '', /Unknown connector: missing_spotify_connector/);
    });
  });

  await t.test('trace show keeps malformed polyfill owner state artifacts inspectable', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');

      getDb().prepare(`
        UPDATE connectors
        SET manifest = ?
        WHERE connector_id = ?
      `).run('{"connector_id":"https://registry.pdpp.org/connectors/spotify","streams":[{"name":"top_artists","primary_key":["missing_id"]}]}', spotifyManifest.connector_id);

      const rejectedResp = await fetch(
        `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );

      assert.equal(rejectedResp.status, 400);
      const rejectedBody = await rejectedResp.json();
      assert.equal(rejectedBody.error.code, 'connector_invalid');
      assert.match(
        rejectedBody.error.message,
        new RegExp(`Connector manifest for ${spotifyManifest.connector_id} is malformed or no longer valid`),
      );
      const requestId = rejectedResp.headers.get('Request-Id');
      const traceId = rejectedResp.headers.get('PDPP-Reference-Trace-Id');
      assert.ok(requestId, 'malformed polyfill owner state read should surface a request id');
      assert.ok(traceId, 'malformed polyfill owner state read should surface a reference trace id');

      const trace = await runCli(
        ['trace', 'show', traceId, '--as-url', asUrl, '--format', 'json'],
      );

      const stateRejected = (trace.json.data || []).find((event) =>
        event.event_type === 'state.rejected' && event.object_id === requestId
      );
      assert.ok(stateRejected, 'trace show should include state.rejected for malformed polyfill owner state reads');
      assert.equal(stateRejected.data?.state_scope, 'owner');
      assert.equal(stateRejected.data?.operation, 'read');
      assert.equal(stateRejected.data?.source?.binding_kind, 'connector');
      assert.equal(stateRejected.data?.source?.connector_id, spotifyManifest.connector_id);
      assert.equal(stateRejected.data?.error?.code, 'connector_invalid');
      assert.match(
        stateRejected.data?.error?.message || '',
        new RegExp(`Connector manifest for ${spotifyManifest.connector_id} is malformed or no longer valid`),
      );
    });
  });

  await t.test('owner streams lists seeded streams through the RS', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const result = await runCli(
        ['owner', 'streams', '--connector-id', spotifyManifest.connector_id, '--rs-url', rsUrl, '--format', 'json'],
        { PDPP_OWNER_TOKEN: ownerToken },
      );

      assert.equal(result.json.object, 'list');
      assert.ok(Array.isArray(result.json.data));
      assert.ok(result.json.data.some((stream) => stream.name === 'top_artists'));
      assert.ok(result.json.data.some((stream) => stream.name === 'saved_tracks'));
      assert.ok(result.json.request_id?.startsWith('req_'));
      assert.ok(typeof result.json.reference_trace_id === 'string' && result.json.reference_trace_id.length > 0);
      assert.equal(result.stderr, '');
    });
  });

  await t.test('client query streams uses a granted client token against the RS', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const approved = await approveGrant(asUrl, 'cli_owner', {
        client_id: 'concert_recommendation_app',
        connector_id: spotifyManifest.connector_id,
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Maintain a concert-recommendation profile over time',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists', view: 'basic' }],
      });

      const result = await runCli(
        ['query', 'streams', '--rs-url', rsUrl, '--format', 'json'],
        { PDPP_CLIENT_TOKEN: approved.token },
      );

      assert.equal(result.json.object, 'list');
      assert.ok(Array.isArray(result.json.data));
      assert.deepEqual(result.json.data.map((stream) => stream.name), ['top_artists']);
      assert.ok(result.json.request_id?.startsWith('req_'));
      assert.ok(typeof result.json.reference_trace_id === 'string' && result.json.reference_trace_id.length > 0);
      assert.equal(result.stderr, '');
    });
  });

  await t.test('client query records surfaces request and reference trace ids from the RS', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const approved = await approveGrant(asUrl, 'cli_owner', {
        client_id: 'concert_recommendation_app',
        connector_id: spotifyManifest.connector_id,
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Maintain a concert-recommendation profile over time',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists', view: 'basic' }],
      });

      const result = await runCli(
        ['query', 'records', 'top_artists', '--rs-url', rsUrl, '--format', 'json'],
        { PDPP_CLIENT_TOKEN: approved.token },
      );

      assert.equal(result.json.object, 'list');
      assert.ok(Array.isArray(result.json.data));
      assert.ok(result.json.request_id?.startsWith('req_'));
      assert.ok(typeof result.json.reference_trace_id === 'string' && result.json.reference_trace_id.length > 0);
      assert.equal(result.stderr, '');
    });
  });

  await t.test('client query records and get preserve field-limited disclosure projections', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const approved = await approveGrant(asUrl, 'cli_owner', {
        client_id: 'concert_recommendation_app',
        connector_id: spotifyManifest.connector_id,
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Recommend concerts using the basic top-artist subset',
        access_mode: 'single_use',
        streams: [{
          name: 'top_artists',
          fields: ['id', 'name', 'genres'],
        }],
      });

      const listResult = await runCli(
        ['query', 'records', 'top_artists', '--rs-url', rsUrl, '--format', 'json', '--limit', '1'],
        { PDPP_CLIENT_TOKEN: approved.token },
      );

      assert.equal(listResult.json.object, 'list');
      const firstRecord = listResult.json.data?.[0];
      assert.ok(firstRecord, 'expected at least one granted record from CLI query records');
      assert.deepEqual(Object.keys(firstRecord.data || {}).sort(), ['genres', 'id', 'name']);
      assert.ok(!('popularity' in (firstRecord.data || {})));
      assert.ok(!('followers' in (firstRecord.data || {})));
      assert.ok(!('image_url' in (firstRecord.data || {})));
      assert.ok(!('source_updated_at' in (firstRecord.data || {})));
      assert.ok(listResult.json.request_id?.startsWith('req_'));
      assert.ok(typeof listResult.json.reference_trace_id === 'string' && listResult.json.reference_trace_id.length > 0);
      assert.equal(listResult.stderr, '');

      const detailResult = await runCli(
        ['query', 'get', 'top_artists', firstRecord.id, '--rs-url', rsUrl, '--format', 'json'],
        { PDPP_CLIENT_TOKEN: approved.token },
      );

      assert.equal(detailResult.json.object, 'record');
      assert.deepEqual(Object.keys(detailResult.json.data || {}).sort(), ['genres', 'id', 'name']);
      assert.ok(!('popularity' in (detailResult.json.data || {})));
      assert.ok(!('followers' in (detailResult.json.data || {})));
      assert.ok(!('image_url' in (detailResult.json.data || {})));
      assert.ok(!('source_updated_at' in (detailResult.json.data || {})));
      assert.ok(detailResult.json.request_id?.startsWith('req_'));
      assert.ok(typeof detailResult.json.reference_trace_id === 'string' && detailResult.json.reference_trace_id.length > 0);
      assert.equal(detailResult.stderr, '');
    });
  });

  await t.test('client query records keeps resource-limited pagination honest', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const ownerRecordsResp = await fetch(
        `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}&limit=20`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      assert.equal(ownerRecordsResp.status, 200);
      const ownerRecordsBody = await ownerRecordsResp.json();
      const ownerRecords = ownerRecordsBody.data || [];
      const mostRecentVisible = ownerRecords[0];
      assert.ok(mostRecentVisible, 'expected at least one owner-visible record to scope the CLI resource-limited grant');

      const approved = await approveGrant(asUrl, 'cli_owner', {
        client_id: 'concert_recommendation_app',
        connector_id: spotifyManifest.connector_id,
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Recommend concerts using only the latest permitted artist',
        access_mode: 'single_use',
        streams: [{
          name: 'top_artists',
          resources: [mostRecentVisible.id],
        }],
      });

      const result = await runCli(
        ['query', 'records', 'top_artists', '--rs-url', rsUrl, '--format', 'json', '--limit', '1'],
        { PDPP_CLIENT_TOKEN: approved.token },
      );

      assert.equal(result.json.object, 'list');
      assert.equal(result.json.has_more, false, 'CLI query records should not claim more pages when only hidden records remain');
      assert.ok(!result.json.next_cursor, 'CLI query records should not expose next_cursor when no more visible records exist');
      assert.equal(result.json.data?.length, 1);
      assert.equal(result.json.data?.[0]?.id, mostRecentVisible.id);
      assert.ok(result.json.request_id?.startsWith('req_'));
      assert.ok(typeof result.json.reference_trace_id === 'string' && result.json.reference_trace_id.length > 0);
      assert.equal(result.stderr, '');
    });
  });

  await t.test('owner streams works without --connector-id against a native provider RS', async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      await seedNorthstar(nativeManifest);

      const result = await runCli(
        ['owner', 'streams', '--rs-url', rsUrl, '--format', 'json'],
        { PDPP_OWNER_TOKEN: ownerToken },
      );

      assert.equal(result.json.object, 'list');
      assert.ok(Array.isArray(result.json.data));
      assert.deepEqual(result.json.data.map((stream) => stream.name), ['benefits_enrollments', 'equity_grants', 'pay_statements']);
      assert.ok(result.json.request_id?.startsWith('req_'));
      assert.ok(result.json.reference_trace_id?.startsWith('trc_qry_'));
      assert.equal(result.stderr, '');
    });
  });

  await t.test('client query failures surface request and reference trace ids on stderr', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const approved = await approveGrant(asUrl, 'cli_owner', {
        client_id: 'concert_recommendation_app',
        connector_id: spotifyManifest.connector_id,
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Maintain a concert-recommendation profile over time',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists', view: 'basic' }],
      });

      const result = await runCliExpectFailure(
        ['query', 'records', 'top_artists', '--rs-url', rsUrl, '--view', 'basic', '--fields', 'id'],
        { PDPP_CLIENT_TOKEN: approved.token },
      );

      assert.equal(result.code, 1);
      assert.match(result.stderr, /view and fields are mutually exclusive/);
      assert.match(result.stderr, /Request ID: req_/);
      assert.match(result.stderr, /Reference trace ID: trc_/);
    });
  });

  await t.test('client auth-gate grant_invalid failures still surface request and reference trace ids on stderr', async () => {
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

      const approved = await approveGrant(asUrl, 'cli_owner', {
        client_id: 'longview',
        provider_id: nativeManifest.provider_id,
        purpose_code: 'https://pdpp.org/purpose/financial_planning',
        purpose_description: 'Support compensation planning and verification',
        access_mode: 'continuous',
        streams: [{ name: 'pay_statements' }],
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

      const result = await runCliExpectFailure(
        ['query', 'streams', '--rs-url', rsUrl],
        { PDPP_CLIENT_TOKEN: approved.token },
      );

      assert.equal(result.code, 4);
      assert.match(result.stderr, /Grant is malformed or no longer valid/);
      assert.match(result.stderr, /Request ID: req_/);
      assert.match(result.stderr, /Reference trace ID: trc_/);
    } finally {
      await closeServer(server);
      cleanup();
    }
  });

  await t.test('client auth-gate grant_revoked failures still surface request and reference trace ids on stderr', async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      await seedNorthstar(nativeManifest);

      const approved = await approveGrant(asUrl, 'cli_owner', {
        client_id: 'longview',
        provider_id: nativeManifest.provider_id,
        purpose_code: 'https://pdpp.org/purpose/financial_planning',
        purpose_description: 'Support compensation planning and verification',
        access_mode: 'continuous',
        streams: [{ name: 'pay_statements' }],
      });

      await fetchJson(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const result = await runCliExpectFailure(
        ['query', 'streams', '--rs-url', rsUrl],
        { PDPP_CLIENT_TOKEN: approved.token },
      );

      assert.equal(result.code, 4);
      assert.match(result.stderr, /Grant has been revoked/);
      assert.match(result.stderr, /Request ID: req_/);
      assert.match(result.stderr, /Reference trace ID: trc_/);
    });
  });

  await t.test('client auth-gate grant_expired failures still surface request and reference trace ids on stderr', async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      await seedNorthstar(nativeManifest);

      const approved = await approveGrant(asUrl, 'cli_owner', {
        client_id: 'longview',
        provider_id: nativeManifest.provider_id,
        purpose_code: 'https://pdpp.org/purpose/financial_planning',
        purpose_description: 'Support compensation planning and verification',
        access_mode: 'continuous',
        streams: [{ name: 'pay_statements' }],
      });

      getDb().prepare(`
        UPDATE tokens
        SET expires_at = ?
        WHERE token_id = ?
      `).run(new Date(Date.now() - 60_000).toISOString(), approved.token);

      const result = await runCliExpectFailure(
        ['query', 'streams', '--rs-url', rsUrl],
        { PDPP_CLIENT_TOKEN: approved.token },
      );

      assert.equal(result.code, 4);
      assert.match(result.stderr, /Grant has expired/);
      assert.match(result.stderr, /Request ID: req_/);
      assert.match(result.stderr, /Reference trace ID: trc_/);
    });
  });

  await t.test('auth-gate client failures stay inspectable through CLI grant timeline and trace readers', async () => {
    const scenarios = [
      {
        name: 'grant_invalid',
        expectedMessage: /Grant is malformed or no longer valid/,
        prepare: async ({ approved, server, dbPath, nativeManifest }) => {
          getDb().prepare(`
            UPDATE grants
            SET storage_binding_json = NULL
            WHERE grant_id = ?
          `).run(approved.grant.grant_id);

          await closeServer(server);
          return startServer({
    quiet: true,
            asPort: server.asPort,
            rsPort: server.rsPort,
            dbPath,
            nativeManifest,
          });
        },
      },
      {
        name: 'grant_revoked',
        expectedMessage: /Grant has been revoked/,
        prepare: async ({ asUrl, approved, server }) => {
          await fetchJson(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          });
          return server;
        },
      },
      {
        name: 'grant_expired',
        expectedMessage: /Grant has expired/,
        prepare: async ({ approved, server }) => {
          getDb().prepare(`
            UPDATE tokens
            SET expires_at = ?
            WHERE token_id = ?
          `).run(new Date(Date.now() - 60_000).toISOString(), approved.token);
          return server;
        },
      },
    ];

    for (const scenario of scenarios) {
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
        const approved = await issueNorthstarClientGrant(asUrl, nativeManifest);

        server = await scenario.prepare({ asUrl, approved, server, dbPath, nativeManifest });

        const queryFailure = await runCliExpectFailure(
          ['query', 'streams', '--rs-url', rsUrl],
          { PDPP_CLIENT_TOKEN: approved.token },
        );

        assert.equal(queryFailure.code, 4);
        assert.match(queryFailure.stderr, scenario.expectedMessage);

        const timeline = await runCli(
          ['grant', 'timeline', approved.grant.grant_id, '--as-url', asUrl, '--format', 'json'],
        );
        const rejectedFromGrantTimeline = timeline.json.data.find(
          (event) => event.event_type === 'query.rejected' && event.data?.auth_gate === true
        );

        assert.ok(rejectedFromGrantTimeline, `grant timeline should include auth-gate query.rejected for ${scenario.name}`);
        assert.equal(rejectedFromGrantTimeline.data.error.code, scenario.name);
        assert.equal(rejectedFromGrantTimeline.data.query_shape, 'stream_list');
        assert.ok(typeof timeline.json.trace_id === 'string' && timeline.json.trace_id.startsWith('trc_'));

        const trace = await runCli(
          ['trace', 'show', timeline.json.trace_id, '--as-url', asUrl, '--format', 'json'],
        );
        const rejectedFromTrace = trace.json.data.find(
          (event) => event.event_type === 'query.rejected' && event.data?.auth_gate === true
        );

        assert.ok(rejectedFromTrace, `trace show should include auth-gate query.rejected for ${scenario.name}`);
        assert.equal(rejectedFromTrace.data.error.code, scenario.name);
        assert.equal(rejectedFromTrace.data.query_shape, 'stream_list');
        assert.equal(trace.json.trace_id, timeline.json.trace_id);
      } finally {
        await closeServer(server);
        cleanup();
      }
    }
  });

  await t.test('auth-gate record-detail failures stay inspectable through CLI grant timeline and trace readers', async () => {
    const scenarios = [
      {
        name: 'grant_invalid',
        expectedMessage: /Grant is malformed or no longer valid/,
        prepare: async ({ approved, server, dbPath, nativeManifest }) => {
          getDb().prepare(`
            UPDATE grants
            SET storage_binding_json = NULL
            WHERE grant_id = ?
          `).run(approved.grant.grant_id);

          await closeServer(server);
          return startServer({
    quiet: true,
            asPort: server.asPort,
            rsPort: server.rsPort,
            dbPath,
            nativeManifest,
          });
        },
      },
      {
        name: 'grant_revoked',
        expectedMessage: /Grant has been revoked/,
        prepare: async ({ asUrl, approved, server }) => {
          await fetchJson(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          });
          return server;
        },
      },
      {
        name: 'grant_expired',
        expectedMessage: /Grant has expired/,
        prepare: async ({ approved, server }) => {
          getDb().prepare(`
            UPDATE tokens
            SET expires_at = ?
            WHERE token_id = ?
          `).run(new Date(Date.now() - 60_000).toISOString(), approved.token);
          return server;
        },
      },
    ];

    for (const scenario of scenarios) {
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
        const approved = await issueNorthstarClientGrant(asUrl, nativeManifest);

        server = await scenario.prepare({ asUrl, approved, server, dbPath, nativeManifest });

        const recordId = 'ps_2026_04_15';
        const queryFailure = await runCliExpectFailure(
          ['query', 'get', 'pay_statements', recordId, '--rs-url', rsUrl],
          { PDPP_CLIENT_TOKEN: approved.token },
        );

        assert.equal(queryFailure.code, 4);
        assert.match(queryFailure.stderr, scenario.expectedMessage);
        const requestId = queryFailure.stderr.match(/Request ID: (req_[A-Za-z0-9_]+)/)?.[1];
        const traceId = queryFailure.stderr.match(/Reference trace ID: (trc_[A-Za-z0-9_]+)/)?.[1];
        assert.ok(requestId, `record-detail auth-gate failure should surface a request id for ${scenario.name}`);
        assert.ok(traceId, `record-detail auth-gate failure should surface a trace id for ${scenario.name}`);

        const timeline = await runCli(
          ['grant', 'timeline', approved.grant.grant_id, '--as-url', asUrl, '--format', 'json'],
        );
        const receivedFromGrantTimeline = timeline.json.data.find(
          (event) =>
            event.event_type === 'query.received' &&
            event.object_id === requestId &&
            event.data?.auth_gate === true
        );
        const rejectedFromGrantTimeline = timeline.json.data.find(
          (event) =>
            event.event_type === 'query.rejected' &&
            event.object_id === requestId &&
            event.data?.auth_gate === true
        );

        assert.ok(receivedFromGrantTimeline, `grant timeline should include auth-gate record-detail receipt for ${scenario.name}`);
        assert.equal(receivedFromGrantTimeline.trace_id, traceId);
        assert.equal(receivedFromGrantTimeline.stream_id, 'pay_statements');
        assert.equal(receivedFromGrantTimeline.data?.query_shape, 'record_detail');
        assert.equal(receivedFromGrantTimeline.data?.requested_record_id, recordId);
        assert.ok(rejectedFromGrantTimeline, `grant timeline should include auth-gate record-detail rejection for ${scenario.name}`);
        assert.equal(rejectedFromGrantTimeline.trace_id, traceId);
        assert.equal(rejectedFromGrantTimeline.stream_id, 'pay_statements');
        assert.equal(rejectedFromGrantTimeline.data?.error?.code, scenario.name);
        assert.equal(rejectedFromGrantTimeline.data?.query_shape, 'record_detail');
        assert.equal(rejectedFromGrantTimeline.data?.requested_record_id, recordId);
        assert.ok(typeof timeline.json.trace_id === 'string' && timeline.json.trace_id.startsWith('trc_'));

        const trace = await runCli(
          ['trace', 'show', traceId, '--as-url', asUrl, '--format', 'json'],
        );
        const receivedFromTrace = trace.json.data.find(
          (event) =>
            event.event_type === 'query.received' &&
            event.object_id === requestId &&
            event.data?.auth_gate === true
        );
        const rejectedFromTrace = trace.json.data.find(
          (event) =>
            event.event_type === 'query.rejected' &&
            event.object_id === requestId &&
            event.data?.auth_gate === true
        );

        assert.ok(receivedFromTrace, `trace show should include auth-gate record-detail receipt for ${scenario.name}`);
        assert.equal(receivedFromTrace.data?.query_shape, 'record_detail');
        assert.equal(receivedFromTrace.data?.requested_record_id, recordId);
        assert.ok(rejectedFromTrace, `trace show should include auth-gate record-detail rejection for ${scenario.name}`);
        assert.equal(rejectedFromTrace.data?.error?.code, scenario.name);
        assert.equal(rejectedFromTrace.data?.query_shape, 'record_detail');
        assert.equal(rejectedFromTrace.data?.requested_record_id, recordId);
        assert.equal(trace.json.trace_id, traceId);
      } finally {
        await closeServer(server);
        cleanup();
      }
    }
  });

  await t.test('auth-gate record-list failures preserve limit and changes_since through CLI grant timeline and trace readers', async () => {
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
      const approved = await issueNorthstarClientGrant(asUrl, nativeManifest);

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

      const changesSince = Buffer.from(JSON.stringify({ kind: 'changes_since', version: 0 })).toString('base64');
      const queryFailure = await runCliExpectFailure(
        ['query', 'records', 'pay_statements', '--rs-url', rsUrl, '--limit', '1', '--changes-since', changesSince],
        { PDPP_CLIENT_TOKEN: approved.token },
      );

      assert.equal(queryFailure.code, 4);
      assert.match(queryFailure.stderr, /Grant is malformed or no longer valid/);
      const requestId = queryFailure.stderr.match(/Request ID: (req_[A-Za-z0-9_]+)/)?.[1];
      const traceId = queryFailure.stderr.match(/Reference trace ID: (trc_[A-Za-z0-9_]+)/)?.[1];
      assert.ok(requestId, 'record-list auth-gate failure should surface a request id');
      assert.ok(traceId, 'record-list auth-gate failure should surface a trace id');

      const timeline = await runCli(
        ['grant', 'timeline', approved.grant.grant_id, '--as-url', asUrl, '--format', 'json'],
      );
      const receivedFromGrantTimeline = timeline.json.data.find(
        (event) =>
          event.event_type === 'query.received' &&
          event.object_id === requestId &&
          event.data?.auth_gate === true
      );
      const rejectedFromGrantTimeline = timeline.json.data.find(
        (event) =>
          event.event_type === 'query.rejected' &&
          event.object_id === requestId &&
          event.data?.auth_gate === true
      );

      assert.ok(receivedFromGrantTimeline, 'grant timeline should include auth-gate record-list receipt');
      assert.equal(receivedFromGrantTimeline.trace_id, traceId);
      assert.equal(receivedFromGrantTimeline.stream_id, 'pay_statements');
      assert.equal(receivedFromGrantTimeline.data?.query_shape, 'record_list');
      assert.equal(receivedFromGrantTimeline.data?.has_changes_since, true);
      assert.equal(receivedFromGrantTimeline.data?.limit, 1);
      assert.ok(rejectedFromGrantTimeline, 'grant timeline should include auth-gate record-list rejection');
      assert.equal(rejectedFromGrantTimeline.trace_id, traceId);
      assert.equal(rejectedFromGrantTimeline.stream_id, 'pay_statements');
      assert.equal(rejectedFromGrantTimeline.data?.error?.code, 'grant_invalid');
      assert.equal(rejectedFromGrantTimeline.data?.query_shape, 'record_list');
      assert.equal(rejectedFromGrantTimeline.data?.has_changes_since, true);
      assert.equal(rejectedFromGrantTimeline.data?.limit, 1);

      const trace = await runCli(
        ['trace', 'show', traceId, '--as-url', asUrl, '--format', 'json'],
      );
      const receivedFromTrace = trace.json.data.find(
        (event) =>
          event.event_type === 'query.received' &&
          event.object_id === requestId &&
          event.data?.auth_gate === true
      );
      const rejectedFromTrace = trace.json.data.find(
        (event) =>
          event.event_type === 'query.rejected' &&
          event.object_id === requestId &&
          event.data?.auth_gate === true
      );

      assert.ok(receivedFromTrace, 'trace show should include auth-gate record-list receipt');
      assert.equal(receivedFromTrace.data?.query_shape, 'record_list');
      assert.equal(receivedFromTrace.data?.has_changes_since, true);
      assert.equal(receivedFromTrace.data?.limit, 1);
      assert.ok(rejectedFromTrace, 'trace show should include auth-gate record-list rejection');
      assert.equal(rejectedFromTrace.data?.error?.code, 'grant_invalid');
      assert.equal(rejectedFromTrace.data?.query_shape, 'record_list');
      assert.equal(rejectedFromTrace.data?.has_changes_since, true);
      assert.equal(rejectedFromTrace.data?.limit, 1);
      assert.equal(trace.json.trace_id, traceId);
    } finally {
      await closeServer(server);
      cleanup();
    }
  });

  await t.test('trace show keeps rejected native client query artifacts inspectable without connector leakage', async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      await seedNorthstar(nativeManifest);
      const approved = await issueNorthstarClientGrant(asUrl, nativeManifest);

      const queryFailure = await runCliExpectFailure(
        ['query', 'records', 'pay_statements', '--rs-url', rsUrl, '--view', 'summary', '--fields', 'id'],
        { PDPP_CLIENT_TOKEN: approved.token },
      );

      assert.equal(queryFailure.code, 1);
      assert.match(queryFailure.stderr, /view and fields are mutually exclusive/);
      const requestId = queryFailure.stderr.match(/Request ID: (req_[A-Za-z0-9_]+)/)?.[1];
      const traceId = queryFailure.stderr.match(/Reference trace ID: (trc_[A-Za-z0-9_]+)/)?.[1];
      assert.ok(requestId, 'native client query failure should surface a request id on stderr');
      assert.ok(traceId, 'native client query failure should surface a reference trace id on stderr');

      const trace = await runCli(
        ['trace', 'show', traceId, '--as-url', asUrl, '--format', 'json'],
      );

      const queryReceived = (trace.json.data || []).find((event) =>
        event.event_type === 'query.received' && event.object_id === requestId
      );
      assert.ok(queryReceived, 'trace show should include query.received for rejected native client reads');
      assert.equal(queryReceived.data?.query_shape, 'record_list');
      assert.equal(queryReceived.stream_id, 'pay_statements');
      assert.equal(queryReceived.data?.source?.binding_kind, 'provider_native');
      assert.equal(queryReceived.data?.source?.provider_id, nativeManifest.provider_id);
      assert.ok(!('connector_id' in (queryReceived.data || {})));
      assert.ok(!('storage_connector_id' in (queryReceived.data || {})));

      const rejectedEvent = (trace.json.data || []).find((event) =>
        event.event_type === 'query.rejected' && event.object_id === requestId
      );
      assert.ok(rejectedEvent, 'trace show should include query.rejected for rejected native client reads');
      assert.equal(rejectedEvent.data?.query_shape, 'record_list');
      assert.equal(rejectedEvent.stream_id, 'pay_statements');
      assert.equal(rejectedEvent.data?.source?.binding_kind, 'provider_native');
      assert.equal(rejectedEvent.data?.source?.provider_id, nativeManifest.provider_id);
      assert.ok(!('connector_id' in (rejectedEvent.data || {})));
      assert.ok(!('storage_connector_id' in (rejectedEvent.data || {})));
      assert.equal(rejectedEvent.data?.error?.code, 'invalid_request');
      assert.match(rejectedEvent.data?.error?.message || '', /view and fields are mutually exclusive/);
      assert.equal(trace.stderr, '');
    });
  });


  await t.test('owner streams fails honestly without --connector-id against a polyfill RS', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const result = await runCliExpectFailure(
        ['owner', 'streams', '--rs-url', rsUrl, '--format', 'json'],
        { PDPP_OWNER_TOKEN: ownerToken },
      );

      assert.notEqual(result.exitCode, 0);
      assert.match(result.stderr, /connector_id must be a single non-empty string for polyfill owner access/);
    });
  });

  await t.test('polyfill owner read failures surface connector-first messages and correlation ids on stderr', async () => {
    await withHarness(async ({ asUrl, rsUrl }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');

      const result = await runCliExpectFailure(
        ['owner', 'streams', '--connector-id', 'missing_spotify_connector', '--rs-url', rsUrl, '--format', 'json'],
        { PDPP_OWNER_TOKEN: ownerToken },
      );

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /Unknown connector: missing_spotify_connector/);
      assert.match(result.stderr, /Request ID: req_/);
      assert.match(result.stderr, /Reference trace ID: trc_qry_/);
    });
  });

  await t.test('trace show keeps malformed polyfill owner read artifacts inspectable', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      getDb().prepare(`
        UPDATE connectors
        SET manifest = ?
        WHERE connector_id = ?
      `).run('{"connector_id":"https://registry.pdpp.org/connectors/spotify","streams":[{"name":"top_artists","primary_key":["missing_id"]}]}', spotifyManifest.connector_id);

      const result = await runCliExpectFailure(
        ['owner', 'streams', '--connector-id', spotifyManifest.connector_id, '--rs-url', rsUrl, '--format', 'json'],
        { PDPP_OWNER_TOKEN: ownerToken },
      );

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, new RegExp(`Connector manifest for ${spotifyManifest.connector_id} is malformed or no longer valid`));
      const requestId = result.stderr.match(/Request ID: (req_[A-Za-z0-9_]+)/)?.[1];
      const traceId = result.stderr.match(/Reference trace ID: (trc_[A-Za-z0-9_]+)/)?.[1];
      assert.ok(requestId, 'malformed polyfill owner read should surface a request id on stderr');
      assert.ok(traceId, 'malformed polyfill owner read should surface a reference trace id on stderr');

      const trace = await runCli(
        ['trace', 'show', traceId, '--as-url', asUrl, '--format', 'json'],
      );

      const queryReceived = (trace.json.data || []).find((event) =>
        event.event_type === 'query.received' && event.object_id === requestId
      );
      assert.ok(queryReceived, 'trace show should include query.received for malformed polyfill owner reads');
      assert.equal(queryReceived.data?.query_shape, 'stream_list');
      assert.equal(queryReceived.data?.source?.binding_kind, 'connector');
      assert.equal(queryReceived.data?.source?.connector_id, spotifyManifest.connector_id);

      const rejectedEvent = (trace.json.data || []).find((event) =>
        event.event_type === 'query.rejected' && event.object_id === requestId
      );
      assert.ok(rejectedEvent, 'trace show should include query.rejected for malformed polyfill owner reads');
      assert.equal(rejectedEvent.data?.query_shape, 'stream_list');
      assert.equal(rejectedEvent.data?.source?.binding_kind, 'connector');
      assert.equal(rejectedEvent.data?.source?.connector_id, spotifyManifest.connector_id);
      assert.equal(rejectedEvent.data?.error?.code, 'connector_invalid');
      assert.match(
        rejectedEvent.data?.error?.message || '',
        new RegExp(`Connector manifest for ${spotifyManifest.connector_id} is malformed or no longer valid`),
      );

      const servedEvent = (trace.json.data || []).find((event) =>
        event.event_type === 'disclosure.served' && event.object_id === requestId
      );
      assert.equal(servedEvent, undefined, 'malformed polyfill owner reads should not produce disclosure.served');
    });
  });

  await t.test('trace show keeps malformed polyfill owner record-detail artifacts inspectable', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const beforeResp = await fetchJson(
        `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}&limit=1`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      const protectedRecordId = beforeResp.body.data?.[0]?.id;
      assert.ok(protectedRecordId, 'expected a seeded record before corrupting the connector manifest');

      getDb().prepare(`
        UPDATE connectors
        SET manifest = ?
        WHERE connector_id = ?
      `).run('{"connector_id":"https://registry.pdpp.org/connectors/spotify","streams":[{"name":"top_artists","primary_key":["missing_id"]}]}', spotifyManifest.connector_id);

      const result = await runCliExpectFailure(
        ['owner', 'get', 'top_artists', protectedRecordId, '--connector-id', spotifyManifest.connector_id, '--rs-url', rsUrl],
        { PDPP_OWNER_TOKEN: ownerToken },
      );

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, new RegExp(`Connector manifest for ${spotifyManifest.connector_id} is malformed or no longer valid`));
      const requestId = result.stderr.match(/Request ID: (req_[A-Za-z0-9_]+)/)?.[1];
      const traceId = result.stderr.match(/Reference trace ID: (trc_[A-Za-z0-9_]+)/)?.[1];
      assert.ok(requestId, 'malformed polyfill owner record-detail read should surface a request id on stderr');
      assert.ok(traceId, 'malformed polyfill owner record-detail read should surface a reference trace id on stderr');

      const trace = await runCli(
        ['trace', 'show', traceId, '--as-url', asUrl, '--format', 'json'],
      );

      const queryReceived = (trace.json.data || []).find((event) =>
        event.event_type === 'query.received' && event.object_id === requestId
      );
      assert.ok(queryReceived, 'trace show should include query.received for malformed polyfill owner record-detail reads');
      assert.equal(queryReceived.data?.query_shape, 'record_detail');
      assert.equal(queryReceived.stream_id, 'top_artists');
      assert.equal(queryReceived.data?.source?.binding_kind, 'connector');
      assert.equal(queryReceived.data?.source?.connector_id, spotifyManifest.connector_id);

      const rejectedEvent = (trace.json.data || []).find((event) =>
        event.event_type === 'query.rejected' && event.object_id === requestId
      );
      assert.ok(rejectedEvent, 'trace show should include query.rejected for malformed polyfill owner record-detail reads');
      assert.equal(rejectedEvent.data?.query_shape, 'record_detail');
      assert.equal(rejectedEvent.stream_id, 'top_artists');
      assert.equal(rejectedEvent.data?.source?.binding_kind, 'connector');
      assert.equal(rejectedEvent.data?.source?.connector_id, spotifyManifest.connector_id);
      assert.equal(rejectedEvent.data?.error?.code, 'connector_invalid');
      assert.match(
        rejectedEvent.data?.error?.message || '',
        new RegExp(`Connector manifest for ${spotifyManifest.connector_id} is malformed or no longer valid`),
      );

      const servedEvent = (trace.json.data || []).find((event) =>
        event.event_type === 'disclosure.served' && event.object_id === requestId
      );
      assert.equal(servedEvent, undefined, 'malformed polyfill owner record-detail reads should not produce disclosure.served');
    });
  });

  await t.test('trace show keeps malformed polyfill owner record-list artifacts inspectable', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      getDb().prepare(`
        UPDATE connectors
        SET manifest = ?
        WHERE connector_id = ?
      `).run('{"connector_id":"https://registry.pdpp.org/connectors/spotify","streams":[{"name":"top_artists","primary_key":["missing_id"]}]}', spotifyManifest.connector_id);

      const result = await runCliExpectFailure(
        ['owner', 'export', 'top_artists', '--connector-id', spotifyManifest.connector_id, '--rs-url', rsUrl],
        { PDPP_OWNER_TOKEN: ownerToken },
      );

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, new RegExp(`Connector manifest for ${spotifyManifest.connector_id} is malformed or no longer valid`));
      const requestId = result.stderr.match(/Request ID: (req_[A-Za-z0-9_]+)/)?.[1];
      const traceId = result.stderr.match(/Reference trace ID: (trc_[A-Za-z0-9_]+)/)?.[1];
      assert.ok(requestId, 'malformed polyfill owner record-list read should surface a request id on stderr');
      assert.ok(traceId, 'malformed polyfill owner record-list read should surface a reference trace id on stderr');

      const trace = await runCli(
        ['trace', 'show', traceId, '--as-url', asUrl, '--format', 'json'],
      );

      const queryReceived = (trace.json.data || []).find((event) =>
        event.event_type === 'query.received' && event.object_id === requestId
      );
      assert.ok(queryReceived, 'trace show should include query.received for malformed polyfill owner record-list reads');
      assert.equal(queryReceived.data?.query_shape, 'record_list');
      assert.equal(queryReceived.stream_id, 'top_artists');
      assert.equal(queryReceived.data?.source?.binding_kind, 'connector');
      assert.equal(queryReceived.data?.source?.connector_id, spotifyManifest.connector_id);

      const rejectedEvent = (trace.json.data || []).find((event) =>
        event.event_type === 'query.rejected' && event.object_id === requestId
      );
      assert.ok(rejectedEvent, 'trace show should include query.rejected for malformed polyfill owner record-list reads');
      assert.equal(rejectedEvent.data?.query_shape, 'record_list');
      assert.equal(rejectedEvent.stream_id, 'top_artists');
      assert.equal(rejectedEvent.data?.source?.binding_kind, 'connector');
      assert.equal(rejectedEvent.data?.source?.connector_id, spotifyManifest.connector_id);
      assert.equal(rejectedEvent.data?.error?.code, 'connector_invalid');
      assert.match(
        rejectedEvent.data?.error?.message || '',
        new RegExp(`Connector manifest for ${spotifyManifest.connector_id} is malformed or no longer valid`),
      );

      const servedEvent = (trace.json.data || []).find((event) =>
        event.event_type === 'disclosure.served' && event.object_id === requestId
      );
      assert.equal(servedEvent, undefined, 'malformed polyfill owner record-list reads should not produce disclosure.served');
    });
  });

  await t.test('owner query works without --connector-id against a native provider RS', async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      await seedNorthstar(nativeManifest);

      const result = await runCli(
        ['owner', 'query', 'pay_statements', '--rs-url', rsUrl, '--format', 'json'],
        { PDPP_OWNER_TOKEN: ownerToken },
      );

      assert.equal(result.json.object, 'list');
      assert.equal(result.json.data.length, 1);
      assert.equal(result.json.data[0].id, 'ps_2026_04_15');
      assert.ok(result.json.request_id?.startsWith('req_'));
      assert.ok(result.json.reference_trace_id?.startsWith('trc_qry_'));
      assert.equal(result.stderr, '');
    });
  });

  await t.test('owner export works without --connector-id against a native provider RS', async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      await seedNorthstar(nativeManifest);

      const result = await runCli(
        ['owner', 'export', 'pay_statements', '--rs-url', rsUrl],
        { PDPP_OWNER_TOKEN: ownerToken },
      );

      const lines = result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      assert.equal(lines.length, 1);
      assert.equal(lines[0].id, 'ps_2026_04_15');
      assert.equal(lines[0].data.employer, 'Northstar HR');
      assert.equal(result.stderr, '');
    });
  });

  await t.test('native owner query failures surface request and reference trace ids on stderr', async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      await seedNorthstar(nativeManifest);

      const result = await runCliExpectFailure(
        ['owner', 'query', 'not_a_stream', '--rs-url', rsUrl, '--format', 'json'],
        { PDPP_OWNER_TOKEN: ownerToken },
      );

      assert.equal(result.code, 5);
      assert.match(result.stderr, /Stream 'not_a_stream' not found/);
      assert.match(result.stderr, /Request ID: req_/);
      assert.match(result.stderr, /Reference trace ID: trc_qry_/);
    });
  });

  await t.test('trace show keeps rejected native owner query artifacts inspectable', async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      await seedNorthstar(nativeManifest);

      const result = await runCliExpectFailure(
        ['owner', 'query', 'not_a_stream', '--rs-url', rsUrl, '--format', 'json'],
        { PDPP_OWNER_TOKEN: ownerToken },
      );

      assert.equal(result.code, 5);
      const requestId = result.stderr.match(/Request ID: (req_[A-Za-z0-9_]+)/)?.[1];
      const traceId = result.stderr.match(/Reference trace ID: (trc_[A-Za-z0-9_]+)/)?.[1];
      assert.ok(requestId, 'native owner query failure should surface a request id on stderr');
      assert.ok(traceId, 'native owner query failure should surface a reference trace id on stderr');

      const trace = await runCli(
        ['trace', 'show', traceId, '--as-url', asUrl, '--format', 'json'],
      );

      const queryReceived = (trace.json.data || []).find((event) =>
        event.event_type === 'query.received' && event.object_id === requestId
      );
      assert.ok(queryReceived, 'trace show should include query.received for rejected native owner reads');
      assert.equal(queryReceived.data?.query_shape, 'record_list');
      assert.equal(queryReceived.stream_id, 'not_a_stream');
      assert.equal(queryReceived.data?.source?.binding_kind, 'provider_native');
      assert.equal(queryReceived.data?.source?.provider_id, nativeManifest.provider_id);
      assert.ok(!('connector_id' in (queryReceived.data || {})));
      assert.ok(!('storage_connector_id' in (queryReceived.data || {})));

      const rejectedEvent = (trace.json.data || []).find((event) =>
        event.event_type === 'query.rejected' && event.object_id === requestId
      );
      assert.ok(rejectedEvent, 'trace show should include query.rejected for rejected native owner reads');
      assert.equal(rejectedEvent.data?.query_shape, 'record_list');
      assert.equal(rejectedEvent.stream_id, 'not_a_stream');
      assert.equal(rejectedEvent.data?.source?.binding_kind, 'provider_native');
      assert.equal(rejectedEvent.data?.source?.provider_id, nativeManifest.provider_id);
      assert.ok(!('connector_id' in (rejectedEvent.data || {})));
      assert.ok(!('storage_connector_id' in (rejectedEvent.data || {})));
      assert.equal(rejectedEvent.data?.error?.code, 'not_found');
      assert.match(rejectedEvent.data?.error?.message || '', /Stream 'not_a_stream' not found/);
      assert.equal(trace.stderr, '');
    });
  });

  await t.test('owner get works without --connector-id against a native provider RS', async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      await seedNorthstar(nativeManifest);

      const result = await runCli(
        ['owner', 'get', 'pay_statements', 'ps_2026_04_15', '--rs-url', rsUrl, '--format', 'json'],
        { PDPP_OWNER_TOKEN: ownerToken },
      );

      assert.equal(result.json.id, 'ps_2026_04_15');
      assert.equal(result.json.data.employer, 'Northstar HR');
      assert.ok(result.json.request_id?.startsWith('req_'));
      assert.ok(result.json.reference_trace_id?.startsWith('trc_qry_'));
      assert.equal(result.stderr, '');
    });
  });

  await t.test('owner export fails honestly without --connector-id against a polyfill RS', async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, 'cli_owner');
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const result = await runCliExpectFailure(
        ['owner', 'export', 'top_artists', '--rs-url', rsUrl],
        { PDPP_OWNER_TOKEN: ownerToken },
      );

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /connector_id must be a single non-empty string for polyfill owner access/);
    });
  });
});
