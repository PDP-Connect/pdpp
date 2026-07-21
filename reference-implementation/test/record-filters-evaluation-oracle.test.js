// Pure-logic oracle for the query_records in-memory filter-evaluation contract
// (server/record-filters.js). parseDateValue, coerceComparableValue,
// passesRequestFilters, and passesTimeRange decide which records a
// query_records / search filter admits — pure functions, previously untested by
// name (coerceComparableValue had a single incidental reference). A silently
// weakened comparison here (inclusive vs exclusive boundary, or a dropped
// operator) would admit or drop records with no failing test. No DB.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseDateValue,
  coerceComparableValue,
  passesRequestFilters,
  passesTimeRange,
} from '../server/record-filters.js';

test('parseDateValue parses an ISO string to epoch ms and returns null for non-parseable input', () => {
  assert.equal(parseDateValue('2026-07-02T00:00:00Z'), Date.parse('2026-07-02T00:00:00Z'));
  assert.equal(parseDateValue('nope'), null);
  assert.equal(parseDateValue(''), null);
  assert.equal(parseDateValue(null), null);
  assert.equal(parseDateValue(123), null);
});

test('coerceComparableValue coerces by single-typed schema and passes strings through', () => {
  assert.equal(coerceComparableValue('42', { type: 'integer' }), 42);
  assert.equal(coerceComparableValue('3.14', { type: 'number' }), 3.14);
  assert.equal(coerceComparableValue('2026-07-02T00:00:00Z', { type: 'string', format: 'date-time' }), Date.parse('2026-07-02T00:00:00Z'));
  assert.equal(coerceComparableValue('hello', { type: 'string' }), 'hello');
  assert.equal(coerceComparableValue(null, { type: 'integer' }), null);
});

test('coerceComparableValue throws in strict mode on an uncoercible typed value', () => {
  assert.throws(() => coerceComparableValue('xx', { type: 'integer' }, { strict: true }), /Invalid integer value/);
});

test('passesRequestFilters matches an exact filter by string equality', () => {
  const filters = [{ field: 'status', kind: 'exact', value: 'shipped' }];
  assert.equal(passesRequestFilters({ status: 'shipped' }, filters), true);
  assert.equal(passesRequestFilters({ status: 'pending' }, filters), false);
  // No filters => always passes.
  assert.equal(passesRequestFilters({ anything: 1 }, []), true);
});

test('passesRequestFilters applies range operators with correct inclusive/exclusive boundaries', () => {
  const filters = [{ field: 'amount', kind: 'range', fieldSchema: { type: 'integer' }, operators: { gte: 10, lt: 100 } }];
  assert.equal(passesRequestFilters({ amount: '50' }, filters), true);
  assert.equal(passesRequestFilters({ amount: '10' }, filters), true); // gte is inclusive
  assert.equal(passesRequestFilters({ amount: '100' }, filters), false); // lt is exclusive
  assert.equal(passesRequestFilters({ amount: '5' }, filters), false);
});

test('passesRequestFilters rejects a record whose range field is uncoercible', () => {
  const filters = [{ field: 'amount', kind: 'range', fieldSchema: { type: 'integer' }, operators: { gte: 10 } }];
  assert.equal(passesRequestFilters({ amount: 'not-a-number' }, filters), false);
  assert.equal(passesRequestFilters({}, filters), false); // absent value coerces to null
});

test('passesTimeRange enforces an inclusive since and an exclusive until', () => {
  const field = 't';
  // No range or no field => passes.
  assert.equal(passesTimeRange({ t: '2026-07-02' }, null, field), true);
  assert.equal(passesTimeRange({ t: '2026-07-02T12:00:00Z' }, { since: '2026-07-01T00:00:00Z', until: '2026-07-03T00:00:00Z' }, field), true);
  // since is inclusive: a value exactly at since passes.
  assert.equal(passesTimeRange({ t: '2026-07-01T00:00:00Z' }, { since: '2026-07-01T00:00:00Z' }, field), true);
  // until is exclusive: a value exactly at until fails.
  assert.equal(passesTimeRange({ t: '2026-07-03T00:00:00Z' }, { until: '2026-07-03T00:00:00Z' }, field), false);
  // A missing time value fails a present range.
  assert.equal(passesTimeRange({}, { since: '2026-07-01T00:00:00Z' }, field), false);
});
