// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure record-query validation / response-shape helpers.
 *
 * record-query-helpers.js is storage-agnostic and shared by the SQLite and
 * Postgres record paths, but had no co-named test and none of its exports
 * appeared under test/. All functions here are pure (no I/O), so they are
 * exercised directly. Coverage targets:
 *   - count/window grade vocabulary validation (+ invalid-query throws),
 *   - changes-feed list-only param rejection (singular/plural grammar),
 *   - canonical sort parsing: sign→direction, cursor-field gating,
 *     conflicting-direction + empty-field errors,
 *   - order parsing + sort/order reconciliation,
 *   - compound key encode/decode round-trips,
 *   - record connection-identity decoration (trim + placeholder skip),
 *   - meta.warnings / meta.count / meta.window envelope merges.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateCountKind,
  validateWindowKind,
  rejectListOnlyParamsForChangesFeed,
  validateCanonicalSort,
  parsePageOrder,
  resolveListOrder,
  encodeKey,
  decodeKey,
  decorateRecordWithConnectionIdentity,
  attachRequestWarningsToResponse,
  mergeMetaCount,
  mergeMetaWindow,
} from '../server/record-query-helpers.ts';

test('validateCountKind passes canonical grades and absent values', () => {
  for (const v of [undefined, null, '', 'none', 'estimated', 'exact']) {
    assert.doesNotThrow(() => validateCountKind(v));
  }
});

test('validateCountKind rejects unknown grades', () => {
  assert.throws(() => validateCountKind('approx'), /count must be one of/);
  assert.throws(() => validateCountKind(5), /count must be one of/);
});

test('validateWindowKind passes none/exact/absent and rejects others', () => {
  for (const v of [undefined, null, '', 'none', 'exact']) {
    assert.doesNotThrow(() => validateWindowKind(v));
  }
  assert.throws(() => validateWindowKind('estimated'), /window must be one of/);
});

test('rejectListOnlyParamsForChangesFeed uses singular grammar for one param', () => {
  assert.doesNotThrow(() => rejectListOnlyParamsForChangesFeed({}));
  assert.doesNotThrow(() => rejectListOnlyParamsForChangesFeed({ sort: '' }));
  assert.throws(
    () => rejectListOnlyParamsForChangesFeed({ sort: '-x' }),
    (e) => /sort is not supported with changes_since/.test(e.message) && e.code === 'invalid_request',
  );
});

test('rejectListOnlyParamsForChangesFeed uses plural grammar for multiple params', () => {
  assert.throws(
    () => rejectListOnlyParamsForChangesFeed({ sort: '-x', count: 'exact', window: 'exact' }),
    /sort, count, window are not supported with changes_since/,
  );
});

test('validateCanonicalSort returns null for absent sort', () => {
  assert.equal(validateCanonicalSort(null, { cursor_field: 'ts' }), null);
  assert.equal(validateCanonicalSort('', { cursor_field: 'ts' }), null);
});

test('validateCanonicalSort maps sign prefix to direction on the cursor field', () => {
  const ms = { cursor_field: 'emitted_at' };
  assert.deepEqual(validateCanonicalSort('emitted_at', ms), { field: 'emitted_at', direction: 'ASC' });
  assert.deepEqual(validateCanonicalSort('-emitted_at', ms), { field: 'emitted_at', direction: 'DESC' });
});

test('validateCanonicalSort rejects non-cursor fields as invalid_sort', () => {
  const ms = { cursor_field: 'emitted_at' };
  assert.throws(
    () => validateCanonicalSort('other', ms),
    (e) => e.code === 'invalid_sort' && e.param === 'sort',
  );
  // No cursor field advertised -> nothing is sortable.
  assert.throws(() => validateCanonicalSort('emitted_at', {}), (e) => e.code === 'invalid_sort');
});

test('validateCanonicalSort rejects empty field and conflicting directions', () => {
  const ms = { cursor_field: 'ts' };
  assert.throws(() => validateCanonicalSort('-', ms), /Empty sort field/);
  assert.throws(
    () => validateCanonicalSort('ts,-ts', ms),
    /Conflicting sort directions/,
  );
  // Same direction repeated is fine.
  assert.deepEqual(validateCanonicalSort('ts,ts', ms), { field: 'ts', direction: 'ASC' });
});

test('parsePageOrder defaults to DESC and maps asc/desc', () => {
  assert.equal(parsePageOrder(null), 'DESC');
  assert.equal(parsePageOrder(''), 'DESC');
  assert.equal(parsePageOrder('asc'), 'ASC');
  assert.equal(parsePageOrder('desc'), 'DESC');
  assert.throws(() => parsePageOrder('sideways'), /order must be asc or desc/);
});

test('resolveListOrder prefers canonical sort direction', () => {
  assert.equal(resolveListOrder(null, { field: 'ts', direction: 'DESC' }), 'DESC');
  assert.equal(resolveListOrder('desc', { field: 'ts', direction: 'DESC' }), 'DESC');
});

test('resolveListOrder rejects sort/order disagreement', () => {
  assert.throws(
    () => resolveListOrder('asc', { field: 'ts', direction: 'DESC' }),
    (e) => e.code === 'invalid_sort',
  );
});

test('resolveListOrder falls back to order when no sort', () => {
  assert.equal(resolveListOrder('asc', null), 'ASC');
  assert.equal(resolveListOrder(null, null), 'DESC');
});

test('encodeKey / decodeKey round-trip strings and compound arrays', () => {
  assert.equal(encodeKey('k'), 'k');
  assert.equal(encodeKey(42), '42');
  assert.equal(encodeKey(['a', 'b']), '["a","b"]');
  assert.deepEqual(decodeKey('["a","b"]'), ['a', 'b']);
  // A plain string that isn't a JSON array decodes to itself.
  assert.equal(decodeKey('plain'), 'plain');
  // A JSON scalar decodes back to the original string form, not the parsed scalar.
  assert.equal(decodeKey('42'), '42');
});

test('decorateRecordWithConnectionIdentity sets both id fields from a trimmed connectionId', () => {
  const rec = {};
  decorateRecordWithConnectionIdentity(rec, { connectionId: '  cin_x  ', displayName: '  Gmail  ' });
  assert.equal(rec.connection_id, 'cin_x');
  assert.equal(rec.connector_instance_id, 'cin_x');
  assert.equal(rec.display_name, 'Gmail');
});

test('decorateRecordWithConnectionIdentity omits blank identity and display name', () => {
  const rec = {};
  decorateRecordWithConnectionIdentity(rec, { connectionId: '   ', displayName: '   ' });
  assert.equal('connection_id' in rec, false);
  assert.equal('display_name' in rec, false);
  // Null record / identity are no-ops.
  assert.doesNotThrow(() => decorateRecordWithConnectionIdentity(null, { connectionId: 'x' }));
});

test('attachRequestWarningsToResponse appends and preserves existing meta', () => {
  const resp = { meta: { count: { kind: 'exact', value: 3 }, warnings: [{ code: 'a' }] } };
  attachRequestWarningsToResponse(resp, [{ code: 'b' }]);
  assert.deepEqual(resp.meta.warnings, [{ code: 'a' }, { code: 'b' }]);
  assert.deepEqual(resp.meta.count, { kind: 'exact', value: 3 });
  // Empty warnings / non-object response are no-ops.
  const resp2 = {};
  attachRequestWarningsToResponse(resp2, []);
  assert.equal('meta' in resp2, false);
});

test('mergeMetaCount / mergeMetaWindow preserve sibling meta members', () => {
  const meta = mergeMetaCount({ warnings: [{ code: 'w' }] }, { kind: 'exact', value: 9 });
  assert.deepEqual(meta.warnings, [{ code: 'w' }]);
  assert.deepEqual(meta.count, { kind: 'exact', value: 9 });

  const meta2 = mergeMetaWindow(meta, { kind: 'exact' });
  assert.deepEqual(meta2.count, { kind: 'exact', value: 9 });
  assert.deepEqual(meta2.window, { kind: 'exact' });
  // Array-shaped or missing meta starts from a clean object.
  assert.deepEqual(mergeMetaCount([], { kind: 'none' }), { count: { kind: 'none' } });
});
