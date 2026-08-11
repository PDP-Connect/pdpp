// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mutation-killing unit coverage for the pure helpers in
 * `server/record-expand-helpers.ts`, excluding `assertRecordIdentity`
 * (already covered directly by `record-identity-validation.test.js`).
 *
 * `normalizeExpandRequest` is exercised only indirectly through the
 * DB-backed expand-hydration integration tests, which hit a handful of its
 * error codes but leave most of the parser's branch matrix — nested-path
 * rejection, empty/whitespace relation names, expand shape guards, the
 * expand_limit shape/positivity/max/cardinality guards, dangling
 * expand_limit relations, duplicate-name dedup, and the insufficient_scope
 * child-grant gate — unpinned. `buildEffectiveFilter`, `normalizePrimaryKey`,
 * `parseIntegerValue`, and `assertNonEmptyJsonField` have no direct coverage at
 * all.
 *
 * A mutant that flips a `<=`/`<` boundary, drops a shape guard, mis-labels an
 * error code (`invalid_expand` vs `insufficient_scope`), or breaks the
 * required-field / request-intersection projection math would survive today.
 *
 * Observation-only: no source logic is changed, including the grant-scope
 * gates (`insufficient_scope`, request∩grant field intersection).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNonEmptyJsonField,
  buildEffectiveFilter,
  invalidQueryError,
  normalizeExpandRequest,
  normalizePrimaryKey,
  parseIntegerValue,
} from "../server/record-expand-helpers.ts";

interface QueryError extends Error {
  code?: string;
}

const INVALID_JSON_FIELD_PATTERN = /non-empty string/;

function isQueryError(value: unknown): value is QueryError {
  return value instanceof Error;
}

// noUncheckedIndexedAccess makes array[0] possibly-undefined; call sites
// already assert `.length` immediately before reading index 0 in most
// cases, and always know the array is non-empty by construction. This
// re-asserts non-emptiness to narrow the type without a non-null assertion.
function first<T>(items: T[]): T {
  assert.ok(items.length > 0, "expected a non-empty array");
  const [item] = items;
  assert.ok(item !== undefined);
  return item;
}

// ─── invalidQueryError ───────────────────────────────────────────────────

test("invalidQueryError defaults to invalid_request", () => {
  const err = invalidQueryError("x");
  assert.ok(isQueryError(err), `expected an Error, got ${JSON.stringify(err)}`);
  assert.equal(err.code, "invalid_request");
  assert.equal(err.message, "x");
});

test("invalidQueryError honors an explicit code", () => {
  const err = invalidQueryError("x", "invalid_expand");
  assert.ok(isQueryError(err), `expected an Error, got ${JSON.stringify(err)}`);
  assert.equal(err.code, "invalid_expand");
});

// ─── normalizePrimaryKey ─────────────────────────────────────────────────

test("normalizePrimaryKey filters non-string / empty entries from an array", () => {
  assert.deepEqual(normalizePrimaryKey(["a", "", 2, "b"]), ["a", "b"]);
});

test("normalizePrimaryKey wraps a non-empty string as a single-field key", () => {
  assert.deepEqual(normalizePrimaryKey("id"), ["id"]);
});

test("normalizePrimaryKey returns [] for an empty string", () => {
  assert.deepEqual(normalizePrimaryKey(""), []);
});

test("normalizePrimaryKey returns [] for null / undefined / non-string scalars", () => {
  assert.deepEqual(normalizePrimaryKey(null), []);
  assert.deepEqual(normalizePrimaryKey(undefined), []);
  assert.deepEqual(normalizePrimaryKey(42), []);
});

// ─── parseIntegerValue ───────────────────────────────────────────────────

test("parseIntegerValue accepts an integer number", () => {
  assert.equal(parseIntegerValue(5), 5);
  assert.equal(parseIntegerValue(-3), -3);
  assert.equal(parseIntegerValue(0), 0);
});

test("parseIntegerValue rejects a non-integer number", () => {
  assert.equal(parseIntegerValue(1.5), null);
});

test("parseIntegerValue parses a trimmed integer string", () => {
  assert.equal(parseIntegerValue(" 7 "), 7);
  assert.equal(parseIntegerValue("-42"), -42);
});

test("parseIntegerValue rejects a non-integer / non-numeric string", () => {
  assert.equal(parseIntegerValue("1.5"), null);
  assert.equal(parseIntegerValue("x"), null);
  assert.equal(parseIntegerValue(""), null);
});

test("parseIntegerValue rejects non-string, non-number inputs", () => {
  assert.equal(parseIntegerValue(null), null);
  assert.equal(parseIntegerValue(undefined), null);
  assert.equal(parseIntegerValue({}), null);
});

// ─── assertNonEmptyJsonField ──────────────────────────────────────────────

test("assertNonEmptyJsonField accepts literal field names and rejects non-strings", () => {
  for (const field of ["subject_id", "1bad", "a.b", "has-dash", 'said "when"', "時刻"]) {
    assert.doesNotThrow(() => assertNonEmptyJsonField(field, "sort"));
  }
  assert.throws(
    () => assertNonEmptyJsonField(5, "sort"),
    (err: unknown) => isQueryError(err) && INVALID_JSON_FIELD_PATTERN.test(err.message)
  );
});

// ─── buildEffectiveFilter ────────────────────────────────────────────────

test("buildEffectiveFilter carries grant scopes through when no request fields", () => {
  const eff = buildEffectiveFilter(
    {
      fields: ["a", "b"],
      resources: ["r1"],
      time_constraint: { field: "frozen_at", since: "2026-01-01T00:00:00Z" },
    },
    {},
    []
  );
  assert.deepEqual(eff, {
    fields: ["a", "b"],
    resources: ["r1"],
    timeConstraint: { field: "frozen_at", since: "2026-01-01T00:00:00Z" },
    timeConstraintField: "frozen_at",
  });
});

test("buildEffectiveFilter intersects request fields with a scoped grant and adds required", () => {
  const eff = buildEffectiveFilter(
    { fields: ["a", "b", "c"] },
    { fields: ["b", "c", "z"] }, // z is not in grant -> dropped
    ["a"] // required -> unioned back in
  );
  assert.deepEqual(eff.fields, ["a", "b", "c"]);
});

test("buildEffectiveFilter uses request fields verbatim when grant is unscoped", () => {
  const eff = buildEffectiveFilter({}, { fields: ["x", "y"] }, ["k"]);
  assert.deepEqual(eff.fields, ["k", "x", "y"]);
});

test("buildEffectiveFilter leaves fields null (and injects no required) when nothing scopes them", () => {
  const eff = buildEffectiveFilter({}, {}, ["k"]);
  assert.equal(eff.fields, null);
});

test("buildEffectiveFilter dedupes required fields already present", () => {
  const eff = buildEffectiveFilter({ fields: ["a", "b"] }, {}, ["a"]);
  assert.deepEqual(eff.fields, ["a", "b"]);
});

// ─── normalizeExpandRequest ──────────────────────────────────────────────

const MANIFEST_STREAM = {
  query: {
    expand: [
      { default_limit: 10, max_limit: 25, name: "attachments" },
      { default_limit: 1, max_limit: 1, name: "author" },
    ],
  },
  relationships: [
    { cardinality: "has_many", name: "attachments", stream: "files" },
    { cardinality: "has_one", name: "author", stream: "people" },
  ],
};

const GRANT = { streams: [{ name: "files" }, { name: "people" }] };
const GRANT_NO_FILES = { streams: [{ name: "people" }] };

function expandThrows(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(isQueryError(err), `expected an Error, got ${JSON.stringify(err)}`);
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

test("normalizeExpandRequest returns [] when expand is absent or empty", () => {
  assert.deepEqual(normalizeExpandRequest({}, "messages", GRANT, MANIFEST_STREAM, undefined), []);
  assert.deepEqual(normalizeExpandRequest({ expand: "" }, "messages", GRANT, MANIFEST_STREAM, undefined), []);
  assert.deepEqual(normalizeExpandRequest({ expand: null }, "messages", GRANT, MANIFEST_STREAM, undefined), []);
});

test("normalizeExpandRequest compiles a has_many relation with its default limit and order", () => {
  const out = normalizeExpandRequest({ expand: "attachments" }, "messages", GRANT, MANIFEST_STREAM, "desc");
  assert.equal(out.length, 1);
  const expansion = first(out);
  assert.equal(expansion.name, "attachments");
  assert.equal(expansion.limit, 10);
  assert.equal(expansion.order, "desc");
  assert.equal(expansion.childGrant.name, "files");
});

test("normalizeExpandRequest applies a valid custom expand_limit", () => {
  const out = normalizeExpandRequest(
    { expand: "attachments", expand_limit: { attachments: 5 } },
    "messages",
    GRANT,
    MANIFEST_STREAM,
    undefined
  );
  assert.equal(first(out).limit, 5);
});

test("normalizeExpandRequest dedupes repeated relation names", () => {
  const out = normalizeExpandRequest(
    { expand: ["attachments", "attachments"] },
    "messages",
    GRANT,
    MANIFEST_STREAM,
    undefined
  );
  assert.equal(out.length, 1);
});

test("normalizeExpandRequest rejects expand_limit without expand (both nullish-expand paths)", () => {
  expandThrows(
    () => normalizeExpandRequest({ expand_limit: { attachments: 5 } }, "messages", GRANT, MANIFEST_STREAM, undefined),
    "invalid_expand"
  );
  expandThrows(
    () =>
      normalizeExpandRequest(
        { expand: "", expand_limit: { attachments: 5 } },
        "messages",
        GRANT,
        MANIFEST_STREAM,
        undefined
      ),
    "invalid_expand"
  );
});

test("normalizeExpandRequest rejects an object-shaped expand", () => {
  expandThrows(
    () => normalizeExpandRequest({ expand: { x: 1 } }, "messages", GRANT, MANIFEST_STREAM, undefined),
    "invalid_expand"
  );
});

test("normalizeExpandRequest rejects an expand list that trims to nothing", () => {
  expandThrows(
    () => normalizeExpandRequest({ expand: ["  ", ""] }, "messages", GRANT, MANIFEST_STREAM, undefined),
    "invalid_expand"
  );
});

test("normalizeExpandRequest rejects a non-object expand_limit", () => {
  expandThrows(
    () =>
      normalizeExpandRequest(
        { expand: "attachments", expand_limit: "5" },
        "messages",
        GRANT,
        MANIFEST_STREAM,
        undefined
      ),
    "invalid_expand"
  );
});

test("normalizeExpandRequest rejects a nested (dotted) expansion", () => {
  expandThrows(
    () => normalizeExpandRequest({ expand: "a.b" }, "messages", GRANT, MANIFEST_STREAM, undefined),
    "invalid_expand"
  );
});

test("normalizeExpandRequest rejects an unsupported relation name", () => {
  expandThrows(
    () => normalizeExpandRequest({ expand: "nope" }, "messages", GRANT, MANIFEST_STREAM, undefined),
    "invalid_expand"
  );
});

test("normalizeExpandRequest fails closed (insufficient_scope) without a child grant", () => {
  expandThrows(
    () => normalizeExpandRequest({ expand: "attachments" }, "messages", GRANT_NO_FILES, MANIFEST_STREAM, undefined),
    "insufficient_scope"
  );
});

test("normalizeExpandRequest rejects expand_limit on a non-has_many relation", () => {
  expandThrows(
    () =>
      normalizeExpandRequest(
        { expand: "author", expand_limit: { author: 1 } },
        "messages",
        GRANT,
        MANIFEST_STREAM,
        undefined
      ),
    "invalid_expand"
  );
});

test("normalizeExpandRequest rejects a non-positive expand_limit", () => {
  for (const bad of [0, -1, "0", "x", 2.5]) {
    expandThrows(
      () =>
        normalizeExpandRequest(
          { expand: "attachments", expand_limit: { attachments: bad } },
          "messages",
          GRANT,
          MANIFEST_STREAM,
          undefined
        ),
      "invalid_expand"
    );
  }
});

test("normalizeExpandRequest rejects an expand_limit above the relation max_limit", () => {
  expandThrows(
    () =>
      normalizeExpandRequest(
        { expand: "attachments", expand_limit: { attachments: 26 } }, // max is 25
        "messages",
        GRANT,
        MANIFEST_STREAM,
        undefined
      ),
    "invalid_expand"
  );
});

test("normalizeExpandRequest accepts an expand_limit exactly at max_limit", () => {
  const out = normalizeExpandRequest(
    { expand: "attachments", expand_limit: { attachments: 25 } },
    "messages",
    GRANT,
    MANIFEST_STREAM,
    undefined
  );
  assert.equal(first(out).limit, 25);
});

test("normalizeExpandRequest rejects an expand_limit for a relation not being expanded", () => {
  expandThrows(
    () =>
      normalizeExpandRequest(
        { expand: "attachments", expand_limit: { author: 1 } },
        "messages",
        GRANT,
        MANIFEST_STREAM,
        undefined
      ),
    "invalid_expand"
  );
});

test("normalizeExpandRequest falls back to default_limit=10 / max_limit=50 when capability omits them", () => {
  const stream = {
    query: { expand: [{ name: "notes" }] },
    relationships: [{ cardinality: "has_many", name: "notes", stream: "notes_stream" }],
  };
  const grant = { streams: [{ name: "notes_stream" }] };
  const def = normalizeExpandRequest({ expand: "notes" }, "messages", grant, stream, undefined);
  assert.equal(first(def).limit, 10);
  // 50 is the default ceiling; 50 accepted, 51 rejected.
  const atCeiling = normalizeExpandRequest(
    { expand: "notes", expand_limit: { notes: 50 } },
    "m",
    grant,
    stream,
    undefined
  );
  assert.equal(first(atCeiling).limit, 50);
  expandThrows(
    () => normalizeExpandRequest({ expand: "notes", expand_limit: { notes: 51 } }, "m", grant, stream, undefined),
    "invalid_expand"
  );
});
