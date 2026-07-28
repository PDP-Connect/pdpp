const TOP_LEVEL_REGEX_1 = /state_stream 'ghost' must name another declared stream/;
const TOP_LEVEL_REGEX_2 = /must be an object or nullable object/;
const TOP_LEVEL_REGEX_3 = /must declare object properties/;
const TOP_LEVEL_REGEX_4 = /size_bytes must be type integer/;
const TOP_LEVEL_REGEX_5 = /must require blob_id/;
const TOP_LEVEL_REGEX_6 = /coverage_policy must be one of/;
const TOP_LEVEL_REGEX_7 = /coverage_strategy must be one of/;
const TOP_LEVEL_REGEX_8 = /freshness_strategy must be one of/;
const TOP_LEVEL_REGEX_9 = /is contradictory with required: absent \(defaults true\)/;
const TOP_LEVEL_REGEX_10 = /is contradictory with required: true/;
const TOP_LEVEL_REGEX_11 = /state_stream must name a different parent stream, not itself/;
const TOP_LEVEL_REGEX_12 = /state_stream must be a non-empty string/;
const TOP_LEVEL_REGEX_13 = /state_stream, which is only valid with coverage_strategy "checkpoint_window"/;
const TOP_LEVEL_REGEX_14 = /state_stream, which is only valid with coverage_strategy "checkpoint_window"/;

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

import assert from "node:assert/strict";
import test from "node:test";

import {
  invalidConnectorManifest,
  isMinMaxAggregateFieldSchema,
  isNumericAggregateFieldSchema,
  isPositiveInteger,
  isRangeQueryableFieldSchema,
  isReferenceCompatibleCursorSchema,
  isScalarAggregateGroupFieldSchema,
  isTimeBucketAggregateFieldSchema,
  isTopLevelSearchableStringField,
  nonNullSchemaTypes,
  schemaTypeIncludes,
  validateBlobRefSchemaDeclaration,
  validateConnectorManifest,
} from "../server/connector-manifest-validation.ts";

function manifestWithStream(stream = {}) {
  return {
    connector_key: "test-manifest",
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } } },
        ...stream,
      },
    ],
  };
}

test("isTopLevelSearchableStringField accepts plain and nullable string, rejects others", () => {
  assert.equal(isTopLevelSearchableStringField({ type: "string" }), true);
  assert.equal(isTopLevelSearchableStringField({ type: ["string", "null"] }), true);
  assert.equal(isTopLevelSearchableStringField({ type: ["string", "integer"] }), false);
  assert.equal(isTopLevelSearchableStringField({ type: "integer" }), false);
  assert.equal(isTopLevelSearchableStringField(null), false);
});

test("isReferenceCompatibleCursorSchema accepts numeric and date/date-time strings", () => {
  assert.equal(isReferenceCompatibleCursorSchema({ type: "integer" }), true);
  assert.equal(isReferenceCompatibleCursorSchema({ type: "number" }), true);
  assert.equal(isReferenceCompatibleCursorSchema({ format: "date", type: "string" }), true);
  assert.equal(isReferenceCompatibleCursorSchema({ format: "date-time", type: ["string", "null"] }), true);
  // Plain string without a date format is not cursor-compatible.
  assert.equal(isReferenceCompatibleCursorSchema({ type: "string" }), false);
  // Two non-null types -> not compatible.
  assert.equal(isReferenceCompatibleCursorSchema({ type: ["integer", "string"] }), false);
  assert.equal(isReferenceCompatibleCursorSchema(null), false);
  // isRangeQueryableFieldSchema is defined as an alias of the cursor check.
  assert.equal(isRangeQueryableFieldSchema({ type: "integer" }), true);
  assert.equal(isRangeQueryableFieldSchema({ type: "string" }), false);
});

test("nonNullSchemaTypes strips null and normalizes scalar/array", () => {
  assert.deepEqual(nonNullSchemaTypes({ type: ["string", "null"] }), ["string"]);
  assert.deepEqual(nonNullSchemaTypes({ type: "integer" }), ["integer"]);
  assert.deepEqual(nonNullSchemaTypes({}), []);
  assert.deepEqual(nonNullSchemaTypes(null), []);
});

test("schemaTypeIncludes checks scalar and array type membership", () => {
  assert.equal(schemaTypeIncludes({ type: "object" }, "object"), true);
  assert.equal(schemaTypeIncludes({ type: ["object", "null"] }, "object"), true);
  assert.equal(schemaTypeIncludes({ type: "string" }, "object"), false);
  assert.equal(schemaTypeIncludes(null, "object"), false);
});

test("numeric / min-max / scalar-group / time-bucket aggregate predicates", () => {
  assert.equal(isNumericAggregateFieldSchema({ type: "integer" }), true);
  assert.equal(isNumericAggregateFieldSchema({ type: "string" }), false);

  assert.equal(isMinMaxAggregateFieldSchema({ type: "number" }), true);
  assert.equal(isMinMaxAggregateFieldSchema({ format: "date-time", type: "string" }), true);
  assert.equal(isMinMaxAggregateFieldSchema({ type: "string" }), false);

  assert.equal(isScalarAggregateGroupFieldSchema({ type: "boolean" }), true);
  assert.equal(isScalarAggregateGroupFieldSchema({ type: "string" }), true);
  assert.equal(isScalarAggregateGroupFieldSchema({ type: ["string", "integer"] }), false);

  assert.equal(isTimeBucketAggregateFieldSchema({ format: "date", type: "string" }), true);
  assert.equal(isTimeBucketAggregateFieldSchema({ format: "date-time", type: "string" }), true);
  // A numeric field is not a time-bucket field even though min/max accepts it.
  assert.equal(isTimeBucketAggregateFieldSchema({ type: "integer" }), false);
  assert.equal(isTimeBucketAggregateFieldSchema({ type: "string" }), false);
});

test("isPositiveInteger accepts positive integers only", () => {
  assert.equal(isPositiveInteger(1), true);
  assert.equal(isPositiveInteger(0), false);
  assert.equal(isPositiveInteger(-3), false);
  assert.equal(isPositiveInteger(1.5), false);
  assert.equal(isPositiveInteger("2"), false);
});

test("invalidConnectorManifest defaults its code to invalid_request", () => {
  assert.equal(invalidConnectorManifest("m").code, "invalid_request");
  assert.equal(invalidConnectorManifest("m", "custom").code, "custom");
});

function validBlobRefSchema() {
  return {
    properties: {
      blob_id: { type: "string" },
      mime_type: { type: "string" },
      sha256: { type: "string" },
      size_bytes: { type: "integer" },
    },
    required: ["blob_id"],
    type: "object",
  };
}

test("validateBlobRefSchemaDeclaration accepts a well-formed blob_ref schema", () => {
  assert.doesNotThrow(() =>
    validateBlobRefSchemaDeclaration({ name: "attachments" }, validBlobRefSchema(), "invalid_request")
  );
});

test("validateBlobRefSchemaDeclaration rejects non-object, missing props, wrong types, and missing required", () => {
  const stream = { name: "attachments" };
  assert.throws(
    () => validateBlobRefSchemaDeclaration(stream, { type: "string" }, "invalid_request"),
    TOP_LEVEL_REGEX_2
  );
  assert.throws(
    () => validateBlobRefSchemaDeclaration(stream, { type: "object" }, "invalid_request"),
    TOP_LEVEL_REGEX_3
  );
  // Wrong type on size_bytes.
  const badType = validBlobRefSchema();
  badType.properties.size_bytes = { type: "string" };
  assert.throws(() => validateBlobRefSchemaDeclaration(stream, badType, "invalid_request"), TOP_LEVEL_REGEX_4);
  // Missing required blob_id.
  const noRequired = validBlobRefSchema();
  noRequired.required = [];
  assert.throws(() => validateBlobRefSchemaDeclaration(stream, noRequired, "invalid_request"), TOP_LEVEL_REGEX_5);
});

test("validateConnectorManifest accepts valid stream evidence declarations", () => {
  assert.doesNotThrow(() =>
    validateConnectorManifest(
      manifestWithStream({
        coverage_policy: "collect",
        coverage_strategy: "full_inventory",
        freshness_strategy: "manual_as_of",
      })
    )
  );
});

test("validateConnectorManifest rejects invalid stream evidence declarations when present", () => {
  assert.throws(() => validateConnectorManifest(manifestWithStream({ coverage_policy: "later" })), TOP_LEVEL_REGEX_6);
  assert.throws(
    () => validateConnectorManifest(manifestWithStream({ coverage_strategy: "best_effort" })),
    TOP_LEVEL_REGEX_7
  );
  assert.throws(
    () => validateConnectorManifest(manifestWithStream({ freshness_strategy: "recent_enough" })),
    TOP_LEVEL_REGEX_8
  );
});

// Presence is a build-time-only guardrail (stream-evidence-strategy-manifest.test.ts,
// gated by the local ci:signoff connector-conformance run), not a write-time
// registerConnector() check — an unconditional presence check at registration
// broke 80+ existing minimal test/legacy manifests that never declared these
// fields. See docs/reference/ci-mode.md.
test("validateConnectorManifest accepts a stream missing coverage_strategy or freshness_strategy", () => {
  assert.doesNotThrow(() => validateConnectorManifest(manifestWithStream({})));
});

test("validateConnectorManifest accepts an optional cursor or consent field when absent", () => {
  assert.doesNotThrow(() => validateConnectorManifest(manifestWithStream({})));
});

test("validateConnectorManifest rejects a required stream with an accepted-coverage policy", () => {
  assert.throws(
    () =>
      validateConnectorManifest(
        manifestWithStream({
          coverage_policy: "deferred",
          coverage_strategy: "full_inventory",
          freshness_strategy: "manual_as_of",
        })
      ),
    TOP_LEVEL_REGEX_9
  );
  assert.throws(
    () =>
      validateConnectorManifest(
        manifestWithStream({
          coverage_policy: "unavailable",
          coverage_strategy: "full_inventory",
          freshness_strategy: "manual_as_of",
          required: true,
        })
      ),
    TOP_LEVEL_REGEX_10
  );
  assert.doesNotThrow(() =>
    validateConnectorManifest(
      manifestWithStream({
        coverage_policy: "deferred",
        coverage_strategy: "full_inventory",
        freshness_strategy: "manual_as_of",
        required: false,
      })
    )
  );
});

// A parent list stream `items` plus a co-emitted child declaring its checkpoint
// parent via `state_stream: 'items'` — the Slack reactions / Gmail message_bodies
// shape. `state_stream` is a checkpoint-parent declaration valid only with the
// `checkpoint_window` coverage strategy.
interface ChildStateStreamManifestStream {
  coverage_strategy?: string;
  name: string;
  primary_key: string[];
  schema: { properties: { id: { type: string } } };
  state_stream?: string;
}

function manifestWithChildStateStream(child: Record<string, unknown> = {}): {
  connector_key: string;
  streams: [ChildStateStreamManifestStream, ChildStateStreamManifestStream];
} {
  return {
    connector_key: "test-manifest",
    streams: [
      { name: "items", primary_key: ["id"], schema: { properties: { id: { type: "string" } } } },
      {
        coverage_strategy: "checkpoint_window",
        name: "child",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } } },
        state_stream: "items",
        ...child,
      },
    ],
  };
}

test("validateConnectorManifest accepts a checkpoint_window child declaring an existing state_stream parent", () => {
  assert.doesNotThrow(() => validateConnectorManifest(manifestWithChildStateStream()));
});

test("validateConnectorManifest rejects a state_stream that names no declared stream", () => {
  assert.throws(
    () => validateConnectorManifest(manifestWithChildStateStream({ state_stream: "ghost" })),
    TOP_LEVEL_REGEX_1
  );
});

test("validateConnectorManifest rejects a state_stream pointing at the stream itself", () => {
  assert.throws(
    () => validateConnectorManifest(manifestWithChildStateStream({ state_stream: "child" })),
    TOP_LEVEL_REGEX_11
  );
});

test("validateConnectorManifest rejects a non-string state_stream", () => {
  assert.throws(
    () => validateConnectorManifest(manifestWithChildStateStream({ state_stream: 42 })),
    TOP_LEVEL_REGEX_12
  );
});

test("validateConnectorManifest rejects state_stream with a non-checkpoint_window strategy", () => {
  assert.throws(
    () => validateConnectorManifest(manifestWithChildStateStream({ coverage_strategy: "full_inventory" })),
    TOP_LEVEL_REGEX_13
  );
});

test("validateConnectorManifest rejects state_stream without an explicit checkpoint_window strategy", () => {
  const manifest = manifestWithChildStateStream();
  const { coverage_strategy: _coverageStrategy, ...stateStream } = manifest.streams[1];
  assert.throws(
    () => validateConnectorManifest({ ...manifest, streams: [manifest.streams[0], stateStream] }),
    TOP_LEVEL_REGEX_14
  );
});
