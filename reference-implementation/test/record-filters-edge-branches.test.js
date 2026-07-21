/**
 * Mutation-killing unit coverage for the pure error-path and edge-case
 * branches of `server/record-filters.js`.
 *
 * The end-to-end filter tests (`records-nullable-filters`,
 * `schema-capability-truth`) exercise `compileRequestFilters` through the
 * happy and typed-rejection paths, but the runtime-side evaluators
 * (`passesRequestFilters`, `passesTimeRange`, `passesGrantRecordConstraints`)
 * and several `compileRequestFilters` / `coerceComparableValue` guards had no
 * direct assertion pinning their behavior. A mutant that flips a comparison
 * operator (`<` -> `<=`), drops a null-guard, or short-circuits an
 * error-throw would survive today.
 *
 * These tests observe the module's public contract only; they do not change
 * any source logic (including the grant-scope check in
 * `passesGrantRecordConstraints`).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  coerceComparableValue,
  compileRequestFilters,
  invalidQueryError,
  passesGrantRecordConstraints,
  passesRequestFilters,
  passesTimeRange,
} from '../server/record-filters.js';

const DATE_TIME_SCHEMA = { type: 'string', format: 'date-time' };
const INTEGER_SCHEMA = { type: 'integer' };
const NUMBER_SCHEMA = { type: 'number' };
const STRING_SCHEMA = { type: 'string' };

function manifestStream({ rangeFilters = {}, properties = {} } = {}) {
  return {
    name: 'messages',
    primary_key: ['message_id'],
    cursor_field: 'received_at',
    consent_time_field: 'received_at',
    schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string' },
        subject: { type: 'string' },
        received_at: DATE_TIME_SCHEMA,
        ...properties,
      },
    },
    query: { range_filters: rangeFilters },
  };
}

const NO_FIELD_LIMIT = { fields: undefined };

// ─── invalidQueryError ───────────────────────────────────────────────────

test('invalidQueryError defaults to invalid_request code', () => {
  const err = invalidQueryError('boom');
  assert.ok(err instanceof Error);
  assert.equal(err.message, 'boom');
  assert.equal(err.code, 'invalid_request');
});

test('invalidQueryError honors an explicit code', () => {
  const err = invalidQueryError('boom', 'field_not_granted');
  assert.equal(err.code, 'field_not_granted');
});

// ─── compileRequestFilters — top-level shape guards ──────────────────────

test('compileRequestFilters treats null filter as empty', () => {
  assert.deepEqual(compileRequestFilters(null, NO_FIELD_LIMIT, manifestStream()), []);
});

test('compileRequestFilters treats undefined filter as empty', () => {
  assert.deepEqual(
    compileRequestFilters(undefined, NO_FIELD_LIMIT, manifestStream()),
    [],
  );
});

test('compileRequestFilters rejects an array filter', () => {
  assert.throws(
    () => compileRequestFilters(['x'], NO_FIELD_LIMIT, manifestStream()),
    (err) => err.code === 'invalid_request' && /filter\[field\]/.test(err.message),
  );
});

test('compileRequestFilters rejects a scalar (non-object) filter', () => {
  assert.throws(
    () => compileRequestFilters('subject=x', NO_FIELD_LIMIT, manifestStream()),
    (err) => err.code === 'invalid_request' && /filter\[field\]/.test(err.message),
  );
});

test('compileRequestFilters accepts an empty-object filter as no filters', () => {
  assert.deepEqual(compileRequestFilters({}, NO_FIELD_LIMIT, manifestStream()), []);
});

// ─── compileRequestFilters — range operator-map guards ───────────────────

test('compileRequestFilters rejects an empty range operator map', () => {
  const stream = manifestStream({ rangeFilters: { received_at: ['gte'] } });
  assert.throws(
    () => compileRequestFilters({ received_at: {} }, NO_FIELD_LIMIT, stream),
    (err) =>
      err.code === 'invalid_request' &&
      /must include at least one operator/.test(err.message),
  );
});

test('compileRequestFilters rejects a range value that coerces to a bad integer', () => {
  const stream = manifestStream({
    rangeFilters: { count: ['gte'] },
    properties: { count: INTEGER_SCHEMA },
  });
  assert.throws(
    () => compileRequestFilters({ count: { gte: 'not-a-number' } }, NO_FIELD_LIMIT, stream),
    (err) => err.code === 'invalid_request' && /Invalid integer value/.test(err.message),
  );
});

test('compileRequestFilters compiles a valid multi-operator range', () => {
  const stream = manifestStream({ rangeFilters: { received_at: ['gte', 'lt'] } });
  const compiled = compileRequestFilters(
    { received_at: { gte: '2026-01-01T00:00:00Z', lt: '2026-02-01T00:00:00Z' } },
    NO_FIELD_LIMIT,
    stream,
  );
  assert.equal(compiled.length, 1);
  assert.equal(compiled[0].kind, 'range');
  assert.ok(compiled[0].operators.gte != null && compiled[0].operators.lt != null);
});

// ─── coerceComparableValue — strict error paths ──────────────────────────

test('coerceComparableValue returns null for nullish input regardless of strict', () => {
  assert.equal(coerceComparableValue(null, INTEGER_SCHEMA, { strict: true }), null);
  assert.equal(coerceComparableValue(undefined, INTEGER_SCHEMA, { strict: true }), null);
});

test('coerceComparableValue strict throws on bad integer', () => {
  assert.throws(
    () => coerceComparableValue('12.5', INTEGER_SCHEMA, { strict: true }),
    (err) => err.code === 'invalid_request' && /Invalid integer value/.test(err.message),
  );
});

test('coerceComparableValue non-strict returns null on bad integer', () => {
  assert.equal(coerceComparableValue('12.5', INTEGER_SCHEMA), null);
});

test('coerceComparableValue strict throws on bad number', () => {
  assert.throws(
    () => coerceComparableValue('abc', NUMBER_SCHEMA, { strict: true }),
    (err) => err.code === 'invalid_request' && /Invalid number value/.test(err.message),
  );
});

test('coerceComparableValue strict throws on bad date', () => {
  assert.throws(
    () => coerceComparableValue('not-a-date', DATE_TIME_SCHEMA, { strict: true }),
    (err) => err.code === 'invalid_request' && /Invalid date value/.test(err.message),
  );
});

test('coerceComparableValue coerces a valid integer string', () => {
  assert.equal(coerceComparableValue('  42 ', INTEGER_SCHEMA), 42);
});

test('coerceComparableValue coerces a valid number string', () => {
  assert.equal(coerceComparableValue('3.14', NUMBER_SCHEMA), 3.14);
});

test('coerceComparableValue coerces a date-time to epoch millis', () => {
  const expected = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(coerceComparableValue('2026-01-01T00:00:00Z', DATE_TIME_SCHEMA), expected);
});

test('coerceComparableValue falls back to String for an untyped/ambiguous schema', () => {
  // No single scalar type declared -> stringify.
  assert.equal(coerceComparableValue(123, { type: ['integer', 'string'] }), '123');
  assert.equal(coerceComparableValue('raw', undefined), 'raw');
});

test('coerceComparableValue stringifies a plain-string (non-date) field', () => {
  assert.equal(coerceComparableValue(7, STRING_SCHEMA), '7');
});

// ─── passesRequestFilters — evaluation branches ──────────────────────────

test('passesRequestFilters returns true for no filters', () => {
  assert.equal(passesRequestFilters({ a: 1 }, []), true);
  assert.equal(passesRequestFilters({ a: 1 }, null), true);
  assert.equal(passesRequestFilters({ a: 1 }, undefined), true);
});

test('passesRequestFilters exact match compares stringified value', () => {
  const filters = [{ field: 'subject', kind: 'exact', value: 'hello' }];
  assert.equal(passesRequestFilters({ subject: 'hello' }, filters), true);
  assert.equal(passesRequestFilters({ subject: 'world' }, filters), false);
});

test('passesRequestFilters exact match coerces record value via String()', () => {
  const filters = [{ field: 'count', kind: 'exact', value: '5' }];
  assert.equal(passesRequestFilters({ count: 5 }, filters), true);
  assert.equal(passesRequestFilters({ count: 6 }, filters), false);
});

test('passesRequestFilters range rejects a record whose value coerces to null', () => {
  const filters = [
    {
      field: 'count',
      kind: 'range',
      fieldSchema: INTEGER_SCHEMA,
      operators: { gte: 1 },
    },
  ];
  // Missing field -> comparable null -> excluded.
  assert.equal(passesRequestFilters({}, filters), false);
  // Non-integer string -> comparable null -> excluded.
  assert.equal(passesRequestFilters({ count: 'x' }, filters), false);
});

test('passesRequestFilters enforces gte boundary (inclusive lower)', () => {
  const filters = [
    { field: 'n', kind: 'range', fieldSchema: INTEGER_SCHEMA, operators: { gte: 10 } },
  ];
  assert.equal(passesRequestFilters({ n: 9 }, filters), false);
  assert.equal(passesRequestFilters({ n: 10 }, filters), true);
  assert.equal(passesRequestFilters({ n: 11 }, filters), true);
});

test('passesRequestFilters enforces gt boundary (exclusive lower)', () => {
  const filters = [
    { field: 'n', kind: 'range', fieldSchema: INTEGER_SCHEMA, operators: { gt: 10 } },
  ];
  assert.equal(passesRequestFilters({ n: 10 }, filters), false);
  assert.equal(passesRequestFilters({ n: 11 }, filters), true);
});

test('passesRequestFilters enforces lte boundary (inclusive upper)', () => {
  const filters = [
    { field: 'n', kind: 'range', fieldSchema: INTEGER_SCHEMA, operators: { lte: 10 } },
  ];
  assert.equal(passesRequestFilters({ n: 11 }, filters), false);
  assert.equal(passesRequestFilters({ n: 10 }, filters), true);
  assert.equal(passesRequestFilters({ n: 9 }, filters), true);
});

test('passesRequestFilters enforces lt boundary (exclusive upper)', () => {
  const filters = [
    { field: 'n', kind: 'range', fieldSchema: INTEGER_SCHEMA, operators: { lt: 10 } },
  ];
  assert.equal(passesRequestFilters({ n: 10 }, filters), false);
  assert.equal(passesRequestFilters({ n: 9 }, filters), true);
});

test('passesRequestFilters applies a combined gte+lt window', () => {
  const filters = [
    {
      field: 'n',
      kind: 'range',
      fieldSchema: INTEGER_SCHEMA,
      operators: { gte: 10, lt: 20 },
    },
  ];
  assert.equal(passesRequestFilters({ n: 10 }, filters), true);
  assert.equal(passesRequestFilters({ n: 19 }, filters), true);
  assert.equal(passesRequestFilters({ n: 20 }, filters), false);
  assert.equal(passesRequestFilters({ n: 9 }, filters), false);
});

test('passesRequestFilters ignores operators that are explicitly null', () => {
  // operators.gte == null -> the gte branch is skipped entirely.
  const filters = [
    {
      field: 'n',
      kind: 'range',
      fieldSchema: INTEGER_SCHEMA,
      operators: { gte: null, lt: 5 },
    },
  ];
  assert.equal(passesRequestFilters({ n: -100 }, filters), true);
  assert.equal(passesRequestFilters({ n: 5 }, filters), false);
});

// ─── passesTimeRange ─────────────────────────────────────────────────────

test('passesTimeRange is a no-op without a range or a field', () => {
  assert.equal(passesTimeRange({ received_at: 'x' }, null, 'received_at'), true);
  assert.equal(passesTimeRange({ received_at: 'x' }, { since: 'y' }, null), true);
});

test('passesTimeRange rejects a record missing the time field', () => {
  assert.equal(passesTimeRange({}, { since: '2026-01-01' }, 'received_at'), false);
});

test('passesTimeRange rejects an unparseable time value', () => {
  assert.equal(
    passesTimeRange({ received_at: 'not-a-date' }, { since: '2026-01-01' }, 'received_at'),
    false,
  );
});

test('passesTimeRange enforces since as an inclusive lower bound', () => {
  const range = { since: '2026-01-10T00:00:00Z' };
  assert.equal(passesTimeRange({ received_at: '2026-01-09T23:59:59Z' }, range, 'received_at'), false);
  assert.equal(passesTimeRange({ received_at: '2026-01-10T00:00:00Z' }, range, 'received_at'), true);
});

test('passesTimeRange enforces until as an exclusive upper bound', () => {
  const range = { until: '2026-01-10T00:00:00Z' };
  assert.equal(passesTimeRange({ received_at: '2026-01-10T00:00:00Z' }, range, 'received_at'), false);
  assert.equal(passesTimeRange({ received_at: '2026-01-09T23:59:59Z' }, range, 'received_at'), true);
});

test('passesTimeRange accepts a value inside a since+until window', () => {
  const range = { since: '2026-01-01T00:00:00Z', until: '2026-02-01T00:00:00Z' };
  assert.equal(passesTimeRange({ received_at: '2026-01-15T00:00:00Z' }, range, 'received_at'), true);
});

// ─── passesGrantRecordConstraints ────────────────────────────────────────

test('passesGrantRecordConstraints allows when grant has no resource/time scope', () => {
  assert.equal(passesGrantRecordConstraints({ received_at: 'x' }, 'k1', {}, manifestStream()), true);
  assert.equal(
    passesGrantRecordConstraints({ received_at: 'x' }, 'k1', undefined, manifestStream()),
    true,
  );
});

test('passesGrantRecordConstraints rejects a record key outside the resource allow-list', () => {
  const grant = { resources: ['k1', 'k2'] };
  assert.equal(passesGrantRecordConstraints({}, 'k9', grant, manifestStream()), false);
  assert.equal(passesGrantRecordConstraints({}, 'k1', grant, manifestStream()), true);
});

test('passesGrantRecordConstraints applies the grant time_range through the consent field', () => {
  const grant = { time_range: { since: '2026-01-10T00:00:00Z' } };
  const stream = manifestStream();
  assert.equal(
    passesGrantRecordConstraints({ received_at: '2026-01-01T00:00:00Z' }, 'k1', grant, stream),
    false,
  );
  assert.equal(
    passesGrantRecordConstraints({ received_at: '2026-01-20T00:00:00Z' }, 'k1', grant, stream),
    true,
  );
});

test('passesGrantRecordConstraints combines resource and time-range gates', () => {
  const grant = {
    resources: ['k1'],
    time_range: { until: '2026-02-01T00:00:00Z' },
  };
  const stream = manifestStream();
  // In resource set AND before until -> allowed.
  assert.equal(
    passesGrantRecordConstraints({ received_at: '2026-01-15T00:00:00Z' }, 'k1', grant, stream),
    true,
  );
  // In resource set but at/after until -> rejected by time gate.
  assert.equal(
    passesGrantRecordConstraints({ received_at: '2026-02-01T00:00:00Z' }, 'k1', grant, stream),
    false,
  );
});
