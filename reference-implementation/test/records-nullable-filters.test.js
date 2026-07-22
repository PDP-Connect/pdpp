// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for filter validation/coercion on nullable scalar
 * schemas (`["string","null"]`, `["integer","null"]`, `["number","null"]`,
 * `["boolean","null"]`).
 *
 * Context: after the cursor-field parity fix for nullable types, the same
 * bug still lived in filter validation — `isScalarFieldSchema`,
 * `isRangeQueryableSchema`, and `coerceComparableValue` all branched on
 * `fieldSchema.type` with bare-string equality, so exact and range filters
 * were rejected on any nullable scalar even when the underlying non-null
 * type was supported.
 *
 * These tests model real manifest shapes (see
 * `packages/polyfill-connectors/manifests/*.json`) and exercise:
 *   - exact filters on nullable string / integer / boolean fields
 *   - range filters on nullable date-time and nullable integer fields
 *   - continued rejection of plain nullable strings (no date format) for
 *     range filters
 *   - null record values never satisfy range comparisons
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../server/index.js';

const TEST_DCR_INITIAL_ACCESS_TOKEN = 'pdpp-reference-test-initial-access-token';

async function closeServer(server) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((r) => server.asServer.close(r)),
    new Promise((r) => server.rsServer.close(r)),
  ]);
}

async function fetchJson(url, opts = {}) {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: resp.status, body };
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

async function registerManifest(asUrl, manifest) {
  const resp = await fetch(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  assert.equal(resp.status, 201, `register ${manifest.connector_id}`);
}

async function seedStream(rsUrl, ownerToken, connectorId, stream, records, emittedAtKey) {
  const lines = records.map((record) => JSON.stringify({
    key: record.id,
    data: record,
    emitted_at: record[emittedAtKey] || record.emitted_at || new Date().toISOString(),
  })).join('\n');
  const resp = await fetch(
    `${rsUrl}/v1/ingest/${encodeURIComponent(stream)}?connector_id=${encodeURIComponent(connectorId)}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ownerToken}`,
        'Content-Type': 'application/x-ndjson',
      },
      body: lines,
    },
  );
  assert.equal(resp.status, 200, `ingest ${stream}`);
}

async function withHarness(fn) {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
  });
  try {
    await fn({
      server,
      asUrl: `http://localhost:${server.asPort}`,
      rsUrl: `http://localhost:${server.rsPort}`,
    });
  } finally {
    await closeServer(server);
  }
}

// One manifest covers every filter case — all scalar shapes + a non-null
// cursor field so pagination itself never blocks these filter tests.
function nullableFiltersManifest() {
  return {
    protocol_version: '0.1.0',
    connector_id: 'nullable-filters',
    version: '1.0.0',
    display_name: 'Nullable Filters',
    runtime_requirements: { bindings: { network: { required: true } } },
    streams: [
      {
        name: 'items',
        semantics: 'mutable_state',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            // Nullable string — used for exact filters.
            label: { type: ['string', 'null'] },
            // Nullable boolean — exact only.
            archived: { type: ['boolean', 'null'] },
            // Nullable integer — exact + range.
            score: { type: ['integer', 'null'] },
            // Nullable number — exact + range.
            rating: { type: ['number', 'null'] },
            // Nullable date-time — range.
            updated_at: { type: ['string', 'null'], format: 'date-time' },
            // Ordering basis — non-null so pagination parity is trivial.
            created_at: { type: 'string', format: 'date-time' },
          },
          required: ['id', 'created_at'],
        },
        primary_key: ['id'],
        cursor_field: 'created_at',
        selection: { fields: true, resources: true },
        query: {
          range_filters: {
            score: ['gte', 'gt', 'lte', 'lt'],
            rating: ['gte', 'lte'],
            updated_at: ['gte', 'lt'],
            // `label` deliberately NOT declared: confirms plain nullable
            // string range filters are rejected below.
          },
        },
      },
    ],
  };
}

async function seedItems(rsUrl, token, connectorId) {
  await seedStream(rsUrl, token, connectorId, 'items', [
    {
      id: 'i1', label: 'alpha', archived: false, score: 1, rating: 1.5,
      updated_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z',
    },
    {
      id: 'i2', label: 'beta', archived: true, score: 5, rating: 4.2,
      updated_at: '2026-02-01T00:00:00Z', created_at: '2026-02-01T00:00:00Z',
    },
    {
      id: 'i3', label: null, archived: null, score: null, rating: null,
      updated_at: null, created_at: '2026-03-01T00:00:00Z',
    },
  ], 'created_at');
}

test('exact filter works on nullable string field', async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const manifest = nullableFiltersManifest();
    await registerManifest(asUrl, manifest);
    const token = await issueOwnerToken(asUrl);
    await seedItems(rsUrl, token, manifest.connector_id);

    const { status, body } = await fetchJson(
      `${rsUrl}/v1/streams/items/records`
      + `?connector_id=${encodeURIComponent(manifest.connector_id)}`
      + '&filter[label]=beta',
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.map((r) => r.id), ['i2']);
  });
});

test('exact filter works on nullable integer and boolean fields', async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const manifest = nullableFiltersManifest();
    await registerManifest(asUrl, manifest);
    const token = await issueOwnerToken(asUrl);
    await seedItems(rsUrl, token, manifest.connector_id);

    const intResp = await fetchJson(
      `${rsUrl}/v1/streams/items/records`
      + `?connector_id=${encodeURIComponent(manifest.connector_id)}`
      + '&filter[score]=5',
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(intResp.status, 200);
    assert.deepEqual(intResp.body.data.map((r) => r.id), ['i2']);

    const boolResp = await fetchJson(
      `${rsUrl}/v1/streams/items/records`
      + `?connector_id=${encodeURIComponent(manifest.connector_id)}`
      + '&filter[archived]=true',
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(boolResp.status, 200);
    assert.deepEqual(boolResp.body.data.map((r) => r.id), ['i2']);
  });
});

test('range filter works on nullable date-time field', async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const manifest = nullableFiltersManifest();
    await registerManifest(asUrl, manifest);
    const token = await issueOwnerToken(asUrl);
    await seedItems(rsUrl, token, manifest.connector_id);

    const { status, body } = await fetchJson(
      `${rsUrl}/v1/streams/items/records`
      + `?connector_id=${encodeURIComponent(manifest.connector_id)}`
      + '&filter[updated_at][gte]=2026-02-01T00:00:00Z',
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(status, 200);
    // i2 matches; i1 is earlier; i3 has null updated_at and must not match.
    assert.deepEqual(body.data.map((r) => r.id).sort(), ['i2']);
  });
});

test('range filter works on nullable integer field', async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const manifest = nullableFiltersManifest();
    await registerManifest(asUrl, manifest);
    const token = await issueOwnerToken(asUrl);
    await seedItems(rsUrl, token, manifest.connector_id);

    const { status, body } = await fetchJson(
      `${rsUrl}/v1/streams/items/records`
      + `?connector_id=${encodeURIComponent(manifest.connector_id)}`
      + '&filter[score][gte]=2',
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(status, 200);
    // i2 (score=5) matches; i1 (score=1) excluded; i3 (null) excluded.
    assert.deepEqual(body.data.map((r) => r.id).sort(), ['i2']);
  });
});

test('range filter on plain nullable string (no date format) is rejected', async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const manifest = nullableFiltersManifest();
    await registerManifest(asUrl, manifest);
    const token = await issueOwnerToken(asUrl);
    await seedItems(rsUrl, token, manifest.connector_id);

    // `label` is `["string","null"]` with no format — range must be refused
    // even though the stream's other fields happily accept range filters.
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/streams/items/records`
      + `?connector_id=${encodeURIComponent(manifest.connector_id)}`
      + '&filter[label][gte]=alpha',
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid_request');
  });
});

test('null record values never satisfy range comparisons', async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const manifest = nullableFiltersManifest();
    await registerManifest(asUrl, manifest);
    const token = await issueOwnerToken(asUrl);
    await seedItems(rsUrl, token, manifest.connector_id);

    // Very wide range — would sweep everything if nulls were coerced to 0 or
    // to an empty string. i3 has null `score` and must still be excluded.
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/streams/items/records`
      + `?connector_id=${encodeURIComponent(manifest.connector_id)}`
      + '&filter[score][gte]=-1000000'
      + '&filter[score][lte]=1000000',
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.map((r) => r.id).sort(), ['i1', 'i2']);
  });
});
