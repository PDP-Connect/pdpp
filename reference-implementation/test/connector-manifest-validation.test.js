// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure schema-predicate helpers in the connector-manifest
 * validator.
 *
 * connector-manifest-validation.ts is a pure module (imports only
 * connector-key.js). Only resolveManifestSensitivity is covered elsewhere
 * (manifest-sensitivity.test.js); the schema-predicate classifiers and the
 * blob_ref shape validator were unpinned. All functions here are pure.
 * Coverage:
 *   - searchable-string / cursor-compatible / range / nonNull / typeIncludes,
 *   - numeric / min-max / scalar-group / time-bucket aggregate schema checks,
 *   - isPositiveInteger boundary, invalidConnectorManifest code,
 *   - validateBlobRefSchemaDeclaration required shape + typed rejections.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateConnectorManifest,
  isTopLevelSearchableStringField,
  isReferenceCompatibleCursorSchema,
  isRangeQueryableFieldSchema,
  nonNullSchemaTypes,
  schemaTypeIncludes,
  isNumericAggregateFieldSchema,
  isMinMaxAggregateFieldSchema,
  isScalarAggregateGroupFieldSchema,
  isTimeBucketAggregateFieldSchema,
  isPositiveInteger,
  invalidConnectorManifest,
  validateBlobRefSchemaDeclaration,
} from '../server/connector-manifest-validation.ts';

function manifestWithStream(stream = {}) {
  return {
    connector_key: 'test-manifest',
    streams: [
      {
        name: 'items',
        primary_key: ['id'],
        schema: { properties: { id: { type: 'string' } } },
        ...stream,
      },
    ],
  };
}

test('isTopLevelSearchableStringField accepts plain and nullable string, rejects others', () => {
  assert.equal(isTopLevelSearchableStringField({ type: 'string' }), true);
  assert.equal(isTopLevelSearchableStringField({ type: ['string', 'null'] }), true);
  assert.equal(isTopLevelSearchableStringField({ type: ['string', 'integer'] }), false);
  assert.equal(isTopLevelSearchableStringField({ type: 'integer' }), false);
  assert.equal(isTopLevelSearchableStringField(null), false);
});

test('isReferenceCompatibleCursorSchema accepts numeric and date/date-time strings', () => {
  assert.equal(isReferenceCompatibleCursorSchema({ type: 'integer' }), true);
  assert.equal(isReferenceCompatibleCursorSchema({ type: 'number' }), true);
  assert.equal(isReferenceCompatibleCursorSchema({ type: 'string', format: 'date' }), true);
  assert.equal(isReferenceCompatibleCursorSchema({ type: ['string', 'null'], format: 'date-time' }), true);
  // Plain string without a date format is not cursor-compatible.
  assert.equal(isReferenceCompatibleCursorSchema({ type: 'string' }), false);
  // Two non-null types -> not compatible.
  assert.equal(isReferenceCompatibleCursorSchema({ type: ['integer', 'string'] }), false);
  assert.equal(isReferenceCompatibleCursorSchema(null), false);
  // isRangeQueryableFieldSchema is defined as an alias of the cursor check.
  assert.equal(isRangeQueryableFieldSchema({ type: 'integer' }), true);
  assert.equal(isRangeQueryableFieldSchema({ type: 'string' }), false);
});

test('nonNullSchemaTypes strips null and normalizes scalar/array', () => {
  assert.deepEqual(nonNullSchemaTypes({ type: ['string', 'null'] }), ['string']);
  assert.deepEqual(nonNullSchemaTypes({ type: 'integer' }), ['integer']);
  assert.deepEqual(nonNullSchemaTypes({}), []);
  assert.deepEqual(nonNullSchemaTypes(null), []);
});

test('schemaTypeIncludes checks scalar and array type membership', () => {
  assert.equal(schemaTypeIncludes({ type: 'object' }, 'object'), true);
  assert.equal(schemaTypeIncludes({ type: ['object', 'null'] }, 'object'), true);
  assert.equal(schemaTypeIncludes({ type: 'string' }, 'object'), false);
  assert.equal(schemaTypeIncludes(null, 'object'), false);
});

test('numeric / min-max / scalar-group / time-bucket aggregate predicates', () => {
  assert.equal(isNumericAggregateFieldSchema({ type: 'integer' }), true);
  assert.equal(isNumericAggregateFieldSchema({ type: 'string' }), false);

  assert.equal(isMinMaxAggregateFieldSchema({ type: 'number' }), true);
  assert.equal(isMinMaxAggregateFieldSchema({ type: 'string', format: 'date-time' }), true);
  assert.equal(isMinMaxAggregateFieldSchema({ type: 'string' }), false);

  assert.equal(isScalarAggregateGroupFieldSchema({ type: 'boolean' }), true);
  assert.equal(isScalarAggregateGroupFieldSchema({ type: 'string' }), true);
  assert.equal(isScalarAggregateGroupFieldSchema({ type: ['string', 'integer'] }), false);

  assert.equal(isTimeBucketAggregateFieldSchema({ type: 'string', format: 'date' }), true);
  assert.equal(isTimeBucketAggregateFieldSchema({ type: 'string', format: 'date-time' }), true);
  // A numeric field is not a time-bucket field even though min/max accepts it.
  assert.equal(isTimeBucketAggregateFieldSchema({ type: 'integer' }), false);
  assert.equal(isTimeBucketAggregateFieldSchema({ type: 'string' }), false);
});

test('isPositiveInteger accepts positive integers only', () => {
  assert.equal(isPositiveInteger(1), true);
  assert.equal(isPositiveInteger(0), false);
  assert.equal(isPositiveInteger(-3), false);
  assert.equal(isPositiveInteger(1.5), false);
  assert.equal(isPositiveInteger('2'), false);
});

test('invalidConnectorManifest defaults its code to invalid_request', () => {
  assert.equal(invalidConnectorManifest('m').code, 'invalid_request');
  assert.equal(invalidConnectorManifest('m', 'custom').code, 'custom');
});

function validBlobRefSchema() {
  return {
    type: 'object',
    properties: {
      blob_id: { type: 'string' },
      mime_type: { type: 'string' },
      size_bytes: { type: 'integer' },
      sha256: { type: 'string' },
    },
    required: ['blob_id'],
  };
}

test('validateBlobRefSchemaDeclaration accepts a well-formed blob_ref schema', () => {
  assert.doesNotThrow(() =>
    validateBlobRefSchemaDeclaration({ name: 'attachments' }, validBlobRefSchema(), 'invalid_request'),
  );
});

test('validateBlobRefSchemaDeclaration rejects non-object, missing props, wrong types, and missing required', () => {
  const stream = { name: 'attachments' };
  assert.throws(
    () => validateBlobRefSchemaDeclaration(stream, { type: 'string' }, 'invalid_request'),
    /must be an object or nullable object/,
  );
  assert.throws(
    () => validateBlobRefSchemaDeclaration(stream, { type: 'object' }, 'invalid_request'),
    /must declare object properties/,
  );
  // Wrong type on size_bytes.
  const badType = validBlobRefSchema();
  badType.properties.size_bytes = { type: 'string' };
  assert.throws(
    () => validateBlobRefSchemaDeclaration(stream, badType, 'invalid_request'),
    /size_bytes must be type integer/,
  );
  // Missing required blob_id.
  const noRequired = validBlobRefSchema();
  noRequired.required = [];
  assert.throws(
    () => validateBlobRefSchemaDeclaration(stream, noRequired, 'invalid_request'),
    /must require blob_id/,
  );
});

test('validateConnectorManifest accepts valid stream evidence declarations', () => {
  assert.doesNotThrow(() =>
    validateConnectorManifest(
      manifestWithStream({
        coverage_policy: 'collect',
        coverage_strategy: 'full_inventory',
        freshness_strategy: 'manual_as_of',
      }),
    ),
  );
});

test('validateConnectorManifest rejects invalid stream evidence declarations when present', () => {
  assert.throws(
    () => validateConnectorManifest(manifestWithStream({ coverage_policy: 'later' })),
    /coverage_policy must be one of/,
  );
  assert.throws(
    () => validateConnectorManifest(manifestWithStream({ coverage_strategy: 'best_effort' })),
    /coverage_strategy must be one of/,
  );
  assert.throws(
    () => validateConnectorManifest(manifestWithStream({ freshness_strategy: 'recent_enough' })),
    /freshness_strategy must be one of/,
  );
});

// Presence is a build-time-only guardrail (stream-evidence-strategy-manifest.test.ts,
// gated by the local ci:signoff connector-conformance run), not a write-time
// registerConnector() check — an unconditional presence check at registration
// broke 80+ existing minimal test/legacy manifests that never declared these
// fields. See docs/reference/ci-mode.md.
test('validateConnectorManifest accepts a stream missing coverage_strategy or freshness_strategy', () => {
  assert.doesNotThrow(() => validateConnectorManifest(manifestWithStream({})));
});

test('validateConnectorManifest rejects a required stream with an accepted-coverage policy', () => {
  assert.throws(
    () =>
      validateConnectorManifest(
        manifestWithStream({
          coverage_policy: 'deferred',
          coverage_strategy: 'full_inventory',
          freshness_strategy: 'manual_as_of',
        }),
      ),
    /is contradictory with required: absent \(defaults true\)/,
  );
  assert.throws(
    () =>
      validateConnectorManifest(
        manifestWithStream({
          coverage_policy: 'unavailable',
          coverage_strategy: 'full_inventory',
          freshness_strategy: 'manual_as_of',
          required: true,
        }),
      ),
    /is contradictory with required: true/,
  );
  assert.doesNotThrow(() =>
    validateConnectorManifest(
      manifestWithStream({
        coverage_policy: 'deferred',
        coverage_strategy: 'full_inventory',
        freshness_strategy: 'manual_as_of',
        required: false,
      }),
    ),
  );
});

// A parent list stream `items` plus a co-emitted child declaring its checkpoint
// parent via `state_stream: 'items'` — the Slack reactions / Gmail message_bodies
// shape. `state_stream` is a checkpoint-parent declaration valid only with the
// `checkpoint_window` coverage strategy.
function manifestWithChildStateStream(child = {}) {
  return {
    connector_key: 'test-manifest',
    streams: [
      { name: 'items', primary_key: ['id'], schema: { properties: { id: { type: 'string' } } } },
      {
        name: 'child',
        primary_key: ['id'],
        schema: { properties: { id: { type: 'string' } } },
        coverage_strategy: 'checkpoint_window',
        state_stream: 'items',
        ...child,
      },
    ],
  };
}

test('validateConnectorManifest accepts a checkpoint_window child declaring an existing state_stream parent', () => {
  assert.doesNotThrow(() => validateConnectorManifest(manifestWithChildStateStream()));
});

test('validateConnectorManifest rejects a state_stream that names no declared stream', () => {
  assert.throws(
    () => validateConnectorManifest(manifestWithChildStateStream({ state_stream: 'ghost' })),
    /state_stream 'ghost' must name another declared stream/,
  );
});

test('validateConnectorManifest rejects a state_stream pointing at the stream itself', () => {
  assert.throws(
    () => validateConnectorManifest(manifestWithChildStateStream({ state_stream: 'child' })),
    /state_stream must name a different parent stream, not itself/,
  );
});

test('validateConnectorManifest rejects a non-string state_stream', () => {
  assert.throws(
    () => validateConnectorManifest(manifestWithChildStateStream({ state_stream: 42 })),
    /state_stream must be a non-empty string/,
  );
});

test('validateConnectorManifest rejects state_stream with a non-checkpoint_window strategy', () => {
  assert.throws(
    () => validateConnectorManifest(manifestWithChildStateStream({ coverage_strategy: 'full_inventory' })),
    /state_stream, which is only valid with coverage_strategy "checkpoint_window"/,
  );
});

test('validateConnectorManifest rejects state_stream without an explicit checkpoint_window strategy', () => {
  const manifest = manifestWithChildStateStream();
  delete manifest.streams[1].coverage_strategy;
  assert.throws(
    () => validateConnectorManifest(manifest),
    /state_stream, which is only valid with coverage_strategy "checkpoint_window"/,
  );
});
