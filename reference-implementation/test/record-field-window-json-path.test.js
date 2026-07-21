/**
 * Mutation-killing unit tests for the two remaining uncovered field-window
 * exports in `server/record-field-window.js`:
 *
 *   - sqliteFieldJsonPath  (builds a `$.<quoted-key>` SQLite JSON path; the
 *                           key is JSON.stringify-quoted so a key containing
 *                           `.` or `"` resolves to that LITERAL key and cannot
 *                           break out of the quoted segment)
 *   - fieldWindowError     (the typed-error constructor: name/code/httpStatus)
 *
 * The `sqliteFieldJsonPath` quoting is the injection-defense contract: a
 * mutant that drops the JSON.stringify (interpolating the raw key) would let a
 * key with a quote escape the path segment, and turns red here.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { fieldWindowError, sqliteFieldJsonPath } from '../server/record-field-window.js';

test('sqliteFieldJsonPath: quotes the key as a JSON string under the $. root', () => {
  // A plain key is quoted.
  assert.equal(sqliteFieldJsonPath('body'), '$."body"');
  // A key containing a dot is quoted so it resolves to the LITERAL key, not a
  // nested path.
  assert.equal(sqliteFieldJsonPath('a.b'), '$."a.b"');
  // A key with a double-quote is escaped by JSON.stringify (cannot break out).
  assert.equal(sqliteFieldJsonPath('a"b'), '$."a\\"b"');
  // Always starts with the `$.` root prefix.
  assert.ok(sqliteFieldJsonPath('x').startsWith('$.'), 'must be rooted at $.');
});

test('fieldWindowError: constructs a FieldWindowError carrying code + httpStatus', () => {
  const err = fieldWindowError('invalid_window', 'bad window', 400);
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'FieldWindowError');
  assert.equal(err.code, 'invalid_window');
  assert.equal(err.httpStatus, 400);
  assert.equal(err.message, 'bad window');
});
