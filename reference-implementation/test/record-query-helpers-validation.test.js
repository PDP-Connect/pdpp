/**
 * Mutation-killing unit tests for the pure query-validation and
 * response-shape helpers in `server/record-query-helpers.ts`.
 *
 * These helpers gate the public read contract (count/window grade
 * vocabularies, canonical `sort` sign-prefix direction, the strict
 * `sort`/`order` disagreement rejection, compound-key codec, and the
 * meta-envelope merges). They are storage-agnostic and pure, so every
 * error/edge branch is pinned here without a database.
 *
 * Each assertion targets a specific branch: the guard that lets absent
 * values pass through, the exact thrown error `code`/`param`, the
 * boundary between `asc`/`desc`/default, the sign-prefix→direction
 * mapping, and the null-tolerant response decorators. A regression that
 * flips any of these guards or error codes turns one of these red.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SUPPORTED_COUNT_KINDS,
  SUPPORTED_WINDOW_KINDS,
  attachRequestWarningsToResponse,
  decodeKey,
  decorateRecordWithConnectionIdentity,
  encodeKey,
  mergeMetaCount,
  mergeMetaWindow,
  parsePageOrder,
  rejectListOnlyParamsForChangesFeed,
  resolveListOrder,
  validateCanonicalSort,
  validateCountKind,
  validateWindowKind,
} from '../server/record-query-helpers.ts';

// A tiny helper so a failing assertion prints WHY the throw expectation
// was not met (either it did not throw, or the code/param was wrong).
function assertThrowsWith(fn, { code, param, messageIncludes } = {}) {
  let thrown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'expected the call to throw, but it returned normally');
  if (code !== undefined) {
    assert.equal(
      thrown.code,
      code,
      `expected error.code=${code} but got ${JSON.stringify(thrown.code)} (message: ${thrown.message})`,
    );
  }
  if (param !== undefined) {
    assert.equal(
      thrown.param,
      param,
      `expected error.param=${param} but got ${JSON.stringify(thrown.param)}`,
    );
  }
  if (messageIncludes !== undefined) {
    assert.ok(
      String(thrown.message).includes(messageIncludes),
      `expected message to include "${messageIncludes}" but got "${thrown.message}"`,
    );
  }
  return thrown;
}

test('validateCountKind: null/empty pass through, unsupported/non-string throw invalid_request', () => {
  // Pass-through branch: absent values are the server's `none` default.
  assert.equal(validateCountKind(undefined), undefined);
  assert.equal(validateCountKind(null), undefined);
  assert.equal(validateCountKind(''), undefined);

  // Every advertised kind must be accepted (kills a mutant that narrows the set).
  for (const kind of SUPPORTED_COUNT_KINDS) {
    assert.equal(validateCountKind(kind), undefined, `expected '${kind}' to be accepted`);
  }

  // Unsupported string rejected with the typed code.
  assertThrowsWith(() => validateCountKind('approximate'), {
    code: 'invalid_request',
    messageIncludes: 'count must be one of',
  });
  // Non-string (array/number/object) rejected by the `typeof value !== 'string'` guard.
  assertThrowsWith(() => validateCountKind(['exact']), { code: 'invalid_request' });
  assertThrowsWith(() => validateCountKind(1), { code: 'invalid_request' });
});

test('validateWindowKind: only none|exact accepted; estimated is NOT a valid window', () => {
  assert.equal(validateWindowKind(undefined), undefined);
  assert.equal(validateWindowKind(''), undefined);
  assert.equal(validateWindowKind('none'), undefined);
  assert.equal(validateWindowKind('exact'), undefined);

  // `estimated` is valid for count but must be rejected for window — this
  // pins that the two vocabularies are distinct sets.
  assert.ok(!SUPPORTED_WINDOW_KINDS.has('estimated'));
  assertThrowsWith(() => validateWindowKind('estimated'), {
    code: 'invalid_request',
    messageIncludes: 'window must be one of',
  });
  assertThrowsWith(() => validateWindowKind({}), { code: 'invalid_request' });
});

test('rejectListOnlyParamsForChangesFeed: flags list-only params, singular/plural grammar, empty passes', () => {
  // No list-only params present -> returns without throwing.
  assert.equal(rejectListOnlyParamsForChangesFeed({}), undefined);
  assert.equal(rejectListOnlyParamsForChangesFeed({ sort: '', count: null }), undefined);
  assert.equal(rejectListOnlyParamsForChangesFeed({ changes_since: 'x' }), undefined);

  // Single offending param -> "is not supported" and code invalid_request.
  const single = assertThrowsWith(() => rejectListOnlyParamsForChangesFeed({ sort: '-emitted_at' }), {
    code: 'invalid_request',
    messageIncludes: 'is not supported with changes_since',
  });
  assert.ok(single.message.startsWith('sort '), `expected message to name 'sort': ${single.message}`);

  // Multiple offending params -> plural "are not supported".
  assertThrowsWith(
    () => rejectListOnlyParamsForChangesFeed({ sort: 'a', count: 'exact', order: 'asc', window: 'exact' }),
    { code: 'invalid_request', messageIncludes: 'are not supported with changes_since' },
  );
});

test('parsePageOrder: default DESC, asc/desc mapping, invalid throws', () => {
  // Default branch (absent / empty) is DESC — the newest-first list default.
  assert.equal(parsePageOrder(undefined), 'DESC');
  assert.equal(parsePageOrder(null), 'DESC');
  assert.equal(parsePageOrder(''), 'DESC');
  assert.equal(parsePageOrder('asc'), 'ASC');
  assert.equal(parsePageOrder('desc'), 'DESC');

  // Case-sensitive: only lowercase 'asc'/'desc' are accepted.
  assertThrowsWith(() => parsePageOrder('ASC'), {
    code: 'invalid_request',
    messageIncludes: 'order must be asc or desc',
  });
  assertThrowsWith(() => parsePageOrder('ascending'), { code: 'invalid_request' });
});

test('validateCanonicalSort: sign prefix controls direction against the cursor field', () => {
  const stream = { cursor_field: 'emitted_at' };

  // Absent sort -> null (no ordering override).
  assert.equal(validateCanonicalSort(undefined, stream), null);
  assert.equal(validateCanonicalSort('', stream), null);
  // Whitespace/comma-only entries collapse to zero entries -> null.
  assert.equal(validateCanonicalSort('  ,  ', stream), null);

  // No sign -> ASC; leading '-' -> DESC. The sign MUST NOT be ignored.
  assert.deepEqual(validateCanonicalSort('emitted_at', stream), {
    field: 'emitted_at',
    direction: 'ASC',
  });
  assert.deepEqual(validateCanonicalSort('-emitted_at', stream), {
    field: 'emitted_at',
    direction: 'DESC',
  });
});

test('validateCanonicalSort: rejects empty field, non-cursor field, and missing cursor_field', () => {
  const stream = { cursor_field: 'emitted_at' };

  // A bare '-' has no field after the sign -> invalid_sort / param sort.
  assertThrowsWith(() => validateCanonicalSort('-', stream), {
    code: 'invalid_sort',
    param: 'sort',
    messageIncludes: 'Empty sort field',
  });

  // A field that is not the advertised cursor field is rejected.
  assertThrowsWith(() => validateCanonicalSort('created_at', stream), {
    code: 'invalid_sort',
    param: 'sort',
    messageIncludes: 'not advertised as sortable',
  });

  // When the stream advertises no cursor_field, NOTHING is sortable.
  assertThrowsWith(() => validateCanonicalSort('emitted_at', { cursor_field: null }), {
    code: 'invalid_sort',
    param: 'sort',
  });
  assertThrowsWith(() => validateCanonicalSort('emitted_at', {}), {
    code: 'invalid_sort',
    param: 'sort',
  });
  // A null manifestStream must also reject (optional-chaining `?.` guard).
  assertThrowsWith(() => validateCanonicalSort('emitted_at', null), {
    code: 'invalid_sort',
    param: 'sort',
  });
});

test('validateCanonicalSort: conflicting directions across CSV entries throw', () => {
  const stream = { cursor_field: 'emitted_at' };
  // Two entries for the same field with opposite signs -> conflict.
  assertThrowsWith(() => validateCanonicalSort('emitted_at,-emitted_at', stream), {
    code: 'invalid_sort',
    param: 'sort',
    messageIncludes: 'Conflicting sort directions',
  });
  // Array input is joined with commas before parsing (kills a mutant that
  // drops the Array.isArray branch).
  assertThrowsWith(() => validateCanonicalSort(['emitted_at', '-emitted_at'], stream), {
    code: 'invalid_sort',
    param: 'sort',
    messageIncludes: 'Conflicting sort directions',
  });
});

test('resolveListOrder: canonical sort wins; order honored only when sort absent; disagreement rejected', () => {
  const asc = { field: 'emitted_at', direction: 'ASC' };
  const desc = { field: 'emitted_at', direction: 'DESC' };

  // No resolved sort -> falls back to parsePageOrder(order).
  assert.equal(resolveListOrder(undefined, null), 'DESC');
  assert.equal(resolveListOrder('asc', null), 'ASC');
  assert.equal(resolveListOrder('desc', null), 'DESC');

  // Resolved sort with no legacy order -> the sort direction is returned.
  assert.equal(resolveListOrder(undefined, asc), 'ASC');
  assert.equal(resolveListOrder('', desc), 'DESC');

  // Resolved sort AND a legacy order that AGREES -> the shared direction.
  assert.equal(resolveListOrder('asc', asc), 'ASC');
  assert.equal(resolveListOrder('desc', desc), 'DESC');

  // Resolved sort AND a legacy order that DISAGREES -> invalid_sort.
  assertThrowsWith(() => resolveListOrder('desc', asc), {
    code: 'invalid_sort',
    param: 'sort',
    messageIncludes: 'sort and order disagree',
  });
  assertThrowsWith(() => resolveListOrder('asc', desc), {
    code: 'invalid_sort',
    param: 'sort',
  });
});

test('encodeKey/decodeKey: round-trip arrays and strings; malformed JSON falls back to raw', () => {
  // Array keys encode to minified JSON arrays and decode back to arrays.
  assert.equal(encodeKey(['a', 'b']), '["a","b"]');
  assert.deepEqual(decodeKey('["a","b"]'), ['a', 'b']);

  // Scalar keys encode via String() and decode back to the same string.
  assert.equal(encodeKey('plain'), 'plain');
  assert.equal(encodeKey(42), '42');
  assert.equal(decodeKey('plain'), 'plain');

  // A JSON value that parses but is NOT an array must decode to the raw
  // string, not the parsed scalar (e.g. "42" stays "42", not 42).
  assert.equal(decodeKey('42'), '42');
  assert.equal(decodeKey('true'), 'true');

  // Malformed JSON must not throw; it returns the raw string unchanged.
  assert.equal(decodeKey('{not json'), '{not json');
});

test('decorateRecordWithConnectionIdentity: null-guarded, trims, sets alias + display name', () => {
  // Null record or null identity are no-ops (must not throw).
  assert.equal(decorateRecordWithConnectionIdentity(null, { connectionId: 'c' }), undefined);
  assert.equal(decorateRecordWithConnectionIdentity({}, null), undefined);

  // A trimmed non-empty connectionId sets BOTH the canonical field and the
  // deprecated alias to the same value.
  const rec = {};
  decorateRecordWithConnectionIdentity(rec, { connectionId: '  cin_1  ', displayName: '  My Bank ' });
  assert.equal(rec.connection_id, 'cin_1');
  assert.equal(rec.connector_instance_id, 'cin_1');
  assert.equal(rec.display_name, 'My Bank');

  // Whitespace-only / non-string identity fields are ignored (no keys added).
  const rec2 = {};
  decorateRecordWithConnectionIdentity(rec2, { connectionId: '   ', displayName: 123 });
  assert.ok(!('connection_id' in rec2), 'blank connectionId must not set connection_id');
  assert.ok(!('display_name' in rec2), 'non-string displayName must not set display_name');
});

test('attachRequestWarningsToResponse: guards + appends to existing warnings', () => {
  // Non-object response or empty/non-array warnings are no-ops.
  assert.equal(attachRequestWarningsToResponse(null, [{ code: 'w' }]), undefined);
  const noop = { data: [] };
  attachRequestWarningsToResponse(noop, []);
  assert.ok(!('meta' in noop), 'empty warnings must not create meta');

  // Fresh meta gets a warnings array.
  const resp = { data: [] };
  attachRequestWarningsToResponse(resp, [{ code: 'partial' }]);
  assert.deepEqual(resp.meta.warnings, [{ code: 'partial' }]);

  // Existing meta warnings are preserved and appended to (not replaced).
  const resp2 = { meta: { count: { kind: 'exact', value: 3 }, warnings: [{ code: 'a' }] } };
  attachRequestWarningsToResponse(resp2, [{ code: 'b' }]);
  assert.deepEqual(resp2.meta.warnings, [{ code: 'a' }, { code: 'b' }]);
  assert.deepEqual(resp2.meta.count, { kind: 'exact', value: 3 }, 'other meta members preserved');
});

test('mergeMetaCount/mergeMetaWindow: preserve prior members, ignore array meta', () => {
  // Preserve existing members while setting the new one.
  const merged = mergeMetaCount({ warnings: [{ code: 'w' }] }, { kind: 'exact', value: 5 });
  assert.deepEqual(merged.warnings, [{ code: 'w' }]);
  assert.deepEqual(merged.count, { kind: 'exact', value: 5 });

  // An array passed as "meta" is not a valid meta object -> start fresh.
  const fromArray = mergeMetaCount([1, 2, 3], { kind: 'none' });
  assert.deepEqual(fromArray, { count: { kind: 'none' } });
  assert.ok(!Array.isArray(fromArray));

  // window merge preserves count.
  const win = mergeMetaWindow({ count: { kind: 'exact', value: 5 } }, { kind: 'exact', value: 10 });
  assert.deepEqual(win.count, { kind: 'exact', value: 5 });
  assert.deepEqual(win.window, { kind: 'exact', value: 10 });
});
