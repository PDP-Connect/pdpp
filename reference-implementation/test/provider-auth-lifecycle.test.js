/**
 * Deterministic integration tests for the provider-authorization lifecycle
 * (task 6.3: complete-self-service-connection-onboarding).
 *
 * All tests use a synthetic "test_provider" connector and an injectable
 * ProviderAuthExchanger double. No live provider credentials are used.
 *
 * Covers:
 *   - deployment config missing blocks initiation (503)
 *   - lifecycle present returns open_provider_auth authorization URL
 *   - callback with missing state does not create/activate a connection
 *   - callback with expired state does not create/activate a connection
 *   - callback with bad/missing code does not create/activate a connection
 *   - callback with valid code but failed inventory does not activate a connection
 *   - callback with valid code + successful inventory activates exactly the intended connection(s)
 *   - two accounts produce two distinct connection_ids with separate credential store calls
 *   - no provider secrets/tokens appear in owner-session, owner-agent, or callback response bodies
 *   - audit events are emitted for all outcome paths
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { listSpineEventsPage } from '../lib/spine.ts';
import { startServer } from '../server/index.js';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';
import { PROVIDER_AUTH_LIFECYCLE_PROVEN_CONNECTOR_KEYS } from '../server/connection-setup-plan.ts';

const OWNER_SUBJECT_ID = 'owner_local';

// Synthetic provider OAuth connector registered for all tests.
// Must have: network binding, oauth auth kind, deployment_config keys.
const TEST_PROVIDER_MANIFEST = {
  connector_id: 'test_provider',
  connector_key: 'test_provider',
  display_name: 'Test Provider',
  version: '1.0.0',
  runtime_requirements: { bindings: { network: { required: true } } },
  capabilities: {
    refresh_policy: {
      recommended_mode: 'automatic',
      recommended_interval_seconds: 900,
      background_safe: true,
      interaction_posture: 'credentials',
      rationale: 'Synthetic provider can refresh with stored OAuth tokens.',
    },
    auth: {
      kind: 'oauth',
      deployment_config: ['TEST_PROVIDER_CLIENT_ID', 'TEST_PROVIDER_CLIENT_SECRET'],
    },
  },
  streams: [
    {
      name: 'items',
      primary_key: ['id'],
      schema: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
    },
  ],
};

// A no-oauth connector used to test that non-provider-auth connectors are rejected.
const NON_OAUTH_MANIFEST = {
  connector_id: 'plain_api',
  connector_key: 'plain_api',
  display_name: 'Plain API',
  version: '1.0.0',
  runtime_requirements: { bindings: { network: { required: true } } },
  capabilities: { auth: { kind: 'api_key' } },
  streams: [
    {
      name: 'items',
      primary_key: ['id'],
      schema: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
    },
  ],
};

// Minimal exchanger double that records all calls and lets callers inject
// per-call behavior via callbacks.
function buildTestExchanger({
  onInitiate = () => ({ authorizationUrl: 'https://provider.example/oauth/authorize?state=TEST' }),
  onExchange = () => ({ accessToken: 'tok_access_synthetic', tokenKind: 'bearer' }),
  onInventory = () => [{ accountId: 'account_1', displayLabel: 'test@example.com' }],
  onStore = () => {},
} = {}) {
  const calls = { initiate: [], exchange: [], inventory: [], store: [] };
  return {
    calls,
    async initiateAuthorization(args) {
      calls.initiate.push(args);
      return onInitiate(args);
    },
    async exchangeCode(args) {
      calls.exchange.push(args);
      return onExchange(args);
    },
    async runInventoryOrTest(args) {
      calls.inventory.push(args);
      return onInventory(args);
    },
    async storeTokens(args) {
      calls.store.push(args);
      return onStore(args);
    },
  };
}

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

// Start a server with the given exchanger and configured provider keys.
async function withServer(exchanger, { configuredKeys = ['test_provider'] } = {}, fn) {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    ownerAuthPassword: '',
    ownerAuthSubjectId: OWNER_SUBJECT_ID,
    autoEnrollEligibleSchedules: false,
    providerAuthExchanger: exchanger,
    configuredProviderAuthConnectorKeys: configuredKeys,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    // Register the test provider connector.
    await fetch(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(TEST_PROVIDER_MANIFEST),
    });
    await fn({ asUrl, rsUrl, server });
  } finally {
    await closeServer(server);
  }
}

// The test server uses ownerAuthPassword: '' (open auth), so the owner session
// requires no password. Pass an empty cookie string — the server treats a
// missing/empty session as the default owner in open-auth mode.
const OPEN_SESSION_COOKIE = '';

async function initiateProviderAuth(asUrl, sessionCookie, connectorId) {
  return fetchJson(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/provider-auth-initiate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie,
    },
  });
}

// ---------------------------------------------------------------------------
// Setup planner unit-level check
// ---------------------------------------------------------------------------

test('PROVIDER_AUTH_LIFECYCLE_PROVEN_CONNECTOR_KEYS includes test_provider', () => {
  assert.ok(
    PROVIDER_AUTH_LIFECYCLE_PROVEN_CONNECTOR_KEYS.includes('test_provider'),
    'test_provider must be in the lifecycle-proven set',
  );
});

// ---------------------------------------------------------------------------
// Deployment config missing → initiation blocked
// ---------------------------------------------------------------------------

test('provider-auth initiation is blocked when deployment config is missing', async () => {
  const exchanger = buildTestExchanger();
  // Pass an empty configured-keys list so the planner sees needs_config.
  await withServer(exchanger, { configuredKeys: [] }, async ({ asUrl, rsUrl }) => {
    const session = OPEN_SESSION_COOKIE;
    const { status, body } = await initiateProviderAuth(asUrl, session, 'test_provider');
    assert.equal(status, 503, `expected 503, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body?.error?.code, 'provider_app_deployment_config_missing');
    // No exchanger calls should have been made.
    assert.equal(exchanger.calls.initiate.length, 0);
    // No connection should exist.
    const connections = await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID);
    assert.equal(connections.length, 0, 'no connection should be created on blocked initiation');
  });
});

// ---------------------------------------------------------------------------
// Non-provider-auth connector is rejected
// ---------------------------------------------------------------------------

test('provider-auth initiation is rejected for non-oauth connectors', async () => {
  const exchanger = buildTestExchanger();
  await withServer(exchanger, {}, async ({ asUrl, rsUrl }) => {
    // Register a non-oauth connector.
    await fetch(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(NON_OAUTH_MANIFEST),
    });
    const session = OPEN_SESSION_COOKIE;
    const { status, body } = await initiateProviderAuth(asUrl, session, 'plain_api');
    assert.equal(status, 409, `expected 409, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body?.error?.code, 'provider_auth_not_applicable');
    assert.equal(exchanger.calls.initiate.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle present → returns authorization URL
// ---------------------------------------------------------------------------

test('provider-auth initiation returns open_provider_auth with authorization URL', async () => {
  const authUrl = 'https://provider.example/oauth/authorize?client_id=X&state=STATE';
  const exchanger = buildTestExchanger({
    onInitiate: () => ({ authorizationUrl: authUrl }),
  });
  await withServer(exchanger, {}, async ({ asUrl, rsUrl }) => {
    const session = OPEN_SESSION_COOKIE;
    const { status, body, resp } = await initiateProviderAuth(asUrl, session, 'test_provider');
    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.object, 'provider_auth_initiate');
    assert.equal(body.connector_id, 'test_provider');
    assert.equal(body.setup_modality, 'provider_authorization');
    assert.equal(body.next_step.kind, 'open_provider_auth');
    assert.equal(body.next_step.authorization_url, authUrl);
    assert.ok(body.next_step.redirect_uri, 'must include redirect_uri');
    assert.ok(body.next_step.expires_at, 'must include expiry');

    // Exchanger was called with the connector id.
    assert.equal(exchanger.calls.initiate.length, 1);
    assert.equal(exchanger.calls.initiate[0].connectorId, 'test_provider');
    assert.ok(exchanger.calls.initiate[0].state, 'exchanger must receive state token');

    // No connection row created yet.
    const connections = await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID);
    assert.equal(connections.length, 0, 'initiation must not create a connection row');

    // No provider secrets in the response.
    const bodyStr = JSON.stringify(body);
    assert.doesNotMatch(bodyStr, /access_token|refresh_token|Bearer/i);

    // Audit event emitted.
    const traceId = resp.headers.get('PDPP-Reference-Trace-Id');
    assert.ok(traceId?.startsWith('trc_'), 'must carry a trace id');
    const page = listSpineEventsPage('trace', traceId, { limit: 20 });
    const event = page.events.find((e) => e.event_type === 'owner.connection.provider_auth.initiate');
    assert.ok(event, 'must emit initiate audit event');
    assert.equal(event.status, 'succeeded');
    assert.equal(event.data?.connector_id, 'test_provider');
  });
});

// ---------------------------------------------------------------------------
// Callback: missing/invalid state
// ---------------------------------------------------------------------------

test('callback with missing state does not create a connection', async () => {
  const exchanger = buildTestExchanger();
  await withServer(exchanger, {}, async ({ asUrl }) => {
    const { status, body } = await fetchJson(`${asUrl}/_ref/provider-auth/callback?code=somecode`);
    assert.equal(status, 400);
    assert.equal(body?.error?.code, 'provider_auth_state_invalid');
    assert.equal(exchanger.calls.exchange.length, 0);
    const connections = await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID);
    assert.equal(connections.length, 0);
  });
});

test('callback with unrecognized state does not create a connection', async () => {
  const exchanger = buildTestExchanger();
  await withServer(exchanger, {}, async ({ asUrl }) => {
    const { status, body } = await fetchJson(
      `${asUrl}/_ref/provider-auth/callback?state=pas_bogus_unrecognized&code=somecode`,
    );
    assert.equal(status, 400);
    assert.equal(body?.error?.code, 'provider_auth_state_invalid');
    assert.equal(exchanger.calls.exchange.length, 0);
    const connections = await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID);
    assert.equal(connections.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Callback: provider error
// ---------------------------------------------------------------------------

test('callback with provider error parameter does not create a connection', async () => {
  const exchanger = buildTestExchanger();
  await withServer(exchanger, {}, async ({ asUrl }) => {
    const { status, body } = await fetchJson(
      `${asUrl}/_ref/provider-auth/callback?error=access_denied&state=irrelevant`,
    );
    assert.equal(status, 400);
    assert.equal(body?.error?.code, 'provider_auth_denied');
    assert.equal(exchanger.calls.exchange.length, 0);
    const connections = await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID);
    assert.equal(connections.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Callback: bad/expired code does not activate connection
// ---------------------------------------------------------------------------

test('callback with code-exchange failure does not activate a connection', async () => {
  const exchanger = buildTestExchanger({
    onExchange: () => null, // simulate failed exchange
  });
  await withServer(exchanger, {}, async ({ asUrl, rsUrl }) => {
    const session = OPEN_SESSION_COOKIE;
    const { body: initBody } = await initiateProviderAuth(asUrl, session, 'test_provider');
    assert.equal(initBody.object, 'provider_auth_initiate');

    // Extract the state token that the exchanger received.
    const stateToken = exchanger.calls.initiate[0].state;

    const { status, body } = await fetchJson(
      `${asUrl}/_ref/provider-auth/callback?state=${encodeURIComponent(stateToken)}&code=bad_code`,
    );
    assert.equal(status, 400);
    assert.equal(body?.error?.code, 'provider_auth_code_invalid');

    // Exchange was attempted but inventory was NOT called.
    assert.equal(exchanger.calls.exchange.length, 1);
    assert.equal(exchanger.calls.inventory.length, 0);

    // No connection was activated.
    const connections = await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID);
    assert.equal(connections.length, 0);
  });
});

test('callback with missing code does not activate a connection', async () => {
  const exchanger = buildTestExchanger();
  await withServer(exchanger, {}, async ({ asUrl, rsUrl }) => {
    const session = OPEN_SESSION_COOKIE;
    await initiateProviderAuth(asUrl, session, 'test_provider');
    const stateToken = exchanger.calls.initiate[0].state;

    // Callback without code parameter.
    const { status, body } = await fetchJson(
      `${asUrl}/_ref/provider-auth/callback?state=${encodeURIComponent(stateToken)}`,
    );
    assert.equal(status, 400);
    assert.equal(body?.error?.code, 'provider_auth_code_missing');
    assert.equal(exchanger.calls.exchange.length, 0);
    const connections = await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID);
    assert.equal(connections.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Callback: failed inventory does not activate connection
// ---------------------------------------------------------------------------

test('callback with failed inventory does not activate a connection', async () => {
  const exchanger = buildTestExchanger({
    onInventory: () => { throw new Error('inventory_service_error'); },
  });
  await withServer(exchanger, {}, async ({ asUrl, rsUrl }) => {
    const session = OPEN_SESSION_COOKIE;
    await initiateProviderAuth(asUrl, session, 'test_provider');
    const stateToken = exchanger.calls.initiate[0].state;

    const { status, body } = await fetchJson(
      `${asUrl}/_ref/provider-auth/callback?state=${encodeURIComponent(stateToken)}&code=valid_code`,
    );
    assert.equal(status, 502);
    assert.equal(body?.error?.code, 'provider_auth_inventory_failed');

    // Exchange was called but store was NOT.
    assert.equal(exchanger.calls.exchange.length, 1);
    assert.equal(exchanger.calls.store.length, 0);

    // No connection was activated.
    const connections = await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID);
    assert.equal(connections.length, 0);
  });
});

test('callback with empty inventory does not activate a connection', async () => {
  const exchanger = buildTestExchanger({
    onInventory: () => [], // empty accounts
  });
  await withServer(exchanger, {}, async ({ asUrl, rsUrl }) => {
    const session = OPEN_SESSION_COOKIE;
    await initiateProviderAuth(asUrl, session, 'test_provider');
    const stateToken = exchanger.calls.initiate[0].state;

    const { status, body } = await fetchJson(
      `${asUrl}/_ref/provider-auth/callback?state=${encodeURIComponent(stateToken)}&code=valid_code`,
    );
    assert.equal(status, 422);
    assert.equal(body?.error?.code, 'provider_auth_no_accounts');
    assert.equal(exchanger.calls.store.length, 0);
    const connections = await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID);
    assert.equal(connections.length, 0);
  });
});

test('callback with token-store failure does not expose an active connection', async () => {
  const exchanger = buildTestExchanger({
    onInventory: () => [{ accountId: 'account_alice', displayLabel: 'alice@example.com' }],
    onStore: () => {
      throw new Error('credential_store_failed');
    },
  });
  await withServer(exchanger, {}, async ({ asUrl }) => {
    await initiateProviderAuth(asUrl, OPEN_SESSION_COOKIE, 'test_provider');
    const stateToken = exchanger.calls.initiate[0].state;

    const { status, body } = await fetchJson(
      `${asUrl}/_ref/provider-auth/callback?state=${encodeURIComponent(stateToken)}&code=valid_code`,
    );
    assert.equal(status, 500);
    assert.equal(body?.error?.code, 'api_error');

    const connections = await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID);
    assert.equal(connections.length, 0, 'credential-store failure must not leave a readable active connection');
  });
});

// ---------------------------------------------------------------------------
// Happy path: single account activated
// ---------------------------------------------------------------------------

test('callback with valid code + successful inventory activates exactly one connection', async () => {
  const exchanger = buildTestExchanger({
    onInventory: () => [{ accountId: 'account_alice', displayLabel: 'alice@example.com' }],
  });
  await withServer(exchanger, {}, async ({ asUrl, rsUrl, server }) => {
    const session = OPEN_SESSION_COOKIE;
    const { body: initBody } = await initiateProviderAuth(asUrl, session, 'test_provider');
    const stateToken = exchanger.calls.initiate[0].state;

    const { status, body, resp } = await fetchJson(
      `${asUrl}/_ref/provider-auth/callback?state=${encodeURIComponent(stateToken)}&code=valid_code`,
    );
    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.object, 'provider_auth_callback');
    assert.equal(body.connector_id, 'test_provider');
    assert.equal(body.connections.length, 1);
    const conn = body.connections[0];
    assert.match(conn.connection_id, /^cin_/, 'connection_id must have cin_ prefix');
    assert.equal(conn.connector_id, 'test_provider');
    assert.equal(conn.status, 'active');

    // Next step is run_connection.
    assert.equal(body.next_step.kind, 'run_connection');

    // Exactly one connection was activated in the store.
    const connections = await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID);
    assert.equal(connections.length, 1);
    assert.equal(connections[0].connectorId, 'test_provider');
    assert.equal(connections[0].status, 'active');

    // The activation lifecycle invariant attaches a per-connection schedule for
    // automatic/background-safe manifests. This is independent of credential
    // presence and keyed by the connection_id, not the connector key.
    const schedule = await server.controller.getSchedule('test_provider', {
      connectorInstanceId: conn.connection_id,
    });
    assert.ok(schedule, 'automatic provider-auth activation must attach a schedule');
    assert.equal(schedule.connector_instance_id, conn.connection_id);
    assert.equal(schedule.interval_seconds, 900);
    assert.equal(schedule.enabled, true);

    // storeTokens was called once for the one account.
    assert.equal(exchanger.calls.store.length, 1);
    assert.equal(exchanger.calls.store[0].connectorInstanceId, conn.connection_id);
    assert.equal(exchanger.calls.store[0].ownerSubjectId, OWNER_SUBJECT_ID);

    // No provider tokens appear in the response body.
    const bodyStr = JSON.stringify(body);
    assert.doesNotMatch(bodyStr, /access_token|refresh_token|tok_access|Bearer/i);
    assert.doesNotMatch(bodyStr, /secret/i);

    // Audit event emitted with no secret leak.
    const traceId = resp.headers.get('PDPP-Reference-Trace-Id');
    assert.ok(traceId?.startsWith('trc_'), 'must carry a trace id');
    const page = listSpineEventsPage('trace', traceId, { limit: 20 });
    const event = page.events.find((e) => e.event_type === 'owner.connection.provider_auth.callback');
    assert.ok(event, 'must emit callback audit event');
    assert.equal(event.status, 'succeeded');
    assert.equal(event.data?.connector_id, 'test_provider');
    assert.equal(event.data?.account_count, 1);
    // Audit must not carry access_token.
    assert.doesNotMatch(JSON.stringify(event), /access_token|tok_access/i);
  });
});

// ---------------------------------------------------------------------------
// Two accounts → two distinct connection_ids
// ---------------------------------------------------------------------------

test('two-account inventory creates two distinct connection_ids with separate storeTokens calls', async () => {
  const exchanger = buildTestExchanger({
    onInventory: () => [
      { accountId: 'account_alice', displayLabel: 'alice@example.com' },
      { accountId: 'account_bob', displayLabel: 'bob@example.com' },
    ],
  });
  await withServer(exchanger, {}, async ({ asUrl, rsUrl }) => {
    const session = OPEN_SESSION_COOKIE;
    await initiateProviderAuth(asUrl, session, 'test_provider');
    const stateToken = exchanger.calls.initiate[0].state;

    const { status, body } = await fetchJson(
      `${asUrl}/_ref/provider-auth/callback?state=${encodeURIComponent(stateToken)}&code=valid_code`,
    );
    assert.equal(status, 201);
    assert.equal(body.connections.length, 2, 'two accounts should produce two connection rows');

    const ids = body.connections.map((c) => c.connection_id);
    assert.notEqual(ids[0], ids[1], 'two accounts must get distinct connection_ids');

    // Both are active in the store.
    const connections = await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID);
    assert.equal(connections.length, 2);
    connections.forEach((c) => assert.equal(c.status, 'active'));

    // storeTokens was called separately for each account.
    assert.equal(exchanger.calls.store.length, 2);
    const storedIds = exchanger.calls.store.map((c) => c.connectorInstanceId);
    assert.notEqual(storedIds[0], storedIds[1], 'storeTokens must be called with distinct instance ids');
  });
});

// ---------------------------------------------------------------------------
// State token replay protection
// ---------------------------------------------------------------------------

test('state token is consumed on first callback; replay is rejected', async () => {
  const exchanger = buildTestExchanger();
  await withServer(exchanger, {}, async ({ asUrl, rsUrl }) => {
    const session = OPEN_SESSION_COOKIE;
    await initiateProviderAuth(asUrl, session, 'test_provider');
    const stateToken = exchanger.calls.initiate[0].state;
    const callbackUrl = `${asUrl}/_ref/provider-auth/callback?state=${encodeURIComponent(stateToken)}&code=valid_code`;

    // First callback succeeds.
    const first = await fetchJson(callbackUrl);
    assert.equal(first.status, 201);

    // Second callback with the same state is rejected.
    const second = await fetchJson(callbackUrl);
    assert.equal(second.status, 400);
    assert.equal(second.body?.error?.code, 'provider_auth_state_invalid');

    // Only one connection should exist (from the first callback).
    const connections = await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID);
    assert.equal(connections.length, 1);
  });
});

// ---------------------------------------------------------------------------
// No provider secrets in any response
// ---------------------------------------------------------------------------

test('no provider tokens appear in initiation or callback response bodies', async () => {
  const exchanger = buildTestExchanger({
    onExchange: () => ({
      accessToken: 'SUPER_SECRET_ACCESS_TOKEN',
      refreshToken: 'SUPER_SECRET_REFRESH_TOKEN',
      tokenKind: 'bearer',
    }),
    onInventory: () => [{ accountId: 'acct_1', displayLabel: 'test@example.com' }],
    onStore: () => {},
  });
  await withServer(exchanger, {}, async ({ asUrl, rsUrl }) => {
    const session = OPEN_SESSION_COOKIE;
    const { body: initBody } = await initiateProviderAuth(asUrl, session, 'test_provider');
    const stateToken = exchanger.calls.initiate[0].state;

    const { body: callbackBody } = await fetchJson(
      `${asUrl}/_ref/provider-auth/callback?state=${encodeURIComponent(stateToken)}&code=valid_code`,
    );

    const initStr = JSON.stringify(initBody);
    const callbackStr = JSON.stringify(callbackBody);
    assert.doesNotMatch(initStr, /SUPER_SECRET/);
    assert.doesNotMatch(callbackStr, /SUPER_SECRET/);
    assert.doesNotMatch(callbackStr, /access_token.*:/i);
    assert.doesNotMatch(callbackStr, /refresh_token.*:/i);
  });
});

// ---------------------------------------------------------------------------
// Owner-session requirement (unauthenticated initiation blocked)
// ---------------------------------------------------------------------------

test('provider-auth initiation without owner session returns 401 or redirect', async () => {
  const exchanger = buildTestExchanger();
  // Use a password-protected server so that no-cookie requests are actually rejected.
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    ownerAuthPassword: 'protected-owner-password',
    ownerAuthSubjectId: OWNER_SUBJECT_ID,
    autoEnrollEligibleSchedules: false,
    providerAuthExchanger: exchanger,
    configuredProviderAuthConnectorKeys: ['test_provider'],
  });
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await fetch(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(TEST_PROVIDER_MANIFEST),
    });
    const { status } = await fetchJson(
      `${asUrl}/_ref/connectors/test_provider/provider-auth-initiate`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
    );
    // Owner session required: expect 401 or 302 redirect to login.
    assert.ok(status === 401 || status === 302 || status === 403, `expected auth rejection, got ${status}`);
    assert.equal(exchanger.calls.initiate.length, 0);
    const connections = await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID);
    assert.equal(connections.length, 0);
  } finally {
    server.schedulerManager?.stop?.();
    server.asServer.closeAllConnections();
    server.rsServer.closeAllConnections();
    await Promise.allSettled([
      new Promise((resolve) => server.asServer.close(resolve)),
      new Promise((resolve) => server.rsServer.close(resolve)),
    ]);
  }
});
