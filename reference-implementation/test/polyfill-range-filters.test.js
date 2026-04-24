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
const SUPPORTED_RANGE_OPERATORS = new Set(['gte', 'gt', 'lte', 'lt']);
const RANGE_FILTERED_CONNECTORS = [
  'gmail',
  'slack',
  'github',
  'ynab',
  'chatgpt',
  'codex',
  'claude_code',
  'chase',
  'usaa',
  'amazon',
];

function readManifest(name) {
  return JSON.parse(readFileSync(join(POLYFILL_MANIFEST_DIR, `${name}.json`), 'utf8'));
}

function nonNullSchemaTypes(schema) {
  const raw = schema?.type;
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((type) => type !== 'null');
}

function isOrderableRangeSchema(schema) {
  const types = nonNullSchemaTypes(schema);
  if (types.length !== 1) return false;
  if (types[0] === 'integer' || types[0] === 'number') return true;
  return types[0] === 'string' && (schema?.format === 'date' || schema?.format === 'date-time');
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
  const lines = records.map((record) => JSON.stringify({
    key: record.id,
    data: record,
    emitted_at: record.emitted_at || record.updated_at || record.received_at || record.date || new Date().toISOString(),
  })).join('\n');
  const resp = await fetch(`${rsUrl}/v1/ingest/${encodeURIComponent(stream)}?connector_id=${encodeURIComponent(connectorId)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      'Content-Type': 'application/x-ndjson',
    },
    body: lines,
  });
  assert.equal(resp.status, 200, `ingest ${connectorId} ${stream}: ${await resp.text()}`);
}

const rangeQueryCases = [
  {
    manifestName: 'gmail',
    stream: 'messages',
    field: 'received_at',
    threshold: '2026-02-01T00:00:00Z',
    records: [
      { id: 'gmail_old', thread_id: 'thread_1', received_at: '2026-01-01T00:00:00Z' },
      { id: 'gmail_hit', thread_id: 'thread_2', received_at: '2026-02-01T00:00:00Z' },
      { id: 'gmail_new', thread_id: 'thread_3', received_at: '2026-03-01T00:00:00Z' },
    ],
    expectedIds: ['gmail_hit', 'gmail_new'],
  },
  {
    manifestName: 'slack',
    stream: 'messages',
    field: 'reply_count',
    threshold: '2',
    records: [
      { id: 'slack_old', channel_id: 'channel_1', ts: '1.000', sent_at: '2026-01-01T00:00:00Z', reply_count: 0 },
      { id: 'slack_hit', channel_id: 'channel_1', ts: '2.000', sent_at: '2026-01-02T00:00:00Z', reply_count: 2 },
      { id: 'slack_new', channel_id: 'channel_1', ts: '3.000', sent_at: '2026-01-03T00:00:00Z', reply_count: 4 },
    ],
    expectedIds: ['slack_hit', 'slack_new'],
  },
  {
    manifestName: 'github',
    stream: 'repositories',
    field: 'stargazers_count',
    threshold: '100',
    records: [
      { id: 'github_old', full_name: 'owner/old', stargazers_count: 10 },
      { id: 'github_hit', full_name: 'owner/hit', stargazers_count: 100 },
      { id: 'github_new', full_name: 'owner/new', stargazers_count: 250 },
    ],
    expectedIds: ['github_hit', 'github_new'],
  },
  {
    manifestName: 'ynab',
    stream: 'transactions',
    field: 'amount',
    threshold: '50000',
    records: [
      { id: 'ynab_old', budget_id: 'budget_1', account_id: 'account_1', date: '2026-01-01', amount: 1200 },
      { id: 'ynab_hit', budget_id: 'budget_1', account_id: 'account_1', date: '2026-01-02', amount: 50000 },
      { id: 'ynab_new', budget_id: 'budget_1', account_id: 'account_1', date: '2026-01-03', amount: 75000 },
    ],
    expectedIds: ['ynab_hit', 'ynab_new'],
  },
  {
    manifestName: 'chatgpt',
    stream: 'conversations',
    field: 'create_time',
    threshold: '2026-02-01T00:00:00Z',
    records: [
      { id: 'chatgpt_old', create_time: '2026-01-01T00:00:00Z' },
      { id: 'chatgpt_hit', create_time: '2026-02-01T00:00:00Z' },
      { id: 'chatgpt_new', create_time: '2026-03-01T00:00:00Z' },
    ],
    expectedIds: ['chatgpt_hit', 'chatgpt_new'],
  },
  {
    manifestName: 'codex',
    stream: 'sessions',
    field: 'tokens_used',
    threshold: '1000',
    records: [
      { id: 'codex_old', tokens_used: 200 },
      { id: 'codex_hit', tokens_used: 1000 },
      { id: 'codex_new', tokens_used: 2500 },
    ],
    expectedIds: ['codex_hit', 'codex_new'],
  },
  {
    manifestName: 'claude_code',
    stream: 'attachments',
    field: 'content_bytes',
    threshold: '1000',
    records: [
      { id: 'claude_old', session_id: 'session_1', content_bytes: 128 },
      { id: 'claude_hit', session_id: 'session_1', content_bytes: 1000 },
      { id: 'claude_new', session_id: 'session_1', content_bytes: 4096 },
    ],
    expectedIds: ['claude_hit', 'claude_new'],
  },
  {
    manifestName: 'chase',
    stream: 'transactions',
    field: 'amount',
    threshold: '5000',
    records: [
      { id: 'chase_old', account_id: 'account_1', fitid: 'fitid_old', date: '2026-01-01', amount: 1200, currency: 'USD' },
      { id: 'chase_hit', account_id: 'account_1', fitid: 'fitid_hit', date: '2026-01-02', amount: 5000, currency: 'USD' },
      { id: 'chase_new', account_id: 'account_1', fitid: 'fitid_new', date: '2026-01-03', amount: 9000, currency: 'USD' },
    ],
    expectedIds: ['chase_hit', 'chase_new'],
  },
  {
    manifestName: 'usaa',
    stream: 'transactions',
    field: 'balance_after_cents',
    threshold: '50000',
    records: [
      { id: 'usaa_old', account_id: 'account_1', date: '2026-01-01', amount: 100, currency: 'USD', balance_after_cents: 1200 },
      { id: 'usaa_hit', account_id: 'account_1', date: '2026-01-02', amount: 100, currency: 'USD', balance_after_cents: 50000 },
      { id: 'usaa_new', account_id: 'account_1', date: '2026-01-03', amount: 100, currency: 'USD', balance_after_cents: 75000 },
    ],
    expectedIds: ['usaa_hit', 'usaa_new'],
  },
  {
    manifestName: 'amazon',
    stream: 'orders',
    field: 'order_total_cents',
    threshold: '5000',
    records: [
      { id: 'amazon_old', order_date: '2026-01-01', order_total_cents: 1200 },
      { id: 'amazon_hit', order_date: '2026-01-02', order_total_cents: 5000 },
      { id: 'amazon_new', order_date: '2026-01-03', order_total_cents: 9000 },
    ],
    expectedIds: ['amazon_hit', 'amazon_new'],
  },
];

test('first-party polyfill manifests declare only valid range filter fields', () => {
  for (const manifestName of RANGE_FILTERED_CONNECTORS) {
    const manifest = readManifest(manifestName);
    for (const stream of manifest.streams) {
      const rangeFilters = stream.query?.range_filters;
      if (!rangeFilters) continue;
      for (const [field, operators] of Object.entries(rangeFilters)) {
        const schema = stream.schema?.properties?.[field];
        assert.ok(schema, `${manifestName}.${stream.name}.${field} must exist in schema.properties`);
        assert.ok(isOrderableRangeSchema(schema), `${manifestName}.${stream.name}.${field} must be numeric, date, or date-time`);
        assert.ok(Array.isArray(operators) && operators.length > 0, `${manifestName}.${stream.name}.${field} operators must be non-empty`);
        assert.deepEqual(
          operators.filter((operator) => !SUPPORTED_RANGE_OPERATORS.has(operator)),
          [],
          `${manifestName}.${stream.name}.${field} must use supported operators`,
        );
      }
    }
  }
});

test('first-party polyfill manifests with range filters register through the AS validator', async () => {
  await withHarness(async ({ asUrl }) => {
    for (const manifestName of RANGE_FILTERED_CONNECTORS) {
      await registerManifest(asUrl, readManifest(manifestName));
    }
  });
});

test('first-party polyfill range filters execute against synthetic records', async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    for (const manifestName of RANGE_FILTERED_CONNECTORS) {
      await registerManifest(asUrl, readManifest(manifestName));
    }
    const ownerToken = await issueOwnerToken(asUrl, 'polyfill_range_owner');
    for (const queryCase of rangeQueryCases) {
      const manifest = readManifest(queryCase.manifestName);
      await seedStream(rsUrl, ownerToken, manifest.connector_id, queryCase.stream, queryCase.records);
      const url = `${rsUrl}/v1/streams/${encodeURIComponent(queryCase.stream)}/records`
        + `?connector_id=${encodeURIComponent(manifest.connector_id)}`
        + `&filter[${encodeURIComponent(queryCase.field)}][gte]=${encodeURIComponent(queryCase.threshold)}`;
      const { status, body } = await fetchJson(url, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(status, 200, `${queryCase.manifestName}.${queryCase.stream}.${queryCase.field}`);
      assert.deepEqual(
        body.data.map((record) => record.id).sort(),
        queryCase.expectedIds,
        `${queryCase.manifestName}.${queryCase.stream}.${queryCase.field} should filter synthetics`,
      );
    }
  });
});
