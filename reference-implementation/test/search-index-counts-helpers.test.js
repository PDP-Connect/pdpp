/**
 * Mutation-killing unit tests for the pure helpers in
 * `server/search-index-counts.ts`.
 *
 * `search-index-counts.test.js` exercises `sqliteCountIndexableTextValues`
 * with a fake SQL iterator but does not import these two building blocks by
 * name, leaving their edge branches unpinned:
 *
 *   - sumCountRows       (null-safe reduce that coerces `row.n` via Number,
 *                         defaulting missing/garbage to 0)
 *   - sqliteFieldPathCte (builds the `(?, ?, ?)` VALUES placeholder string and
 *                         the flat bind list interleaving ordinal/field/path)
 *
 * The bind-interleaving order and the one-placeholder-triple-per-field
 * invariant are load-bearing: a mutant that reorders the binds or emits the
 * wrong placeholder count would silently corrupt the grouped count SQL and
 * turns red here.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { sqliteFieldPathCte, sumCountRows } from '../server/search-index-counts.ts';

test('sumCountRows: sums numeric n, coerces strings, treats missing/garbage as 0, null-safe', () => {
  assert.equal(sumCountRows([{ n: 1 }, { n: 2 }, { n: 3 }]), 6);
  // Null / undefined input -> 0 (the `rows || []` guard).
  assert.equal(sumCountRows(null), 0);
  assert.equal(sumCountRows(undefined), 0);
  assert.equal(sumCountRows([]), 0);

  // Numeric strings are coerced via Number.
  assert.equal(sumCountRows([{ n: '4' }, { n: '6' }]), 10);
  // Missing n (undefined), null row, and n===0 all contribute 0 via `row?.n || 0`.
  assert.equal(sumCountRows([{ n: 5 }, {}, null, { n: 0 }]), 5);
  // Real query rows always carry a numeric COUNT(*) alias; the coercion path is
  // Number(row.n). A row whose n is a non-numeric string is out of contract and
  // yields NaN (documented here so a mutant that changes the coercion to a
  // silent-0 or a different operator is still observable).
  assert.ok(Number.isNaN(sumCountRows([{ n: 'not-a-number' }])), 'garbage n coerces to NaN, not 0');
});

test('sqliteFieldPathCte: one placeholder triple per field + interleaved [ordinal, field, path] binds', () => {
  const jsonPathForField = (f) => `$.${f}`;
  const cte = sqliteFieldPathCte(['body', 'subject'], jsonPathForField);

  assert.deepEqual(cte.fields, ['body', 'subject']);
  // Exactly one "(?, ?, ?)" per field, comma-joined.
  assert.equal(cte.valuesSql, '(?, ?, ?), (?, ?, ?)');
  // Binds interleave ordinal, field, and the computed path IN THAT ORDER.
  assert.deepEqual(cte.binds, [0, 'body', '$.body', 1, 'subject', '$.subject']);
  // 3 binds per field.
  assert.equal(cte.binds.length, cte.fields.length * 3);
});

test('sqliteFieldPathCte: empty / non-array declaredFields -> empty SQL and binds', () => {
  const jsonPathForField = (f) => `$.${f}`;
  const empty = sqliteFieldPathCte([], jsonPathForField);
  assert.deepEqual(empty.fields, []);
  assert.equal(empty.valuesSql, '');
  assert.deepEqual(empty.binds, []);

  // A non-array (null) is normalized to an empty field list.
  const fromNull = sqliteFieldPathCte(null, jsonPathForField);
  assert.deepEqual(fromNull.fields, []);
  assert.equal(fromNull.valuesSql, '');
  assert.deepEqual(fromNull.binds, []);
});
