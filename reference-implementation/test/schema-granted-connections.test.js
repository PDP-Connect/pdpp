/**
 * `/v1/schema` per-stream `granted_connections` regression suite.
 *
 * Closes the deferred `granted_connections` sub-item under section 4.1 of
 * `openspec/changes/canonicalize-public-read-contract/tasks.md`. With storage
 * fan-in landed, the runtime can now advertise the discoverable set of
 * connections per granted stream so grant-authorized clients (and the
 * hosted MCP gateway / dashboard) can scope subsequent reads via
 * `connection_id` without trial-and-error.
 *
 * Covers:
 *
 *   - multi-connection owner scope returns every active connection;
 *   - grant constrained to one `connection_id` returns only that connection;
 *   - grant without `connection_id` constraint preserves fan-in across
 *     active connections;
 *   - owner-renamed `display_name` propagates to the next schema response;
 *   - storage placeholder labels (`legacy`, `default_account`, connector_id
 *     defaults) are omitted from the wire (no leakage of non-granted /
 *     placeholder connections).
 *
 * Stays on the SQLite reference path; the helper delegates to
 * `connector-instance-store.listActiveByConnector`, which has Postgres
 * parity tested by the same fan-in helpers in `storage-fan-in-read-contract.test.js`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { closeDb, initDb } from '../server/db.js';
import { ingestRecord } from '../server/records.js';
import { registerConnector } from '../server/auth.js';
import { listGrantedConnectionsForStream } from '../server/connection-identity.js';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from '../server/owner-auth.ts';
import { startServer } from '../server/index.js';

const CONNECTOR_ID = 'schema-granted-connections';
const STREAM = 'messages';

const INSTANCE_A = 'cin_schema_account_a';
const INSTANCE_B = 'cin_schema_account_b';

const baseManifest = {
  protocol_version: '0.1.0',
  connector_id: CONNECTOR_ID,
  version: '1.0.0',
  display_name: 'Schema Granted Connections Test Connector',
  capabilities: { human_interaction: [] },
  streams: [
    {
      name: STREAM,
      primary_key: ['id'],
      cursor_field: 'received_at',
      consent_time_field: 'received_at',
      schema: {
        type: 'object',
        required: ['id', 'subject', 'received_at'],
        properties: {
          id: { type: 'string' },
          subject: { type: 'string' },
          received_at: { type: 'string', format: 'date-time' },
        },
      },
      query: {},
      selection: { fields: { mode: 'explicit' } },
    },
  ],
};

function target(instanceId) {
  return { connector_id: CONNECTOR_ID, connector_instance_id: instanceId };
}

function record(id, receivedAt) {
  return {
    stream: STREAM,
    key: id,
    data: { id, subject: `subj ${id}`, received_at: receivedAt },
    emitted_at: receivedAt,
  };
}

async function seedInstance(instanceId, displayName, sourceBindingKey) {
  const store = createSqliteConnectorInstanceStore();
  const now = new Date().toISOString();
  await store.upsert({
    connectorInstanceId: instanceId,
    ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    connectorId: CONNECTOR_ID,
    displayName,
    status: 'active',
    sourceKind: 'account',
    sourceBindingKey,
    sourceBinding: { account: sourceBindingKey },
    createdAt: now,
    updatedAt: now,
  });
}

async function withDualConnectionDb(fn) {
  initDb();
  try {
    await registerConnector(baseManifest);
    await seedInstance(INSTANCE_A, 'Account A', 'a@example.com');
    await seedInstance(INSTANCE_B, 'Account B', 'b@example.com');
    await ingestRecord(target(INSTANCE_A), record('a-1', '2026-05-25T12:00:00.000Z'));
    await ingestRecord(target(INSTANCE_B), record('b-1', '2026-05-25T12:01:00.000Z'));
    await fn();
  } finally {
    closeDb();
  }
}

async function withSingleConnectionDb(fn) {
  initDb();
  try {
    await registerConnector(baseManifest);
    await seedInstance(INSTANCE_A, 'Sole Account', 'a@example.com');
    await ingestRecord(target(INSTANCE_A), record('a-1', '2026-05-25T12:00:00.000Z'));
    await fn();
  } finally {
    closeDb();
  }
}

async function withPlaceholderConnectionDb(fn) {
  initDb();
  try {
    await registerConnector(baseManifest);
    // `default_account` is the legacy placeholder display_name the storage
    // layer assigns when no owner-meaningful label has been set. The wire
    // MUST omit `display_name` for this row rather than leak the placeholder.
    await seedInstance(INSTANCE_A, 'default_account', 'a@example.com');
    // A second connection whose label happens to equal the connector_id is
    // also a placeholder (the helper falls back to that string when no real
    // display_name exists). Verify it is omitted too.
    await seedInstance(INSTANCE_B, CONNECTOR_ID, 'b@example.com');
    await fn();
  } finally {
    closeDb();
  }
}

// ─── Owner / multi-connection scope ───────────────────────────────────────

test('owner scope enumerates every active connection with meaningful display_name', async () => {
  await withDualConnectionDb(async () => {
    const granted = await listGrantedConnectionsForStream({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
    });
    assert.equal(granted.length, 2);
    const ids = granted.map((g) => g.connection_id).sort();
    assert.deepEqual(ids, [INSTANCE_A, INSTANCE_B]);
    const labels = granted.map((g) => g.display_name).sort();
    assert.deepEqual(labels, ['Account A', 'Account B']);
    for (const entry of granted) {
      assert.equal(Object.keys(entry).sort().join(','), 'connection_id,display_name');
    }
  });
});

// ─── Grant constrained to one connection ──────────────────────────────────

test('grant constrained to one connection_id returns only that connection', async () => {
  await withDualConnectionDb(async () => {
    const granted = await listGrantedConnectionsForStream({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
      grantStreamConnectionId: INSTANCE_B,
    });
    assert.equal(granted.length, 1);
    assert.equal(granted[0].connection_id, INSTANCE_B);
    assert.equal(granted[0].display_name, 'Account B');
  });
});

// ─── Grant without connection_id constraint preserves fan-in ─────────────

test('grant without connection_id constraint returns every active connection', async () => {
  await withDualConnectionDb(async () => {
    const granted = await listGrantedConnectionsForStream({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
      grantStreamConnectionId: null,
    });
    const ids = granted.map((g) => g.connection_id).sort();
    assert.deepEqual(ids, [INSTANCE_A, INSTANCE_B]);
  });
});

// ─── display_name propagation after owner rename ──────────────────────────

test('owner-renamed display_name propagates to the next granted_connections list', async () => {
  await withDualConnectionDb(async () => {
    const store = createSqliteConnectorInstanceStore();
    await store.setDisplayName(INSTANCE_A, {
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      displayName: 'Personal Inbox',
    });
    const granted = await listGrantedConnectionsForStream({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
    });
    const a = granted.find((g) => g.connection_id === INSTANCE_A);
    assert.equal(a?.display_name, 'Personal Inbox');
  });
});

// ─── No leakage of storage placeholders ───────────────────────────────────

test('placeholder display_names are omitted from granted_connections', async () => {
  await withPlaceholderConnectionDb(async () => {
    const granted = await listGrantedConnectionsForStream({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
    });
    assert.equal(granted.length, 2);
    for (const entry of granted) {
      assert.equal(Object.hasOwn(entry, 'display_name'), false,
        `expected placeholder display_name to be omitted, got ${entry.display_name}`);
      assert.ok(['cin_schema_account_a', 'cin_schema_account_b'].includes(entry.connection_id));
    }
  });
});

// ─── No leakage of non-granted connections (different owners) ─────────────

test('non-granted connections under a different owner do not leak into granted_connections', async () => {
  initDb();
  try {
    await registerConnector(baseManifest);
    await seedInstance(INSTANCE_A, 'Account A', 'a@example.com');
    // Seed an instance under a different owner — must not appear in the
    // owner's granted_connections enumeration.
    const store = createSqliteConnectorInstanceStore();
    const now = new Date().toISOString();
    await store.upsert({
      connectorInstanceId: 'cin_other_owner',
      ownerSubjectId: 'other_owner_subject',
      connectorId: CONNECTOR_ID,
      displayName: 'Other Owner Account',
      status: 'active',
      sourceKind: 'account',
      sourceBindingKey: 'c@example.com',
      sourceBinding: { account: 'c@example.com' },
      createdAt: now,
      updatedAt: now,
    });

    const granted = await listGrantedConnectionsForStream({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
    });
    assert.equal(granted.length, 1);
    assert.equal(granted[0].connection_id, INSTANCE_A);
  } finally {
    closeDb();
  }
});

// ─── Revoked (non-active) connections do not appear ───────────────────────

test('revoked connections do not appear in granted_connections', async () => {
  initDb();
  try {
    await registerConnector(baseManifest);
    await seedInstance(INSTANCE_A, 'Account A', 'a@example.com');
    await seedInstance(INSTANCE_B, 'Account B', 'b@example.com');
    const store = createSqliteConnectorInstanceStore();
    await store.updateStatus(INSTANCE_B, {
      status: 'revoked',
      updatedAt: new Date().toISOString(),
      revokedAt: new Date().toISOString(),
    });
    const granted = await listGrantedConnectionsForStream({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
    });
    assert.equal(granted.length, 1);
    assert.equal(granted[0].connection_id, INSTANCE_A);
  } finally {
    closeDb();
  }
});

// ─── Single-connection deployment preserves canonical shape ──────────────

test('single-connection deployment returns one entry with display_name', async () => {
  await withSingleConnectionDb(async () => {
    const granted = await listGrantedConnectionsForStream({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
    });
    assert.equal(granted.length, 1);
    assert.equal(granted[0].connection_id, INSTANCE_A);
    assert.equal(granted[0].display_name, 'Sole Account');
  });
});

// ─── Empty inputs yield empty array (defensive, not a throw) ──────────────

test('missing connectorId or ownerSubjectId returns an empty list', async () => {
  const noConnector = await listGrantedConnectionsForStream({
    ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    connectorId: null,
  });
  assert.deepEqual(noConnector, []);
  const noOwner = await listGrantedConnectionsForStream({
    ownerSubjectId: null,
    connectorId: CONNECTOR_ID,
  });
  assert.deepEqual(noOwner, []);
});

// ─── End-to-end HTTP wire-shape on /v1/schema ──────────────────────────────

const TEST_DCR_INITIAL_ACCESS_TOKEN = 'pdpp-reference-test-initial-access-token';

async function fetchJson(url, opts = {}) {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: resp.status, body };
}

async function closeServer(server) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((r) => server.asServer.close(r)),
    new Promise((r) => server.rsServer.close(r)),
  ]);
}

async function issueOwnerToken(asUrl, subjectId = 'owner_local') {
  const clientId = 'cli_longview';
  const { body: device } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId }).toString(),
  });
  await fetch(`${asUrl}/device/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user_code: device.user_code, subject_id: subjectId }).toString(),
  });
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

async function approveGrant(asUrl, subjectId, params) {
  const { body: initiate } = await fetchJson(`${asUrl}/oauth/par`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: params.client_id,
      authorization_details: [
        {
          type: 'https://pdpp.org/data-access',
          source: params.source || { kind: 'connector', id: params.connector_id },
          purpose_code: params.purpose_code,
          purpose_description: params.purpose_description,
          access_mode: params.access_mode,
          streams: params.streams,
        },
      ],
    }),
  });
  if (!initiate?.request_uri) {
    throw new Error(`startGrantRequest returned no request_uri: ${JSON.stringify(initiate)}`);
  }
  const { body: approved } = await fetchJson(`${asUrl}/consent/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_uri: initiate.request_uri, subject_id: subjectId }),
  });
  return approved;
}

async function withHttpHarness(fn, { seed } = {}) {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(baseManifest),
    });
    assert.equal(registerResp.status, 201, 'register connector');
    if (seed) await seed();
    await fn({ asUrl, rsUrl });
  } finally {
    await closeServer(server);
  }
}

test('GET /v1/schema emits granted_connections for multi-connection owner scope', async () => {
  await withHttpHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/schema?connector_id=${encodeURIComponent(CONNECTOR_ID)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    assert.equal(status, 200);
    assert.equal(body.object, 'schema');
    const connector = body.connectors.find((c) => c.connector_id === CONNECTOR_ID);
    assert.ok(connector, 'connector item present');
    const stream = connector.streams.find((s) => s.name === STREAM);
    assert.ok(Array.isArray(stream.granted_connections), 'granted_connections is an array');
    assert.equal(stream.granted_connections.length, 2);
    const ids = stream.granted_connections.map((g) => g.connection_id).sort();
    assert.deepEqual(ids, [INSTANCE_A, INSTANCE_B]);
    const labels = stream.granted_connections.map((g) => g.display_name).sort();
    assert.deepEqual(labels, ['Account A', 'Account B']);
  }, {
    seed: async () => {
      await seedInstance(INSTANCE_A, 'Account A', 'a@example.com');
      await seedInstance(INSTANCE_B, 'Account B', 'b@example.com');
      await ingestRecord(target(INSTANCE_A), record('a-1', '2026-05-25T12:00:00.000Z'));
      await ingestRecord(target(INSTANCE_B), record('b-1', '2026-05-25T12:01:00.000Z'));
    },
  });
});

test('GET /v1/schema honors grant.streams[].connection_id constraint', async () => {
  await withHttpHarness(async ({ asUrl, rsUrl }) => {
    const approved = await approveGrant(asUrl, 'owner_local', {
      client_id: 'longview',
      source: { kind: 'connector', id: CONNECTOR_ID },
      purpose_code: 'https://pdpp.org/purpose/analytics',
      purpose_description: 'granted_connections scope test',
      access_mode: 'continuous',
      streams: [
        {
          name: STREAM,
          fields: ['id', 'subject', 'received_at'],
          connection_id: INSTANCE_B,
        },
      ],
    });
    assert.ok(approved.token, 'expected client token');
    const { status, body } = await fetchJson(`${rsUrl}/v1/schema`, {
      headers: { Authorization: `Bearer ${approved.token}` },
    });
    assert.equal(status, 200);
    const connector = body.connectors[0];
    const stream = connector.streams.find((s) => s.name === STREAM);
    assert.equal(stream.granted_connections.length, 1);
    assert.equal(stream.granted_connections[0].connection_id, INSTANCE_B);
    assert.equal(stream.granted_connections[0].display_name, 'Account B');
    // The non-granted connection MUST NOT appear anywhere in the body.
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes(INSTANCE_A), false,
      'non-granted connection_id leaked into client schema response');
  }, {
    seed: async () => {
      await seedInstance(INSTANCE_A, 'Account A', 'a@example.com');
      await seedInstance(INSTANCE_B, 'Account B', 'b@example.com');
      await ingestRecord(target(INSTANCE_A), record('a-1', '2026-05-25T12:00:00.000Z'));
      await ingestRecord(target(INSTANCE_B), record('b-1', '2026-05-25T12:01:00.000Z'));
    },
  });
});

test('GET /v1/schema returns every active connection when grant omits connection_id', async () => {
  await withHttpHarness(async ({ asUrl, rsUrl }) => {
    const approved = await approveGrant(asUrl, 'owner_local', {
      client_id: 'longview',
      source: { kind: 'connector', id: CONNECTOR_ID },
      purpose_code: 'https://pdpp.org/purpose/analytics',
      purpose_description: 'granted_connections fan-in test',
      access_mode: 'continuous',
      streams: [{ name: STREAM, fields: ['id', 'subject', 'received_at'] }],
    });
    assert.ok(approved.token, 'expected client token');
    const { status, body } = await fetchJson(`${rsUrl}/v1/schema`, {
      headers: { Authorization: `Bearer ${approved.token}` },
    });
    assert.equal(status, 200);
    const stream = body.connectors[0].streams.find((s) => s.name === STREAM);
    const ids = stream.granted_connections.map((g) => g.connection_id).sort();
    assert.deepEqual(ids, [INSTANCE_A, INSTANCE_B]);
  }, {
    seed: async () => {
      await seedInstance(INSTANCE_A, 'Account A', 'a@example.com');
      await seedInstance(INSTANCE_B, 'Account B', 'b@example.com');
      await ingestRecord(target(INSTANCE_A), record('a-1', '2026-05-25T12:00:00.000Z'));
      await ingestRecord(target(INSTANCE_B), record('b-1', '2026-05-25T12:01:00.000Z'));
    },
  });
});
