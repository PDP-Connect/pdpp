// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for records pagination with nullable cursor_field
 * schemas (e.g. `type: ["string", "null"]` with `format: date-time`, or
 * `type: ["integer", "null"]`).
 *
 * Context: the SQL-layer pagination rewrite (fix-rs-query-memory-pressure)
 * asserted exact parity against the JS comparator by rejecting any
 * cursor_field whose schema wasn't numeric or ISO date/date-time. That
 * rejected the nullable variants used across the polyfill-connectors corpus
 * (gmail threads, ynab budgets, slack channels, etc.), causing /records to
 * return 500s for those streams.
 *
 * These tests model the real manifest shapes and exercise:
 *   - nullable date/date-time cursors with all-present values
 *   - nullable date/date-time cursors with some null values (missing bucket)
 *   - nullable integer cursors
 *   - cursor round-trip across pages
 *   - continued rejection of plain string cursors with no date format
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

async function seedStream(rsUrl, ownerToken, connectorId, stream, records, cursorKey) {
  const lines = records.map((record) => JSON.stringify({
    key: record.id,
    data: record,
    emitted_at: record[cursorKey] || record.emitted_at || new Date().toISOString(),
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

// Modeled after packages/polyfill-connectors/manifests/ynab.json's `budgets`
// stream — `cursor_field` is a nullable date-time string.
function nullableDateTimeManifest() {
  return {
    protocol_version: '0.1.0',
    connector_id: 'nullable-datetime',
    version: '1.0.0',
    display_name: 'Nullable DateTime Cursor',
    runtime_requirements: { bindings: { network: { required: true } } },
    streams: [
      {
        name: 'budgets',
        description: 'Budgets, modeled after ynab.budgets',
        semantics: 'mutable_state',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            last_modified_on: {
              type: ['string', 'null'],
              format: 'date-time',
            },
          },
          required: ['id', 'name'],
        },
        primary_key: ['id'],
        cursor_field: 'last_modified_on',
        selection: { fields: true, resources: true },
      },
    ],
  };
}

// Modeled after packages/polyfill-connectors/manifests/slack.json's
// `channels` stream — `cursor_field` is a nullable integer epoch.
function nullableIntegerManifest() {
  return {
    protocol_version: '0.1.0',
    connector_id: 'nullable-integer',
    version: '1.0.0',
    display_name: 'Nullable Integer Cursor',
    runtime_requirements: { bindings: { network: { required: true } } },
    streams: [
      {
        name: 'channels',
        description: 'Channels, modeled after slack.channels',
        semantics: 'mutable_state',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            created: { type: ['integer', 'null'] },
          },
          required: ['id', 'name'],
        },
        primary_key: ['id'],
        cursor_field: 'created',
        selection: { fields: true, resources: true },
      },
    ],
  };
}

// A plain-string cursor with no date format — this must still be rejected,
// because SQLite's BINARY collation on TEXT does not match JS localeCompare.
function unsupportedPlainStringManifest() {
  return {
    protocol_version: '0.1.0',
    connector_id: 'plain-string-cursor',
    version: '1.0.0',
    display_name: 'Plain String Cursor',
    runtime_requirements: { bindings: { network: { required: true } } },
    streams: [
      {
        name: 'notes',
        description: 'Notes keyed by arbitrary string — not a date',
        semantics: 'mutable_state',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: ['string', 'null'] },
          },
          required: ['id'],
        },
        primary_key: ['id'],
        cursor_field: 'title',
        selection: { fields: true, resources: true },
      },
    ],
  };
}

test('records paginate with nullable date-time cursor_field (all present)', async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const manifest = nullableDateTimeManifest();
    await registerManifest(asUrl, manifest);
    const ownerToken = await issueOwnerToken(asUrl);
    await seedStream(rsUrl, ownerToken, manifest.connector_id, 'budgets', [
      { id: 'b_a', name: 'A', last_modified_on: '2026-01-01T00:00:00Z' },
      { id: 'b_b', name: 'B', last_modified_on: '2026-02-01T00:00:00Z' },
      { id: 'b_c', name: 'C', last_modified_on: '2026-03-01T00:00:00Z' },
    ], 'last_modified_on');

    const listUrl =
      `${rsUrl}/v1/streams/budgets/records`
      + `?connector_id=${encodeURIComponent(manifest.connector_id)}`
      + '&order=asc&limit=2';
    const { status, body } = await fetchJson(listUrl, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    assert.equal(status, 200, 'first page succeeds');
    assert.equal(body.object, 'list');
    assert.equal(body.has_more, true);
    assert.deepEqual(body.data.map((r) => r.id), ['b_a', 'b_b']);
    assert.ok(body.next_cursor, 'next_cursor should be present');

    const page2 = await fetchJson(
      `${listUrl}&cursor=${encodeURIComponent(body.next_cursor)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    assert.equal(page2.status, 200);
    assert.deepEqual(page2.body.data.map((r) => r.id), ['b_c']);
    assert.equal(page2.body.has_more, false);
  });
});

test('records paginate with nullable date-time cursor_field (some null values)', async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const manifest = nullableDateTimeManifest();
    await registerManifest(asUrl, manifest);
    const ownerToken = await issueOwnerToken(asUrl);
    // Two null-cursor rows sit in the missing bucket — in ASC they must come
    // AFTER all present-cursor rows, in bucketed pk order.
    await seedStream(rsUrl, ownerToken, manifest.connector_id, 'budgets', [
      { id: 'b_a', name: 'A', last_modified_on: '2026-01-01T00:00:00Z' },
      { id: 'b_b', name: 'B', last_modified_on: '2026-02-01T00:00:00Z' },
      { id: 'b_null1', name: 'N1', last_modified_on: null },
      { id: 'b_null2', name: 'N2', last_modified_on: null },
    ], 'last_modified_on');

    const listUrl =
      `${rsUrl}/v1/streams/budgets/records`
      + `?connector_id=${encodeURIComponent(manifest.connector_id)}`
      + '&order=asc&limit=10';
    const { status, body } = await fetchJson(listUrl, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    assert.equal(status, 200, 'nullable-with-nulls page succeeds');
    // Present rows first (ASC cursor order), then missing bucket (pk-ordered).
    assert.deepEqual(body.data.map((r) => r.id), ['b_a', 'b_b', 'b_null1', 'b_null2']);
    assert.equal(body.has_more, false);
  });
});

test('records paginate with nullable integer cursor_field', async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const manifest = nullableIntegerManifest();
    await registerManifest(asUrl, manifest);
    const ownerToken = await issueOwnerToken(asUrl);
    await seedStream(rsUrl, ownerToken, manifest.connector_id, 'channels', [
      { id: 'c_a', name: 'A', created: 1000 },
      { id: 'c_b', name: 'B', created: 2000 },
      { id: 'c_c', name: 'C', created: 3000 },
      { id: 'c_null', name: 'N', created: null },
    ], 'created');

    const listUrl =
      `${rsUrl}/v1/streams/channels/records`
      + `?connector_id=${encodeURIComponent(manifest.connector_id)}`
      + '&order=asc&limit=2';
    const { status, body } = await fetchJson(listUrl, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    assert.equal(status, 200, 'first page succeeds for nullable integer cursor');
    assert.deepEqual(body.data.map((r) => r.id), ['c_a', 'c_b']);
    assert.equal(body.has_more, true);

    const page2 = await fetchJson(
      `${listUrl}&cursor=${encodeURIComponent(body.next_cursor)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    assert.equal(page2.status, 200);
    // c_c (created=3000), then null row in missing bucket.
    assert.deepEqual(page2.body.data.map((r) => r.id), ['c_c', 'c_null']);
    assert.equal(page2.body.has_more, false);
  });
});

test('plain nullable string cursor_field with no date format is rejected at registration', async () => {
  await withHarness(async ({ asUrl }) => {
    const manifest = unsupportedPlainStringManifest();
    const resp = await fetch(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    });
    // The manifest validator catches unsupported cursor_field shapes up-front
    // so the same bug class (500s on /records) cannot recur for freshly
    // registered connectors. Stale DB manifests that predate this guardrail
    // are handled by the runtime in-memory fallback path instead.
    assert.equal(resp.status, 400, 'unsupported cursor_field rejected at registration');
    const body = await resp.json();
    assert.ok(/cursor_field/i.test(body.error?.message ?? ''));
  });
});
