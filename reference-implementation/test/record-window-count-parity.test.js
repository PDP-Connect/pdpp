// Dual-backend parity for the record-list `window` and `count` aggregates.
//
// `queryRecords` dispatches to the SQLite store or the real `postgresQueryRecords`
// based on the active backend, so the SAME test body run under each backend is a
// true conformance check of the production code (not a test-only reimplementation
// like the record-read-conformance Postgres driver).
//
// This pins a known parity gap: the Postgres list path validated `window` but did
// not compute `meta.window`, so a client asking for `window: 'exact'` got bounds
// on SQLite and nothing on Postgres. Storage-convergence increment 2.

import assert from 'node:assert/strict';
import test from 'node:test';
import { closeDb, initDb } from '../server/db.js';
import { registerConnector } from '../server/auth.js';
import { ingestRecord, queryRecords } from '../server/records.js';
import { closePostgresStorage, initPostgresStorage, postgresQuery } from '../server/postgres-storage.js';

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

const CONNECTOR_ID = 'window_parity_demo';
const STREAM = 'items';
const MANIFEST = {
  connector_id: CONNECTOR_ID,
  version: '1.0.0',
  streams: [
    {
      name: STREAM,
      primary_key: ['id'],
      cursor_field: 'created_at',
      consent_time_field: 'created_at',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' },
          body: { type: 'string' },
        },
      },
      selection: { fields: true },
    },
  ],
};

const SEED = [
  { id: 'r1', created_at: '2026-01-01T00:00:00.000Z', body: 'a' },
  { id: 'r2', created_at: '2026-01-02T00:00:00.000Z', body: 'b' },
  { id: 'r3', created_at: '2026-01-03T00:00:00.000Z', body: 'c' },
];

const GRANT = { streams: [{ name: STREAM, fields: ['id', 'created_at', 'body'] }] };

async function seedAndQuery() {
  await registerConnector(MANIFEST);
  for (const data of SEED) {
    await ingestRecord(CONNECTOR_ID, { stream: STREAM, key: data.id, data, emitted_at: data.created_at });
  }
  return queryRecords(CONNECTOR_ID, STREAM, GRANT, { window: 'exact', count: 'exact' }, MANIFEST);
}

// The behavioral contract both backends must satisfy. Asserting it in one place
// guarantees SQLite and Postgres agree.
function assertWindowAndCount(result, label) {
  assert.ok(result?.meta, `${label}: response must carry meta`);
  assert.deepEqual(
    result.meta.count,
    { kind: 'exact', value: 3 },
    `${label}: exact count must equal the 3 seeded rows`,
  );
  assert.ok(result.meta.window, `${label}: window: 'exact' must produce meta.window`);
  assert.equal(result.meta.window.total, 3, `${label}: window total over the 3 seeded rows`);
  // Window bounds span the cursor/consent-time field across the seeded rows.
  assert.equal(result.meta.window.earliest_at, '2026-01-01T00:00:00.000Z', `${label}: window earliest_at`);
  assert.equal(result.meta.window.latest_at, '2026-01-03T00:00:00.000Z', `${label}: window latest_at`);
}

test('SQLite: window:exact + count:exact produce bounds and count', async () => {
  initDb(':memory:');
  try {
    const result = await seedAndQuery();
    assertWindowAndCount(result, 'sqlite');
  } finally {
    closeDb();
  }
});

if (!POSTGRES_URL) {
  test('Postgres: window/count parity (skipped: PDPP_TEST_POSTGRES_URL unset)', { skip: true }, () => {});
} else {
  test('Postgres: window:exact + count:exact produce bounds and count (parity with SQLite)', async () => {
    initDb(':memory:');
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      await postgresQuery('DELETE FROM records WHERE connector_id = $1', [CONNECTOR_ID]);
      await postgresQuery('DELETE FROM retained_size_stream WHERE stream = $1', [STREAM]).catch(() => {});
      const result = await seedAndQuery();
      assertWindowAndCount(result, 'postgres');
    } finally {
      await postgresQuery('DELETE FROM records WHERE connector_id = $1', [CONNECTOR_ID]).catch(() => {});
      await closePostgresStorage();
      closeDb();
    }
  });
}
