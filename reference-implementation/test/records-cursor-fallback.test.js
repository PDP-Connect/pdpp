// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for the runtime in-memory pagination fallback.
 *
 * The validator rejects unsupported `cursor_field` schemas at registration
 * time, but existing databases can still hold manifests that predate the
 * guardrail. In that case the reference falls back to a JS-comparator
 * sort/seek path rather than hard-failing the read.
 *
 * These tests simulate a stale DB row by writing a manifest directly into
 * the `connectors` table and then exercising `/v1/streams/:s/records`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { getDb } from '../server/db.js';

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
      asUrl: `http://localhost:${server.asPort}`,
      rsUrl: `http://localhost:${server.rsPort}`,
    });
  } finally {
    await closeServer(server);
  }
}

/**
 * Bypass `registerConnector` (which would run the validator) and write a
 * stale manifest directly into the connectors table.
 */
function insertStaleManifest(manifest) {
  getDb()
    .prepare(`
      INSERT INTO connectors(connector_id, manifest) VALUES(?, ?)
      ON CONFLICT(connector_id) DO UPDATE SET manifest = excluded.manifest
    `)
    .run(manifest.connector_id, JSON.stringify(manifest));
}

async function seedStream(rsUrl, token, connectorId, stream, records) {
  const lines = records
    .map((r) => JSON.stringify({ key: r.id, data: r, emitted_at: r._iso || r[Object.keys(r)[0]] || new Date().toISOString() }))
    .join('\n');
  const resp = await fetch(
    `${rsUrl}/v1/ingest/${encodeURIComponent(stream)}?connector_id=${encodeURIComponent(connectorId)}`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/x-ndjson' },
      body: lines,
    },
  );
  if (resp.status !== 200) {
    const body = await resp.text();
    throw new Error(`ingest ${stream} failed: ${resp.status} ${body}`);
  }
}

// Mimics a pre-fix shipped manifest — cursor_field is a plain string with
// no format. Accepted by the old validator, rejected by the current one.
const STALE_MANIFEST = {
  protocol_version: '0.1.0',
  connector_id: 'https://registry.pdpp.test/connectors/stale-plain-string',
  version: '1.0.0',
  display_name: 'Stale plain-string cursor',
  runtime_requirements: { bindings: { network: { required: true } } },
  streams: [
    {
      name: 'notes',
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
      cursor_field: 'title', // plain nullable string — no date format
      selection: { fields: true, resources: true },
    },
  ],
};

test('records pagination falls back to JS comparator for stale unsupported cursor_field', async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    insertStaleManifest(STALE_MANIFEST);
    const token = await issueOwnerToken(asUrl);

    await seedStream(rsUrl, token, STALE_MANIFEST.connector_id, 'notes', [
      { id: 'n1', title: 'cherry' },
      { id: 'n2', title: 'apple' },
      { id: 'n3', title: 'banana' },
      { id: 'n4', title: null },
    ]);

    const { status, body } = await fetchJson(
      `${rsUrl}/v1/streams/notes/records?connector_id=${encodeURIComponent(STALE_MANIFEST.connector_id)}&order=asc&limit=2`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    assert.equal(status, 200, `fallback path should serve 200, got ${status}`);
    assert.equal(body.object, 'list');
    // localeCompare order: apple < banana < cherry; null goes to missing bucket last.
    assert.deepEqual(body.data.map((r) => r.id), ['n2', 'n3']);
    assert.equal(body.has_more, true);

    const page2 = await fetchJson(
      `${rsUrl}/v1/streams/notes/records?connector_id=${encodeURIComponent(STALE_MANIFEST.connector_id)}&order=asc&limit=2&cursor=${encodeURIComponent(body.next_cursor)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(page2.status, 200);
    assert.deepEqual(page2.body.data.map((r) => r.id), ['n1', 'n4']);
    assert.equal(page2.body.has_more, false);
  });
});
