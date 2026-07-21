import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const POLYFILL_MANIFEST_DIR = join(REPO_ROOT, 'packages/polyfill-connectors/manifests');
const TEST_DCR_INITIAL_ACCESS_TOKEN = 'pdpp-reference-test-initial-access-token';

function readManifest(name) {
  return JSON.parse(readFileSync(join(POLYFILL_MANIFEST_DIR, `${name}.json`), 'utf8'));
}

async function closeServer(server) {
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

async function registerManifest(asUrl, manifest) {
  const resp = await fetch(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  assert.equal(resp.status, 201, `register ${manifest.connector_id}`);
}

async function seedStream(rsUrl, ownerToken, connectorId, stream, records) {
  const lines = records
    .map((record) =>
      JSON.stringify({
        key: record.id,
        data: record,
        emitted_at: record.date ? `${record.date}T00:00:00Z` : new Date().toISOString(),
      }),
    )
    .join('\n');
  const resp = await fetch(
    `${rsUrl}/v1/ingest/${encodeURIComponent(stream)}?connector_id=${encodeURIComponent(connectorId)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/x-ndjson',
      },
      body: lines,
    },
  );
  assert.equal(resp.status, 200, `ingest ${connectorId} ${stream}: ${await resp.text()}`);
}

// Chase `transactions.amount` is a signed integer (cents): negative for debits,
// positive for credits. The stream advertises `amount` as a range filter. These
// records straddle zero so each predicate must be enforced for real: a filter
// that is silently ignored would let negatives leak through `gte=0` or let
// positives leak through `lte=-50000`.
const CHASE_RECORDS = [
  { id: 'big_debit', account_id: 'acct_1', fitid: 'f1', date: '2026-05-02', amount: -75000, currency: 'USD' },
  { id: 'small_debit', account_id: 'acct_1', fitid: 'f2', date: '2026-05-03', amount: -2000, currency: 'USD' },
  { id: 'zero', account_id: 'acct_1', fitid: 'f3', date: '2026-05-04', amount: 0, currency: 'USD' },
  { id: 'credit', account_id: 'acct_1', fitid: 'f4', date: '2026-05-05', amount: 5000, currency: 'USD' },
  // Out of the date window below; guards the combined date+amount case.
  { id: 'old_big_debit', account_id: 'acct_1', fitid: 'f5', date: '2026-04-01', amount: -90000, currency: 'USD' },
];

async function recordIdsFor(rsUrl, ownerToken, connectorId, query) {
  const url =
    `${rsUrl}/v1/streams/transactions/records` +
    `?connector_id=${encodeURIComponent(connectorId)}&${query}`;
  const { status, body } = await fetchJson(url, { headers: { Authorization: `Bearer ${ownerToken}` } });
  assert.equal(status, 200, `query ${query}: ${JSON.stringify(body)}`);
  return body.data.map((record) => record.id).sort();
}

test('amount range filters are enforced across zero (negatives, combined date+amount)', async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const manifest = readManifest('chase');
    await registerManifest(asUrl, manifest);
    const ownerToken = await issueOwnerToken(asUrl, 'amount_range_owner');
    await seedStream(rsUrl, ownerToken, manifest.connector_id, 'transactions', CHASE_RECORDS);

    // gte=0 must EXCLUDE negative amounts (the live-reported defect).
    assert.deepEqual(
      await recordIdsFor(rsUrl, ownerToken, manifest.connector_id, 'filter[amount][gte]=0'),
      ['credit', 'zero'],
      'filter[amount][gte]=0 must exclude negative amounts',
    );

    // lte=-50000 must exclude positives and small negatives.
    assert.deepEqual(
      await recordIdsFor(rsUrl, ownerToken, manifest.connector_id, 'filter[amount][lte]=-50000'),
      ['big_debit', 'old_big_debit'],
      'filter[amount][lte]=-50000 must keep only large debits',
    );

    // Date range alone (regression guard: the date filter is reported working).
    assert.deepEqual(
      await recordIdsFor(
        rsUrl,
        ownerToken,
        manifest.connector_id,
        'filter[date][gte]=2026-05-01&filter[date][lte]=2026-05-05',
      ),
      ['big_debit', 'credit', 'small_debit', 'zero'],
      'filter[date] range must bound by date',
    );

    // Combined date + amount must honor BOTH predicates. Within the May window,
    // only big_debit is <= -50000; old_big_debit is excluded by the date bound.
    assert.deepEqual(
      await recordIdsFor(
        rsUrl,
        ownerToken,
        manifest.connector_id,
        'filter[date][gte]=2026-05-01&filter[date][lte]=2026-05-05&filter[amount][lte]=-50000',
      ),
      ['big_debit'],
      'combined date+amount must honor both predicates',
    );
  });
});
