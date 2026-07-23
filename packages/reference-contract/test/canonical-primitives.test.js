// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import Ajv from "ajv";
import addFormats from "ajv-formats";

import {
  CanonicalAggregateEnvelopeSchema,
  CanonicalListEnvelopeSchema,
  CanonicalReadInputProperties,
  CanonicalReadInputQuerySchema,
  CanonicalSchemaEnvelopeSchema,
  CanonicalSearchEnvelopeSchema,
  CanonicalSingleEnvelopeSchema,
  CountKindSchema,
  CountMetaSchema,
  CountParamSchema,
  ExpandLimitParamSchema,
  ExpandParamSchema,
  FieldsParamSchema,
  FilterParamSchema,
  LimitParamSchema,
  LinksSchema,
  MetaSchema,
  SortParamSchema,
  WarningCodeSchema,
  WarningSchema,
} from "../src/common/index.ts";

// Module-level Ajv: schemas live in a per-package shared instance so we mirror
// how `validateRequest` compiles its schemas at runtime.
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

function compile(schema) {
  return ajv.compile(schema);
}

function assertValid(validator, value, label) {
  const ok = validator(value);
  assert.ok(ok, `${label} should be valid: ${JSON.stringify(validator.errors)}`);
}

function assertInvalid(validator, value, label) {
  const ok = validator(value);
  assert.ok(!ok, `${label} should be invalid`);
}

// ----- Envelope: links and meta -----

test("LinksSchema accepts canonical self/next pairs and null next", () => {
  const validate = compile(LinksSchema);
  assertValid(validate, {}, "empty");
  assertValid(validate, { next: null, self: "/v1/streams/messages/records" }, "self + null next");
  assertValid(
    validate,
    { next: "/v1/streams/messages/records?cursor=abc", self: "/v1/streams/messages/records" },
    "self + concrete next"
  );
});

test("LinksSchema rejects unknown link members", () => {
  const validate = compile(LinksSchema);
  assertInvalid(
    validate,
    { prev: "/v1/streams/messages/records?cursor=foo", self: "/v1/streams/messages/records" },
    "unknown link member"
  );
});

test("CountKindSchema closes the initial grade vocabulary", () => {
  const validate = compile(CountKindSchema);
  for (const kind of ["none", "estimated", "exact"]) {
    assertValid(validate, kind, kind);
  }
  for (const kind of ["planned", "approximate", "", "EXACT", null]) {
    assertInvalid(validate, kind, `bad kind ${JSON.stringify(kind)}`);
  }
});

test("CountMetaSchema accepts `none` without a value and `estimated`/`exact` with one", () => {
  const validate = compile(CountMetaSchema);
  assertValid(validate, { kind: "none" }, "none without value");
  assertValid(validate, { kind: "estimated", value: 1234 }, "estimated with value");
  assertValid(validate, { kind: "exact", value: 0 }, "exact zero");
  assertInvalid(validate, { kind: "estimated", value: -1 }, "negative count");
  assertInvalid(validate, { value: 5 }, "missing kind");
  assertInvalid(validate, { kind: "estimated", surplus: true }, "unknown property");
});

test("WarningCodeSchema enumerates the initial closed code set", () => {
  const validate = compile(WarningCodeSchema);
  for (const code of [
    "count_downgraded",
    "source_skipped_not_applicable",
    "deprecated_alias_used",
    "limit_clamped",
    "partial_results",
    "compatibility_fallback",
  ]) {
    assertValid(validate, code, code);
  }
  assertInvalid(validate, "arbitrary_warning", "unknown warning code");
});

test("WarningSchema accepts well-formed structured warnings", () => {
  const validate = compile(WarningSchema);
  assertValid(validate, { code: "count_downgraded", message: "exact -> estimated" }, "minimal");
  assertValid(
    validate,
    {
      code: "source_skipped_not_applicable",
      connection_id: "cin_abc",
      detail: { connector_id: "spotify" },
      message: "spotify did not contribute to `messages`",
      param: "connection_id",
    },
    "with detail, param, and connection_id"
  );
  assertInvalid(validate, { code: "count_downgraded" }, "missing message");
  assertInvalid(validate, { code: "unknown_code", message: "no" }, "unknown code");
});

test("MetaSchema accepts {count, warnings} and rejects unknown members", () => {
  const validate = compile(MetaSchema);
  assertValid(validate, {}, "empty");
  assertValid(
    validate,
    {
      count: { kind: "estimated", value: 12 },
      warnings: [{ code: "count_downgraded", message: "downgraded" }],
    },
    "count + warnings"
  );
  assertInvalid(validate, { count: { kind: "none" }, extra: true }, "unknown member");
});

// ----- Envelope helpers -----

const recordItem = {
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    object: { const: "record" },
    stream: { type: "string" },
  },
  required: ["object", "id", "stream"],
  type: "object",
};

test("CanonicalListEnvelopeSchema requires data/has_more/links/meta and the list discriminator", () => {
  const validate = compile(CanonicalListEnvelopeSchema(recordItem));
  assertValid(
    validate,
    {
      data: [{ id: "r_1", object: "record", stream: "messages" }],
      has_more: false,
      links: { next: null, self: "/v1/streams/messages/records" },
      meta: { count: { kind: "none" }, warnings: [] },
      object: "list",
    },
    "canonical list payload"
  );
  assertInvalid(
    validate,
    {
      data: [],
      has_more: false,
      links: { self: "/v1/streams/messages/records" },
      object: "list",
      // meta missing
    },
    "missing meta"
  );
  assertInvalid(
    validate,
    {
      data: [],
      has_more: false,
      links: {},
      meta: {},
      object: "record",
    },
    "wrong discriminator"
  );
});

test("CanonicalSingleEnvelopeSchema scopes the discriminator and forbids extra members", () => {
  const validate = compile(
    CanonicalSingleEnvelopeSchema("record", {
      properties: { id: { type: "string" } },
      required: ["id"],
      type: "object",
    })
  );
  assertValid(
    validate,
    {
      data: { id: "r_1" },
      links: { next: null, self: "/v1/streams/messages/records/r_1" },
      meta: {},
      object: "record",
    },
    "canonical single payload"
  );
  assertInvalid(
    validate,
    {
      data: { id: "r_1" },
      has_more: false,
      links: {},
      meta: {},
      object: "record",
    },
    "has_more is not allowed on single envelope"
  );
});

test('CanonicalSchemaEnvelopeSchema pins object="schema"', () => {
  const validate = compile(CanonicalSchemaEnvelopeSchema({ type: "object" }));
  assertValid(validate, { data: {}, links: {}, meta: {}, object: "schema" }, "schema envelope");
  assertInvalid(validate, { data: {}, links: {}, meta: {}, object: "list" }, "wrong discriminator");
});

test('CanonicalSearchEnvelopeSchema requires the list shape under object="search"', () => {
  const validate = compile(CanonicalSearchEnvelopeSchema(recordItem));
  assertValid(
    validate,
    {
      data: [],
      has_more: false,
      links: { next: null },
      meta: { count: { kind: "none" } },
      object: "search",
    },
    "empty search page"
  );
});

test("CanonicalAggregateEnvelopeSchema is the aggregate-flavored single envelope", () => {
  const validate = compile(CanonicalAggregateEnvelopeSchema({ type: "object" }));
  assertValid(
    validate,
    {
      data: { metric: "count", value: 42 },
      links: {},
      meta: { count: { kind: "exact", value: 42 } },
      object: "aggregate",
    },
    "aggregate envelope"
  );
});

// ----- Shared read-input parameters -----

test("FieldsParamSchema accepts CSV string and array forms but rejects empty", () => {
  const validate = compile(FieldsParamSchema);
  assertValid(validate, "id,name,data.title", "csv");
  assertValid(validate, ["id", "name", "data.title"], "array");
  assertInvalid(validate, "", "empty csv");
  assertInvalid(validate, [], "empty array");
  assertInvalid(validate, [""], "array of empty");
});

test("ExpandParamSchema requires non-empty relation names", () => {
  const validate = compile(ExpandParamSchema);
  assertValid(validate, ["artist"], "single relation");
  assertValid(validate, [], "empty allowed at the schema layer");
  assertInvalid(validate, [""], "empty relation name");
  assertInvalid(validate, "artist", "non-array form");
});

test("ExpandLimitParamSchema requires positive integer per relation", () => {
  const validate = compile(ExpandLimitParamSchema);
  assertValid(validate, { albums: 5, artist: 1 }, "two relations");
  assertInvalid(validate, { artist: 0 }, "zero limit");
  assertInvalid(validate, { artist: -1 }, "negative limit");
  assertInvalid(validate, { artist: "5" }, "string limit");
});

test("FilterParamSchema accepts exact scalars and operator submaps", () => {
  const validate = compile(FilterParamSchema);
  assertValid(validate, { sent_at: "2026-01-01" }, "exact string");
  assertValid(validate, { unread: true }, "exact boolean");
  assertValid(validate, { sent_at: { gte: "2026-01-01", lt: "2026-02-01" } }, "operator map");
  assertInvalid(validate, { sent_at: { gte: { nested: "object" } } }, "nested object operator value");
  assertInvalid(validate, { sent_at: ["array"] }, "array filter value");
});

test("SortParamSchema accepts sign-prefix CSV and array, rejects pathological forms", () => {
  const validate = compile(SortParamSchema);
  assertValid(validate, "-emitted_at,name", "csv");
  assertValid(validate, ["-emitted_at", "name"], "array");
  assertInvalid(validate, "+emitted_at", "plus prefix not allowed");
  assertInvalid(validate, "-emitted at", "space in field name");
  assertInvalid(validate, "", "empty");
});

test("CountParamSchema closes on none/estimated/exact", () => {
  const validate = compile(CountParamSchema);
  for (const kind of ["none", "estimated", "exact"]) {
    assertValid(validate, kind, kind);
  }
  assertInvalid(validate, "planned", "planned not allowed");
});

test("LimitParamSchema bounds to [1, 500]", () => {
  const validate = compile(LimitParamSchema);
  assertValid(validate, 1, "min");
  assertValid(validate, 500, "max");
  assertInvalid(validate, 0, "zero");
  assertInvalid(validate, 501, "too big");
  assertInvalid(validate, 1.5, "fractional");
});

test("CanonicalReadInputQuerySchema bundles primitives and rejects unknown members", () => {
  const validate = compile(CanonicalReadInputQuerySchema());
  assertValid(
    validate,
    {
      connection_id: "cin_abc",
      connector_instance_id: "cin_abc",
      count: "estimated",
      cursor: "opaque-cursor",
      expand: ["artist"],
      expand_limit: { artist: 1 },
      fields: ["id", "data.title"],
      filter: { sent_at: { gte: "2026-01-01" } },
      limit: 50,
      sort: "-emitted_at,name",
    },
    "full bundle"
  );
  assertInvalid(validate, { extra_param: true, fields: ["id"] }, "unknown parameter rejected");
});

test("CanonicalReadInputQuerySchema accepts extra properties when explicitly opted in", () => {
  const validate = compile(
    CanonicalReadInputQuerySchema({
      q: { minLength: 1, type: "string" },
    })
  );
  assertValid(validate, { limit: 10, q: "hello world" }, "search-style extension");
  assertInvalid(validate, { q: "hello", surprise: true }, "still strict beyond extensions");
});

test("CanonicalReadInputProperties exposes the deprecated alias for the migration window", () => {
  // Smoke test: this is the documented contract surface for callers that want
  // to compose their own query shape instead of using
  // CanonicalReadInputQuerySchema.
  assert.ok(CanonicalReadInputProperties.connection_id, "must export connection_id");
  assert.ok(CanonicalReadInputProperties.connector_instance_id, "must export connector_instance_id alias");
  assert.match(
    CanonicalReadInputProperties.connector_instance_id.description,
    /[Dd]eprecated/,
    "alias description must call out deprecation"
  );
});
