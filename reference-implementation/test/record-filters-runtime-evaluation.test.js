// Pure, no-DB unit tests pinning the RUNTIME record-filter evaluators in
// server/record-filters.js. These functions decide whether an already-loaded
// record row satisfies the compiled query filters + grant constraints; they run
// on the hot per-record path and their boundary semantics (strict-vs-inclusive
// range comparisons, half-open time windows, resource allow-lists) are the exact
// off-by-one surface that a mutant flips. `compileRequestFilters` is exercised by
// schema-capability-truth.test.js; the *evaluation* side (passesRequestFilters,
// passesTimeRange, passesGrantRecordConstraints, allowedCandidateRecordKeysFromRows,
// needsCandidateRecordScan, hasGrantRecordConstraints) had ZERO by-name coverage.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  allowedCandidateRecordKeysFromRows,
  hasGrantRecordConstraints,
  needsCandidateRecordScan,
  passesGrantRecordConstraints,
  passesRequestFilters,
  passesTimeRange,
} from '../server/record-filters.js';

const intSchema = { type: 'integer' };

// --- passesRequestFilters: exact-kind -----------------------------------------

test('passesRequestFilters: exact filter compares via String() coercion', () => {
  const filters = [{ field: 'status', kind: 'exact', value: 'shipped' }];
  assert.equal(passesRequestFilters({ status: 'shipped' }, filters), true);
  assert.equal(passesRequestFilters({ status: 'pending' }, filters), false);
});

test('passesRequestFilters: exact filter coerces numeric record value to string', () => {
  // filter.value is always a String (normalizeExactFilterValue); the record
  // value is String()-ed before compare, so numeric 7 matches "7".
  const filters = [{ field: 'qty', kind: 'exact', value: '7' }];
  assert.equal(passesRequestFilters({ qty: 7 }, filters), true);
  assert.equal(passesRequestFilters({ qty: 8 }, filters), false);
});

test('passesRequestFilters: empty/absent filter list passes everything', () => {
  assert.equal(passesRequestFilters({ anything: 1 }, []), true);
  assert.equal(passesRequestFilters({ anything: 1 }, undefined), true);
  assert.equal(passesRequestFilters(null, null), true);
});

// --- passesRequestFilters: range boundary math (the mutant surface) -----------
// Contract from source:
//   gte -> reject when comparable <  gte   (value == gte is ACCEPTED, inclusive)
//   gt  -> reject when comparable <= gt    (value == gt  is REJECTED, exclusive)
//   lte -> reject when comparable >  lte   (value == lte is ACCEPTED, inclusive)
//   lt  -> reject when comparable >= lt    (value == lt  is REJECTED, exclusive)

function rangeFilter(operators) {
  return [{ field: 'n', kind: 'range', fieldSchema: intSchema, operators }];
}

test('passesRequestFilters: gte is INCLUSIVE at the boundary', () => {
  const f = rangeFilter({ gte: 10 });
  assert.equal(passesRequestFilters({ n: 9 }, f), false, 'below gte rejected');
  assert.equal(passesRequestFilters({ n: 10 }, f), true, 'at gte accepted (inclusive)');
  assert.equal(passesRequestFilters({ n: 11 }, f), true, 'above gte accepted');
});

test('passesRequestFilters: gt is EXCLUSIVE at the boundary', () => {
  const f = rangeFilter({ gt: 10 });
  assert.equal(passesRequestFilters({ n: 10 }, f), false, 'at gt rejected (exclusive)');
  assert.equal(passesRequestFilters({ n: 11 }, f), true, 'above gt accepted');
});

test('passesRequestFilters: lte is INCLUSIVE at the boundary', () => {
  const f = rangeFilter({ lte: 20 });
  assert.equal(passesRequestFilters({ n: 21 }, f), false, 'above lte rejected');
  assert.equal(passesRequestFilters({ n: 20 }, f), true, 'at lte accepted (inclusive)');
  assert.equal(passesRequestFilters({ n: 19 }, f), true, 'below lte accepted');
});

test('passesRequestFilters: lt is EXCLUSIVE at the boundary', () => {
  const f = rangeFilter({ lt: 20 });
  assert.equal(passesRequestFilters({ n: 20 }, f), false, 'at lt rejected (exclusive)');
  assert.equal(passesRequestFilters({ n: 19 }, f), true, 'below lt accepted');
});

test('passesRequestFilters: combined half-open window [gte, lt)', () => {
  const f = rangeFilter({ gte: 10, lt: 20 });
  assert.equal(passesRequestFilters({ n: 10 }, f), true, 'lower inclusive');
  assert.equal(passesRequestFilters({ n: 19 }, f), true, 'inside');
  assert.equal(passesRequestFilters({ n: 20 }, f), false, 'upper exclusive');
  assert.equal(passesRequestFilters({ n: 9 }, f), false, 'below lower');
});

test('passesRequestFilters: null/uncoercible record value fails any range filter', () => {
  const f = rangeFilter({ gte: 0 });
  // coerceComparableValue(null) -> null -> reject; a value 0 with gte:0 passes,
  // so this specifically pins the null-guard (not just "0 < 0").
  assert.equal(passesRequestFilters({ n: null }, f), false);
  assert.equal(passesRequestFilters({}, f), false, 'absent field rejected');
  assert.equal(passesRequestFilters({ n: 0 }, f), true, 'present 0 accepted (guard is null, not falsy)');
});

// --- passesTimeRange: half-open [since, until) --------------------------------

test('passesTimeRange: no timeRange or no field name is a pass-through', () => {
  assert.equal(passesTimeRange({ t: 'x' }, null, 't'), true);
  assert.equal(passesTimeRange({ t: '2020-01-01' }, { since: '2019-01-01' }, null), true);
});

test('passesTimeRange: since is INCLUSIVE, until is EXCLUSIVE (half-open)', () => {
  const field = 'occurred_at';
  const tr = { since: '2020-01-01T00:00:00Z', until: '2020-02-01T00:00:00Z' };
  // exactly at since -> t < since is false -> passes (inclusive lower)
  assert.equal(passesTimeRange({ [field]: '2020-01-01T00:00:00Z' }, tr, field), true, 'at since inclusive');
  // just before since -> rejected
  assert.equal(passesTimeRange({ [field]: '2019-12-31T23:59:59Z' }, tr, field), false, 'before since rejected');
  // exactly at until -> t >= until is true -> rejected (exclusive upper)
  assert.equal(passesTimeRange({ [field]: '2020-02-01T00:00:00Z' }, tr, field), false, 'at until exclusive');
  // just before until -> passes
  assert.equal(passesTimeRange({ [field]: '2020-01-31T23:59:59Z' }, tr, field), true, 'before until passes');
});

test('passesTimeRange: missing or unparseable field value is rejected', () => {
  const field = 'occurred_at';
  const tr = { since: '2020-01-01T00:00:00Z' };
  assert.equal(passesTimeRange({}, tr, field), false, 'absent value rejected');
  assert.equal(passesTimeRange({ [field]: 'not-a-date' }, tr, field), false, 'NaN date rejected');
});

// --- passesGrantRecordConstraints: resource allow-list + time_range -----------

test('passesGrantRecordConstraints: resource allow-list gates by record key', () => {
  const grant = { resources: ['rec-a', 'rec-b'] };
  assert.equal(passesGrantRecordConstraints({}, 'rec-a', grant, {}), true, 'allowed key passes');
  assert.equal(passesGrantRecordConstraints({}, 'rec-c', grant, {}), false, 'unlisted key rejected');
});

test('passesGrantRecordConstraints: empty resources means no key restriction', () => {
  assert.equal(passesGrantRecordConstraints({}, 'anything', { resources: [] }, {}), true);
  assert.equal(passesGrantRecordConstraints({}, 'anything', {}, {}), true);
});

test('passesGrantRecordConstraints: also enforces grant time_range against consent_time_field', () => {
  const grant = { time_range: { since: '2021-01-01T00:00:00Z' } };
  const manifestStream = { consent_time_field: 'ts' };
  assert.equal(
    passesGrantRecordConstraints({ ts: '2021-06-01T00:00:00Z' }, 'k', grant, manifestStream),
    true,
    'inside grant window passes',
  );
  assert.equal(
    passesGrantRecordConstraints({ ts: '2020-06-01T00:00:00Z' }, 'k', grant, manifestStream),
    false,
    'before grant since rejected',
  );
});

// --- hasGrantRecordConstraints / needsCandidateRecordScan ---------------------

test('hasGrantRecordConstraints: true only when time_range or non-empty resources', () => {
  assert.equal(hasGrantRecordConstraints({}), false);
  assert.equal(hasGrantRecordConstraints({ resources: [] }), false, 'empty resources is NOT a constraint');
  assert.equal(hasGrantRecordConstraints({ resources: ['x'] }), true);
  assert.equal(hasGrantRecordConstraints({ time_range: { since: 'x' } }), true);
});

test('needsCandidateRecordScan: true when filters present OR grant constrains records', () => {
  assert.equal(needsCandidateRecordScan({}, []), false, 'no filters, no constraints');
  assert.equal(needsCandidateRecordScan({}, [{ field: 'a' }]), true, 'has filters');
  assert.equal(needsCandidateRecordScan({ resources: ['x'] }, []), true, 'grant constrains');
});

// --- allowedCandidateRecordKeysFromRows: JSON parse + gate composition --------

test('allowedCandidateRecordKeysFromRows: returns only rows passing grant AND filters', () => {
  const streamGrant = { resources: ['keep-1', 'keep-2', 'time-out'] };
  const manifestStream = { consent_time_field: 'ts' };
  const compiledFilters = [{ field: 'n', kind: 'range', fieldSchema: intSchema, operators: { gte: 5 } }];
  const rows = [
    { record_key: 'keep-1', record_json: JSON.stringify({ n: 5, ts: '2021-01-01T00:00:00Z' }) },
    { record_key: 'keep-2', record_json: JSON.stringify({ n: 100, ts: '2021-01-01T00:00:00Z' }) },
    { record_key: 'filtered', record_json: JSON.stringify({ n: 4, ts: '2021-01-01T00:00:00Z' }) }, // fails gte:5
    { record_key: 'not-granted', record_json: JSON.stringify({ n: 9, ts: '2021-01-01T00:00:00Z' }) }, // not in resources
    { record_key: 'bad-json', record_json: '{not valid json' }, // parse failure -> skipped
    { record_key: 'null-json', record_json: null }, // null data -> passesGrant on null still ok, but filter n undefined -> skipped
  ];
  const allowed = allowedCandidateRecordKeysFromRows(rows, { streamGrant, manifestStream, compiledFilters });
  assert.deepEqual(allowed, ['keep-1', 'keep-2']);
});

test('allowedCandidateRecordKeysFromRows: malformed JSON is skipped, not thrown', () => {
  const rows = [{ record_key: 'x', record_json: 'definitely {{ not json' }];
  const allowed = allowedCandidateRecordKeysFromRows(rows, {
    streamGrant: {},
    manifestStream: {},
    compiledFilters: [],
  });
  assert.deepEqual(allowed, [], 'bad JSON yields no keys and no throw');
});
