// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Dual-backend conformance for the bounded field-window substrate.
//
// `getRecordFieldWindow` dispatches to the SQLite store or the real
// `postgresGetRecordFieldWindow` based on the active backend, so the SAME test
// body run under each backend is a true conformance check of the production
// code. This is the P0 substrate for the MCP content ladder: it MUST return a
// bounded character window of one record field, enforcing grant
// field/stream/resource/time/connection scope BEFORE returning field bytes, and
// it MUST NOT hydrate `record_json` to do so.
//
// Spec: openspec/changes/add-mcp-content-ladder/specs/mcp-adapter/spec.md
//       Requirement: "MCP bounded field reads SHALL be served by a
//       grant-enforced resource-server path"

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

const CONNECTOR_ID = 'field_window_demo';
const STREAM = 'emails';

// A body long enough to exceed a single default window and prove paging.
const LONG_BODY = 'The quick brown fox jumps over the lazy dog. '.repeat(300).trim();

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
          subject: { type: 'string' },
          body: { type: 'string' },
          read_count: { type: 'integer' },
          attachment: { type: 'object' },
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
    subject: 'Hello',
    body: LONG_BODY,
    read_count: 3,
    attachment: { kind: 'blob', blob_id: 'blob_sha256_abc', mime_type: 'application/pdf' },
  },
  {
    id: 'e2',
    created_at: '2026-06-01T00:00:00.000Z',
    subject: 'Later',
    body: 'short body',
    read_count: 0,
    attachment: null,
  },
  {
    id: 'e3',
    created_at: '2026-06-02T00:00:00.000Z',
    subject: 'Mixed case query',
    body: 'Alpha Hyperlane Bridge Omega',
    read_count: 0,
    attachment: null,
  },
];

// Grant that scopes a field projection: `attachment` is intentionally withheld
// so a read of it must fail closed as not-granted (not merely not-found).
const GRANT = {
  streams: [{ name: STREAM, fields: ['id', 'created_at', 'subject', 'body', 'read_count'] }],
};

async function seed(seed = SEED) {
  await registerConnector(MANIFEST);
  for (const data of seed) {
    await ingestRecord(CONNECTOR_ID, {
      stream: STREAM,
      key: data.id,
      data,
      emitted_at: data.created_at,
    });
  }
}

async function expectError(fn, code, label) {
  await assert.rejects(
    fn,
    (err) => {
      assert.equal(err.code, code, `${label}: expected code ${code}, got ${err.code} (${err.message})`);
      return true;
    },
    label,
  );
}

// The behavioral contract both backends must satisfy.
async function runSubstrateConformance(label) {
  await seed();

  // 1. Default window from offset 0 returns a bounded prefix, reports the full
  //    length, and signals more remains.
  const w0 = await getRecordFieldWindow(CONNECTOR_ID, STREAM, 'e1', 'body', GRANT, MANIFEST, {});
  assert.equal(w0.field_path, 'body', `${label}: field_path echoed`);
  assert.equal(w0.field_type, 'string', `${label}: body classified string`);
  assert.equal(w0.window.total_chars, LONG_BODY.length, `${label}: total_chars is full field length`);
  assert.equal(w0.window.start_chars, 0, `${label}: starts at 0`);
  assert.equal(w0.window.limit_chars, 4096, `${label}: default limit 4096`);
  assert.equal(w0.window.text, LONG_BODY.slice(0, 4096), `${label}: default window prefix matches`);
  assert.equal(w0.window.complete, false, `${label}: not complete when more remains`);
  assert.equal(w0.window.has_more, true, `${label}: has_more true`);
  assert.equal(w0.window.next_offset_chars, 4096, `${label}: next cursor at end of window`);
  assert.equal(w0.window.previous_offset_chars, null, `${label}: no previous before offset 0`);

  // 2. The next window continues exactly where the first ended (paging).
  const w1 = await getRecordFieldWindow(CONNECTOR_ID, STREAM, 'e1', 'body', GRANT, MANIFEST, {
    offset_chars: w0.window.next_offset_chars,
    limit_chars: 4096,
  });
  assert.equal(w1.window.start_chars, 4096, `${label}: second window starts at 4096`);
  assert.equal(w1.window.text, LONG_BODY.slice(4096, 8192), `${label}: second window slice matches`);
  assert.equal(w1.window.previous_offset_chars, 0, `${label}: previous points back to 0`);

  // 3. A small explicit window returns exactly that slice.
  const w2 = await getRecordFieldWindow(CONNECTOR_ID, STREAM, 'e1', 'body', GRANT, MANIFEST, {
    offset_chars: 4,
    limit_chars: 9,
  });
  assert.equal(w2.window.text, LONG_BODY.slice(4, 13), `${label}: explicit window slice matches`);
  assert.equal(w2.window.text.length, 9, `${label}: explicit window length honored`);

  // 4. A q selector returns bounded context around the first match without
  // changing grant enforcement.
  const matchNeedle = 'lazy dog';
  const matchStart = LONG_BODY.indexOf(matchNeedle);
  const wQuery = await getRecordFieldWindow(CONNECTOR_ID, STREAM, 'e1', 'body', GRANT, MANIFEST, {
    q: matchNeedle,
    before_chars: 5,
    after_chars: 7,
  });
  assert.equal(wQuery.window.start_chars, matchStart - 5, `${label}: q context starts before match`);
  assert.equal(wQuery.window.match_start_chars, matchStart, `${label}: q match start reported`);
  assert.equal(wQuery.window.match_end_chars, matchStart + matchNeedle.length, `${label}: q match end reported`);
  assert.equal(
    wQuery.window.text,
    LONG_BODY.slice(matchStart - 5, matchStart + matchNeedle.length + 7),
    `${label}: q context slice matches`
  );

  const wCaseQuery = await getRecordFieldWindow(CONNECTOR_ID, STREAM, 'e3', 'body', GRANT, MANIFEST, {
    q: 'hyperlane',
    before_chars: 6,
    after_chars: 7,
  });
  assert.equal(wCaseQuery.window.text, 'Alpha Hyperlane Bridge', `${label}: q matching is case-insensitive`);
  assert.equal(wCaseQuery.window.match_start_chars, 6, `${label}: q match start preserves original-case field offsets`);

  // 5. A short field returns complete in one window.
  const wShort = await getRecordFieldWindow(CONNECTOR_ID, STREAM, 'e2', 'body', GRANT, MANIFEST, {});
  assert.equal(wShort.window.text, 'short body', `${label}: short field full text`);
  assert.equal(wShort.window.complete, true, `${label}: short field complete`);
  assert.equal(wShort.window.has_more, false, `${label}: short field no more`);
  assert.equal(wShort.window.next_offset_chars, null, `${label}: short field no next cursor`);

  // 5. limit_chars above the ceiling is clamped and warned, not rejected.
  const wClamp = await getRecordFieldWindow(CONNECTOR_ID, STREAM, 'e1', 'body', GRANT, MANIFEST, {
    limit_chars: 999999,
  });
  assert.equal(wClamp.window.limit_chars, 16384, `${label}: limit clamped to max 16384`);
  assert.ok(
    wClamp.warnings.some((wn) => wn.code === 'limit_clamped'),
    `${label}: clamp warning emitted`,
  );

  // --- Negative controls ---

  // 6. Ungranted field: withheld by the grant projection -> field_not_granted.
  await expectError(
    () => getRecordFieldWindow(CONNECTOR_ID, STREAM, 'e1', 'attachment', GRANT, MANIFEST, {}),
    'field_not_granted',
    `${label}: ungranted field`,
  );

  // 7. Unknown field: granted-by-null-projection but absent on the record.
  //    Use an all-fields grant so visibility passes and we reach the storage
  //    layer, which reports the field absent.
  const allFieldsGrant = { streams: [{ name: STREAM }] };
  await expectError(
    () => getRecordFieldWindow(CONNECTOR_ID, STREAM, 'e1', 'nonexistent_field', allFieldsGrant, MANIFEST, {}),
    'field_not_found',
    `${label}: unknown field`,
  );

  // 8. Non-string field: read_count is an integer -> field_not_text.
  await expectError(
    () => getRecordFieldWindow(CONNECTOR_ID, STREAM, 'e1', 'read_count', GRANT, MANIFEST, {}),
    'field_not_text',
    `${label}: non-string field`,
  );

  // 9. Object/binary field via an all-fields grant -> field_not_text
  //    (binary/blob references are metadata-only, never windowed text).
  await expectError(
    () => getRecordFieldWindow(CONNECTOR_ID, STREAM, 'e1', 'attachment', allFieldsGrant, MANIFEST, {}),
    'field_not_text',
    `${label}: object field`,
  );

  // 10. Stream not in grant -> grant_stream_not_allowed.
  const otherStreamGrant = { streams: [{ name: 'not_emails', fields: ['body'] }] };
  await expectError(
    () => getRecordFieldWindow(CONNECTOR_ID, STREAM, 'e1', 'body', otherStreamGrant, MANIFEST, {}),
    'grant_stream_not_allowed',
    `${label}: ungranted stream`,
  );

  // 11. Out-of-grant by time range -> not_found (the record's consent time is
  //     before the grant window, so the grant cannot see it at all).
  const futureGrant = {
    streams: [{ name: STREAM, fields: ['body'], time_range: { since: '2026-03-01T00:00:00.000Z' } }],
  };
  await expectError(
    () => getRecordFieldWindow(CONNECTOR_ID, STREAM, 'e1', 'body', futureGrant, MANIFEST, {}),
    'not_found',
    `${label}: record outside grant time range`,
  );
  // ...but e2 (June) IS inside that window and reads fine.
  const wInRange = await getRecordFieldWindow(CONNECTOR_ID, STREAM, 'e2', 'body', futureGrant, MANIFEST, {});
  assert.equal(wInRange.window.text, 'short body', `${label}: in-range record reads under time grant`);

  // 12. Out-of-grant by resource list -> not_found.
  const resourceGrant = { streams: [{ name: STREAM, fields: ['body'], resources: ['e2'] }] };
  await expectError(
    () => getRecordFieldWindow(CONNECTOR_ID, STREAM, 'e1', 'body', resourceGrant, MANIFEST, {}),
    'not_found',
    `${label}: record outside grant resource list`,
  );

  // 13. Missing record -> not_found.
  await expectError(
    () => getRecordFieldWindow(CONNECTOR_ID, STREAM, 'no_such_record', 'body', GRANT, MANIFEST, {}),
    'not_found',
    `${label}: missing record`,
  );

  // 14. Malformed window bounds are rejected before any read.
  await expectError(
    () => getRecordFieldWindow(CONNECTOR_ID, STREAM, 'e1', 'body', GRANT, MANIFEST, { offset_chars: -1 }),
    'invalid_window',
    `${label}: negative offset`,
  );
  await expectError(
    () => getRecordFieldWindow(CONNECTOR_ID, STREAM, 'e1', 'body', GRANT, MANIFEST, { limit_chars: 0 }),
    'invalid_window',
    `${label}: zero limit`,
  );

  // 15. Empty/invalid field path rejected.
  await expectError(
    () => getRecordFieldWindow(CONNECTOR_ID, STREAM, 'e1', '', GRANT, MANIFEST, {}),
    'invalid_field_path',
    `${label}: empty field path`,
  );
}

test('SQLite: field-window substrate conformance', async () => {
  initDb(':memory:');
  try {
    await runSubstrateConformance('sqlite');
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
  test('Postgres: field-window substrate conformance (skipped: PDPP_TEST_POSTGRES_URL unset)', { skip: true }, () => {});
} else {
  test('Postgres: field-window substrate conformance (parity with SQLite)', async () => {
    initDb(':memory:');
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      await cleanupPostgres();
      await runSubstrateConformance('postgres');
    } finally {
      await cleanupPostgres();
      await closePostgresStorage();
      closeDb();
    }
  });
}
