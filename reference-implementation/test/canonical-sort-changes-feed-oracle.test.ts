// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure-logic oracle for validateCanonicalSort and
// rejectListOnlyParamsForChangesFeed (server/record-query-helpers.ts), two
// untested query_records validators. validateCanonicalSort enforces the
// canonical `sort` contract: the sign prefix MUST control direction (accepting
// `sort` as a no-op is forbidden), only the stream's advertised cursor field is
// sortable, and conflicting directions are rejected — all with the typed
// invalid_sort error carrying param='sort'. rejectListOnlyParamsForChangesFeed
// rejects list-only params on the changes feed. No DB.
//
// Spec: openspec/changes/canonicalize-public-read-contract

import assert from "node:assert/strict";
import test from "node:test";
import { rejectListOnlyParamsForChangesFeed, validateCanonicalSort } from "../server/record-query-helpers.ts";

const MANIFEST_STREAM = { cursor_field: "emitted_at" };

interface QueryError extends Error {
  code?: string;
  param?: string;
}

function isQueryError(err: unknown): err is QueryError {
  return err instanceof Error;
}

function invalidSort() {
  return (err: unknown) => {
    assert.ok(isQueryError(err));
    assert.equal(err.code, "invalid_sort");
    assert.equal(err.param, "sort");
    return true;
  };
}

test("validateCanonicalSort returns null for an absent sort", () => {
  assert.equal(validateCanonicalSort(null, MANIFEST_STREAM), null);
  assert.equal(validateCanonicalSort("", MANIFEST_STREAM), null);
});

test("validateCanonicalSort maps the sign prefix to direction on the cursor field", () => {
  assert.deepEqual(validateCanonicalSort("emitted_at", MANIFEST_STREAM), { direction: "ASC", field: "emitted_at" });
  assert.deepEqual(validateCanonicalSort("-emitted_at", MANIFEST_STREAM), { direction: "DESC", field: "emitted_at" });
  // An array value is joined and parsed the same way.
  assert.deepEqual(validateCanonicalSort(["emitted_at"], MANIFEST_STREAM), { direction: "ASC", field: "emitted_at" });
});

test("validateCanonicalSort rejects a non-cursor field, a missing cursor field, and conflicting directions", () => {
  assert.throws(() => validateCanonicalSort("other_field", MANIFEST_STREAM), invalidSort());
  assert.throws(() => validateCanonicalSort("emitted_at", { cursor_field: null }), invalidSort());
  assert.throws(() => validateCanonicalSort("emitted_at,-emitted_at", MANIFEST_STREAM), invalidSort());
});

test("rejectListOnlyParamsForChangesFeed passes a bare changes feed and rejects list-only params", () => {
  assert.doesNotThrow(() => rejectListOnlyParamsForChangesFeed({ changes_since: "x" }));
  assert.throws(
    () => rejectListOnlyParamsForChangesFeed({ count: "exact", sort: "a" }),
    (err: unknown) => {
      assert.ok(isQueryError(err));
      assert.equal(err.code, "invalid_request");
      assert.ok(err.message.includes("sort, count"));
      assert.ok(err.message.includes("not supported with changes_since"));
      return true;
    }
  );
  // A single offending param uses the singular "is".
  assert.throws(
    () => rejectListOnlyParamsForChangesFeed({ order: "asc" }),
    (err: unknown) => {
      assert.ok(isQueryError(err));
      assert.ok(err.message.includes("order is not supported with changes_since"));
      return true;
    }
  );
});
