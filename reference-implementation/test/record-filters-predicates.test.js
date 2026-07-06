/**
 * Mutation-killing unit tests for the pure predicate/coercion helpers in
 * `server/record-filters.js`.
 *
 * `compileRequestFilters`'s error tree is already pinned by
 * `schema-capability-truth.test.js`. This file covers the OTHER exported
 * pure surface that has no by-name coverage: value coercion (incl. the
 * strict-mode throws), the in-memory filter/time-range predicates and
 * their inclusive/exclusive boundary semantics, the grant-constraint
 * gates, JSON-path escaping, and the row-scan guard that tolerates
 * malformed record JSON.
 *
 * The boundary assertions are the point: `gte` is inclusive, `gt`
 * exclusive, `lte` inclusive, `lt` exclusive; `time_range.since` is
 * inclusive, `until` exclusive. Off-by-one mutants (`<` vs `<=`) flip
 * exactly one of these and turn red here.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  allowedCandidateRecordKeysFromRows,
  coerceComparableValue,
  hasGrantRecordConstraints,
  jsonPathForTopLevelField,
  needsCandidateRecordScan,
  nonNullSchemaTypes,
  parseDateValue,
  passesGrantRecordConstraints,
  passesRequestFilters,
  passesTimeRange,
} from '../server/record-filters.js';

const INT = { type: 'integer' };
const NUM = { type: 'number' };
const STR = { type: 'string' };
const DATE = { type: 'string', format: 'date-time' };

test('nonNullSchemaTypes: strips null, handles scalar/array/absent type', () => {
  assert.deepEqual([...nonNullSchemaTypes(undefined)], []);
  assert.deepEqual([...nonNullSchemaTypes({})], []);
  assert.deepEqual([...nonNullSchemaTypes({ type: 'string' })], ['string']);
  // Nullable union: the 'null' member is removed, the real type kept.
  assert.deepEqual([...nonNullSchemaTypes({ type: ['string', 'null'] })], ['string']);
  assert.deepEqual([...nonNullSchemaTypes({ type: ['null'] })], []);
});

test('parseDateValue: parses ISO strings, rejects non-strings/blank/garbage', () => {
  assert.equal(parseDateValue('2026-01-02T00:00:00Z'), Date.parse('2026-01-02T00:00:00Z'));
  assert.equal(parseDateValue(''), null);
  assert.equal(parseDateValue('   '), null);
  assert.equal(parseDateValue('not-a-date'), null);
  // Non-string inputs are rejected by the typeof guard (numbers are NOT coerced).
  assert.equal(parseDateValue(1735776000000), null);
  assert.equal(parseDateValue(null), null);
});

test('coerceComparableValue: non-strict returns null on bad input; strict throws typed errors', () => {
  // null passes through as null regardless of schema/strict.
  assert.equal(coerceComparableValue(null, INT, { strict: true }), null);

  // integer: valid numeric string coerces; bad value is null (lax) or throws (strict).
  assert.equal(coerceComparableValue('42', INT), 42);
  assert.equal(coerceComparableValue('4.5', INT), null); // non-integer string -> null
  assert.equal(coerceComparableValue('nope', INT), null);
  assert.throws(
    () => coerceComparableValue('nope', INT, { strict: true }),
    (e) => e.code === 'invalid_request' && /Invalid integer value/.test(e.message),
    'strict integer coercion of garbage must throw invalid_request',
  );

  // number: finite string coerces; garbage null (lax) / throws (strict).
  assert.equal(coerceComparableValue('4.5', NUM), 4.5);
  assert.equal(coerceComparableValue('abc', NUM), null);
  assert.throws(
    () => coerceComparableValue('abc', NUM, { strict: true }),
    (e) => e.code === 'invalid_request' && /Invalid number value/.test(e.message),
  );

  // date-time string: parses to epoch ms; garbage null (lax) / throws (strict).
  assert.equal(coerceComparableValue('2026-01-01T00:00:00Z', DATE), Date.parse('2026-01-01T00:00:00Z'));
  assert.equal(coerceComparableValue('nope', DATE), null);
  assert.throws(
    () => coerceComparableValue('nope', DATE, { strict: true }),
    (e) => e.code === 'invalid_request' && /Invalid date value/.test(e.message),
  );

  // plain string / unknown schema -> String(value), never throws.
  assert.equal(coerceComparableValue(123, STR), '123');
  assert.equal(coerceComparableValue('x', {}, { strict: true }), 'x');
});

test('passesRequestFilters: empty/absent filters pass; exact match uses String() equality', () => {
  assert.equal(passesRequestFilters({ a: 1 }, undefined), true);
  assert.equal(passesRequestFilters({ a: 1 }, []), true);

  const exact = [{ field: 'status', kind: 'exact', value: 'active' }];
  assert.equal(passesRequestFilters({ status: 'active' }, exact), true);
  assert.equal(passesRequestFilters({ status: 'inactive' }, exact), false);
  // String() coercion: numeric 5 equals the exact string '5'.
  assert.equal(passesRequestFilters({ status: 5 }, [{ field: 'status', kind: 'exact', value: '5' }]), true);
  // A missing field stringifies to 'undefined' and fails a real value.
  assert.equal(passesRequestFilters({}, exact), false);
});

test('passesRequestFilters: range operator boundaries are gte-inclusive / gt-exclusive / lte-inclusive / lt-exclusive', () => {
  const f = (operators) => [{ field: 'amount', kind: 'range', fieldSchema: NUM, operators }];

  // gte: inclusive at the bound.
  assert.equal(passesRequestFilters({ amount: 10 }, f({ gte: 10 })), true);
  assert.equal(passesRequestFilters({ amount: 9.99 }, f({ gte: 10 })), false);

  // gt: exclusive at the bound.
  assert.equal(passesRequestFilters({ amount: 10 }, f({ gt: 10 })), false);
  assert.equal(passesRequestFilters({ amount: 10.01 }, f({ gt: 10 })), true);

  // lte: inclusive at the bound.
  assert.equal(passesRequestFilters({ amount: 10 }, f({ lte: 10 })), true);
  assert.equal(passesRequestFilters({ amount: 10.01 }, f({ lte: 10 })), false);

  // lt: exclusive at the bound.
  assert.equal(passesRequestFilters({ amount: 10 }, f({ lt: 10 })), false);
  assert.equal(passesRequestFilters({ amount: 9.99 }, f({ lt: 10 })), true);

  // Combined gte+lt window: [5, 20) contains 5, excludes 20.
  const window = f({ gte: 5, lt: 20 });
  assert.equal(passesRequestFilters({ amount: 5 }, window), true);
  assert.equal(passesRequestFilters({ amount: 20 }, window), false);
  assert.equal(passesRequestFilters({ amount: 12 }, window), true);

  // A value that cannot be coerced (null/garbage) fails the range.
  assert.equal(passesRequestFilters({ amount: null }, f({ gte: 5 })), false);
  assert.equal(passesRequestFilters({ amount: 'not-a-number' }, f({ gte: 5 })), false);
});

test('passesTimeRange: no-op without range/field; since inclusive, until exclusive; bad date fails', () => {
  const field = 'occurred_at';
  // Missing range or field -> always passes.
  assert.equal(passesTimeRange({ [field]: '2026-01-01T00:00:00Z' }, null, field), true);
  assert.equal(passesTimeRange({ [field]: '2026-01-01T00:00:00Z' }, { since: '2026-01-01T00:00:00Z' }, null), true);

  // Missing/blank value fails a real range.
  assert.equal(passesTimeRange({}, { since: '2026-01-01T00:00:00Z' }, field), false);
  // Unparseable date value fails.
  assert.equal(passesTimeRange({ [field]: 'garbage' }, { since: '2026-01-01T00:00:00Z' }, field), false);

  const since = '2026-01-10T00:00:00Z';
  const until = '2026-01-20T00:00:00Z';
  // since is INCLUSIVE: exactly at `since` passes; one ms before fails.
  assert.equal(passesTimeRange({ [field]: since }, { since }, field), true);
  assert.equal(passesTimeRange({ [field]: '2026-01-09T23:59:59.999Z' }, { since }, field), false);
  // until is EXCLUSIVE: exactly at `until` fails; one ms before passes.
  assert.equal(passesTimeRange({ [field]: until }, { until }, field), false);
  assert.equal(passesTimeRange({ [field]: '2026-01-19T23:59:59.999Z' }, { until }, field), true);
});

test('passesGrantRecordConstraints: resources allowlist gates by record key, then time range', () => {
  const stream = { consent_time_field: 'occurred_at' };

  // No resources + no time range -> always allowed.
  assert.equal(passesGrantRecordConstraints({}, 'k1', {}, stream), true);

  // resources present: only listed keys pass.
  const grant = { resources: ['k1', 'k2'] };
  assert.equal(passesGrantRecordConstraints({}, 'k1', grant, stream), true);
  assert.equal(passesGrantRecordConstraints({}, 'k9', grant, stream), false);

  // Allowed key still subject to the grant time_range.
  const timed = { resources: ['k1'], time_range: { since: '2026-02-01T00:00:00Z' } };
  assert.equal(
    passesGrantRecordConstraints({ occurred_at: '2026-01-01T00:00:00Z' }, 'k1', timed, stream),
    false,
    'key allowed but before since -> excluded',
  );
  assert.equal(
    passesGrantRecordConstraints({ occurred_at: '2026-03-01T00:00:00Z' }, 'k1', timed, stream),
    true,
  );
});

test('hasGrantRecordConstraints / needsCandidateRecordScan: detect time_range, non-empty resources, or filters', () => {
  assert.equal(hasGrantRecordConstraints(null), false);
  assert.equal(hasGrantRecordConstraints({}), false);
  // Empty resources array is NOT a constraint.
  assert.equal(hasGrantRecordConstraints({ resources: [] }), false);
  assert.equal(hasGrantRecordConstraints({ resources: ['k1'] }), true);
  assert.equal(hasGrantRecordConstraints({ time_range: { since: 'x' } }), true);

  // needsCandidateRecordScan: true if any compiled filters OR grant constraints.
  assert.equal(needsCandidateRecordScan({}, []), false);
  assert.equal(needsCandidateRecordScan({}, [{ field: 'a', kind: 'exact', value: '1' }]), true);
  assert.equal(needsCandidateRecordScan({ resources: ['k1'] }, []), true);
});

test('jsonPathForTopLevelField: quotes the field and escapes backslash then double-quote', () => {
  assert.equal(jsonPathForTopLevelField('amount'), '$."amount"');
  // A double-quote in the field name is backslash-escaped.
  assert.equal(jsonPathForTopLevelField('a"b'), '$."a\\"b"');
  // A backslash is doubled (and escaped BEFORE quotes, so a trailing
  // backslash+quote does not collapse into one escape).
  assert.equal(jsonPathForTopLevelField('a\\b'), '$."a\\\\b"');
  // Non-string field is stringified first.
  assert.equal(jsonPathForTopLevelField(7), '$."7"');
});

test('allowedCandidateRecordKeysFromRows: skips unparseable JSON, applies grant + filters', () => {
  const stream = { consent_time_field: 'occurred_at' };
  const streamGrant = { resources: ['k1', 'k2', 'k3'] };
  const compiledFilters = [{ field: 'status', kind: 'exact', value: 'active' }];

  const rows = [
    { record_key: 'k1', record_json: JSON.stringify({ status: 'active' }) }, // passes
    { record_key: 'k2', record_json: JSON.stringify({ status: 'archived' }) }, // filtered out
    { record_key: 'k3', record_json: '{ this is not json' }, // parse error -> skipped
    { record_key: 'k9', record_json: JSON.stringify({ status: 'active' }) }, // not in resources
  ];

  const allowed = allowedCandidateRecordKeysFromRows(rows, { streamGrant, manifestStream: stream, compiledFilters });
  assert.deepEqual(allowed, ['k1'], 'only k1 survives grant + filter; malformed row is skipped, not thrown');
});
