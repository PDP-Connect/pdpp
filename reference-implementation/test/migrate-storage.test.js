import assert from 'node:assert/strict';
import test from 'node:test';
import { createWriteStream } from 'node:fs';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { TABLES, DERIVED_TABLES, SHADOW_TABLE_PATTERNS, isShadowTable, getMigratableColumns } from '../scripts/migrate-storage/schema.mjs';
import {
  coerceJsonb,
  coerceBoolean,
  coerceBytea,
  coerceTimestamp,
  coerceBigint,
  coerceInteger,
  buildRowTransformer,
  getJsonbScrubStats,
  resetJsonbScrubStats,
  setJsonbNulPolicy,
  getJsonbNulPolicy,
  setExtractionSink,
  setCurrentRowContext,
  getMigrationStats,
} from '../scripts/migrate-storage/transformers.mjs';
import {
  openSqliteSource,
  checkSqliteNotLocked,
  countRows,
  tryQueryRowCount,
  streamRows,
  listSourceTables,
  describeSourceColumns,
} from '../scripts/migrate-storage/sqlite-source.mjs';
import {
  derivePrimaryKeyText,
  deriveCursorValue,
} from '../scripts/migrate-storage/record-synthesis.mjs';

// Helper to create temp SQLite file path
function getTempSqlitePath() {
  return join(tmpdir(), `test-migrate-${randomUUID()}.db`);
}

// Helper to create and populate a minimal SQLite database
function createTempDb(schema, rows = []) {
  const filepath = getTempSqlitePath();
  const db = new Database(filepath);

  // Enable foreign keys
  db.pragma('foreign_keys = ON');

  // Create schema
  db.exec(schema);

  // Insert rows
  for (const row of rows) {
    const { table, data } = row;
    const cols = Object.keys(data);
    const placeholders = cols.map(() => '?').join(',');
    const vals = cols.map((c) => data[c]);
    db.prepare(
      `INSERT INTO \`${table}\` (${cols.join(',')}) VALUES (${placeholders})`
    ).run(...vals);
  }

  db.close();
  return filepath;
}

// Helper to clean up temp files
function cleanup(filepath) {
  try {
    unlinkSync(filepath);
  } catch {
    // Ignore if file doesn't exist
  }
  // Also clean up WAL/SHM files if they exist
  try {
    unlinkSync(`${filepath}-wal`);
  } catch {}
  try {
    unlinkSync(`${filepath}-shm`);
  } catch {}
}

// ============================================================================
// SCHEMA TESTS
// ============================================================================

test('schema: TABLES is an array of 32 entries', () => {
  assert.ok(Array.isArray(TABLES));
  assert.equal(TABLES.length, 32);
});

test('schema: 7 derived tables marked skipMigration=true with reason', () => {
  const skipMigration = TABLES.filter((t) => t.skipMigration);
  assert.equal(skipMigration.length, 7);

  for (const table of skipMigration) {
    assert.equal(table.skipMigration, true);
    assert.ok(
      typeof table.reason === 'string' && table.reason.length > 0,
      `Table ${table.name} missing reason`
    );
  }
});

test('schema: every non-skip table has at least one column', () => {
  const migratable = TABLES.filter((t) => !t.skipMigration);
  for (const table of migratable) {
    assert.ok(
      Array.isArray(table.columns) && table.columns.length > 0,
      `Table ${table.name} has no columns`
    );
  }
});

test('schema: 25 non-skip tables in stable dependency order', () => {
  const migratable = TABLES.filter((t) => !t.skipMigration);
  assert.equal(migratable.length, 25);

  // Verify connectors is first
  assert.equal(migratable[0].name, 'connectors');
  assert.equal(migratable[1].name, 'connector_instances');

  // Verify spine_events is among the last
  const spineIdx = migratable.findIndex((t) => t.name === 'spine_events');
  assert.ok(spineIdx > 15, 'spine_events should be near the end');
});

test('schema: DERIVED_TABLES contains exactly 7 lexical_search_*/semantic_search_* names', () => {
  assert.equal(DERIVED_TABLES.size, 7);

  const expected = [
    'lexical_search_index',
    'lexical_search_snapshots',
    'lexical_search_meta',
    'semantic_search_blob',
    'semantic_search_snapshots',
    'semantic_search_meta',
    'semantic_search_backfill_progress',
  ];

  for (const name of expected) {
    assert.ok(
      DERIVED_TABLES.has(name),
      `Missing derived table: ${name}`
    );
  }
});

// ============================================================================
// TRANSFORMER TESTS (Per-Coercer Behavior)
// ============================================================================

test('transformers: coerceJsonb parses JSON string to object', () => {
  const result = coerceJsonb('{"x":1}', { name: 'test' });
  assert.deepEqual(result, { x: 1 });
});

test('transformers: coerceJsonb passes through plain object', () => {
  const obj = { x: 1 };
  const result = coerceJsonb(obj, { name: 'test' });
  assert.equal(result, obj);
});

test('transformers: coerceJsonb returns null for null, "", undefined', () => {
  assert.equal(coerceJsonb(null, { name: 'test' }), null);
  assert.equal(coerceJsonb('', { name: 'test' }), null);
  assert.equal(coerceJsonb(undefined, { name: 'test' }), null);
});

test('transformers: coerceJsonb throws on invalid JSON string', () => {
  assert.throws(
    () => coerceJsonb('{invalid}', { name: 'manifest' }),
    /coerceJsonb.*invalid JSON.*manifest/
  );
});

// ============================================================================
// JSONB POLICY TESTS (strict / migrate-to-blobs)
// See docs/binary-content-invariant-design-brief.md §4.7.
// ============================================================================

test('transformers: jsonb-nul-policy "strict" (default) throws with table/column/offset/pointer', () => {
  resetJsonbScrubStats();
  assert.equal(getJsonbNulPolicy(), 'strict');

  assert.throws(
    () => coerceJsonb('{"output":"hello\\u0000bytes"}', { name: 'record_json', tableName: 'records' }),
    (err) => {
      assert.match(err.message, /record_json/);
      assert.match(err.message, /records/);
      assert.match(err.message, /U\+0000/);
      assert.match(err.message, /offset/);
      assert.match(err.message, /json_path/);
      assert.match(err.message, /\/output/);
      assert.match(err.message, /migrate-to-blobs/);
      return true;
    }
  );

  const stats = getJsonbScrubStats();
  assert.equal(stats.strictFailures, 1);
});

test('transformers: setJsonbNulPolicy rejects unknown policy values', () => {
  resetJsonbScrubStats();
  assert.throws(() => setJsonbNulPolicy('drop'), /unknown policy/);
  assert.throws(() => setJsonbNulPolicy('scrub'), /unknown policy/);
  assert.throws(() => setJsonbNulPolicy('preserve-base64'), /unknown policy/);
});

test('transformers: jsonb-nul-policy "migrate-to-blobs" replaces binary leaves with null and emits extractions', () => {
  resetJsonbScrubStats();
  setJsonbNulPolicy('migrate-to-blobs');
  setCurrentRowContext({ connectorId: 'codex', stream: 'function_calls', recordKey: 'call_test1' });

  const captured = [];
  setExtractionSink((e) => captured.push(e));

  const result = coerceJsonb(
    '{"output":"hello\\u0000bytes","clean":"ok"}',
    { name: 'record_json', tableName: 'records' }
  );

  assert.equal(result.output, null);
  assert.equal(result.clean, 'ok');

  assert.equal(captured.length, 1);
  const e = captured[0];
  assert.equal(e.connector_id, 'codex');
  assert.equal(e.stream, 'function_calls');
  assert.equal(e.record_key, 'call_test1');
  assert.equal(e.json_path, '/output');
  assert.equal(typeof e.sha256, 'string');
  assert.equal(e.sha256.length, 64);
  assert.equal(e.blob_id, `blob_sha256_${e.sha256}`);
  assert.equal(typeof e.size_bytes, 'number');
  assert.match(e.reason, /^U\+0000 at offset \d+$/);
  assert.ok(Buffer.isBuffer(e.bytes));
  // Roundtrip: the bytes recover the exact original UTF-8 (including NUL).
  assert.equal(e.bytes.toString('utf8'), 'hello\u0000bytes');

  const stats = getMigrationStats();
  assert.equal(stats.extractedLeaves, 1);
  assert.equal(stats.extractedRows, 1);
  assert.equal(stats.uniqueBlobCount, 1);
});

test('transformers: "migrate-to-blobs" uses RFC 6901 JSON Pointers for nested paths', () => {
  resetJsonbScrubStats();
  setJsonbNulPolicy('migrate-to-blobs');
  setCurrentRowContext({ connectorId: 'c', stream: 's', recordKey: 'r' });

  const captured = [];
  setExtractionSink((e) => captured.push(e));

  const obj = {
    messages: [
      { content: 'clean' },
      { content: 'bad\u0000bytes' },
    ],
    nested: { tilde: { 'with/slash': 'also\u0000bad' } },
  };
  const result = coerceJsonb(obj, { name: 'record_json' });

  assert.equal(result.messages[0].content, 'clean');
  assert.equal(result.messages[1].content, null);
  assert.equal(result.nested.tilde['with/slash'], null);

  const paths = captured.map((e) => e.json_path).sort();
  assert.deepEqual(paths, ['/messages/1/content', '/nested/tilde/with~1slash']);
});

test('transformers: "migrate-to-blobs" only extracts U+0000 (other C0/C1 controls pass through)', () => {
  // Postgres JSONB only rejects U+0000. Other control codepoints
  // (U+0001, U+001B ANSI escape, U+0080 Latin-1, etc.) survive a
  // migration to Postgres unchanged. This narrowing was added after a
  // dry-run on real production data showed the broader set would treat
  // mojibake-corrupted-but-legible Gmail snippets as "binary" and
  // discard the surrounding text. The full forbidden set (incl. C0/C1)
  // remains enforced for NEW writes via pdppSafeText/safeTextPreview.
  resetJsonbScrubStats();
  setJsonbNulPolicy('migrate-to-blobs');
  setCurrentRowContext({ connectorId: 'c', stream: 's', recordKey: 'r' });

  const captured = [];
  setExtractionSink((e) => captured.push(e));

  // \x01 / \x1b / \x80 should pass through unchanged in migration mode.
  const result = coerceJsonb(
    '{"a":"x\\u0001y","b":"z\\u001bw","c":"v\\u0080u"}',
    { name: 'record_json' },
  );

  assert.equal(captured.length, 0);
  assert.equal(result.a.length, 3);
  assert.equal(result.b.length, 3);
  assert.equal(result.c.length, 3);

  // U+0000 still triggers extraction.
  const result2 = coerceJsonb('{"x":"a\\u0000b"}', { name: 'record_json' });
  assert.equal(result2.x, null);
  assert.equal(captured.length, 1);
  assert.match(captured[0].reason, /^U\+0000 at offset \d+$/);
});

test('transformers: "migrate-to-blobs" dedupes identical bytes to a single sha256', () => {
  resetJsonbScrubStats();
  setJsonbNulPolicy('migrate-to-blobs');
  setCurrentRowContext({ connectorId: 'c', stream: 's', recordKey: 'r' });

  const captured = [];
  setExtractionSink((e) => captured.push(e));

  const obj = {
    a: 'same\u0000bytes',
    b: 'same\u0000bytes',
    c: 'different\u0000value',
  };
  coerceJsonb(obj, { name: 'record_json' });

  assert.equal(captured.length, 3);
  const sha256s = new Set(captured.map((e) => e.sha256));
  // Identical UTF-8 bytes produce identical sha256s; the sink saw 3
  // extractions but there are only 2 unique blobs.
  assert.equal(sha256s.size, 2);

  const stats = getMigrationStats();
  assert.equal(stats.extractedLeaves, 3);
  assert.equal(stats.uniqueBlobCount, 2);
});

test('transformers: "migrate-to-blobs" leaves clean records untouched (fast path)', () => {
  resetJsonbScrubStats();
  setJsonbNulPolicy('migrate-to-blobs');
  setCurrentRowContext({ connectorId: 'c', stream: 's', recordKey: 'r' });

  const captured = [];
  setExtractionSink((e) => captured.push(e));

  const result = coerceJsonb('{"text":"clean","n":1,"arr":["a","b"]}', { name: 'record_json' });
  assert.equal(result.text, 'clean');
  assert.equal(result.n, 1);
  assert.deepEqual(result.arr, ['a', 'b']);

  assert.equal(captured.length, 0);
  const stats = getMigrationStats();
  assert.equal(stats.extractedLeaves, 0);
  assert.equal(stats.extractedRows, 0);
});

test('transformers: coerceBoolean coerces 0→false, 1→true', () => {
  assert.equal(coerceBoolean(0, { name: 'test' }), false);
  assert.equal(coerceBoolean(1, { name: 'test' }), true);
});

test('transformers: coerceBoolean coerces "0"→false, "1"→true', () => {
  assert.equal(coerceBoolean('0', { name: 'test' }), false);
  assert.equal(coerceBoolean('1', { name: 'test' }), true);
});

test('transformers: coerceBoolean passes through true/false', () => {
  assert.equal(coerceBoolean(true, { name: 'test' }), true);
  assert.equal(coerceBoolean(false, { name: 'test' }), false);
});

test('transformers: coerceBoolean returns null for null/undefined', () => {
  assert.equal(coerceBoolean(null, { name: 'test' }), null);
  assert.equal(coerceBoolean(undefined, { name: 'test' }), null);
});

test('transformers: coerceBoolean throws on "yes"', () => {
  assert.throws(
    () => coerceBoolean('yes', { name: 'enabled' }),
    /coerceBoolean.*expected 0, 1, true, false/
  );
});

test('transformers: coerceBytea passes through Buffer', () => {
  const buf = Buffer.from('hello');
  const result = coerceBytea(buf, { name: 'test' });
  assert.equal(result, buf);
});

test('transformers: coerceBytea converts base64 string to Buffer', () => {
  const b64 = Buffer.from('hello').toString('base64');
  const result = coerceBytea(b64, { name: 'test' });
  assert.deepEqual(result, Buffer.from('hello'));
});

test('transformers: coerceBytea returns null for null/undefined', () => {
  assert.equal(coerceBytea(null, { name: 'test' }), null);
  assert.equal(coerceBytea(undefined, { name: 'test' }), null);
});

test('transformers: coerceBytea throws on non-string non-Buffer', () => {
  assert.throws(
    () => coerceBytea(123, { name: 'data' }),
    /coerceBytea.*expected Buffer or base64 string/
  );
});

test('transformers: coerceTimestamp ISO string round-trip', () => {
  const iso = '2026-05-08T12:34:56.789Z';
  const result = coerceTimestamp(iso, { name: 'test' });
  assert.equal(result, iso);
});

test('transformers: coerceTimestamp converts ms epoch to ISO', () => {
  const ms = 1715164496789; // Some epoch value
  const result = coerceTimestamp(ms, { name: 'test' });
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result));
});

test('transformers: coerceTimestamp converts Date to ISO', () => {
  const date = new Date('2026-05-08T12:34:56.789Z');
  const result = coerceTimestamp(date, { name: 'test' });
  assert.equal(result, '2026-05-08T12:34:56.789Z');
});

test('transformers: coerceTimestamp returns null for null/undefined', () => {
  assert.equal(coerceTimestamp(null, { name: 'test' }), null);
  assert.equal(coerceTimestamp(undefined, { name: 'test' }), null);
});

test('transformers: coerceBigint accepts BigInt, number, numeric string', () => {
  // BigInt
  const result1 = coerceBigint(BigInt('12345'), { name: 'test' });
  assert.ok(typeof result1 === 'number' || typeof result1 === 'bigint');

  // Number
  const result2 = coerceBigint(12345, { name: 'test' });
  assert.equal(result2, 12345);

  // String
  const result3 = coerceBigint('12345', { name: 'test' });
  assert.equal(result3, 12345);
});

test('transformers: coerceBigint returns null for null/undefined', () => {
  assert.equal(coerceBigint(null, { name: 'test' }), null);
  assert.equal(coerceBigint(undefined, { name: 'test' }), null);
});

test('transformers: coerceBigint throws on non-finite number', () => {
  assert.throws(
    () => coerceBigint(Infinity, { name: 'id' }),
    /coerceBigint.*not finite/
  );
});

test('transformers: coerceInteger accepts number, numeric string', () => {
  // Number
  const result1 = coerceInteger(42, { name: 'test' });
  assert.equal(result1, 42);

  // String
  const result2 = coerceInteger('42', { name: 'test' });
  assert.equal(result2, 42);
});

test('transformers: coerceInteger returns null for null/undefined', () => {
  assert.equal(coerceInteger(null, { name: 'test' }), null);
  assert.equal(coerceInteger(undefined, { name: 'test' }), null);
});

test('transformers: coerceInteger throws on non-finite or non-integer', () => {
  assert.throws(
    () => coerceInteger(3.14, { name: 'count' }),
    /coerceInteger.*not an integer/
  );

  assert.throws(
    () => coerceInteger(NaN, { name: 'count' }),
    /coerceInteger.*not finite/
  );
});

// ============================================================================
// buildRowTransformer TESTS
// ============================================================================

test('transformers: buildRowTransformer with mixed types', () => {
  const tableMeta = {
    name: 'test_table',
    columns: [
      { name: 'id', pgType: 'BIGINT', bigint: true },
      { name: 'data', pgType: 'JSONB', jsonb: true },
      { name: 'enabled', pgType: 'BOOLEAN', boolean: true },
      { name: 'created_at', pgType: 'TIMESTAMP', timestamp: true },
      { name: 'content', pgType: 'TEXT' },
    ],
  };

  const transformer = buildRowTransformer(tableMeta);
  assert.ok(typeof transformer === 'function');

  const row = {
    id: 123,
    data: '{"name":"test"}',
    enabled: 1,
    created_at: '2026-05-08T12:34:56Z',
    content: 'hello',
  };

  const result = transformer(row);
  assert.deepEqual(result, [
    123,
    { name: 'test' },
    true,
    '2026-05-08T12:34:56Z',
    'hello',
  ]);
});

test('transformers: buildRowTransformer bad input produces column-named error', () => {
  const tableMeta = {
    name: 'test_table',
    columns: [
      { name: 'manifest', pgType: 'JSONB', jsonb: true },
    ],
  };

  const transformer = buildRowTransformer(tableMeta);

  assert.throws(
    () => transformer({ manifest: '{bad json}' }),
    /manifest/
  );
});

test('transformers: buildRowTransformer rejects invalid tableMeta', () => {
  assert.throws(
    () => buildRowTransformer({}),
    /buildRowTransformer.*columns array/
  );

  assert.throws(
    () => buildRowTransformer({ columns: 'not-an-array' }),
    /buildRowTransformer.*columns array/
  );
});

// ============================================================================
// SQLITE-SOURCE TESTS (Real on-disk SQLite)
// ============================================================================

test('sqlite-source: openSqliteSource returns handle and methods', async () => {
  const filepath = createTempDb(
    'CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)'
  );

  try {
    const source = await openSqliteSource(filepath);
    assert.ok(source.handle);
    assert.ok(typeof source.close === 'function');
    assert.equal(source.filepath, filepath);
    assert.ok(typeof source.vecLoaded === 'boolean');
    source.close();
  } finally {
    cleanup(filepath);
  }
});

test('sqlite-source: listSourceTables returns Set of table names', async () => {
  const filepath = createTempDb(
    'CREATE TABLE connectors (id INTEGER PRIMARY KEY); CREATE TABLE grants (id INTEGER PRIMARY KEY)'
  );

  try {
    const source = await openSqliteSource(filepath);
    const tables = listSourceTables(source.handle);
    assert.ok(tables instanceof Set);
    assert.equal(tables.size, 2);
    assert.ok(tables.has('connectors'));
    assert.ok(tables.has('grants'));
    source.close();
  } finally {
    cleanup(filepath);
  }
});

test('sqlite-source: countRows counts correctly', async () => {
  const filepath = createTempDb(
    'CREATE TABLE connectors (id INTEGER PRIMARY KEY, name TEXT)',
    [
      { table: 'connectors', data: { id: 1, name: 'foo' } },
      { table: 'connectors', data: { id: 2, name: 'bar' } },
      { table: 'connectors', data: { id: 3, name: 'baz' } },
    ]
  );

  try {
    const source = await openSqliteSource(filepath);
    const count = countRows(source.handle, 'connectors');
    assert.equal(count, 3);
    source.close();
  } finally {
    cleanup(filepath);
  }
});

test('sqlite-source: streamRows yields all rows in batches', async () => {
  const filepath = createTempDb(
    'CREATE TABLE connectors (id INTEGER PRIMARY KEY, name TEXT)',
    [
      { table: 'connectors', data: { id: 1, name: 'foo' } },
      { table: 'connectors', data: { id: 2, name: 'bar' } },
      { table: 'connectors', data: { id: 3, name: 'baz' } },
    ]
  );

  try {
    const source = await openSqliteSource(filepath);
    const batches = Array.from(streamRows(source.handle, 'connectors', 2));

    // Should have 2 batches: [1,2] and [3]
    assert.equal(batches.length, 2);
    assert.equal(batches[0].length, 2);
    assert.equal(batches[1].length, 1);

    // Verify row values
    assert.equal(batches[0][0].name, 'foo');
    assert.equal(batches[0][1].name, 'bar');
    assert.equal(batches[1][0].name, 'baz');

    source.close();
  } finally {
    cleanup(filepath);
  }
});

test('sqlite-source: describeSourceColumns returns column info', async () => {
  const filepath = createTempDb(
    'CREATE TABLE connectors (connector_id TEXT PRIMARY KEY, manifest TEXT, created_at TEXT)'
  );

  try {
    const source = await openSqliteSource(filepath);
    const cols = describeSourceColumns(source.handle, 'connectors');

    assert.ok(Array.isArray(cols));
    assert.equal(cols.length, 3);

    const names = cols.map((c) => c.name);
    assert.deepEqual(names, ['connector_id', 'manifest', 'created_at']);

    source.close();
  } finally {
    cleanup(filepath);
  }
});

test('sqlite-source: close() does not throw', async () => {
  const filepath = createTempDb('CREATE TABLE test (id INTEGER PRIMARY KEY)');

  try {
    const source = await openSqliteSource(filepath);
    assert.doesNotThrow(() => source.close());
  } finally {
    cleanup(filepath);
  }
});

test('sqlite-source: checkSqliteNotLocked on clean file returns locked:false', async () => {
  const filepath = createTempDb('CREATE TABLE test (id INTEGER PRIMARY KEY)');

  try {
    const result = checkSqliteNotLocked(filepath);
    assert.deepEqual(result, { locked: false });
  } finally {
    cleanup(filepath);
  }
});

test('sqlite-source: tryQueryRowCount returns ok:true with count for existing table', async () => {
  const filepath = createTempDb(
    'CREATE TABLE test_table (id INTEGER PRIMARY KEY, name TEXT)',
    [
      { table: 'test_table', data: { id: 1, name: 'foo' } },
      { table: 'test_table', data: { id: 2, name: 'bar' } },
    ]
  );

  try {
    const source = await openSqliteSource(filepath);
    const result = tryQueryRowCount(source.handle, 'test_table');
    assert.deepEqual(result, { ok: true, count: 2 });
    source.close();
  } finally {
    cleanup(filepath);
  }
});

test('sqlite-source: tryQueryRowCount returns ok:false with reason for non-existent table', async () => {
  const filepath = createTempDb(
    'CREATE TABLE test_table (id INTEGER PRIMARY KEY)'
  );

  try {
    const source = await openSqliteSource(filepath);
    const result = tryQueryRowCount(source.handle, 'nonexistent_table');
    assert.equal(result.ok, false);
    assert.ok(typeof result.reason === 'string');
    assert.ok(result.reason.length > 0);
    source.close();
  } finally {
    cleanup(filepath);
  }
});

// ============================================================================
// END-TO-END: Transformer over Real SQLite Row
// ============================================================================

test('e2e: transformer applies to real SQLite row with JSONB coercion', async () => {
  const filepath = createTempDb(
    'CREATE TABLE connectors (connector_id TEXT PRIMARY KEY, manifest TEXT, created_at TEXT)',
    [
      {
        table: 'connectors',
        data: {
          connector_id: 'conn1',
          manifest: '{"name":"myconnector"}',
          created_at: '2026-05-08T12:00:00Z',
        },
      },
    ]
  );

  try {
    const source = await openSqliteSource(filepath);

    // Find the connectors table schema from TABLES
    const connectorsSchema = TABLES.find((t) => t.name === 'connectors');
    assert.ok(connectorsSchema);

    const transformer = buildRowTransformer(connectorsSchema);

    // Stream rows and transform
    const batches = Array.from(streamRows(source.handle, 'connectors'));
    assert.equal(batches.length, 1);
    assert.equal(batches[0].length, 1);

    const row = batches[0][0];
    const transformed = transformer(row);

    // The transformed row should have manifest as an object
    // Locate manifest column in connectorsSchema
    const manifestIdx = connectorsSchema.columns.findIndex(
      (c) => c.name === 'manifest'
    );
    assert.ok(manifestIdx >= 0);

    assert.deepEqual(transformed[manifestIdx], { name: 'myconnector' });

    source.close();
  } finally {
    cleanup(filepath);
  }
});

// ============================================================================
// SCHEMA: Shadow Tables Tests
// ============================================================================

test('schema: isShadowTable matches lexical_search_index shadow tables', () => {
  assert.ok(isShadowTable('lexical_search_index_config'));
  assert.ok(isShadowTable('lexical_search_index_data'));
  assert.ok(isShadowTable('lexical_search_index_docsize'));
  assert.ok(isShadowTable('lexical_search_index_idx'));
  assert.ok(isShadowTable('lexical_search_index_content'));
});

test('schema: isShadowTable matches ref_record_search and shadow tables', () => {
  assert.ok(isShadowTable('ref_record_search'));
  assert.ok(isShadowTable('ref_record_search_config'));
  assert.ok(isShadowTable('ref_record_search_data'));
  assert.ok(isShadowTable('ref_record_search_docsize'));
  assert.ok(isShadowTable('ref_record_search_idx'));
  assert.ok(isShadowTable('ref_record_search_content'));
});

test('schema: isShadowTable matches semantic_search_rowid', () => {
  assert.ok(isShadowTable('semantic_search_rowid'));
});

test('schema: isShadowTable rejects canonical table names', () => {
  assert.equal(isShadowTable('connectors'), false);
  assert.equal(isShadowTable('lexical_search_index'), false);
  assert.equal(isShadowTable('semantic_search_blob'), false);
  assert.equal(isShadowTable('blobs'), false);
  assert.equal(isShadowTable('records'), false);
});

// ============================================================================
// SCHEMA DRIFT TOLERANCE TESTS
// ============================================================================

test('schema: parseColumnDef filters out constraint lines with parens', () => {
  // Test that constraint keywords with parens are properly filtered
  const recordsSchema = TABLES.find((t) => t.name === 'records');
  assert.ok(recordsSchema);

  // Verify no column named "UNIQUE", "PRIMARY", "FOREIGN", etc.
  const colNames = recordsSchema.columns.map((c) => c.name);
  assert.equal(colNames.includes('UNIQUE'), false);
  assert.equal(colNames.includes('PRIMARY'), false);
  assert.equal(colNames.includes('FOREIGN'), false);
  assert.equal(colNames.includes('CONSTRAINT'), false);
  assert.equal(colNames.includes('CHECK'), false);
  assert.equal(colNames.includes('INDEX'), false);

  // Verify actual columns are still present
  assert.ok(colNames.includes('id'));
  assert.ok(colNames.includes('connector_id'));
  assert.ok(colNames.includes('record_json'));
});

// ============================================================================
// buildRowTransformer with sourceColumnNames Tests
// ============================================================================

test('transformers: buildRowTransformer with sourceColumnNames substitutes null for missing columns', () => {
  const tableMeta = {
    name: 'test_table',
    columns: [
      { name: 'id', pgType: 'BIGINT', nullable: true },
      { name: 'existing_col', pgType: 'TEXT', nullable: true },
      { name: 'missing_col', pgType: 'TEXT', nullable: true },
    ],
  };

  // Source only has id and existing_col, not missing_col
  const sourceColumnNames = new Set(['id', 'existing_col']);

  const transformer = buildRowTransformer(tableMeta, sourceColumnNames);
  assert.ok(typeof transformer === 'function');

  const row = {
    id: 123,
    existing_col: 'hello',
    // missing_col is deliberately not in the row
  };

  const result = transformer(row);
  assert.deepEqual(result, [
    123,
    'hello',
    null, // missing_col should be substituted as null
  ]);
});

test('transformers: buildRowTransformer with sourceColumnNames drops extra source columns', () => {
  const tableMeta = {
    name: 'test_table',
    columns: [
      { name: 'id', pgType: 'BIGINT' },
      { name: 'name', pgType: 'TEXT' },
    ],
  };

  // Source has extra column not in Postgres schema
  const sourceColumnNames = new Set(['id', 'name', 'extra_col']);

  const transformer = buildRowTransformer(tableMeta, sourceColumnNames);

  const row = {
    id: 123,
    name: 'test',
    extra_col: 'will-be-ignored',
  };

  const result = transformer(row);
  // Tuple should only have 2 values (one per Postgres column)
  assert.equal(result.length, 2);
  assert.deepEqual(result, [123, 'test']);
});

test('transformers: buildRowTransformer without sourceColumnNames is backward compatible', () => {
  const tableMeta = {
    name: 'test_table',
    columns: [
      { name: 'id', pgType: 'BIGINT' },
      { name: 'value', pgType: 'TEXT' },
    ],
  };

  // Call without sourceColumnNames argument
  const transformer = buildRowTransformer(tableMeta);
  assert.ok(typeof transformer === 'function');

  const row = {
    id: 42,
    value: 'data',
  };

  const result = transformer(row);
  assert.deepEqual(result, [42, 'data']);
});

// ============================================================================
// getMigratableColumns Tests
// ============================================================================

test('schema: getMigratableColumns exported and returns correct structure', () => {
  const tableMeta = {
    name: 'test_table',
    columns: [
      { name: 'id', pgType: 'BIGINT', nullable: true },
      { name: 'existing', pgType: 'TEXT', nullable: true },
      { name: 'missing', pgType: 'TEXT', nullable: true },
    ],
  };

  const sourceColumnNames = new Set(['id', 'existing']);

  const plan = getMigratableColumns(tableMeta, sourceColumnNames);

  assert.ok(Array.isArray(plan));
  assert.equal(plan.length, 3);

  // Check structure
  assert.deepEqual(plan[0], { name: 'id', mode: 'copy' });
  assert.deepEqual(plan[1], { name: 'existing', mode: 'copy' });
  assert.deepEqual(plan[2], { name: 'missing', mode: 'null' });
});

test('schema: getMigratableColumns returns all "copy" when all source columns present', () => {
  const tableMeta = {
    name: 'test_table',
    columns: [
      { name: 'a', pgType: 'TEXT', nullable: true },
      { name: 'b', pgType: 'TEXT', nullable: true },
    ],
  };

  const sourceColumnNames = new Set(['a', 'b']);
  const plan = getMigratableColumns(tableMeta, sourceColumnNames);

  for (const item of plan) {
    assert.equal(item.mode, 'copy');
  }
});

test('schema: getMigratableColumns returns all "null" when no source columns present', () => {
  const tableMeta = {
    name: 'test_table',
    columns: [
      { name: 'a', pgType: 'TEXT', nullable: true },
      { name: 'b', pgType: 'TEXT', nullable: true },
    ],
  };

  const sourceColumnNames = new Set([]); // Empty source
  const plan = getMigratableColumns(tableMeta, sourceColumnNames);

  for (const item of plan) {
    assert.equal(item.mode, 'null');
  }
});

// ============================================================================
// RECORD SYNTHESIS TESTS (primary_key_text and cursor_value)
// ============================================================================

test('record-synthesis: derivePrimaryKeyText with single primary field returns field value', () => {
  const streamMeta = {
    primary_key: 'user_id',
    cursor_field: null,
  };

  const recordJson = '{"user_id":"abc123","name":"John"}';
  const recordKey = 'fallback_key';

  const result = derivePrimaryKeyText(streamMeta, recordJson, recordKey);

  // Should extract user_id from recordJson
  assert.equal(result, 'abc123');
});

test('record-synthesis: derivePrimaryKeyText with single primary field falls back to record_key when field missing', () => {
  const streamMeta = {
    primary_key: 'user_id',
    cursor_field: null,
  };

  const recordJson = '{"name":"John"}'; // user_id is missing
  const recordKey = 'fallback_key';

  const result = derivePrimaryKeyText(streamMeta, recordJson, recordKey);

  // Should use record_key as fallback
  assert.equal(result, 'fallback_key');
});

test('record-synthesis: derivePrimaryKeyText with no primary_key declared returns record_key', () => {
  const streamMeta = {
    // primary_key not declared (defaults to 'id')
    cursor_field: null,
  };

  const recordJson = '{"id":"xyz","name":"Jane"}';
  const recordKey = 'fallback_key';

  const result = derivePrimaryKeyText(streamMeta, recordJson, recordKey);

  // Default primary key is 'id', so should extract it
  assert.equal(result, 'xyz');
});

test('record-synthesis: derivePrimaryKeyText with composite primary key returns record_key', () => {
  const streamMeta = {
    primary_key: ['user_id', 'org_id'], // Composite key
    cursor_field: null,
  };

  const recordJson = '{"user_id":"u1","org_id":"o1"}';
  const recordKey = 'composite_fallback';

  const result = derivePrimaryKeyText(streamMeta, recordJson, recordKey);

  // With composite key, should join the fields with NUL separator
  // NUL is \x00, so result should be 'u1\x00o1'
  assert.equal(result, 'u1\x00o1');
});

test('record-synthesis: derivePrimaryKeyText handles null record_json gracefully', () => {
  const streamMeta = {
    primary_key: 'id',
    cursor_field: null,
  };

  const recordJson = null;
  const recordKey = 'fallback';

  const result = derivePrimaryKeyText(streamMeta, recordJson, recordKey);

  // Should fall back to record_key since recordJson is null
  assert.equal(result, 'fallback');
});

test('record-synthesis: derivePrimaryKeyText ensures non-empty string return', () => {
  const streamMeta = {
    primary_key: 'id',
  };

  const recordJson = '{"id":""}'; // Empty string value
  const recordKey = 'fallback';

  const result = derivePrimaryKeyText(streamMeta, recordJson, recordKey);

  // Empty string value should be converted to string and returned
  assert.equal(typeof result, 'string');
  assert.ok(result.length > 0 || result === recordKey);
});

test('record-synthesis: deriveCursorValue with cursor_field declared returns field value', () => {
  const streamMeta = {
    primary_key: 'id',
    cursor_field: 'updated_at',
  };

  const recordJson = '{"id":"123","updated_at":"2026-05-08T12:00:00Z"}';

  const result = deriveCursorValue(streamMeta, recordJson);

  assert.equal(result, '2026-05-08T12:00:00Z');
});

test('record-synthesis: deriveCursorValue with cursor_field returns null when field missing', () => {
  const streamMeta = {
    primary_key: 'id',
    cursor_field: 'updated_at',
  };

  const recordJson = '{"id":"123"}'; // updated_at is missing

  const result = deriveCursorValue(streamMeta, recordJson);

  assert.equal(result, null);
});

test('record-synthesis: deriveCursorValue with no cursor_field declared returns null', () => {
  const streamMeta = {
    primary_key: 'id',
    // cursor_field not declared
  };

  const recordJson = '{"id":"123","updated_at":"2026-05-08T12:00:00Z"}';

  const result = deriveCursorValue(streamMeta, recordJson);

  // Should return null since cursor_field is not declared
  assert.equal(result, null);
});

test('record-synthesis: deriveCursorValue handles null record_json gracefully', () => {
  const streamMeta = {
    primary_key: 'id',
    cursor_field: 'updated_at',
  };

  const recordJson = null;

  const result = deriveCursorValue(streamMeta, recordJson);

  assert.equal(result, null);
});

test('record-synthesis: deriveCursorValue converts value to string', () => {
  const streamMeta = {
    primary_key: 'id',
    cursor_field: 'version',
  };

  const recordJson = '{"id":"123","version":42}'; // Numeric version

  const result = deriveCursorValue(streamMeta, recordJson);

  // Should convert to string
  assert.equal(result, '42');
  assert.equal(typeof result, 'string');
});

// ============================================================================
// buildRowTransformer with synthesize hook Tests
// ============================================================================

test('transformers: buildRowTransformer with synthesize hook overrides column values', () => {
  const tableMeta = {
    name: 'records',
    columns: [
      { name: 'id', pgType: 'BIGINT' },
      { name: 'primary_key_text', pgType: 'TEXT' },
      { name: 'cursor_value', pgType: 'TEXT' },
      { name: 'record_json', pgType: 'JSONB', jsonb: true },
    ],
  };

  const sourceColumnNames = new Set(['id', 'record_json']);

  const synthesizeHook = (sqliteRow, columnName) => {
    if (columnName === 'primary_key_text') {
      return 'synthesized_pk';
    }
    if (columnName === 'cursor_value') {
      return 'synthesized_cursor';
    }
    return undefined; // Use normal path for other columns
  };

  const transformer = buildRowTransformer(tableMeta, sourceColumnNames, { synthesize: synthesizeHook });

  const row = {
    id: 1,
    record_json: '{"data":"test"}',
  };

  const result = transformer(row);

  // Result should have synthesized values for primary_key_text and cursor_value
  assert.deepEqual(result, [
    1,
    'synthesized_pk',
    'synthesized_cursor',
    { data: 'test' },
  ]);
});

test('transformers: buildRowTransformer with synthesize hook returning undefined uses normal coercion', () => {
  const tableMeta = {
    name: 'test',
    columns: [
      { name: 'id', pgType: 'BIGINT' },
      { name: 'value', pgType: 'TEXT' },
    ],
  };

  const synthesizeHook = (sqliteRow, columnName) => {
    // Always return undefined to use normal coercion
    return undefined;
  };

  const transformer = buildRowTransformer(tableMeta, new Set(['id', 'value']), { synthesize: synthesizeHook });

  const row = {
    id: 42,
    value: 'hello',
  };

  const result = transformer(row);

  assert.deepEqual(result, [42, 'hello']);
});

test('transformers: buildRowTransformer synthesize hook receives correct sqliteRow', () => {
  const tableMeta = {
    name: 'test',
    columns: [
      { name: 'connector_id', pgType: 'TEXT' },
      { name: 'stream', pgType: 'TEXT' },
      { name: 'synthesized', pgType: 'TEXT' },
    ],
  };

  let capturedRow = null;
  let capturedColumnName = null;

  const synthesizeHook = (sqliteRow, columnName) => {
    if (columnName === 'synthesized') {
      capturedRow = sqliteRow;
      capturedColumnName = columnName;
      return 'hook-was-called';
    }
    return undefined;
  };

  const transformer = buildRowTransformer(tableMeta, new Set(['connector_id', 'stream']), { synthesize: synthesizeHook });

  const row = {
    connector_id: 'conn1',
    stream: 'stream1',
  };

  const result = transformer(row);

  // Verify the hook was called with the correct row
  assert.equal(capturedColumnName, 'synthesized');
  assert.deepEqual(capturedRow, row);
  assert.equal(result[2], 'hook-was-called');
});
