// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mutation-killing unit tests for the pure expand/projection helpers in
 * `server/record-expand-helpers.js`.
 *
 * `assertRecordIdentity` is already covered by
 * `record-identity-validation.test.js`. This file pins the OTHER exported
 * pure surface with no by-name coverage:
 *
 *   - normalizePrimaryKey  (array/scalar/empty normalization)
 *   - parseIntegerValue    (integer coercion + strict digit regex)
 *   - assertNonEmptyJsonField (validates non-empty literal top-level keys)
 *   - buildEffectiveFilter (grant∩request field projection + required-field
 *                           union)
 *   - normalizeExpandRequest (the whole invalid_expand / insufficient_scope
 *                             error tree + limit clamping)
 *
 * SQL builders quote or bind this value; this helper only rejects absent field
 * names so valid JSON property names cannot be narrowed into identifiers.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNonEmptyJsonField,
  buildEffectiveFilter,
  normalizeExpandRequest,
  normalizePrimaryKey,
  parseIntegerValue,
} from "../server/record-expand-helpers.ts";

interface QueryError extends Error {
  code?: string;
}

function isQueryError(value: unknown): value is QueryError {
  return value instanceof Error;
}

function assertThrowsCode(fn: () => unknown, code?: string, messageIncludes?: string): QueryError {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, "expected the call to throw, but it returned normally");
  assert.ok(isQueryError(thrown), `expected an Error, got ${JSON.stringify(thrown)}`);
  if (code !== undefined) {
    assert.equal(thrown.code, code, `expected code=${code} but got ${JSON.stringify(thrown.code)} (${thrown.message})`);
  }
  if (messageIncludes !== undefined) {
    assert.ok(
      String(thrown.message).includes(messageIncludes),
      `expected message to include "${messageIncludes}" but got "${thrown.message}"`
    );
  }
  return thrown;
}

test("normalizePrimaryKey: arrays filter non-string/empty; scalar wraps; junk -> []", () => {
  assert.deepEqual(normalizePrimaryKey(["a", "b"]), ["a", "b"]);
  // Non-string and empty-string members are dropped.
  assert.deepEqual(normalizePrimaryKey(["a", "", null, 3, "b"]), ["a", "b"]);
  // A non-empty scalar string wraps into a one-element array.
  assert.deepEqual(normalizePrimaryKey("id"), ["id"]);
  // Empty string, undefined, number, object -> empty array.
  assert.deepEqual(normalizePrimaryKey(""), []);
  assert.deepEqual(normalizePrimaryKey(undefined), []);
  assert.deepEqual(normalizePrimaryKey(42), []);
});

test("parseIntegerValue: accepts int number / digit strings; rejects floats, blanks, garbage", () => {
  assert.equal(parseIntegerValue(7), 7);
  assert.equal(parseIntegerValue("7"), 7);
  assert.equal(parseIntegerValue("  -12 "), -12); // trimmed, sign allowed
  // A float number is NOT an integer -> null (Number.isInteger guard).
  assert.equal(parseIntegerValue(7.5), null);
  // A float string fails the /^-?\d+$/ regex -> null.
  assert.equal(parseIntegerValue("7.5"), null);
  assert.equal(parseIntegerValue(""), null);
  assert.equal(parseIntegerValue("   "), null);
  assert.equal(parseIntegerValue("12abc"), null);
  assert.equal(parseIntegerValue(null), null);
});

test("assertNonEmptyJsonField: accepts literal JSON keys and rejects absent values", () => {
  for (const field of ["emitted_at", "9field", "a.b", 'a"; DROP', "a b", "時刻"]) {
    assert.equal(assertNonEmptyJsonField(field, "x"), undefined);
  }
  assertThrowsCode(() => assertNonEmptyJsonField("", "sort"), undefined, "non-empty string");
  assertThrowsCode(() => assertNonEmptyJsonField(123, "sort"), undefined, "non-empty string");
});

test("buildEffectiveFilter: intersects request fields with grant, unions required fields", () => {
  // Grant limits to [a,b,c]; request narrows to [b,c,z] -> intersection [b,c].
  const eff = buildEffectiveFilter(
    {
      fields: ["a", "b", "c"],
      resources: ["k1"],
      time_constraint: { field: "frozen_at", since: "2026-01-01T00:00:00Z" },
    },
    { fields: ["b", "c", "z"] },
    []
  );
  assert.deepEqual(eff.fields, ["b", "c"]);
  assert.deepEqual(eff.timeConstraint, { field: "frozen_at", since: "2026-01-01T00:00:00Z" });
  assert.equal(eff.timeConstraintField, "frozen_at");
  assert.deepEqual(eff.resources, ["k1"]);

  // No grant field limit + request fields -> request fields used verbatim.
  const eff2 = buildEffectiveFilter({}, { fields: ["x", "y"] }, []);
  assert.deepEqual(eff2.fields, ["x", "y"]);

  // requiredFields are unioned in FRONT and de-duplicated.
  const eff3 = buildEffectiveFilter({ fields: ["a", "b"] }, {}, ["id", "a"]);
  assert.deepEqual(eff3.fields, ["id", "a", "b"]);

  // No grant limit and no request fields -> null (full projection).
  const eff4 = buildEffectiveFilter({}, {}, ["id"]);
  assert.equal(eff4.fields, null, "no field constraint anywhere -> null, required-fields not injected");
});

// ---- normalizeExpandRequest: the invalid_expand / insufficient_scope tree ----

const MANIFEST_STREAM = {
  query: {
    expand: [{ default_limit: 10, max_limit: 25, name: "items" }, { name: "customer" }],
  },
  relationships: [
    { cardinality: "has_many", name: "items", stream: "order_items" },
    { cardinality: "belongs_to", name: "customer", stream: "customers" },
  ],
};
const FULL_GRANT = { streams: [{ name: "order_items" }, { name: "customers" }] };

test("normalizeExpandRequest: no expand -> [], and expand_limit without expand is rejected", () => {
  assert.deepEqual(normalizeExpandRequest({}, "orders", FULL_GRANT, MANIFEST_STREAM, "DESC"), []);
  assert.deepEqual(normalizeExpandRequest({ expand: "" }, "orders", FULL_GRANT, MANIFEST_STREAM, "DESC"), []);

  // expand_limit present but expand absent -> invalid_expand (two guard sites).
  assertThrowsCode(
    () => normalizeExpandRequest({ expand_limit: { items: 5 } }, "orders", FULL_GRANT, MANIFEST_STREAM, "DESC"),
    "invalid_expand",
    "expand_limit requires a matching expand relation"
  );
});

test("normalizeExpandRequest: happy path applies default and requested limits, dedupes", () => {
  // Default limit from capability (10) when no explicit limit.
  const [items] = normalizeExpandRequest({ expand: "items" }, "orders", FULL_GRANT, MANIFEST_STREAM, "ASC");
  assert.ok(items, "expected exactly one expansion");
  assert.equal(items.name, "items");
  assert.equal(items.limit, 10);
  assert.equal(items.order, "ASC");

  // Explicit valid limit within max_limit is applied.
  const [limited] = normalizeExpandRequest(
    { expand: "items", expand_limit: { items: 5 } },
    "orders",
    FULL_GRANT,
    MANIFEST_STREAM,
    "DESC"
  );
  assert.ok(limited, "expected exactly one expansion");
  assert.equal(limited.limit, 5);

  // Repeated relation names are de-duplicated to a single expansion.
  const dup = normalizeExpandRequest({ expand: ["items", "items"] }, "orders", FULL_GRANT, MANIFEST_STREAM, "DESC");
  assert.equal(dup.length, 1);
});

test("normalizeExpandRequest: rejects nested, unknown, ungranted relations and bad limits", () => {
  // Nested path (dot) unsupported.
  assertThrowsCode(
    () => normalizeExpandRequest({ expand: "items.sku" }, "orders", FULL_GRANT, MANIFEST_STREAM, "DESC"),
    "invalid_expand",
    "Nested expansion"
  );

  // Unknown relation (not in relationships/capabilities).
  assertThrowsCode(
    () => normalizeExpandRequest({ expand: "ghost" }, "orders", FULL_GRANT, MANIFEST_STREAM, "DESC"),
    "invalid_expand",
    "Unsupported expand relation"
  );

  // Known relation but no grant to the child stream -> insufficient_scope (NOT invalid_expand).
  assertThrowsCode(
    () => normalizeExpandRequest({ expand: "items" }, "orders", { streams: [] }, MANIFEST_STREAM, "DESC"),
    "insufficient_scope",
    "requires grant access"
  );

  // expand_limit on a non-has_many relation is rejected.
  assertThrowsCode(
    () =>
      normalizeExpandRequest(
        { expand: "customer", expand_limit: { customer: 3 } },
        "orders",
        FULL_GRANT,
        MANIFEST_STREAM,
        "DESC"
      ),
    "invalid_expand",
    "only valid for has_many"
  );

  // Non-positive limit rejected.
  assertThrowsCode(
    () =>
      normalizeExpandRequest(
        { expand: "items", expand_limit: { items: 0 } },
        "orders",
        FULL_GRANT,
        MANIFEST_STREAM,
        "DESC"
      ),
    "invalid_expand",
    "must be a positive integer"
  );

  // Limit above max_limit rejected (25 is the declared max for items).
  assertThrowsCode(
    () =>
      normalizeExpandRequest(
        { expand: "items", expand_limit: { items: 26 } },
        "orders",
        FULL_GRANT,
        MANIFEST_STREAM,
        "DESC"
      ),
    "invalid_expand",
    "exceeds max_limit 25"
  );

  // expand_limit referencing a relation NOT in expand[] is rejected.
  assertThrowsCode(
    () =>
      normalizeExpandRequest(
        { expand: "items", expand_limit: { customer: 5 } },
        "orders",
        FULL_GRANT,
        MANIFEST_STREAM,
        "DESC"
      ),
    "invalid_expand",
    "requires a matching expand relation"
  );
});

test("normalizeExpandRequest: boundary limit equal to max_limit is accepted (off-by-one guard)", () => {
  const [items] = normalizeExpandRequest(
    { expand: "items", expand_limit: { items: 25 } },
    "orders",
    FULL_GRANT,
    MANIFEST_STREAM,
    "DESC"
  );
  assert.ok(items, "expected exactly one expansion");
  assert.equal(items.limit, 25, "limit exactly at max_limit must be allowed (> not >=)");
});
