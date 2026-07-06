/**
 * Unit coverage for the UNTESTED manifest-validation shaper
 * `validateStreamExpandDeclarations` (`server/connector-manifest-validation.ts`)
 * — the richest catalog validator. It cross-references a stream's
 * `query.expand[]` against its `relationships[]` and the related streams'
 * schemas, THROWING a typed `invalidConnectorManifest` (carrying `code`,
 * stream-scoped message) for each violation, or returning when absent/valid.
 *
 * Pinned here:
 *   - ACCEPT: no expand; a fully-valid expand (has_many with fk + limits).
 *   - REJECT: expand not a non-empty array; an entry without a name; a duplicate
 *     entry; an entry with no matching same-stream relationship; a relationship
 *     missing stream/foreign_key or with a bad cardinality; an unknown related
 *     stream; a related stream without schema.properties; a foreign_key that is
 *     not a top-level property of the related stream; a non-positive
 *     default_limit/max_limit; default_limit > max_limit; and has_one declaring
 *     any limits.
 *
 * Pure — the module imports only connector-key helpers (no DB). No fixtures.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { validateStreamExpandDeclarations } from '../server/connector-manifest-validation.ts';

const CODE = 'invalid_connector_manifest';

// A related stream 'order_lines' whose schema declares the fk 'order_id'.
function relatedStreams() {
  return new Map([
    ['order_lines', { schema: { properties: { order_id: { type: 'string' }, sku: { type: 'string' } } } }],
  ]);
}

// Build the destructured argument bag; `stream` overrides let each test shape a
// specific expand/relationships combination.
function args(streamOverrides = {}, manifestStreamsByName = relatedStreams()) {
  return {
    code: CODE,
    manifestStreamsByName,
    schemaProperties: { id: { type: 'string' } },
    stream: {
      name: 'orders',
      query: { expand: [{ name: 'lines', default_limit: 10, max_limit: 50 }] },
      relationships: [{ name: 'lines', stream: 'order_lines', foreign_key: 'order_id', cardinality: 'has_many' }],
      ...streamOverrides,
    },
  };
}

function assertRejects(streamOverrides, messagePart, manifestStreamsByName = relatedStreams()) {
  assert.throws(
    () => validateStreamExpandDeclarations(args(streamOverrides, manifestStreamsByName)),
    (err) => {
      assert.equal(err.code, CODE, `code: ${err.code}`);
      assert.ok(String(err.message).includes("Stream 'orders'"), `stream-scoped: ${err.message}`);
      assert.ok(String(err.message).includes(messagePart), `message ${JSON.stringify(err.message)} lacks ${JSON.stringify(messagePart)}`);
      return true;
    },
  );
}

// --- accept paths -----------------------------------------------------------

test('validateStreamExpandDeclarations: returns when no expand is declared', () => {
  assert.equal(validateStreamExpandDeclarations(args({ query: {} })), undefined);
});

test('validateStreamExpandDeclarations: accepts a valid has_many expand with limits + fk', () => {
  assert.equal(validateStreamExpandDeclarations(args()), undefined);
});

// --- reject paths -----------------------------------------------------------

test('validateStreamExpandDeclarations: rejects a non-array or empty expand', () => {
  assertRejects({ query: { expand: 'x' } }, 'query.expand must be a non-empty array');
  assertRejects({ query: { expand: [] } }, 'query.expand must be a non-empty array');
});

test('validateStreamExpandDeclarations: rejects an entry without a name', () => {
  assertRejects({ query: { expand: [{}] }, relationships: [] }, 'query.expand entries must include a non-empty name');
});

test('validateStreamExpandDeclarations: rejects a duplicate expand entry', () => {
  assertRejects(
    {
      query: { expand: [{ name: 'lines' }, { name: 'lines' }] },
      relationships: [{ name: 'lines', stream: 'order_lines', foreign_key: 'order_id', cardinality: 'has_many' }],
    },
    "query.expand has duplicate entry 'lines'",
  );
});

test('validateStreamExpandDeclarations: rejects an entry with no matching relationship', () => {
  assertRejects(
    { query: { expand: [{ name: 'ghost' }] }, relationships: [] },
    "query.expand entry 'ghost' must match a same-stream relationships[] entry",
  );
});

test('validateStreamExpandDeclarations: rejects a relationship missing stream or foreign_key', () => {
  assertRejects(
    {
      query: { expand: [{ name: 'lines' }] },
      relationships: [{ name: 'lines', foreign_key: 'order_id', cardinality: 'has_many' }],
    },
    "relationship 'lines' must include a related stream",
  );
  assertRejects(
    {
      query: { expand: [{ name: 'lines' }] },
      relationships: [{ name: 'lines', stream: 'order_lines', cardinality: 'has_many' }],
    },
    "relationship 'lines' must include a foreign_key",
  );
});

test('validateStreamExpandDeclarations: rejects a bad cardinality', () => {
  assertRejects(
    {
      query: { expand: [{ name: 'lines' }] },
      relationships: [{ name: 'lines', stream: 'order_lines', foreign_key: 'order_id', cardinality: 'has_three' }],
    },
    "relationship 'lines' must use cardinality has_one or has_many",
  );
});

test('validateStreamExpandDeclarations: rejects an unknown related stream', () => {
  assertRejects(
    {
      query: { expand: [{ name: 'lines' }] },
      relationships: [{ name: 'lines', stream: 'missing', foreign_key: 'order_id', cardinality: 'has_many' }],
    },
    "references unknown related stream 'missing'",
    new Map(), // no related streams at all
  );
});

test('validateStreamExpandDeclarations: rejects a foreign_key that is not a top-level property of the related stream', () => {
  assertRejects(
    {
      query: { expand: [{ name: 'lines' }] },
      relationships: [{ name: 'lines', stream: 'order_lines', foreign_key: 'nonexistent', cardinality: 'has_many' }],
    },
    "foreign_key 'nonexistent' must be a top-level property on related stream 'order_lines'",
  );
});

test('validateStreamExpandDeclarations: rejects a non-positive or inverted limit', () => {
  assertRejects(
    {
      query: { expand: [{ name: 'lines', default_limit: 0 }] },
      relationships: [{ name: 'lines', stream: 'order_lines', foreign_key: 'order_id', cardinality: 'has_many' }],
    },
    "default_limit must be a positive integer",
  );
  assertRejects(
    {
      query: { expand: [{ name: 'lines', default_limit: 100, max_limit: 10 }] },
      relationships: [{ name: 'lines', stream: 'order_lines', foreign_key: 'order_id', cardinality: 'has_many' }],
    },
    "default_limit must be less than or equal to max_limit",
  );
});

test('validateStreamExpandDeclarations: rejects a has_one relationship that declares limits', () => {
  assertRejects(
    {
      query: { expand: [{ name: 'lines', default_limit: 5 }] },
      relationships: [{ name: 'lines', stream: 'order_lines', foreign_key: 'order_id', cardinality: 'has_one' }],
    },
    'must not declare limits for has_one relationships',
  );
});
