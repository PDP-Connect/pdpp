/**
 * Mutation-killing coverage for the public `query_not_found` typed-error code
 * (server/routes/ref-error-status.ts: `query_not_found: 404`).
 *
 * `getRecordFieldWindow` supports a `q` selector that returns a bounded text
 * window centered on the FIRST occurrence of `q` within a text field (the
 * `content_ladder` / read_record_field affordance). When `q` does not occur in
 * the field's text, the read raises a `query_not_found` (HTTP 404) error rather
 * than returning an empty or offset-0 window — the caller asked to be anchored
 * on a match that does not exist.
 *
 * The existing field-window substrate test exercises the SUCCESS path of the
 * `q` selector but never the miss; no `test/` file exercised `query_not_found`
 * by name, so a mutation dropping the "no match" branch (silently returning a
 * degenerate window) or corrupting the code string went undetected. This test
 * pins the miss case on both storage backends.
 *
 * Note: this test only OBSERVES `getRecordFieldWindow`; it changes no behavior.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { registerConnector } from '../server/auth.js';
import { closeDb, initDb } from '../server/db.js';
import {
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
} from '../server/postgres-storage.js';
import { getRecordFieldWindow, ingestRecord } from '../server/records.js';

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

const CONNECTOR_ID = 'query_not_found_demo';
const STREAM = 'emails';

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
        required: ['id'],
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
  {
    id: 'e1',
    created_at: '2026-01-01T00:00:00.000Z',
    body: 'Alpha Hyperlane Bridge Omega',
  },
];

const GRANT = { streams: [{ name: STREAM, fields: ['id', 'created_at', 'body'] }] };

async function seed() {
  await registerConnector(MANIFEST);
  for (const data of SEED) {
    await ingestRecord(CONNECTOR_ID, {
      stream: STREAM,
      key: data.id,
      data,
      emitted_at: data.created_at,
    });
  }
}

async function runConformance(label) {
  await seed();

  // Sanity: a needle that IS present resolves to a match window (proves the
  // record + field are readable, so a miss below is truly a "not found in
  // field", not a not-granted / not-found-record outcome).
  const hit = await getRecordFieldWindow(CONNECTOR_ID, STREAM, 'e1', 'body', GRANT, MANIFEST, {
    q: 'Hyperlane',
    before_chars: 0,
    after_chars: 0,
  });
  assert.equal(hit.window.match_start_chars, 6, `${label}: present needle anchors on its match`);

  // The miss: a needle absent from the field text raises query_not_found (404).
  await assert.rejects(
    () =>
      getRecordFieldWindow(CONNECTOR_ID, STREAM, 'e1', 'body', GRANT, MANIFEST, {
        q: 'needle-that-is-absent',
      }),
    (err) => {
      assert.equal(err.code, 'query_not_found', `${label}: absent q SHALL raise query_not_found`);
      assert.equal(err.httpStatus, 404, `${label}: query_not_found is a 404`);
      return true;
    },
    `${label}: absent q selector`,
  );

  // Case-insensitive matching means a differently-cased present needle is a HIT,
  // not a miss — so a miss is genuinely "no such text", not a casing artifact.
  const caseHit = await getRecordFieldWindow(CONNECTOR_ID, STREAM, 'e1', 'body', GRANT, MANIFEST, {
    q: 'bridge',
    before_chars: 0,
    after_chars: 0,
  });
  assert.equal(caseHit.window.match_start_chars, 16, `${label}: case-insensitive present needle is a hit`);
}

test('SQLite: query_not_found on an absent q selector', async () => {
  initDb(':memory:');
  try {
    await runConformance('sqlite');
  } finally {
    closeDb();
  }
});

async function cleanupPostgres() {
  for (const table of ['records', 'record_changes', 'version_counter', 'retained_size_stream', 'connectors']) {
    const column = table === 'retained_size_stream' ? 'stream' : 'connector_id';
    const value = table === 'retained_size_stream' ? STREAM : CONNECTOR_ID;
    await postgresQuery(`DELETE FROM ${table} WHERE ${column} = $1`, [value]).catch(() => {});
  }
}

if (!POSTGRES_URL) {
  test('Postgres: query_not_found on an absent q selector (skipped: PDPP_TEST_POSTGRES_URL unset)', { skip: true }, () => {});
} else {
  test('Postgres: query_not_found on an absent q selector (parity with SQLite)', async () => {
    initDb(':memory:');
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      await cleanupPostgres();
      await runConformance('postgres');
    } finally {
      await cleanupPostgres();
      await closePostgresStorage();
      closeDb();
    }
  });
}
