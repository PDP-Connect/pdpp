/**
 * Regression + readiness tests for the SQLite -> Postgres storage migration.
 *
 * Two concerns:
 *
 *  1. Schema-parser regression. The migration derives its target column set by
 *     parsing the canonical DDL in `server/postgres-storage.js` (see
 *     `schema.mjs`). These tests pin the column lists for the data-bearing
 *     tables so a parser bug (or an undeclared schema change that the migration
 *     does not understand) fails loudly here instead of mid-migration against a
 *     production database.
 *
 *  2. SQLite -> Postgres readiness rehearsal (the SQLite half). The full
 *     round-trip needs a live Postgres target (see the manual rehearsal in the
 *     workstream report), but the source-read + column-plan + row-transform half
 *     runs entirely against a throwaway SQLite file built by the real server
 *     bootstrap (`initDb`). That half is where the highest-risk drift lives:
 *     `connector_instance_id` is `NOT NULL` in every data table and has no
 *     synthesize fallback, so if a source row reached the transformer without
 *     it, the migration would either insert NULL into a NOT NULL column or
 *     migrate an empty identity. These tests prove the live store's actual
 *     shape (post-boot, column present) transforms cleanly, and that a legacy
 *     pre-column shape is caught as a hard drift rather than silently corrupted.
 *
 * Run directly (not part of `scripts/run-tests.js`, which only globs *.test.js):
 *   node --test scripts/migrate-storage/migrate-storage.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DERIVED_TABLES,
  TABLES,
  classifyMissingTargetColumn,
  getMigratableColumns,
  isSynthesizedColumn,
} from './schema.mjs';
import {
  openSqliteSource,
  describeSourceColumns,
  streamRows,
} from './sqlite-source.ts';
import { buildRowTransformer } from './transformers.mjs';
import { initDb, closeDb } from '../../server/db.js';

function tableByName(name) {
  const table = TABLES.find((t) => t.name === name);
  assert.ok(table, `Table ${name} not found in parsed schema`);
  return table;
}

function assertExactColumns(tableName, expectedColumns) {
  const table = tableByName(tableName);
  const actualNames = table.columns.map((c) => c.name);
  assert.deepEqual(
    [...actualNames].sort(),
    [...expectedColumns].sort(),
    `${tableName} column set drifted. Parsed: ${actualNames.join(', ')}`,
  );
}

// --- 1. Schema-parser column pins -------------------------------------------

test('schema parser: records columns', () => {
  // Regression: ensure primary_key_text is not filtered out by constraint
  // keyword matching, and that connector_instance_id (added for the
  // per-connector-instance storage model) is recognized.
  assertExactColumns('records', [
    'id',
    'connector_id',
    'connector_instance_id',
    'stream',
    'record_key',
    'record_json',
    'emitted_at',
    'version',
    'deleted',
    'deleted_at',
    'cursor_value',
    'primary_key_text',
  ]);
});

test('schema parser: connector_state columns', () => {
  assertExactColumns('connector_state', [
    'connector_id',
    'connector_instance_id',
    'stream',
    'state_json',
    'updated_at',
  ]);
});

test('schema parser: grant_connector_state columns', () => {
  assertExactColumns('grant_connector_state', [
    'grant_id',
    'connector_id',
    'connector_instance_id',
    'stream',
    'state_json',
    'updated_at',
  ]);
});

// --- 2. connector_instance_id NOT NULL invariant ----------------------------

test('readiness: connector_instance_id is NOT NULL in every data table that carries it', () => {
  // These are the data-bearing tables where a missing connector_instance_id in
  // the source would be a hard migration failure (insert NULL into NOT NULL) or
  // a silent identity corruption. The migration has no synthesize fallback for
  // this column (unlike primary_key_text / cursor_value / json_path), so the
  // source MUST already carry it. The SQLite server bootstrap guarantees that
  // (see the rehearsal below); this pin makes sure the column does not silently
  // become nullable in the target schema, which would mask a real drift.
  const carriers = TABLES.filter((t) =>
    t.columns.some((c) => c.name === 'connector_instance_id'),
  );
  assert.ok(carriers.length > 0, 'expected some tables to carry connector_instance_id');

  const mustBeNotNull = [
    'records',
    'record_changes',
    'blobs',
    'blob_bindings',
    'version_counter',
    'connector_state',
    'grant_connector_state',
    'scheduler_run_history',
  ];
  for (const name of mustBeNotNull) {
    const col = tableByName(name).columns.find((c) => c.name === 'connector_instance_id');
    assert.ok(col, `${name} should carry connector_instance_id`);
    assert.equal(
      col.nullable,
      false,
      `${name}.connector_instance_id must be NOT NULL — a nullable target would mask a missing-source-column drift`,
    );
  }
});

// --- 3. Diff classifier matches execute semantics ---------------------------

test('diff readiness: synthesized target columns are handled, not hard drift', () => {
  assert.equal(isSynthesizedColumn('records', 'primary_key_text'), true);
  assert.equal(isSynthesizedColumn('records', 'cursor_value'), true);
  assert.equal(isSynthesizedColumn('blob_bindings', 'json_path'), true);

  const records = tableByName('records');
  const primaryKeyText = records.columns.find((c) => c.name === 'primary_key_text');
  const cursorValue = records.columns.find((c) => c.name === 'cursor_value');
  assert.equal(classifyMissingTargetColumn(primaryKeyText, 'records'), 'synthesized');
  assert.equal(classifyMissingTargetColumn(cursorValue, 'records'), 'synthesized');

  const blobBindings = tableByName('blob_bindings');
  const jsonPath = blobBindings.columns.find((c) => c.name === 'json_path');
  assert.equal(classifyMissingTargetColumn(jsonPath, 'blob_bindings'), 'synthesized');
});

test('diff readiness: nullable missing target columns are null-fill, while missing NOT NULL identity is hard drift', () => {
  const records = tableByName('records');
  const deletedAt = records.columns.find((c) => c.name === 'deleted_at');
  const connectorInstanceId = records.columns.find((c) => c.name === 'connector_instance_id');

  assert.equal(classifyMissingTargetColumn(deletedAt, 'records'), 'null-fill');
  assert.equal(classifyMissingTargetColumn(connectorInstanceId, 'records'), 'hard-drift');
});

test('diff readiness: derived/runtime-rebuilt tables are classified for skip by table set', () => {
  assert.equal(DERIVED_TABLES.has('lexical_search_index'), true);
  assert.equal(DERIVED_TABLES.has('semantic_search_backfill_progress'), true);
  assert.equal(DERIVED_TABLES.has('records'), false);
});

// --- 4. SQLite -> (plan/transform) rehearsal against a real bootstrapped DB --

test('rehearsal: a bootstrapped SQLite store carries connector_instance_id and transforms cleanly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdpp-migrate-rehearsal-'));
  const dbPath = join(dir, 'pdpp.sqlite');
  let src;
  try {
    // Build a real store via the server bootstrap — this is the shape the live
    // 55GB store has after the db.js connector_instance_id boot migration runs.
    const db = initDb(dbPath);
    const recordsCols = db
      .prepare("PRAGMA table_info('records')")
      .all()
      .map((c) => c.name);
    assert.ok(
      recordsCols.includes('connector_instance_id'),
      'bootstrapped SQLite records table must carry connector_instance_id',
    );

    const insert = db.prepare(
      `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run('chase', 'cin_demo_a', 'statements', 'k1', '{"amount":1}', '2026-01-01T00:00:00Z', 1, 0);
    insert.run('usaa', 'cin_demo_b', 'accounts', 'k2', '{"balance":2}', '2026-01-02T00:00:00Z', 1, 0);
    closeDb();

    // Drive the real migrate-storage SQLite-read + plan + transform path.
    src = await openSqliteSource(dbPath);
    const recTable = tableByName('records');
    const srcColNames = new Set(
      describeSourceColumns(src.handle, 'records').map((c) => c.name),
    );

    const plan = getMigratableColumns(recTable, srcColNames);
    const ciiPlan = plan.find((p) => p.name === 'connector_instance_id');
    assert.equal(
      ciiPlan?.mode,
      'copy',
      'connector_instance_id must be copied from source, never NULL-filled',
    );

    // Synthesize hook mirrors the CLI execute path for the records table
    // (primary_key_text / cursor_value). connector_instance_id is NOT
    // synthesized — it must flow straight through from the source row.
    const transformer = buildRowTransformer(recTable, srcColNames, {
      synthesize: (row, colName) => {
        if (colName === 'primary_key_text') return row.record_key;
        return undefined;
      },
    });
    const colOrder = recTable.columns.map((c) => c.name);
    const ciiIdx = colOrder.indexOf('connector_instance_id');
    const pkIdx = colOrder.indexOf('primary_key_text');

    const instanceIds = [];
    for (const batch of streamRows(src.handle, 'records', 500)) {
      for (const row of batch) {
        const tuple = transformer(row);
        assert.equal(tuple.length, colOrder.length, 'tuple width must match target columns');
        assert.ok(
          typeof tuple[ciiIdx] === 'string' && tuple[ciiIdx].length > 0,
          'transformed connector_instance_id must be a non-empty string',
        );
        assert.ok(tuple[pkIdx], 'primary_key_text must be synthesized');
        instanceIds.push(tuple[ciiIdx]);
      }
    }
    assert.deepEqual(
      instanceIds.sort(),
      ['cin_demo_a', 'cin_demo_b'],
      'source connector_instance_id values must survive the transform unchanged',
    );
  } finally {
    if (src) src.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rehearsal: a legacy source missing connector_instance_id is caught as a hard NOT-NULL drift, not silently NULL-migrated', () => {
  // A SQLite store predating the connector_instance_id column would expose the
  // hazard: getMigratableColumns marks the column mode:"null", and because the
  // target column is NOT NULL the migration's `diff` reports a hard drift
  // (a nullable extra is auto-handled; a NOT NULL extra is not). This guards
  // against a future change that removes the boot migration or makes the column
  // nullable, either of which would let an empty identity migrate silently.
  const recTable = tableByName('records');
  const legacyCols = new Set([
    'id',
    'connector_id',
    'stream',
    'record_key',
    'record_json',
    'emitted_at',
    'version',
    'deleted',
    'deleted_at',
  ]);
  const plan = getMigratableColumns(recTable, legacyCols);
  const ciiPlan = plan.find((p) => p.name === 'connector_instance_id');
  assert.equal(ciiPlan?.mode, 'null', 'a legacy source maps the missing column to mode:null');

  const ciiCol = recTable.columns.find((c) => c.name === 'connector_instance_id');
  assert.equal(
    ciiCol.nullable,
    false,
    'target column is NOT NULL, so the mode:null plan above is a hard drift the migration must refuse',
  );
});
