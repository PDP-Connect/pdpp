/**
 * Pure-substrate unit coverage for the bounded record-field window helpers in
 * `server/record-field-window.js`.
 *
 * The existing suites exercise this module only *indirectly*:
 *   - record-field-window-substrate.test.js drives it through the DB-backed
 *     reader (`getRecordFieldWindow`), and
 *   - rs-record-field-window-route.test.js drives it through the HTTP route.
 * Both cover the happy path, but neither pins the mutation-sensitive branches
 * of the pure helpers by name: the MAX_LIMIT clamp, the context-char ceiling,
 * the offset-past-end envelope math, the `previous_offset_chars` window, the
 * full storage-type classification map, the single-key JSON path builder, and
 * the typed error vocabulary (`invalid_window`, `invalid_field_path`,
 * `field_not_found`, `field_not_text`, and the grant-preserving
 * `field_not_granted`).
 *
 * These functions are pure and backend-agnostic, so this file is DB-free: it
 * asserts the substrate contract directly. Assertions here OBSERVE the
 * grant-visibility helper; they do not change its behavior.
 *
 * Spec: openspec/changes/add-mcp-content-ladder/specs/mcp-adapter/spec.md
 *       Requirement: "MCP bounded field reads SHALL be served by a
 *       grant-enforced resource-server path"
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FIELD_WINDOW_DEFAULT_LIMIT,
  FIELD_WINDOW_MAX_LIMIT,
  FIELD_WINDOW_MAX_CONTEXT_CHARS,
  FieldWindowError,
  fieldWindowError,
  assertFieldPath,
  sqliteFieldJsonPath,
  clampWindowBounds,
  normalizeWindowSelector,
  assertFieldVisibleToGrant,
  buildWindowEnvelope,
  classifyFieldType,
  assertReadableStringField,
} from '../server/record-field-window.js';

// `assert.throws` returns undefined, so capturing the thrown error for further
// code/httpStatus assertions needs an explicit try/catch. This helper runs the
// thunk, asserts it threw a FieldWindowError, and returns that error.
function catchFieldWindowError(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof FieldWindowError, `expected FieldWindowError, got ${err}`);
    return err;
  }
  assert.fail('expected the call to throw a FieldWindowError');
}

// Pin the advertised substrate constants. The MCP adapter mirrors these; if the
// resource-server authority drifts, the adapter's advertised window silently
// disagrees with what the server enforces.
test('substrate window constants hold their advertised values', () => {
  assert.equal(FIELD_WINDOW_DEFAULT_LIMIT, 4096);
  assert.equal(FIELD_WINDOW_MAX_LIMIT, 16384);
  assert.equal(FIELD_WINDOW_MAX_CONTEXT_CHARS, 8192);
});

// ─── fieldWindowError / FieldWindowError ────────────────────────────────────

test('fieldWindowError carries code + httpStatus verbatim for route/adapter mapping', () => {
  const err = fieldWindowError('field_not_text', 'nope', 422);
  assert.ok(err instanceof FieldWindowError, 'is a FieldWindowError');
  assert.ok(err instanceof Error, 'is an Error');
  assert.equal(err.name, 'FieldWindowError');
  assert.equal(err.code, 'field_not_text');
  assert.equal(err.message, 'nope');
  assert.equal(err.httpStatus, 422);
});

// ─── assertFieldPath ────────────────────────────────────────────────────────

test('assertFieldPath accepts a non-empty single-key string', () => {
  assert.doesNotThrow(() => assertFieldPath('body'));
  // A key that itself contains dots/quotes is a literal single key, not a path.
  assert.doesNotThrow(() => assertFieldPath('weird.key'));
  assert.doesNotThrow(() => assertFieldPath('a"b'));
});

test('assertFieldPath rejects non-string, empty, and NUL-bearing field names', () => {
  for (const bad of [undefined, null, 42, {}, []]) {
    const err = catchFieldWindowError(() => assertFieldPath(bad));
    assert.equal(err.code, 'invalid_field_path');
    assert.equal(err.httpStatus, 400);
  }
  const empty = catchFieldWindowError(() => assertFieldPath(''));
  assert.equal(empty.code, 'invalid_field_path');

  const nul = catchFieldWindowError(() => assertFieldPath('bo\u0000dy'));
  assert.equal(nul.code, 'invalid_field_path');
  assert.equal(nul.httpStatus, 400);
});

// ─── sqliteFieldJsonPath ────────────────────────────────────────────────────

test('sqliteFieldJsonPath quotes the key so it resolves as a literal single key', () => {
  assert.equal(sqliteFieldJsonPath('body'), '$."body"');
  // A key containing a dot must NOT become a nested path segment.
  assert.equal(sqliteFieldJsonPath('weird.key'), '$."weird.key"');
  // A key containing a quote is JSON-escaped, so it cannot break out of $."...".
  assert.equal(sqliteFieldJsonPath('a"b'), '$."a\\"b"');
});

// ─── clampWindowBounds ──────────────────────────────────────────────────────

test('clampWindowBounds defaults offset to 0 and limit to the substrate default', () => {
  assert.deepEqual(clampWindowBounds(), {
    offset: 0,
    limit: FIELD_WINDOW_DEFAULT_LIMIT,
    limitClamped: false,
  });
  assert.deepEqual(clampWindowBounds({}), {
    offset: 0,
    limit: FIELD_WINDOW_DEFAULT_LIMIT,
    limitClamped: false,
  });
  // null is treated the same as absent for both fields.
  assert.deepEqual(clampWindowBounds({ offsetChars: null, limitChars: null }), {
    offset: 0,
    limit: FIELD_WINDOW_DEFAULT_LIMIT,
    limitClamped: false,
  });
});

test('clampWindowBounds passes through an in-range explicit offset and limit', () => {
  const out = clampWindowBounds({ offsetChars: 10, limitChars: 25 });
  assert.equal(out.offset, 10);
  assert.equal(out.limit, 25);
  assert.equal(out.limitClamped, false);
});

test('clampWindowBounds clamps a limit above the ceiling and flags it', () => {
  const out = clampWindowBounds({ limitChars: FIELD_WINDOW_MAX_LIMIT + 1 });
  assert.equal(out.limit, FIELD_WINDOW_MAX_LIMIT, 'over-ceiling limit is clamped to the max');
  assert.equal(out.limitClamped, true, 'the clamp is flagged for a warning');

  // Exactly at the ceiling is honored, not flagged.
  const atMax = clampWindowBounds({ limitChars: FIELD_WINDOW_MAX_LIMIT });
  assert.equal(atMax.limit, FIELD_WINDOW_MAX_LIMIT);
  assert.equal(atMax.limitClamped, false);
});

test('clampWindowBounds rejects a non-integer or negative offset', () => {
  for (const bad of [1.5, -1, Number.NaN]) {
    const err = catchFieldWindowError(() => clampWindowBounds({ offsetChars: bad }));
    assert.equal(err.code, 'invalid_window');
    assert.equal(err.httpStatus, 400);
  }
  // offset 0 is a legal non-negative integer.
  assert.equal(clampWindowBounds({ offsetChars: 0 }).offset, 0);
});

test('clampWindowBounds rejects a non-positive or non-integer limit', () => {
  for (const bad of [0, -5, 2.5]) {
    const err = catchFieldWindowError(() => clampWindowBounds({ limitChars: bad }));
    assert.equal(err.code, 'invalid_window');
    assert.equal(err.httpStatus, 400);
  }
  // limit 1 is the smallest legal positive window.
  assert.equal(clampWindowBounds({ limitChars: 1 }).limit, 1);
});

// ─── normalizeWindowSelector ────────────────────────────────────────────────

test('normalizeWindowSelector defaults to an offset-mode window', () => {
  const out = normalizeWindowSelector();
  assert.equal(out.mode, 'offset');
  assert.equal(out.offset, 0);
  assert.equal(out.limit, FIELD_WINDOW_DEFAULT_LIMIT);
  assert.equal(out.limitClamped, false);
});

test('normalizeWindowSelector requires q for before_chars/after_chars', () => {
  const before = catchFieldWindowError(
    () => normalizeWindowSelector({ before_chars: 5 }),
  );
  assert.equal(before.code, 'invalid_window');
  const after = catchFieldWindowError(
    () => normalizeWindowSelector({ after_chars: 5 }),
  );
  assert.equal(after.code, 'invalid_window');
});

test('normalizeWindowSelector treats q as exclusive with offset_chars', () => {
  const err = catchFieldWindowError(
    () => normalizeWindowSelector({ q: 'x', offset_chars: 3 }),
  );
  assert.equal(err.code, 'invalid_window');
  assert.equal(err.httpStatus, 400);
});

test('normalizeWindowSelector rejects an empty or non-string q', () => {
  for (const bad of ['', 42, {}]) {
    const err = catchFieldWindowError(
      () => normalizeWindowSelector({ q: bad }),
    );
    assert.equal(err.code, 'invalid_window');
  }
});

test('normalizeWindowSelector in query mode derives the limit from context + q length', () => {
  const out = normalizeWindowSelector({ q: 'lazy', before_chars: 5, after_chars: 7 });
  assert.equal(out.mode, 'query');
  assert.equal(out.query, 'lazy');
  assert.equal(out.before, 5);
  assert.equal(out.after, 7);
  assert.equal(out.offset, 0, 'query mode always starts the underlying scan at 0');
  // Explicit context with no explicit limit_chars: before + q.length + after.
  assert.equal(out.limit, 5 + 'lazy'.length + 7);
  assert.equal(out.limitClamped, false);
});

test('normalizeWindowSelector query mode without context defaults the window to the substrate default', () => {
  const out = normalizeWindowSelector({ q: 'needle' });
  assert.equal(out.mode, 'query');
  assert.equal(out.before, 0);
  assert.equal(out.after, 0);
  assert.equal(out.limit, FIELD_WINDOW_DEFAULT_LIMIT);
});

test('normalizeWindowSelector query mode honors an explicit in-range limit_chars over context math', () => {
  const out = normalizeWindowSelector({ q: 'needle', before_chars: 5, after_chars: 7, limit_chars: 40 });
  assert.equal(out.limit, 40);
  assert.equal(out.limitClamped, false);
});

test('normalizeWindowSelector clamps a query-mode window that exceeds the max and flags it', () => {
  const out = normalizeWindowSelector({ q: 'needle', limit_chars: FIELD_WINDOW_MAX_LIMIT + 100 });
  assert.equal(out.limit, FIELD_WINDOW_MAX_LIMIT);
  assert.equal(out.limitClamped, true);
});

test('normalizeWindowSelector enforces the context-char ceiling on before_chars/after_chars', () => {
  const over = catchFieldWindowError(
    () => normalizeWindowSelector({ q: 'x', before_chars: FIELD_WINDOW_MAX_CONTEXT_CHARS + 1 }),
  );
  assert.equal(over.code, 'invalid_window');
  assert.equal(over.httpStatus, 400);

  // Exactly at the ceiling is allowed.
  assert.doesNotThrow(
    () => normalizeWindowSelector({ q: 'x', after_chars: FIELD_WINDOW_MAX_CONTEXT_CHARS }),
  );
});

test('normalizeWindowSelector rejects negative/non-integer context chars', () => {
  for (const bad of [-1, 1.5]) {
    const err = catchFieldWindowError(
      () => normalizeWindowSelector({ q: 'x', before_chars: bad }),
    );
    assert.equal(err.code, 'invalid_window');
  }
});

// ─── assertFieldVisibleToGrant (OBSERVED, not changed) ──────────────────────

test('assertFieldVisibleToGrant lets every field through when the grant scopes no projection', () => {
  // null / undefined effectiveFields means "no field projection" -> all visible.
  assert.doesNotThrow(() => assertFieldVisibleToGrant('subject', null));
  assert.doesNotThrow(() => assertFieldVisibleToGrant('subject', undefined));
});

test('assertFieldVisibleToGrant allows a field inside the granted projection', () => {
  assert.doesNotThrow(() => assertFieldVisibleToGrant('body', ['id', 'body']));
});

test('assertFieldVisibleToGrant fails closed with field_not_granted outside the projection', () => {
  const err = catchFieldWindowError(
    () => assertFieldVisibleToGrant('subject', ['id', 'body']),
  );
  assert.equal(err.code, 'field_not_granted');
  assert.equal(err.httpStatus, 403);

  // A non-array projection is also treated as "not visible" — fail closed.
  const nonArray = catchFieldWindowError(
    () => assertFieldVisibleToGrant('body', 'body'),
  );
  assert.equal(nonArray.code, 'field_not_granted');
});

// ─── buildWindowEnvelope ────────────────────────────────────────────────────

test('buildWindowEnvelope reports a complete window that covers the whole field', () => {
  const w = buildWindowEnvelope({ text: 'hello', totalChars: 5, offset: 0, limit: 4096 });
  assert.equal(w.text, 'hello');
  assert.equal(w.total_chars, 5);
  assert.equal(w.start_chars, 0);
  assert.equal(w.end_chars, 5);
  assert.equal(w.limit_chars, 4096);
  assert.equal(w.complete, true);
  assert.equal(w.has_more, false);
  assert.equal(w.next_offset_chars, null, 'a complete window advertises no next offset');
  assert.equal(w.previous_offset_chars, null, 'offset 0 has no previous window');
  assert.equal(w.match_start_chars, null);
  assert.equal(w.match_end_chars, null);
});

test('buildWindowEnvelope on a leading partial window advertises the next offset', () => {
  const w = buildWindowEnvelope({ text: 'abcd', totalChars: 10, offset: 0, limit: 4 });
  assert.equal(w.start_chars, 0);
  assert.equal(w.end_chars, 4);
  assert.equal(w.complete, false, 'a partial window from 0 is not complete');
  assert.equal(w.has_more, true);
  assert.equal(w.next_offset_chars, 4, 'next offset continues from end of the window');
  assert.equal(w.previous_offset_chars, null);
});

test('buildWindowEnvelope on an interior window points back by one limit and forward to the end', () => {
  const w = buildWindowEnvelope({ text: 'ef', totalChars: 10, offset: 4, limit: 2 });
  assert.equal(w.start_chars, 4);
  assert.equal(w.end_chars, 6);
  assert.equal(w.complete, false, 'a window not starting at 0 is never complete');
  assert.equal(w.has_more, true);
  assert.equal(w.next_offset_chars, 6);
  assert.equal(w.previous_offset_chars, 2, 'previous window is one limit back');
});

test('buildWindowEnvelope clamps previous_offset_chars at 0 when a limit would underflow', () => {
  // offset 3 with limit 10: previous = max(0, 3 - 10) = 0, not -7.
  const w = buildWindowEnvelope({ text: 'de', totalChars: 20, offset: 3, limit: 10 });
  assert.equal(w.start_chars, 3);
  assert.equal(w.previous_offset_chars, 0);
});

test('buildWindowEnvelope on a trailing window that reaches the end has no next offset', () => {
  const w = buildWindowEnvelope({ text: 'ij', totalChars: 10, offset: 8, limit: 4 });
  assert.equal(w.start_chars, 8);
  assert.equal(w.end_chars, 10);
  assert.equal(w.complete, false, 'reaching the end from a non-zero offset is still not "complete"');
  assert.equal(w.has_more, false);
  assert.equal(w.next_offset_chars, null);
  assert.equal(w.previous_offset_chars, 4);
});

test('buildWindowEnvelope caps start_chars/end_chars at total when offset runs past the field', () => {
  // Backend returned no text because the offset is beyond the field length.
  const w = buildWindowEnvelope({ text: '', totalChars: 5, offset: 99, limit: 10 });
  assert.equal(w.start_chars, 5, 'start is clamped to total_chars');
  assert.equal(w.end_chars, 5, 'end never exceeds total_chars');
  assert.equal(w.complete, false, 'a window past offset 0 is not complete even when empty');
  assert.equal(w.has_more, false);
  assert.equal(w.next_offset_chars, null);
});

test('buildWindowEnvelope passes q-match coordinates straight through', () => {
  const w = buildWindowEnvelope({
    text: 'xxNEEDLEyy',
    totalChars: 10,
    offset: 0,
    limit: 10,
    matchStartChars: 2,
    matchEndChars: 8,
  });
  assert.equal(w.match_start_chars, 2);
  assert.equal(w.match_end_chars, 8);
});

// ─── classifyFieldType ──────────────────────────────────────────────────────

test('classifyFieldType maps SQLite and Postgres type names to the same coarse class', () => {
  assert.equal(classifyFieldType(null), 'absent');
  assert.equal(classifyFieldType(undefined), 'absent');

  // string: sqlite json_type -> 'text', postgres jsonb_typeof -> 'string'.
  assert.equal(classifyFieldType('text'), 'string');
  assert.equal(classifyFieldType('string'), 'string');

  // number: sqlite 'integer'/'real', postgres 'number'.
  assert.equal(classifyFieldType('integer'), 'number');
  assert.equal(classifyFieldType('real'), 'number');
  assert.equal(classifyFieldType('number'), 'number');

  // boolean: sqlite 'true'/'false', postgres 'boolean'.
  assert.equal(classifyFieldType('true'), 'boolean');
  assert.equal(classifyFieldType('false'), 'boolean');
  assert.equal(classifyFieldType('boolean'), 'boolean');

  assert.equal(classifyFieldType('null'), 'null');
  assert.equal(classifyFieldType('object'), 'object');
  assert.equal(classifyFieldType('array'), 'array');

  // Anything unrecognized is 'other', never silently 'string'.
  assert.equal(classifyFieldType('blob'), 'other');
  assert.equal(classifyFieldType('weird'), 'other');
});

// ─── assertReadableStringField ──────────────────────────────────────────────

test('assertReadableStringField accepts a string field', () => {
  assert.doesNotThrow(() => assertReadableStringField('body', 'string'));
});

test('assertReadableStringField reports an absent field as field_not_found (404)', () => {
  const err = catchFieldWindowError(
    () => assertReadableStringField('subject', 'absent'),
  );
  assert.equal(err.code, 'field_not_found');
  assert.equal(err.httpStatus, 404);
});

test('assertReadableStringField reports any present non-string field as field_not_text (422)', () => {
  for (const cls of ['number', 'boolean', 'null', 'object', 'array', 'other']) {
    const err = catchFieldWindowError(
      () => assertReadableStringField('read_count', cls),
    );
    assert.equal(err.code, 'field_not_text', `${cls} -> field_not_text`);
    assert.equal(err.httpStatus, 422, `${cls} -> 422`);
  }
});
