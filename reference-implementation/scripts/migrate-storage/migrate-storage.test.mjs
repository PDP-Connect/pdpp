/**
 * Regression tests for schema parser
 * Pins column lists to catch parser bugs early
 */

import { TABLES } from './schema.mjs';
import assert from 'node:assert';

function testTableColumns(tableName, expectedColumns) {
  const table = TABLES.find(t => t.name === tableName);
  assert(table, `Table ${tableName} not found`);

  const actualNames = table.columns.map(c => c.name);
  const actualSet = new Set(actualNames);
  const expectedSet = new Set(expectedColumns);

  // Check for missing columns
  for (const col of expectedColumns) {
    assert(
      actualSet.has(col),
      `Missing column ${tableName}.${col}. Got: ${actualNames.join(', ')}`
    );
  }

  // Check for spurious columns
  for (const col of actualNames) {
    assert(
      expectedSet.has(col),
      `Spurious column ${tableName}.${col}. Expected: ${expectedColumns.join(', ')}`
    );
  }

  console.log(`✓ ${tableName}: ${actualNames.length} columns OK`);
}

console.log('Testing schema parser column extraction...\n');

// Regression test: ensure primary_key_text is not filtered out by constraint keyword matching
testTableColumns('records', [
  'id',
  'connector_id',
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

testTableColumns('grant_connector_state', [
  'grant_id',
  'connector_id',
  'stream',
  'state_json',
  'updated_at',
]);

testTableColumns('connector_state', [
  'connector_id',
  'stream',
  'state_json',
  'updated_at',
]);

console.log('\n✓ All schema parser regression tests passed');
