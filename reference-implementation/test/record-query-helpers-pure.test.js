// Pure, no-DB unit tests for server/record-query-helpers.ts. NO test imports
// this module by name; all 12 exports were unpinned. These are the shared
// query-validation + response-envelope helpers used by both the SQLite and
// Postgres record paths, so a regression here breaks both backends identically.
//
// Mutation surface:
//   validateCanonicalSort  -- sign-prefix direction (-field=DESC), cursor-field
//     allowlist -> invalid_sort, conflicting directions -> invalid_sort.
//   resolveListOrder       -- canonical `sort` wins; sort/order disagreement ->
//     invalid_sort; default DESC.
//   parsePageOrder         -- asc/desc/default-DESC + invalid reject.
//   validateCountKind / validateWindowKind -- closed vocabularies.
//   rejectListOnlyParamsForChangesFeed -- list-only param rejection on changes feed.
//   encodeKey / decodeKey  -- compound-key round-trip (JSON array vs plain string).
//   attachRequestWarningsToResponse / mergeMetaCount / mergeMetaWindow -- meta
//     envelope assembly that must PRESERVE sibling members.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
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

const streamCursor = { cursor_field: 'emitted_at' };

function expectInvalidSort(fn) {
  assert.throws(fn, (err) => {
    assert.equal(err.code, 'invalid_sort', `expected invalid_sort, got ${err.code}`);
    assert.equal(err.param, 'sort');
    return true;
  });
}

// ---------------------------------------------------------------------------
// validateCanonicalSort
// ---------------------------------------------------------------------------

test('validateCanonicalSort: null/empty sort yields null', () => {
  assert.equal(validateCanonicalSort(null, streamCursor), null);
  assert.equal(validateCanonicalSort('', streamCursor), null);
});

test('validateCanonicalSort: sign prefix controls direction on the cursor field', () => {
  assert.deepEqual(validateCanonicalSort('emitted_at', streamCursor), { field: 'emitted_at', direction: 'ASC' });
  assert.deepEqual(validateCanonicalSort('-emitted_at', streamCursor), { field: 'emitted_at', direction: 'DESC' });
});

test('validateCanonicalSort: a non-cursor field is invalid_sort', () => {
  expectInvalidSort(() => validateCanonicalSort('created_at', streamCursor));
  expectInvalidSort(() => validateCanonicalSort('-created_at', streamCursor));
});

test('validateCanonicalSort: no advertised cursor field means nothing is sortable', () => {
  expectInvalidSort(() => validateCanonicalSort('emitted_at', {}));
});

test('validateCanonicalSort: conflicting directions for the same field is invalid_sort', () => {
  expectInvalidSort(() => validateCanonicalSort('emitted_at,-emitted_at', streamCursor));
});

test('validateCanonicalSort: array form is joined and validated', () => {
  assert.deepEqual(validateCanonicalSort(['-emitted_at'], streamCursor), { field: 'emitted_at', direction: 'DESC' });
});

// ---------------------------------------------------------------------------
// parsePageOrder / resolveListOrder
// ---------------------------------------------------------------------------

test('parsePageOrder: asc/desc parsed, default DESC, invalid rejected', () => {
  assert.equal(parsePageOrder('asc'), 'ASC');
  assert.equal(parsePageOrder('desc'), 'DESC');
  assert.equal(parsePageOrder(null), 'DESC', 'default order is DESC');
  assert.equal(parsePageOrder(''), 'DESC');
  assert.throws(() => parsePageOrder('sideways'), /order must be asc or desc/);
  assert.throws(() => parsePageOrder('ASC'), /order must be asc or desc/, 'case-sensitive: ASC is invalid');
});

test('resolveListOrder: canonical sort direction wins over absent order', () => {
  assert.equal(resolveListOrder(null, { field: 'emitted_at', direction: 'ASC' }), 'ASC');
  assert.equal(resolveListOrder('', { field: 'emitted_at', direction: 'DESC' }), 'DESC');
});

test('resolveListOrder: sort and matching legacy order is fine', () => {
  assert.equal(resolveListOrder('asc', { field: 'emitted_at', direction: 'ASC' }), 'ASC');
});

test('resolveListOrder: sort and DISAGREEING legacy order is invalid_sort', () => {
  expectInvalidSort(() => resolveListOrder('desc', { field: 'emitted_at', direction: 'ASC' }));
});

test('resolveListOrder: with no sort, falls back to legacy order (default DESC)', () => {
  assert.equal(resolveListOrder('asc', null), 'ASC');
  assert.equal(resolveListOrder(null, null), 'DESC');
});

// ---------------------------------------------------------------------------
// validateCountKind / validateWindowKind
// ---------------------------------------------------------------------------

test('validateCountKind: accepts none/estimated/exact, absent passes, others reject', () => {
  assert.doesNotThrow(() => validateCountKind('none'));
  assert.doesNotThrow(() => validateCountKind('estimated'));
  assert.doesNotThrow(() => validateCountKind('exact'));
  assert.doesNotThrow(() => validateCountKind(null));
  assert.doesNotThrow(() => validateCountKind(''));
  assert.throws(() => validateCountKind('approximate'), /count must be one of/);
  assert.throws(() => validateCountKind('EXACT'), /count must be one of/, 'case-sensitive');
});

test('validateWindowKind: accepts none/exact only, rejects estimated (not a window grade)', () => {
  assert.doesNotThrow(() => validateWindowKind('none'));
  assert.doesNotThrow(() => validateWindowKind('exact'));
  assert.doesNotThrow(() => validateWindowKind(''));
  assert.throws(() => validateWindowKind('estimated'), /window must be one of/, 'estimated is valid for count but NOT window');
  assert.throws(() => validateWindowKind('all'), /window must be one of/);
});

// ---------------------------------------------------------------------------
// rejectListOnlyParamsForChangesFeed
// ---------------------------------------------------------------------------

test('rejectListOnlyParamsForChangesFeed: no list-only params is a no-op', () => {
  assert.doesNotThrow(() => rejectListOnlyParamsForChangesFeed({}));
  assert.doesNotThrow(() => rejectListOnlyParamsForChangesFeed({ sort: '', count: '' }));
  assert.doesNotThrow(() => rejectListOnlyParamsForChangesFeed({ changes_since: 'x' }));
});

test('rejectListOnlyParamsForChangesFeed: any of sort/count/order/window is invalid_request', () => {
  for (const key of ['sort', 'count', 'order', 'window']) {
    assert.throws(
      () => rejectListOnlyParamsForChangesFeed({ [key]: 'v' }),
      (err) => {
        assert.equal(err.code, 'invalid_request');
        assert.ok(err.message.includes(key), `message should name ${key}`);
        return true;
      },
      `expected rejection for ${key}`,
    );
  }
});

test('rejectListOnlyParamsForChangesFeed: singular vs plural verb agreement', () => {
  assert.throws(() => rejectListOnlyParamsForChangesFeed({ sort: 'a' }), /sort is not supported/);
  assert.throws(() => rejectListOnlyParamsForChangesFeed({ sort: 'a', count: 'b' }), /sort, count are not supported/);
});

// ---------------------------------------------------------------------------
// encodeKey / decodeKey (compound-key round-trip)
// ---------------------------------------------------------------------------

test('encodeKey/decodeKey: single string round-trips unchanged', () => {
  assert.equal(encodeKey('abc'), 'abc');
  assert.equal(decodeKey('abc'), 'abc');
  assert.equal(decodeKey(encodeKey('rec-1')), 'rec-1');
});

test('encodeKey/decodeKey: compound array round-trips to an array', () => {
  const key = ['order-1', 'item-2'];
  const encoded = encodeKey(key);
  assert.equal(encoded, '["order-1","item-2"]');
  assert.deepEqual(decodeKey(encoded), key);
});

test('encodeKey: numeric key is stringified', () => {
  assert.equal(encodeKey(42), '42');
});

test('decodeKey: a plain string that is not a JSON array stays a string', () => {
  // '42' JSON-parses to a number (not an array) -> returns the original string.
  assert.equal(decodeKey('42'), '42');
  // an object literal JSON also is not an array -> original string returned.
  assert.equal(decodeKey('{"a":1}'), '{"a":1}');
});

// ---------------------------------------------------------------------------
// meta-envelope assembly (must preserve sibling members)
// ---------------------------------------------------------------------------

test('attachRequestWarningsToResponse: appends to existing meta.warnings, preserves other meta', () => {
  const response = { data: [], meta: { count: { kind: 'exact', value: 3 }, warnings: [{ code: 'a' }] } };
  attachRequestWarningsToResponse(response, [{ code: 'b' }]);
  assert.deepEqual(response.meta.warnings, [{ code: 'a' }, { code: 'b' }], 'appends, preserving existing');
  assert.deepEqual(response.meta.count, { kind: 'exact', value: 3 }, 'preserves sibling meta.count');
});

test('attachRequestWarningsToResponse: empty/absent warnings is a no-op', () => {
  const response = { data: [] };
  attachRequestWarningsToResponse(response, []);
  assert.equal(response.meta, undefined, 'no meta created for empty warnings');
  attachRequestWarningsToResponse(response, null);
  assert.equal(response.meta, undefined);
});

test('mergeMetaCount: sets count while preserving warnings and window', () => {
  const merged = mergeMetaCount({ warnings: [{ code: 'x' }], window: { kind: 'exact' } }, { kind: 'estimated', value: 9 });
  assert.deepEqual(merged.count, { kind: 'estimated', value: 9 });
  assert.deepEqual(merged.warnings, [{ code: 'x' }], 'warnings preserved');
  assert.deepEqual(merged.window, { kind: 'exact' }, 'window preserved');
});

test('mergeMetaWindow: sets window while preserving count and warnings', () => {
  const merged = mergeMetaWindow({ count: { kind: 'exact', value: 2 }, warnings: [] }, { kind: 'exact', total: 5 });
  assert.deepEqual(merged.window, { kind: 'exact', total: 5 });
  assert.deepEqual(merged.count, { kind: 'exact', value: 2 }, 'count preserved');
});

test('mergeMetaCount/Window: non-object existing meta yields a fresh object', () => {
  assert.deepEqual(mergeMetaCount(null, { kind: 'none' }), { count: { kind: 'none' } });
  assert.deepEqual(mergeMetaWindow(undefined, { kind: 'exact' }), { window: { kind: 'exact' } });
});

// ---------------------------------------------------------------------------
// decorateRecordWithConnectionIdentity
// ---------------------------------------------------------------------------

test('decorateRecordWithConnectionIdentity: sets both canonical id and deprecated alias to the same value', () => {
  const record = {};
  decorateRecordWithConnectionIdentity(record, { connectionId: '  ci-1  ', displayName: '  My Gmail  ' });
  assert.equal(record.connection_id, 'ci-1', 'trimmed canonical id');
  assert.equal(record.connector_instance_id, 'ci-1', 'alias mirrors canonical id');
  assert.equal(record.display_name, 'My Gmail', 'trimmed display name');
});

test('decorateRecordWithConnectionIdentity: blank identity fields are omitted', () => {
  const record = {};
  decorateRecordWithConnectionIdentity(record, { connectionId: '   ', displayName: '' });
  assert.equal(record.connection_id, undefined, 'blank connection id not attached');
  assert.equal(record.display_name, undefined, 'blank display name not attached');
});
