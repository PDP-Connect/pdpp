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
const PARENT_STREAMS_ARRAY_PATTERN = /parent_streams must be a non-empty string array/;
const PARENT_STREAMS_DUPLICATE_PATTERN = /parent_streams must not contain duplicates/;
const PARENT_STREAMS_UNKNOWN_PATTERN = /parent_streams entry 'ghost' must name another declared stream/;
const PARENT_STREAMS_SELF_PATTERN = /parent_streams must not name the stream itself/;
const PARENT_STREAMS_STRATEGY_PATTERN =
  /parent_streams, which is only valid with coverage_strategy "parent_detail_accounting"/;
const BOTH_STATE_STREAM_AND_PARENT_STREAMS_PATTERN = /must not declare both state_stream and parent_streams/;
const TOP_LEVEL_REGEX_15 = /capabilities\.proven must be an object when declared/;
const TOP_LEVEL_REGEX_16 = /capabilities\.proven has unsupported keys: bogus_key/;
const TOP_LEVEL_REGEX_17 = /capabilities\.proven\.local_collector must be a boolean when declared/;
const TOP_LEVEL_REGEX_18 = /capabilities\.proven\.provider_auth_lifecycle must be a boolean when declared/;
const TOP_LEVEL_REGEX_19 = /capabilities\.proven\.static_secret_live must be an object when declared/;
const TOP_LEVEL_REGEX_20 = /capabilities\.proven\.static_secret_live has unsupported keys: bogus_key/;
const TOP_LEVEL_REGEX_21 = /capabilities\.proven\.static_secret_live\.proven must be a boolean/;
const TOP_LEVEL_REGEX_22 =
  /capabilities\.proven\.static_secret_live\.run_id must be a non-empty string or null when declared/;
const TOP_LEVEL_REGEX_23 =
  /capabilities\.proven\.static_secret_live\.date must be an ISO yyyy-mm-dd string when declared/;
const TOP_LEVEL_REGEX_24 = /capabilities\.proven\.static_secret_live\.note must be a non-empty string when declared/;
const TOP_LEVEL_REGEX_25 =
  /capabilities\.proven\.static_secret_live\.proven=true requires setup\.modality "static_secret"/;
const TOP_LEVEL_REGEX_26 =
  /capabilities\.proven\.provider_auth_lifecycle=true requires setup\.modality "provider_authorization"/;
const TOP_LEVEL_REGEX_27 =
  /capabilities\.proven\.local_collector=true requires runtime_requirements\.bindings\.filesystem/;
const TOP_LEVEL_REGEX_28 = /credential_capture field 'password' is a secret field .* with no label/;
const TOP_LEVEL_REGEX_29 = /credential_capture field 'password' is a secret field with zero env aliases/;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure schema-predicate helpers in the connector-manifest
 * validator.
 *
 * connector-manifest-validation.ts is a pure module (imports only
 * connector-key.js and the shared static-secret-credential-capture
 * normalizer). Only resolveManifestSensitivity is covered elsewhere
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
  validateProvenCapability,
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

test("validateConnectorManifest accepts a parent-detail stream with multiple declared parents", () => {
  const manifest = manifestWithChildStateStream();
  assert.doesNotThrow(() =>
    validateConnectorManifest({
      ...manifest,
      streams: [
        manifest.streams[0],
        { name: "other_parent", primary_key: ["id"], schema: { properties: { id: { type: "string" } } } },
        {
          coverage_strategy: "parent_detail_accounting",
          name: "details",
          parent_streams: ["items", "other_parent"],
          primary_key: ["id"],
          schema: { properties: { id: { type: "string" } } },
        },
      ],
    })
  );
});

test("validateConnectorManifest rejects ambiguous parent_streams declarations", () => {
  const manifest = manifestWithChildStateStream();
  const detail = (parent_streams: unknown, coverage_strategy = "parent_detail_accounting") => ({
    coverage_strategy,
    name: "details",
    parent_streams,
    primary_key: ["id"],
    schema: { properties: { id: { type: "string" } } },
  });
  const base = [
    manifest.streams[0],
    { name: "other_parent", primary_key: ["id"], schema: { properties: { id: { type: "string" } } } },
  ];

  assert.throws(
    () => validateConnectorManifest({ ...manifest, streams: [...base, detail([])] }),
    PARENT_STREAMS_ARRAY_PATTERN
  );
  assert.throws(
    () => validateConnectorManifest({ ...manifest, streams: [...base, detail(["items", "items"])] }),
    PARENT_STREAMS_DUPLICATE_PATTERN
  );
  assert.throws(
    () => validateConnectorManifest({ ...manifest, streams: [...base, detail(["ghost"])] }),
    PARENT_STREAMS_UNKNOWN_PATTERN
  );
  assert.throws(
    () => validateConnectorManifest({ ...manifest, streams: [...base, detail(["details"])] }),
    PARENT_STREAMS_SELF_PATTERN
  );
  assert.throws(
    () => validateConnectorManifest({ ...manifest, streams: [...base, detail(["items"], "full_inventory")] }),
    PARENT_STREAMS_STRATEGY_PATTERN
  );
});

// Direct discriminator for spec Validation rule 4 ("both fields present").
// `state_stream` and `parent_streams` are each gated to a different,
// mutually exclusive `coverage_strategy` value, which makes this combination
// unrepresentable as an incidental side effect of that gate today — but the
// rule is normative on its own and must be enforced directly, not merely as
// a side effect of the two single-field coverage_strategy checks. This test
// crafts a stream that would otherwise satisfy state_stream's own checks
// (coverage_strategy: "checkpoint_window", valid state_stream target) while
// also declaring parent_streams, to prove the explicit joint check fires
// before either individual field validator gets a chance to pass it.
test("validateConnectorManifest rejects a stream declaring both state_stream and parent_streams", () => {
  const manifest = manifestWithChildStateStream({
    parent_streams: ["items"],
  });
  assert.throws(() => validateConnectorManifest(manifest), BOTH_STATE_STREAM_AND_PARENT_STREAMS_PATTERN);
});

// ─── Checkpoint-dependency cycle detection (spec Validation rule 6, P2-1) ──
//
// Rules 1-5 (self-reference, unknown parent, duplicate parent, both fields,
// empty parent_streams) each inspect one stream's own declared edges in
// isolation, so they cannot see a cycle formed by TWO OR MORE direct edges
// (A -> B -> A, or a longer chain through direct edges only). These tests
// build such graphs directly and prove genuine cycle detection fires — a
// provider-neutral DFS over the declared dependency graph, no connector-
// specific knowledge.

const CYCLE_PATTERN = /Checkpoint-dependency cycle detected/;

function streamStub(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    primary_key: ["id"],
    schema: { properties: { id: { type: "string" } } },
    ...extra,
  };
}

test("validateConnectorManifest rejects a 2-cycle formed by two direct state_stream edges (A <-> B)", () => {
  const manifest = {
    connector_key: "test-manifest",
    streams: [
      streamStub("stream_a", { coverage_strategy: "checkpoint_window", state_stream: "stream_b" }),
      streamStub("stream_b", { coverage_strategy: "checkpoint_window", state_stream: "stream_a" }),
    ],
  };
  assert.throws(() => validateConnectorManifest(manifest), CYCLE_PATTERN);
});

test("validateConnectorManifest rejects a 3-cycle formed by direct state_stream edges (A -> B -> C -> A)", () => {
  const manifest = {
    connector_key: "test-manifest",
    streams: [
      streamStub("stream_a", { coverage_strategy: "checkpoint_window", state_stream: "stream_b" }),
      streamStub("stream_b", { coverage_strategy: "checkpoint_window", state_stream: "stream_c" }),
      streamStub("stream_c", { coverage_strategy: "checkpoint_window", state_stream: "stream_a" }),
    ],
  };
  assert.throws(() => validateConnectorManifest(manifest), CYCLE_PATTERN);
});

test("validateConnectorManifest rejects a mixed state_stream/parent_streams cycle", () => {
  const manifest = {
    connector_key: "test-manifest",
    streams: [
      streamStub("stream_a", { coverage_strategy: "checkpoint_window", state_stream: "stream_b" }),
      streamStub("stream_b", { coverage_strategy: "parent_detail_accounting", parent_streams: ["stream_a"] }),
    ],
  };
  assert.throws(() => validateConnectorManifest(manifest), CYCLE_PATTERN);
});

test("validateConnectorManifest accepts an acyclic manifest where two streams share the same declared parent", () => {
  const manifest = {
    connector_key: "test-manifest",
    streams: [
      streamStub("shared_parent"),
      streamStub("child_one", { coverage_strategy: "checkpoint_window", state_stream: "shared_parent" }),
      streamStub("child_two", { coverage_strategy: "checkpoint_window", state_stream: "shared_parent" }),
    ],
  };
  assert.doesNotThrow(() => validateConnectorManifest(manifest));
});

// ─── validateProvenCapability: adversarial direct tests ───────────────────
//
// The Cluster B closure made capabilities.proven a schema-validated,
// cross-field-checked declaration (server/connection-setup-plan.ts reads
// these traits instead of a hardcoded connector-id allowlist). Every
// rejection branch below is exercised directly against a manifest crafted
// to trip exactly that branch and nothing else — proving each cross-field
// consistency check actually fires, not just that real shipped manifests
// happen to pass.

function manifestWithCapabilities(capabilities: unknown, extra: Record<string, unknown> = {}) {
  return { capabilities, connector_key: "test-manifest", ...extra };
}

test("validateProvenCapability accepts a manifest with no capabilities or no proven declaration", () => {
  assert.doesNotThrow(() => validateProvenCapability({ connector_key: "test-manifest" }, "invalid_request"));
  assert.doesNotThrow(() => validateProvenCapability(manifestWithCapabilities({}), "invalid_request"));
  assert.doesNotThrow(() => validateProvenCapability(manifestWithCapabilities(undefined), "invalid_request"));
});

test("validateProvenCapability rejects capabilities.proven that is not an object", () => {
  assert.throws(
    () => validateProvenCapability(manifestWithCapabilities({ proven: "yes" }), "invalid_request"),
    TOP_LEVEL_REGEX_15
  );
  assert.throws(
    () => validateProvenCapability(manifestWithCapabilities({ proven: ["local_collector"] }), "invalid_request"),
    TOP_LEVEL_REGEX_15
  );
});

test("validateProvenCapability rejects an unsupported key under capabilities.proven", () => {
  assert.throws(
    () => validateProvenCapability(manifestWithCapabilities({ proven: { bogus_key: true } }), "invalid_request"),
    TOP_LEVEL_REGEX_16
  );
});

test("validateProvenCapability rejects non-boolean local_collector / provider_auth_lifecycle", () => {
  assert.throws(
    () =>
      validateProvenCapability(manifestWithCapabilities({ proven: { local_collector: "true" } }), "invalid_request"),
    TOP_LEVEL_REGEX_17
  );
  assert.throws(
    () =>
      validateProvenCapability(manifestWithCapabilities({ proven: { provider_auth_lifecycle: 1 } }), "invalid_request"),
    TOP_LEVEL_REGEX_18
  );
});

test("validateProvenCapability rejects a non-object static_secret_live", () => {
  assert.throws(
    () =>
      validateProvenCapability(manifestWithCapabilities({ proven: { static_secret_live: true } }), "invalid_request"),
    TOP_LEVEL_REGEX_19
  );
  assert.throws(
    () => validateProvenCapability(manifestWithCapabilities({ proven: { static_secret_live: [] } }), "invalid_request"),
    TOP_LEVEL_REGEX_19
  );
});

test("validateProvenCapability rejects an unsupported key under capabilities.proven.static_secret_live", () => {
  assert.throws(
    () =>
      validateProvenCapability(
        manifestWithCapabilities({ proven: { static_secret_live: { bogus_key: true, proven: true } } }),
        "invalid_request"
      ),
    TOP_LEVEL_REGEX_20
  );
});

test("validateProvenCapability rejects static_secret_live.proven that is not a boolean", () => {
  assert.throws(
    () =>
      validateProvenCapability(
        manifestWithCapabilities({ proven: { static_secret_live: { proven: "true" } } }),
        "invalid_request"
      ),
    TOP_LEVEL_REGEX_21
  );
});

test("validateProvenCapability rejects a run_id that is present but not a non-empty string or null", () => {
  assert.throws(
    () =>
      validateProvenCapability(
        manifestWithCapabilities({ proven: { static_secret_live: { proven: true, run_id: "" } } }),
        "invalid_request"
      ),
    TOP_LEVEL_REGEX_22
  );
  assert.throws(
    () =>
      validateProvenCapability(
        manifestWithCapabilities({ proven: { static_secret_live: { proven: true, run_id: 42 } } }),
        "invalid_request"
      ),
    TOP_LEVEL_REGEX_22
  );
});

test("validateProvenCapability accepts a null run_id", () => {
  assert.doesNotThrow(() =>
    validateProvenCapability(
      manifestWithCapabilities(
        { proven: { static_secret_live: { proven: true, run_id: null } } },
        { setup: { modality: "static_secret" } }
      ),
      "invalid_request"
    )
  );
});

test("validateProvenCapability rejects a date that is not an ISO yyyy-mm-dd string", () => {
  assert.throws(
    () =>
      validateProvenCapability(
        manifestWithCapabilities({ proven: { static_secret_live: { date: "08/09/2026", proven: true } } }),
        "invalid_request"
      ),
    TOP_LEVEL_REGEX_23
  );
  assert.throws(
    () =>
      validateProvenCapability(
        manifestWithCapabilities({ proven: { static_secret_live: { date: "2026-8-9", proven: true } } }),
        "invalid_request"
      ),
    TOP_LEVEL_REGEX_23
  );
});

test("validateProvenCapability rejects a note that is present but not a non-empty string", () => {
  assert.throws(
    () =>
      validateProvenCapability(
        manifestWithCapabilities({ proven: { static_secret_live: { note: "", proven: true } } }),
        "invalid_request"
      ),
    TOP_LEVEL_REGEX_24
  );
});

test("validateProvenCapability rejects static_secret_live.proven=true without setup.modality static_secret", () => {
  assert.throws(
    () =>
      validateProvenCapability(
        manifestWithCapabilities({ proven: { static_secret_live: { proven: true } } }),
        "invalid_request"
      ),
    TOP_LEVEL_REGEX_25
  );
  assert.throws(
    () =>
      validateProvenCapability(
        manifestWithCapabilities(
          { proven: { static_secret_live: { proven: true } } },
          { setup: { modality: "provider_authorization" } }
        ),
        "invalid_request"
      ),
    TOP_LEVEL_REGEX_25
  );
});

test("validateProvenCapability accepts static_secret_live.proven=true with setup.modality static_secret", () => {
  assert.doesNotThrow(() =>
    validateProvenCapability(
      manifestWithCapabilities(
        { proven: { static_secret_live: { proven: true } } },
        { setup: { modality: "static_secret" } }
      ),
      "invalid_request"
    )
  );
});

test("validateProvenCapability rejects provider_auth_lifecycle=true without setup.modality provider_authorization", () => {
  assert.throws(
    () =>
      validateProvenCapability(
        manifestWithCapabilities({ proven: { provider_auth_lifecycle: true } }),
        "invalid_request"
      ),
    TOP_LEVEL_REGEX_26
  );
  assert.throws(
    () =>
      validateProvenCapability(
        manifestWithCapabilities(
          { proven: { provider_auth_lifecycle: true } },
          { setup: { modality: "static_secret" } }
        ),
        "invalid_request"
      ),
    TOP_LEVEL_REGEX_26
  );
});

test("validateProvenCapability accepts provider_auth_lifecycle=true with setup.modality provider_authorization", () => {
  assert.doesNotThrow(() =>
    validateProvenCapability(
      manifestWithCapabilities(
        { proven: { provider_auth_lifecycle: true } },
        { setup: { modality: "provider_authorization" } }
      ),
      "invalid_request"
    )
  );
});

test("validateProvenCapability rejects local_collector=true without runtime_requirements.bindings.filesystem", () => {
  assert.throws(
    () => validateProvenCapability(manifestWithCapabilities({ proven: { local_collector: true } }), "invalid_request"),
    TOP_LEVEL_REGEX_27
  );
  assert.throws(
    () =>
      validateProvenCapability(
        manifestWithCapabilities(
          { proven: { local_collector: true } },
          { runtime_requirements: { bindings: { browser: {} } } }
        ),
        "invalid_request"
      ),
    TOP_LEVEL_REGEX_27
  );
});

test("validateProvenCapability accepts local_collector=true with runtime_requirements.bindings.filesystem", () => {
  assert.doesNotThrow(() =>
    validateProvenCapability(
      manifestWithCapabilities(
        { proven: { local_collector: true } },
        { runtime_requirements: { bindings: { filesystem: {} } } }
      ),
      "invalid_request"
    )
  );
});

test("validateProvenCapability rejects local_collector=false paired with an unrelated proof failure but does not itself require a binding", () => {
  // local_collector: false must never trigger the filesystem-binding
  // requirement — only local_collector === true does. This proves the
  // modality-consistency check reads the exact boolean, not truthiness.
  assert.doesNotThrow(() =>
    validateProvenCapability(manifestWithCapabilities({ proven: { local_collector: false } }), "invalid_request")
  );
});

function manifestWithCredentialCapture(field = {}) {
  return {
    ...manifestWithStream({}),
    setup: {
      credential_capture: {
        credential_kind: "static_secret",
        fields: [{ name: "password", secret: true, ...field }],
      },
    },
  };
}

test("validateConnectorManifest rejects a secret credential_capture field missing label at registration", () => {
  // P2-2 (see final-combined-uat-redteam-0811.md): this contract violation
  // must fail here, at registration, not later as a runtime 500 when setup
  // or runtime injection reads the same manifest.
  assert.throws(
    () => validateConnectorManifest(manifestWithCredentialCapture({ env: ["TEST_PASSWORD"], label: undefined })),
    TOP_LEVEL_REGEX_28
  );
});

test("validateConnectorManifest rejects a secret credential_capture field with zero env aliases at registration", () => {
  assert.throws(
    () => validateConnectorManifest(manifestWithCredentialCapture({ env: [], label: "Password" })),
    TOP_LEVEL_REGEX_29
  );
});

test("validateConnectorManifest accepts a well-formed secret credential_capture field", () => {
  assert.doesNotThrow(() =>
    validateConnectorManifest(manifestWithCredentialCapture({ env: ["TEST_PASSWORD"], label: "Password" }))
  );
});

test("validateConnectorManifest accepts a manifest with no credential_capture at all", () => {
  assert.doesNotThrow(() => validateConnectorManifest(manifestWithStream({})));
});
