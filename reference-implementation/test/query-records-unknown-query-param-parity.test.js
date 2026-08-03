// Regression + parity test: Postgres must reject unknown/unsupported
// top-level query-string keys on the record list read, the same as SQLite.
//
// SQLite's `queryRecords` (server/records.js) validates every request
// through `validateTopLevelQueryParams`, which rejects any key not in the
// canonical `SUPPORTED_RECORD_QUERY_PARAMS` allowlist with a typed
// `invalid_request` error. `postgresQueryRecords` (server/postgres-records.js)
// never ran this check, so a caller typo (e.g. `?limitt=5` instead of
// `?limit=5`) silently no-op'd on Postgres — the misspelled key was
// ignored and the request proceeded with defaults — instead of erroring
// the way SQLite does.
//
// postgres-records.js intentionally does not import from records.js (the
// dependency runs one way: records.js dispatches into postgres-records.js).
// The fix duplicates the allowlist + check in postgres-records.js,
// following the same duplication pattern already used there for
// SUPPORTED_COUNT_KINDS / SUPPORTED_WINDOW_KINDS.
//
// This test drives both backends through the SAME public dispatcher
// (`queryRecords`) with an unsupported key and asserts both reject it
// identically.

import assert from 'node:assert/strict';
import test from 'node:test';

import { registerConnector } from '../server/auth.js';
import { closeDb, initDb } from '../server/db.js';
import {
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
} from '../server/postgres-storage.js';
import { ingestRecord, queryRecords } from '../server/records.js';

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

const CONNECTOR_ID = 'unknown_query_param_demo';
const STREAM = 'items';

const MANIFEST = {
  connector_id: CONNECTOR_ID,
  version: '1.0.0',
  streams: [
    {
      name: STREAM,
      primary_key: ['id'],
      cursor_field: 'created_at',
      schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      selection: { fields: true },
    },
  ],
};

const GRANT = { streams: [{ name: STREAM }] };

async function seed() {
  await registerConnector(MANIFEST);
  await ingestRecord(CONNECTOR_ID, {
    stream: STREAM,
    key: 'i1',
    data: { id: 'i1', created_at: '2026-01-01T00:00:00.000Z' },
    emitted_at: '2026-01-01T00:00:00.000Z',
  });
}

async function runUnknownParamConformance(label) {
  await seed();

  // Sanity control: a well-formed request with a supported param succeeds.
  const ok = await queryRecords(CONNECTOR_ID, STREAM, GRANT, { limit: 5 }, MANIFEST);
  assert.equal(ok.data.length, 1, `${label}: supported param request succeeds`);

  // A typo'd/unsupported key must be a typed rejection, not a silent no-op.
  await assert.rejects(
    () => queryRecords(CONNECTOR_ID, STREAM, GRANT, { limitt: 5 }, MANIFEST),
    (err) => {
      assert.equal(err.code, 'invalid_request', `${label}: unsupported param rejected with invalid_request`);
      assert.match(err.message, /limitt/, `${label}: error message names the offending key`);
      return true;
    },
    `${label}: unsupported query param 'limitt' must reject, not silently no-op`,
  );
}

test('SQLite: queryRecords rejects an unsupported query param', async () => {
  initDb(':memory:');
  try {
    await runUnknownParamConformance('sqlite');
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
  test('Postgres: queryRecords rejects an unsupported query param (skipped: PDPP_TEST_POSTGRES_URL unset)', { skip: true }, () => {});
} else {
  test('Postgres: queryRecords rejects an unsupported query param (parity with SQLite)', async () => {
    initDb(':memory:');
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      await cleanupPostgres();
      await runUnknownParamConformance('postgres');
    } finally {
      await cleanupPostgres();
      await closePostgresStorage();
      closeDb();
    }
  });
}
