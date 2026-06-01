/**
 * `GET /v1/schema?view=compact` token-efficiency + projection conformance.
 *
 * Owned by `openspec/changes/add-compact-rs-schema-view`. The REST follow-up to
 * the MCP `schema` compaction (`packages/mcp-server/test/schema-token-budget.test.js`):
 * an additive compact REST schema view for owner-agent REST clients.
 *
 * These tests register a deliberately large connector (many streams, many
 * fields, each field carrying a verbose per-field JSON Schema blob), then drive
 * the real `/v1/schema` route over HTTP and assert:
 *
 *   - the DEFAULT (`view` omitted) body stays full / current-compatible — no
 *     fields are dropped, the raw per-field JSON Schema survives;
 *   - `view=compact` stays under a documented byte budget and is dramatically
 *     smaller than the full body;
 *   - the compact body preserves stream identity, connection identity
 *     (`granted_connections[].{connection_id, display_name}`), field names,
 *     declared types, and terse capability flags;
 *   - the compact body drops the raw per-field/per-stream JSON Schema blobs;
 *   - `view=compact&stream=<name>` scopes the document to one stream and stays
 *     under a tight per-stream budget;
 *   - the compact per-field cost stays bounded as field count grows.
 *
 * No live external data is required: the body is produced by the reference
 * server from a registered manifest seeded with one connection.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ingestRecord } from '../server/records.js';
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from '../server/owner-auth.ts';
import { startServer } from '../server/index.js';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';

// Documented byte budgets for the compact REST schema view. These are the
// regression guards: if a future change re-introduces verbatim-by-default on
// the compact path or stops dropping the per-field JSON Schema blobs, these
// fail locally. Deliberately generous relative to the compact projection's real
// size so legitimate growth does not flap the test, while still being many
// times smaller than the full body for this fixture.
const COMPACT_SCHEMA_BYTE_BUDGET = 60_000; // full grant, all streams, compact view
const STREAM_COMPACT_SCHEMA_BYTE_BUDGET = 6_000; // one stream, compact view

// Size of the verbose per-field JSON Schema blob attached to every field — the
// dominant size driver the compact projection drops.
const FIELD_SCHEMA_BLOB_PADDING = 1_200;

const CONNECTOR_ID = 'compact-schema-fixture';
const TEST_DCR_INITIAL_ACCESS_TOKEN = 'pdpp-reference-test-initial-access-token';

function makeLargeManifest({ streamCount = 6, fieldsPerStream = 30 } = {}) {
  return {
    protocol_version: '0.1.0',
    connector_id: CONNECTOR_ID,
    version: '1.0.0',
    display_name: 'Compact Schema Fixture Connector',
    capabilities: { human_interaction: [] },
    streams: Array.from({ length: streamCount }, (_, s) => {
      const properties = {
        id: { type: 'string' },
        received_at: { type: 'string', format: 'date-time' },
      };
      const rangeFilters = { received_at: ['gte', 'lte'] };
      for (let f = 0; f < fieldsPerStream; f += 1) {
        // A verbose per-field JSON Schema: the size driver. A real RS attaches
        // the full declared JSON Schema (descriptions, enums, examples).
        properties[`field_${f}`] = {
          type: 'string',
          description: 'x'.repeat(FIELD_SCHEMA_BLOB_PADDING),
          examples: Array.from({ length: 4 }, (_, e) => `example-${f}-${e}`.repeat(8)),
        };
      }
      return {
        name: `stream_${s}`,
        primary_key: ['id'],
        cursor_field: 'received_at',
        consent_time_field: 'received_at',
        schema: { type: 'object', required: ['id', 'received_at'], properties },
        query: { range_filters: rangeFilters },
        selection: { fields: { mode: 'explicit' } },
      };
    }),
  };
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

async function withHttpHarness(fn, { manifest = makeLargeManifest() } = {}) {
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
      body: JSON.stringify(manifest),
    });
    assert.equal(registerResp.status, 201, 'register connector');
    const ownerToken = await issueOwnerToken(asUrl);
    await fn({ asUrl, rsUrl, ownerToken });
  } finally {
    await closeServer(server);
  }
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function schemaUrl(rsUrl, params = {}) {
  const search = new URLSearchParams({ connector_id: CONNECTOR_ID, ...params }).toString();
  return `${rsUrl}/v1/schema?${search}`;
}

function allStreams(body) {
  return (body.connectors || []).flatMap((connector) =>
    Array.isArray(connector.streams) ? connector.streams : [],
  );
}

test('the fixture is large enough to model the verbose-schema problem', async () => {
  await withHttpHarness(async ({ rsUrl, ownerToken }) => {
    const { status, body } = await fetchJson(schemaUrl(rsUrl), {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    const fullBytes = byteLength(body);
    assert.ok(
      fullBytes > 200_000,
      `full schema body should be large to model the problem (got ${fullBytes} bytes)`,
    );
  });
});

test('default (view omitted) /v1/schema stays full and current-compatible', async () => {
  await withHttpHarness(async ({ rsUrl, ownerToken }) => {
    const { status, body } = await fetchJson(schemaUrl(rsUrl), {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    assert.equal(body.object, 'schema');
    // No compact marker on the default path.
    assert.equal(body.detail, undefined, 'default body must not be marked compact');
    const stream = allStreams(body).find((s) => s.name === 'stream_0');
    assert.ok(stream, 'stream_0 present');
    // Full per-field JSON Schema survives on the default path.
    assert.ok(stream.field_capabilities, 'default body keeps field_capabilities');
    const field = stream.field_capabilities.field_0;
    assert.equal(typeof field, 'object', 'default field capability is the verbose object');
    assert.equal(
      field.schema.description.length,
      FIELD_SCHEMA_BLOB_PADDING,
      'default body keeps the full per-field JSON Schema blob',
    );
  });
});

test('view=compact stays under the documented package byte budget and is far smaller', async () => {
  await withHttpHarness(async ({ rsUrl, ownerToken }) => {
    const full = await fetchJson(schemaUrl(rsUrl), {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const compact = await fetchJson(schemaUrl(rsUrl, { view: 'compact' }), {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(compact.status, 200);
    assert.equal(compact.body.detail, 'compact', 'compact body carries the detail marker');

    const fullBytes = byteLength(full.body);
    const compactBytes = byteLength(compact.body);

    assert.ok(
      compactBytes < COMPACT_SCHEMA_BYTE_BUDGET,
      `compact schema must stay under ${COMPACT_SCHEMA_BYTE_BUDGET} bytes (got ${compactBytes}; full was ${fullBytes})`,
    );
    assert.ok(
      compactBytes < fullBytes / 5,
      `compact schema must be far smaller than full (got ${compactBytes} vs full ${fullBytes})`,
    );
  });
});

test('view=compact drops per-field JSON Schema but keeps flags + connection identity', async () => {
  await withHttpHarness(async ({ rsUrl, ownerToken }) => {
    const { body } = await fetchJson(schemaUrl(rsUrl, { view: 'compact' }), {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const stream = allStreams(body).find((s) => s.name === 'stream_0');
    const field = stream.field_capabilities.field_0;

    // Compact grade: each field is a terse flag string, not the verbose object.
    assert.equal(typeof field, 'string', 'compact field must be a terse flag string');
    assert.doesNotMatch(field, /description/, 'compact must drop per-field JSON Schema blob');
    assert.match(field, /type=string/, 'compact flag string must keep declared type');
    assert.match(field, /granted=true/, 'compact flag string must keep grant flag');
    assert.match(field, /(^|,)exact(,|$)/, 'compact flag string must keep usable capability flags');

    // received_at advertises a usable range filter (manifest range_filters).
    assert.match(
      stream.field_capabilities.received_at,
      /range=/,
      'compact flag string must keep usable range operators',
    );

    // The heavy per-stream JSON Schema blob is gone on the compact path.
    assert.equal(stream.schema, undefined, 'compact stream must drop the raw JSON Schema');
    // Stream identity survives.
    assert.equal(stream.name, 'stream_0');
    // Connection identity survives.
    assert.ok(Array.isArray(stream.granted_connections), 'compact keeps granted_connections');
    for (const entry of stream.granted_connections) {
      assert.equal(typeof entry.connection_id, 'string');
      assert.ok('display_name' in entry);
    }
  });
});

test('view=compact&stream=<name> scopes to one stream under a tight budget', async () => {
  await withHttpHarness(async ({ rsUrl, ownerToken }) => {
    const { status, body } = await fetchJson(
      schemaUrl(rsUrl, { view: 'compact', stream: 'stream_2' }),
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    assert.equal(status, 200);
    assert.equal(body.detail, 'compact');

    const streams = allStreams(body);
    assert.equal(streams.length, 1, 'per-stream scope keeps exactly one stream');
    assert.equal(streams[0].name, 'stream_2');
    // Each surviving connector reports the scoped stream_count.
    for (const connector of body.connectors) {
      assert.equal(connector.stream_count, connector.streams.length);
    }
    // Still usable: capability flags survive on the scoped stream.
    assert.match(streams[0].field_capabilities.field_0, /type=string/);

    const bytes = byteLength(body);
    assert.ok(
      bytes < STREAM_COMPACT_SCHEMA_BYTE_BUDGET,
      `per-stream compact schema must stay under ${STREAM_COMPACT_SCHEMA_BYTE_BUDGET} bytes (got ${bytes})`,
    );
  });
});

test('an unknown stream scope yields an empty connector set, not an error', async () => {
  await withHttpHarness(async ({ rsUrl, ownerToken }) => {
    const { status, body } = await fetchJson(
      schemaUrl(rsUrl, { view: 'compact', stream: 'does_not_exist' }),
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    assert.equal(status, 200);
    assert.equal(body.detail, 'compact');
    assert.deepEqual(body.connectors, [], 'no connector contributes the missing stream');
  });
});

async function seedConnection(instanceId, displayName, account) {
  const store = createSqliteConnectorInstanceStore();
  const now = new Date().toISOString();
  await store.upsert({
    connectorInstanceId: instanceId,
    ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    connectorId: CONNECTOR_ID,
    displayName,
    status: 'active',
    sourceKind: 'account',
    sourceBindingKey: account,
    sourceBinding: { account },
    createdAt: now,
    updatedAt: now,
  });
  await ingestRecord(
    { connector_id: CONNECTOR_ID, connector_instance_id: instanceId },
    {
      stream: 'stream_0',
      key: `${instanceId}-1`,
      data: { id: `${instanceId}-1`, received_at: '2026-05-25T12:00:00.000Z' },
      emitted_at: '2026-05-25T12:00:00.000Z',
    },
  );
}

test('view=compact preserves multi-connection identity on granted_connections', async () => {
  await withHttpHarness(
    async ({ rsUrl, ownerToken }) => {
      await seedConnection('cin_compact_a', 'Account A', 'a@example.com');
      await seedConnection('cin_compact_b', 'Account B', 'b@example.com');

      const { status, body } = await fetchJson(
        schemaUrl(rsUrl, { view: 'compact', stream: 'stream_0' }),
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      assert.equal(status, 200);
      assert.equal(body.detail, 'compact');

      const stream = allStreams(body).find((s) => s.name === 'stream_0');
      assert.ok(Array.isArray(stream.granted_connections), 'granted_connections survives compaction');
      assert.equal(stream.granted_connections.length, 2, 'both connections enumerated');
      const ids = stream.granted_connections.map((g) => g.connection_id).sort();
      assert.deepEqual(ids, ['cin_compact_a', 'cin_compact_b']);
      const labels = stream.granted_connections.map((g) => g.display_name).sort();
      assert.deepEqual(labels, ['Account A', 'Account B']);
      // Compaction still dropped the heavy per-field JSON Schema.
      assert.equal(typeof stream.field_capabilities.field_0, 'string');
    },
    { manifest: makeLargeManifest({ streamCount: 1, fieldsPerStream: 4 }) },
  );
});

test('compact projection scales: doubling field count does not blow the budget', async () => {
  let bytes15 = 0;
  let bytes30 = 0;
  await withHttpHarness(
    async ({ rsUrl, ownerToken }) => {
      const { body } = await fetchJson(schemaUrl(rsUrl, { view: 'compact' }), {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      bytes15 = byteLength(body);
    },
    { manifest: makeLargeManifest({ fieldsPerStream: 15 }) },
  );
  await withHttpHarness(
    async ({ rsUrl, ownerToken }) => {
      const { body } = await fetchJson(schemaUrl(rsUrl, { view: 'compact' }), {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      bytes30 = byteLength(body);
    },
    { manifest: makeLargeManifest({ fieldsPerStream: 30 }) },
  );

  assert.ok(
    bytes30 < COMPACT_SCHEMA_BYTE_BUDGET,
    `compact schema must stay under budget even at 30 fields/stream (got ${bytes30})`,
  );
  // 15 added fields across 6 streams. The compact per-field cost must stay
  // small (nowhere near the verbatim ~1.2 KB/field blob).
  const perFieldGrowth = (bytes30 - bytes15) / (15 * 6);
  assert.ok(
    perFieldGrowth < 200,
    `compact per-field cost must stay small (got ~${Math.round(perFieldGrowth)} bytes/field)`,
  );
});
