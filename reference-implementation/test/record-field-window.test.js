// Unit tests for the bounded record-field window substrate
// (server/record-field-window.js) — the backend-agnostic pure helpers only.
//
// Covered: field-path validation, SQLite JSON-path building, window-bound
// clamping, selector normalization (offset vs query mode), the completeness
// envelope math, the storage-type classifier, and the readable-string guard.
//
// NOTE: `assertFieldVisibleToGrant` is intentionally NOT exercised here — it
// is grant/authorization code and out of scope for this refactor-safe test set.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  FIELD_WINDOW_DEFAULT_LIMIT,
  FIELD_WINDOW_MAX_CONTEXT_CHARS,
  FIELD_WINDOW_MAX_LIMIT,
  assertFieldPath,
  assertReadableStringField,
  buildWindowEnvelope,
  clampWindowBounds,
  classifyFieldType,
  normalizeWindowSelector,
  sqliteFieldJsonPath,
} from '../server/record-field-window.js';

const codeIs = (code) => (err) => err.code === code;

test('assertFieldPath accepts a non-empty single-key string', () => {
  assert.doesNotThrow(() => assertFieldPath('body'));
  assert.doesNotThrow(() => assertFieldPath('weird.key')); // dots allowed; single top-level key
});

test('assertFieldPath rejects non-strings, empty, and NUL', () => {
  assert.throws(() => assertFieldPath(''), codeIs('invalid_field_path'));
  assert.throws(() => assertFieldPath(null), codeIs('invalid_field_path'));
  assert.throws(() => assertFieldPath(42), codeIs('invalid_field_path'));
  assert.throws(() => assertFieldPath('a\u0000b'), codeIs('invalid_field_path'));
});

test('sqliteFieldJsonPath wraps the key as a quoted literal path segment', () => {
  assert.equal(sqliteFieldJsonPath('body'), '$."body"');
  // Embedded quote is JSON-escaped so it cannot break out of the segment.
  assert.equal(sqliteFieldJsonPath('a"b'), '$."a\\"b"');
});

test('clampWindowBounds defaults offset to 0 and limit to the default', () => {
  assert.deepEqual(clampWindowBounds(), { offset: 0, limit: FIELD_WINDOW_DEFAULT_LIMIT, limitClamped: false });
  assert.deepEqual(clampWindowBounds({}), { offset: 0, limit: FIELD_WINDOW_DEFAULT_LIMIT, limitClamped: false });
});

test('clampWindowBounds rejects non-integer / negative offset', () => {
  assert.throws(() => clampWindowBounds({ offsetChars: -1 }), codeIs('invalid_window'));
  assert.throws(() => clampWindowBounds({ offsetChars: 1.5 }), codeIs('invalid_window'));
  // Zero offset is valid (boundary of `< 0`).
  assert.equal(clampWindowBounds({ offsetChars: 0 }).offset, 0);
});

test('clampWindowBounds rejects non-positive limit', () => {
  assert.throws(() => clampWindowBounds({ limitChars: 0 }), codeIs('invalid_window'));
  assert.throws(() => clampWindowBounds({ limitChars: -5 }), codeIs('invalid_window'));
  assert.throws(() => clampWindowBounds({ limitChars: 2.5 }), codeIs('invalid_window'));
});

test('clampWindowBounds clamps an over-max limit and flags it', () => {
  // Boundary: exactly max is NOT clamped; max+1 IS.
  assert.deepEqual(clampWindowBounds({ limitChars: FIELD_WINDOW_MAX_LIMIT }), {
    offset: 0,
    limit: FIELD_WINDOW_MAX_LIMIT,
    limitClamped: false,
  });
  const over = clampWindowBounds({ limitChars: FIELD_WINDOW_MAX_LIMIT + 1 });
  assert.equal(over.limit, FIELD_WINDOW_MAX_LIMIT);
  assert.equal(over.limitClamped, true);
});

test('normalizeWindowSelector defaults to offset mode', () => {
  const result = normalizeWindowSelector({});
  assert.equal(result.mode, 'offset');
  assert.equal(result.offset, 0);
  assert.equal(result.limit, FIELD_WINDOW_DEFAULT_LIMIT);
});

test('normalizeWindowSelector requires q for before_chars/after_chars', () => {
  assert.throws(() => normalizeWindowSelector({ before_chars: 5 }), codeIs('invalid_window'));
  assert.throws(() => normalizeWindowSelector({ after_chars: 5 }), codeIs('invalid_window'));
});

test('normalizeWindowSelector rejects q combined with offset_chars', () => {
  assert.throws(() => normalizeWindowSelector({ q: 'x', offset_chars: 3 }), codeIs('invalid_window'));
});

test('normalizeWindowSelector rejects an empty q string', () => {
  // hasQParam is true for '' only if !== undefined && !== null; '' is a
  // present-but-empty q, which must be rejected as non-empty-string.
  assert.throws(() => normalizeWindowSelector({ q: '' }), codeIs('invalid_window'));
});

test('normalizeWindowSelector query mode derives limit from context when explicit', () => {
  const result = normalizeWindowSelector({ q: 'needle', before_chars: 10, after_chars: 20 });
  assert.equal(result.mode, 'query');
  assert.equal(result.query, 'needle');
  assert.equal(result.before, 10);
  assert.equal(result.after, 20);
  // requestedLimit = before + q.length + after = 10 + 6 + 20 = 36
  assert.equal(result.limit, 36);
});

test('normalizeWindowSelector query mode uses the default limit without explicit context', () => {
  const result = normalizeWindowSelector({ q: 'needle' });
  assert.equal(result.limit, FIELD_WINDOW_DEFAULT_LIMIT);
  assert.equal(result.before, 0);
  assert.equal(result.after, 0);
});

test('normalizeWindowSelector rejects context chars over the ceiling', () => {
  assert.throws(
    () => normalizeWindowSelector({ q: 'x', before_chars: FIELD_WINDOW_MAX_CONTEXT_CHARS + 1 }),
    codeIs('invalid_window')
  );
});

test('buildWindowEnvelope reports a complete window from offset 0 covering the whole field', () => {
  const env = buildWindowEnvelope({ text: 'hello', totalChars: 5, offset: 0, limit: 4096 });
  assert.equal(env.start_chars, 0);
  assert.equal(env.end_chars, 5);
  assert.equal(env.complete, true);
  assert.equal(env.has_more, false);
  assert.equal(env.next_offset_chars, null);
  assert.equal(env.previous_offset_chars, null);
});

test('buildWindowEnvelope reports has_more and next cursor for a partial window', () => {
  // Field is 100 chars; window covers [0,10).
  const env = buildWindowEnvelope({ text: 'x'.repeat(10), totalChars: 100, offset: 0, limit: 10 });
  assert.equal(env.end_chars, 10);
  assert.equal(env.complete, false);
  assert.equal(env.has_more, true);
  assert.equal(env.next_offset_chars, 10);
});

test('buildWindowEnvelope computes previous cursor for a mid-field window', () => {
  // Window covers [20,30) of a 100-char field with limit 10.
  const env = buildWindowEnvelope({ text: 'x'.repeat(10), totalChars: 100, offset: 20, limit: 10 });
  assert.equal(env.start_chars, 20);
  assert.equal(env.end_chars, 30);
  assert.equal(env.complete, false); // start != 0
  assert.equal(env.previous_offset_chars, 10); // max(0, 20 - 10)
  assert.equal(env.next_offset_chars, 30);
});

test('buildWindowEnvelope clamps start/end to totalChars', () => {
  // Offset beyond the field: start clamps to totalChars, end too.
  const env = buildWindowEnvelope({ text: '', totalChars: 5, offset: 50, limit: 10 });
  assert.equal(env.start_chars, 5);
  assert.equal(env.end_chars, 5);
  assert.equal(env.has_more, false);
});

test('classifyFieldType maps engine type names to coarse classes', () => {
  assert.equal(classifyFieldType(null), 'absent');
  assert.equal(classifyFieldType(undefined), 'absent');
  assert.equal(classifyFieldType('text'), 'string');
  assert.equal(classifyFieldType('string'), 'string');
  assert.equal(classifyFieldType('integer'), 'number');
  assert.equal(classifyFieldType('real'), 'number');
  assert.equal(classifyFieldType('number'), 'number');
  assert.equal(classifyFieldType('true'), 'boolean');
  assert.equal(classifyFieldType('false'), 'boolean');
  assert.equal(classifyFieldType('boolean'), 'boolean');
  assert.equal(classifyFieldType('null'), 'null');
  assert.equal(classifyFieldType('object'), 'object');
  assert.equal(classifyFieldType('array'), 'array');
  assert.equal(classifyFieldType('mystery'), 'other');
});

test('assertReadableStringField passes for string, errors by class otherwise', () => {
  assert.doesNotThrow(() => assertReadableStringField('body', 'string'));
  assert.throws(() => assertReadableStringField('body', 'absent'), codeIs('field_not_found'));
  assert.throws(() => assertReadableStringField('body', 'object'), codeIs('field_not_text'));
  assert.throws(() => assertReadableStringField('body', 'number'), codeIs('field_not_text'));
});

test('assertReadableStringField maps error classes to the right HTTP status', () => {
  assert.throws(() => assertReadableStringField('body', 'absent'), (err) => err.httpStatus === 404);
  assert.throws(() => assertReadableStringField('body', 'array'), (err) => err.httpStatus === 422);
});
