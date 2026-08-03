// Regression + parity test for a wrong-arity `buildEffectiveFilter` call in
// `postgresGetRecordFieldWindow` (server/postgres-records.js).
//
// `buildEffectiveFilter(streamGrant, requestParams, requiredFields = [])`
// unions the manifest's schema-required fields into the effective grant
// projection (see server/record-expand-helpers.js) so that a required field
// is always readable even when a grant's explicit `fields` allowlist omits
// it. The Postgres field-window path called
// `buildEffectiveFilter(streamGrant, requiredFieldsFor(manifestStream))` —
// passing the required-fields array into the `requestParams` slot, so the
// real `requiredFields` argument silently defaulted to `[]` and the union
// never happened. A field the schema declares required but the grant does
// not explicitly list was then wrongly rejected with `field_not_granted` on
// Postgres, while SQLite (which calls `buildEffectiveFilter(streamGrant, {},
// requiredFields)` correctly) allowed it.
//
// This test seeds a manifest where `id` is schema-required but the grant's
// `fields` allowlist omits it, then reads the `id` field window. Both
// backends must allow it (return the field window, not `field_not_granted`).
//
// Spec: openspec/changes/add-postgres-expand-hydration/specs/
//       reference-implementation-architecture/spec.md

import assert from 'node:assert/strict';
import test from 'node:test';

import { registerConnector } from '../server/auth.ts';
import { closeDb, initDb } from '../server/db.ts';
import {
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
} from '../server/postgres-storage.ts';
import { getRecordFieldWindow, ingestRecord } from '../server/records.ts';

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

const CONNECTOR_ID = 'field_window_required_field_demo';
const STREAM = 'emails';

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
        // `id` is schema-required. buildEffectiveFilter's contract is that
        // required fields are ALWAYS unioned into the effective projection,
        // regardless of what the grant's explicit `fields` list says.
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

// Deliberately omits the required 'id' field from the grant's explicit
// allowlist, to isolate the required-fields union behavior.
const GRANT = {
  streams: [{ name: STREAM, fields: ['body'] }],
};

const SEED = [
  { id: 'e1', created_at: '2026-01-01T00:00:00.000Z', body: 'hello world' },
];

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

async function runRequiredFieldConformance(label: string) {
  await seed();

  // The grant's explicit `fields` list is ['body'] only, but the manifest
  // schema declares `id` required — buildEffectiveFilter's required-fields
  // union must make `id` readable anyway.
  const window = await getRecordFieldWindow(CONNECTOR_ID, STREAM, 'e1', 'id', GRANT, MANIFEST, {});
  assert.equal(window.field_path, 'id', `${label}: field_path echoed`);
  assert.equal(window.window.text, 'e1', `${label}: required field 'id' is readable via the union`);

  // Explicitly-granted field still works too (sanity control).
  const bodyWindow = await getRecordFieldWindow(CONNECTOR_ID, STREAM, 'e1', 'body', GRANT, MANIFEST, {});
  assert.equal(bodyWindow.window.text, 'hello world', `${label}: explicitly-granted field still readable`);
}

test('SQLite: required-but-not-explicitly-granted field is readable in field window', async () => {
  initDb(':memory:');
  try {
    await runRequiredFieldConformance('sqlite');
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
  test('Postgres: required-but-not-explicitly-granted field is readable (skipped: PDPP_TEST_POSTGRES_URL unset)', { skip: true }, () => {});
} else {
  test('Postgres: required-but-not-explicitly-granted field is readable in field window (parity with SQLite)', async () => {
    initDb(':memory:');
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      await cleanupPostgres();
      await runRequiredFieldConformance('postgres');
    } finally {
      await cleanupPostgres();
      await closePostgresStorage();
      closeDb();
    }
  });
}
