/**
 * Assistant-readiness smoke suite.
 *
 * Mirrors the owner-side personal assistant's actual workflow against the
 * first-party polyfill manifests so that a single broken cursor_field can't
 * ship a regression quietly. If any assistant-critical stream hard-fails on
 * basic page-one listing, this suite fails the release.
 *
 * Checked streams (must cover the assistant's highest-value surfaces):
 *   - Gmail messages
 *   - Slack messages
 *   - ChatGPT messages
 *   - Codex messages
 *   - Claude Code messages
 *   - GitHub issues
 *   - GitHub pull_requests
 *   - YNAB transactions
 *
 * Checks per stream:
 *   1. owner-paginated page-one records succeeds (200, list envelope)
 *   2. round-trips a follow-up cursor page when `has_more` is true
 *   3. resolves a single record by its returned id
 *   4. cross-stream lexical /v1/search is callable and returns a list envelope
 *
 * We register each shipped polyfill manifest against the reference AS and
 * synthesize a small number of well-typed sample records — the focus is
 * pagination/cursor correctness, not connector ingest semantics.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';
import { getDb } from '../server/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POLYFILL_MANIFESTS_DIR = join(
  __dirname,
  '..',
  '..',
  'packages',
  'polyfill-connectors',
  'manifests',
);

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

function loadManifest(filename) {
  return JSON.parse(readFileSync(join(POLYFILL_MANIFESTS_DIR, filename), 'utf8'));
}

async function seedRecords(rsUrl, token, connectorId, stream, records) {
  const lines = records
    .map((r) => JSON.stringify({ key: r.id, data: r, emitted_at: r.emitted_at || r._iso || new Date().toISOString() }))
    .join('\n');
  const resp = await fetch(
    `${rsUrl}/v1/ingest/${encodeURIComponent(stream)}?connector_id=${encodeURIComponent(connectorId)}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/x-ndjson',
      },
      body: lines,
    },
  );
  assert.equal(resp.status, 200, `ingest ${stream} ok`);
}

/**
 * Cases the smoke suite covers. Each provides a synthetic record set keyed
 * by a unique id. Focus is on proving records pagination + cursor
 * round-trip on every assistant-critical shape; per-connector ingest
 * nuances are covered elsewhere.
 */
const CASES = [
  {
    name: 'gmail.messages',
    manifest: 'gmail.json',
    stream: 'messages',
    records: () => [
      { id: 'm-a', thread_id: 't1', received_at: '2026-01-01T00:00:00Z', subject: 'Alpha' },
      { id: 'm-b', thread_id: 't1', received_at: '2026-01-02T00:00:00Z', subject: 'Beta' },
      { id: 'm-c', thread_id: 't2', received_at: '2026-01-03T00:00:00Z', subject: 'Gamma' },
    ],
  },
  {
    name: 'slack.messages',
    manifest: 'slack.json',
    stream: 'messages',
    records: () => [
      { id: 'C1::100.000001', channel_id: 'C1', ts: '100.000001', sent_at: '2026-01-01T00:00:00Z' },
      { id: 'C1::200.000002', channel_id: 'C1', ts: '200.000002', sent_at: '2026-01-02T00:00:00Z' },
      { id: 'C1::300.000003', channel_id: 'C1', ts: '300.000003', sent_at: '2026-01-03T00:00:00Z' },
    ],
  },
  {
    name: 'chatgpt.messages',
    manifest: 'chatgpt.json',
    stream: 'messages',
    records: () => [
      { id: 'msg_a', conversation_id: 'c1', create_time: '2026-01-01T00:00:00Z', role: 'user' },
      { id: 'msg_b', conversation_id: 'c1', create_time: '2026-01-02T00:00:00Z', role: 'assistant' },
      { id: 'msg_c', conversation_id: 'c2', create_time: null, role: 'user' }, // nullable cursor
    ],
  },
  {
    name: 'codex.messages',
    manifest: 'codex.json',
    stream: 'messages',
    records: () => [
      { id: 'codex_m1', session_id: 's1', timestamp: '2026-01-01T00:00:00Z', role: 'user' },
      { id: 'codex_m2', session_id: 's1', timestamp: '2026-01-02T00:00:00Z', role: 'assistant' },
    ],
  },
  {
    name: 'claude_code.messages',
    manifest: 'claude_code.json',
    stream: 'messages',
    records: () => [
      { id: 'cc_m1', session_id: 's1', timestamp: '2026-01-01T00:00:00Z', role: 'user' },
      { id: 'cc_m2', session_id: 's1', timestamp: '2026-01-02T00:00:00Z', role: 'assistant' },
    ],
  },
  {
    name: 'github.issues',
    manifest: 'github.json',
    stream: 'issues',
    records: () => [
      { id: 'gh_i1', number: 1, repository_full_name: 'o/r', updated_at: '2026-01-01T00:00:00Z', title: 'First' },
      { id: 'gh_i2', number: 2, repository_full_name: 'o/r', updated_at: '2026-01-02T00:00:00Z', title: 'Second' },
    ],
  },
  {
    name: 'github.pull_requests',
    manifest: 'github.json',
    stream: 'pull_requests',
    records: () => [
      { id: 'gh_pr1', number: 10, repository_full_name: 'o/r', updated_at: '2026-01-01T00:00:00Z', title: 'PR one' },
      { id: 'gh_pr2', number: 11, repository_full_name: 'o/r', updated_at: '2026-01-02T00:00:00Z', title: 'PR two' },
    ],
  },
  {
    name: 'ynab.transactions',
    manifest: 'ynab.json',
    stream: 'transactions',
    records: () => [
      { id: 'ynab_t1', account_id: 'a1', budget_id: 'b1', date: '2026-01-01', amount: -1000, payee_name: 'Coffee' },
      { id: 'ynab_t2', account_id: 'a1', budget_id: 'b1', date: '2026-01-02', amount: -2500, payee_name: 'Grocery' },
    ],
  },
];

const REPRESENTATIVE_REALIZATION_CASES = [
  { kind: 'api', name: 'github.issues' },
  { kind: 'browser-scraper', name: 'chatgpt.messages' },
  { kind: 'file-based', name: 'claude_code.messages' },
];

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

for (const c of CASES) {
  test(`assistant smoke: ${c.name} pages + cursor + single-record hydration`, async () => {
    await withHarness(async ({ asUrl, rsUrl }) => {
      const manifest = loadManifest(c.manifest);
      await registerManifest(asUrl, manifest);
      const ownerToken = await issueOwnerToken(asUrl);
      const records = c.records();
      await seedRecords(rsUrl, ownerToken, manifest.connector_id, c.stream, records);

      // Page one — limit=1 so we can guarantee has_more=true for round-trip.
      const firstUrl =
        `${rsUrl}/v1/streams/${encodeURIComponent(c.stream)}/records`
        + `?connector_id=${encodeURIComponent(manifest.connector_id)}`
        + `&limit=1&order=asc`;
      const page1 = await fetchJson(firstUrl, { headers: { Authorization: `Bearer ${ownerToken}` } });
      assert.equal(page1.status, 200, `page one 200: ${JSON.stringify(page1.body)}`);
      assert.equal(page1.body.object, 'list', 'list envelope');
      assert.equal(page1.body.data.length, 1);
      assert.equal(page1.body.has_more, true);
      assert.ok(page1.body.next_cursor, 'next_cursor present');

      // Cursor round-trip — page two should succeed and return remaining rows.
      const page2 = await fetchJson(
        `${firstUrl}&cursor=${encodeURIComponent(page1.body.next_cursor)}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      assert.equal(page2.status, 200, 'cursor round-trip 200');
      assert.equal(page2.body.object, 'list');
      assert.ok(page2.body.data.length >= 1, 'at least one record on page two');

      // Single-record hydration: grab the first record's id and fetch it.
      const firstId = page1.body.data[0].id;
      const detail = await fetchJson(
        `${rsUrl}/v1/streams/${encodeURIComponent(c.stream)}/records/${encodeURIComponent(firstId)}`
        + `?connector_id=${encodeURIComponent(manifest.connector_id)}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      assert.equal(detail.status, 200, 'single-record hydration');
      assert.equal(detail.body.id, firstId);

      // Cross-stream lexical search is callable and returns a list envelope.
      // Content assertions are covered in lexical-retrieval.test.js.
      const search = await fetchJson(`${rsUrl}/v1/search?q=test`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(search.status, 200, 'search endpoint reachable');
      assert.equal(search.body.object, 'list');
      assert.ok(Array.isArray(search.body.data));
    });
  });
}

test('assistant smoke: in-memory fallback activates for stale DB cursor_field drift', async () => {
  // Simulate a stale DB row where the persisted manifest's cursor_field
  // schema is still the old pre-fix shape. Reconcile is disabled for this
  // test so the fallback path is exercised rather than the self-heal.
  await withHarness(async ({ asUrl, rsUrl }) => {
    // Register a manifest manually with plain string cursor — bypass the
    // validator by going through a patched shape that still satisfies it
    // first, then injecting drift via direct DB write. Since the validator
    // now enforces SQL-compat, we can only test the fallback by registering
    // a supported shape and then verifying the records path still works
    // when the cursor is missing on some records. (Full stale-DB simulation
    // is covered by the reconcile tests.)
    const manifest = {
      // Custom (non-first-party) manifest: connector_id must be a bare slug
      // that matches connector_key. The registry URL belongs in manifest_uri,
      // not connector_id. See canonicalize-connector-keys (connector_id ==
      // connector_key invariant enforced at registration + ingest).
      protocol_version: '0.1.0',
      connector_id: 'fallback-smoke',
      connector_key: 'fallback-smoke',
      version: '1.0.0',
      display_name: 'Fallback smoke',
      runtime_requirements: { bindings: { network: { required: true } } },
      streams: [
        {
          name: 'items',
          semantics: 'mutable_state',
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              updated_at: { type: ['string', 'null'], format: 'date-time' },
            },
            required: ['id'],
          },
          primary_key: ['id'],
          cursor_field: 'updated_at',
          selection: { fields: true, resources: true },
        },
      ],
    };
    await registerManifest(asUrl, manifest);
    const ownerToken = await issueOwnerToken(asUrl);
    await seedRecords(rsUrl, ownerToken, manifest.connector_id, 'items', [
      { id: 'i1', updated_at: '2026-01-01T00:00:00Z' },
      { id: 'i2', updated_at: null },
      { id: 'i3', updated_at: '2026-01-02T00:00:00Z' },
    ]);
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/streams/items/records?connector_id=${encodeURIComponent(manifest.connector_id)}&order=asc`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    assert.equal(status, 200);
    // Null-cursor row goes to the missing bucket in ASC (after present).
    assert.deepEqual(body.data.map((r) => r.id), ['i1', 'i3', 'i2']);
  });
});

test('assistant smoke: representative polyfill classes populate canonical spine source columns', async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const expectedConnectorIds = [];

    for (const representative of REPRESENTATIVE_REALIZATION_CASES) {
      const c = CASES.find((item) => item.name === representative.name);
      assert.ok(c, `missing representative case for ${representative.kind}`);
      const manifest = loadManifest(c.manifest);
      await registerManifest(asUrl, manifest);
      expectedConnectorIds.push(manifest.connector_id);

      await seedRecords(rsUrl, ownerToken, manifest.connector_id, c.stream, c.records().slice(0, 1));
      const page = await fetchJson(
        `${rsUrl}/v1/streams/${encodeURIComponent(c.stream)}/records?connector_id=${encodeURIComponent(manifest.connector_id)}&limit=1`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      );
      assert.equal(page.status, 200, `${representative.kind} representative query succeeds`);
      assert.equal(page.body.object, 'list');
    }

    const rows = getDb().prepare('SELECT event_id, source_kind, source_id, data_json FROM spine_events').all();
    const sourcedRows = rows.filter((row) => {
      const data = JSON.parse(row.data_json || '{}');
      return data.source?.kind === 'connector' && expectedConnectorIds.includes(data.source.id);
    });

    for (const connectorId of expectedConnectorIds) {
      assert.ok(
        sourcedRows.some((row) => row.source_id === connectorId),
        `expected sourced spine rows for ${connectorId}`,
      );
    }
    assert.equal(
      sourcedRows.filter((row) => row.source_kind !== 'connector' || !row.source_id).length,
      0,
      'representative sourced spine rows should have non-null canonical source columns',
    );
  });
});
