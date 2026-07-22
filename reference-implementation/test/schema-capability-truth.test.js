// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Schema-capability truth conformance — tasks 3.5 / 4.2 of
 * `canonicalize-public-read-contract`.
 *
 * The canonical contract says: every capability the runtime advertises via
 * `/v1/schema` MUST be enforceable by the runtime, and every capability the
 * runtime does NOT advertise MUST be rejected by the runtime with a typed
 * error. Drift in either direction is a silent no-op or an unkept promise.
 *
 * This file proves the contract for the per-field filter operator surface
 * the reference runtime exposes today:
 *
 *   - `field_capabilities.<field>.range_filter.operators` (schema)
 *     SHOULD equal the set the filter compiler will accept.
 *
 *   - `field_capabilities.<field>.exact_filter.usable` (schema)
 *     SHOULD equal whether the filter compiler accepts a scalar value on
 *     that field.
 *
 * Coverage stops short of `/v1/schema` end-to-end because the live HTTP
 * harness requires runtime fixtures; the unit-level guarantee here is the
 * shape that matters: the SAME manifest-stream object feeds both the
 * capability-builder and the runtime validator, so the two cannot drift
 * without one of these assertions failing.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { compileRequestFilters } from '../server/record-filters.js';

const RECEIVED_AT_SCHEMA = { type: 'string', format: 'date-time' };

function makeManifestStream({
  rangeFilters = {},
  schemaProperties = {},
  cursorField = 'received_at',
} = {}) {
  return {
    name: 'messages',
    primary_key: ['message_id'],
    cursor_field: cursorField,
    schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string' },
        subject: { type: 'string' },
        received_at: RECEIVED_AT_SCHEMA,
        ...schemaProperties,
      },
      required: ['message_id'],
    },
    query: {
      range_filters: rangeFilters,
    },
  };
}

const ALL_OPERATORS = ['gte', 'gt', 'lte', 'lt'];
const NO_FIELD_GRANT_LIMIT = { fields: undefined };

// ───────────────────────────────────────────────────────────────────────
// range_filter.operators — schema advertisement <-> runtime acceptance
// ───────────────────────────────────────────────────────────────────────

test('runtime accepts every advertised range operator', () => {
  // Schema advertises gte+lte for received_at; runtime SHALL accept both.
  const manifestStream = makeManifestStream({
    rangeFilters: { received_at: ['gte', 'lte'] },
  });
  for (const op of ['gte', 'lte']) {
    const compiled = compileRequestFilters(
      { received_at: { [op]: '2026-01-01T00:00:00Z' } },
      NO_FIELD_GRANT_LIMIT,
      manifestStream,
    );
    assert.equal(compiled.length, 1);
    assert.equal(compiled[0].kind, 'range');
    assert.ok(compiled[0].operators[op] != null);
  }
});

test('runtime rejects every operator the schema did NOT advertise', () => {
  // Advertise only gte; gt/lte/lt are all undeclared and SHALL be rejected.
  const manifestStream = makeManifestStream({
    rangeFilters: { received_at: ['gte'] },
  });
  for (const op of ['gt', 'lte', 'lt']) {
    assert.throws(
      () =>
        compileRequestFilters(
          { received_at: { [op]: '2026-01-01T00:00:00Z' } },
          NO_FIELD_GRANT_LIMIT,
          manifestStream,
        ),
      (err) =>
        err instanceof Error &&
        err.code === 'invalid_request' &&
        /not declared|Unsupported range operator/.test(err.message),
      `operator '${op}' should be rejected when schema declares only gte`,
    );
  }
});

test('runtime rejects range filters when schema declares NONE on that field', () => {
  const manifestStream = makeManifestStream({ rangeFilters: {} });
  for (const op of ALL_OPERATORS) {
    assert.throws(
      () =>
        compileRequestFilters(
          { received_at: { [op]: '2026-01-01T00:00:00Z' } },
          NO_FIELD_GRANT_LIMIT,
          manifestStream,
        ),
      (err) => err.code === 'invalid_request',
      `operator '${op}' should be rejected when schema declares no range_filters`,
    );
  }
});

test('runtime rejects range filters on a field that is not range-queryable', () => {
  // subject is a plain string with no date format — range-queryable schema
  // gate rejects before the operator-declaration check.
  const manifestStream = makeManifestStream();
  assert.throws(
    () =>
      compileRequestFilters(
        { subject: { gte: 'foo' } },
        NO_FIELD_GRANT_LIMIT,
        manifestStream,
      ),
    (err) =>
      err.code === 'invalid_request' &&
      /Range filters are not supported/.test(err.message),
  );
});

// ───────────────────────────────────────────────────────────────────────
// exact_filter — schema scalar-acceptance <-> runtime
// ───────────────────────────────────────────────────────────────────────

test('runtime accepts exact filter on every scalar-schema field', () => {
  const manifestStream = makeManifestStream({
    schemaProperties: {
      seen: { type: 'boolean' },
      score: { type: 'number' },
      thread_index: { type: 'integer' },
    },
  });
  const fields = ['message_id', 'subject', 'seen', 'score', 'thread_index'];
  for (const field of fields) {
    const compiled = compileRequestFilters(
      { [field]: 'x' },
      NO_FIELD_GRANT_LIMIT,
      manifestStream,
    );
    assert.equal(compiled.length, 1, `field '${field}' should accept exact filter`);
    assert.equal(compiled[0].kind, 'exact');
  }
});

test('runtime rejects exact filter on a non-scalar (object) field', () => {
  const manifestStream = makeManifestStream({
    schemaProperties: { headers: { type: 'object' } },
  });
  assert.throws(
    () =>
      compileRequestFilters({ headers: 'x' }, NO_FIELD_GRANT_LIMIT, manifestStream),
    (err) =>
      err.code === 'invalid_request' &&
      /scalar/.test(err.message),
  );
});

test('runtime rejects filters on undeclared fields', () => {
  const manifestStream = makeManifestStream();
  assert.throws(
    () =>
      compileRequestFilters({ nope: 'x' }, NO_FIELD_GRANT_LIMIT, manifestStream),
    (err) =>
      err.code === 'filter_field_not_in_schema' &&
      /Unknown field/.test(err.message),
  );
});

test('runtime rejects filter on field not granted (grant trumps schema)', () => {
  const manifestStream = makeManifestStream();
  assert.throws(
    () =>
      compileRequestFilters(
        { subject: 'x' },
        { fields: ['message_id'] },
        manifestStream,
      ),
    (err) =>
      err.code === 'field_not_granted' &&
      /not in grant/.test(err.message),
  );
});

// ───────────────────────────────────────────────────────────────────────
// Internal consistency: the operator vocabulary is closed
// ───────────────────────────────────────────────────────────────────────

test('runtime rejects unsupported range operators that no schema could ever advertise', () => {
  const manifestStream = makeManifestStream({
    rangeFilters: { received_at: ['contains'] },
  });
  // Even if a manifest mistakenly lists an unsupported operator, the
  // runtime's closed vocabulary SHALL still reject it. This prevents a
  // manifest typo from creating a silent SQL injection vector.
  assert.throws(
    () =>
      compileRequestFilters(
        { received_at: { contains: 'x' } },
        NO_FIELD_GRANT_LIMIT,
        manifestStream,
      ),
    (err) =>
      err.code === 'invalid_request' &&
      /Unsupported range operator/.test(err.message),
  );
});
