// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mutation-killing unit tests for the remaining uncovered pure helpers in
 * `server/record-filters.js` that the earlier predicate suite did not touch:
 *
 *   - fingerprintDeclaredFields   (dedup + SORT + JSON — an order-stable
 *                                  fingerprint used to detect declared-field
 *                                  drift)
 *   - compileSingleStreamSearchFilter (null-guards: missing stream name /
 *                                  manifest stream / stream grant all yield
 *                                  null before any filter compilation)
 *   - hashSearchPlanSummary       (a canonical, order-independent plan hash)
 *
 * The determinism / order-independence assertions are the point: a mutant
 * that drops the `.sort()` in the fingerprint, or the ordering comparator in
 * the plan hash, makes two logically-equal inputs hash differently and turns
 * red here.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  compileSingleStreamSearchFilter,
  fingerprintDeclaredFields,
  hashSearchPlanSummary,
} from "../server/record-filters.ts";

test("fingerprintDeclaredFields: dedupes, SORTS, and is insertion-order independent", () => {
  const a = fingerprintDeclaredFields(["b", "a", "c"]);
  const b = fingerprintDeclaredFields(["c", "b", "a"]);
  assert.equal(a, b, "fingerprint must not depend on input order");
  assert.equal(a, JSON.stringify(["a", "b", "c"]));

  // Duplicates collapse to a single entry.
  assert.equal(fingerprintDeclaredFields(["a", "a", "b"]), JSON.stringify(["a", "b"]));

  // Empty input -> empty JSON array.
  assert.equal(fingerprintDeclaredFields([]), "[]");

  // A different field SET produces a different fingerprint (drift detection).
  assert.notEqual(fingerprintDeclaredFields(["a", "b"]), fingerprintDeclaredFields(["a", "b", "c"]));
});

test("compileSingleStreamSearchFilter: null-guards on stream name / manifest / grant", () => {
  const manifest = { streams: [{ name: "messages", schema: { properties: { body: { type: "string" } } } }] };
  const grant = { streams: [{ fields: ["body"], name: "messages" }] };

  // No stream name -> null (never touches manifest/grant).
  assert.equal(compileSingleStreamSearchFilter({ filter: {}, grant, manifest, streamName: "" }), null);
  assert.equal(compileSingleStreamSearchFilter({ filter: {}, grant, manifest, streamName: null }), null);

  // Stream name not in the manifest -> null.
  assert.equal(compileSingleStreamSearchFilter({ filter: {}, grant, manifest, streamName: "ghost" }), null);

  // Stream in manifest but not in the grant -> null (fail closed, no filter compiled).
  assert.equal(
    compileSingleStreamSearchFilter({ filter: {}, grant: { streams: [] }, manifest, streamName: "messages" }),
    null
  );

  // Fully resolvable -> a compiled descriptor with the stream name and filters.
  const resolved = compileSingleStreamSearchFilter({
    filter: { body: "hello" },
    grant,
    manifest,
    streamName: "messages",
  });
  assert.ok(resolved, "expected a fully resolvable filter to compile");
  assert.equal(resolved.streamName, "messages");
  assert.deepEqual(resolved.filters, [{ field: "body", kind: "exact", value: "hello" }]);
});

test("hashSearchPlanSummary: canonical, order-independent across connectors/streams/fields", () => {
  const planA = {
    isOwner: true,
    perConnectorPlans: [
      {
        connectorId: "github",
        planEntries: [
          { connectorInstanceId: "cin_2", searchableFields: ["name", "desc"], streamName: "repos" },
          { connectorInstanceId: "cin_1", searchableFields: ["title"], streamName: "issues" },
        ],
      },
      {
        connectorId: "amazon",
        planEntries: [{ connectorInstanceId: "cin_3", searchableFields: ["id"], streamName: "orders" }],
      },
    ],
  };
  // Same logical plan, but connectors, entries, and field lists shuffled.
  const planB = {
    isOwner: true,
    perConnectorPlans: [
      {
        connectorId: "amazon",
        planEntries: [{ connectorInstanceId: "cin_3", searchableFields: ["id"], streamName: "orders" }],
      },
      {
        connectorId: "github",
        planEntries: [
          { connectorInstanceId: "cin_1", searchableFields: ["title"], streamName: "issues" },
          { connectorInstanceId: "cin_2", searchableFields: ["desc", "name"], streamName: "repos" },
        ],
      },
    ],
  };
  assert.equal(hashSearchPlanSummary(planA), hashSearchPlanSummary(planB), "hash must be order-independent");

  // isOwner is part of the hash: flipping it changes the result.
  assert.notEqual(hashSearchPlanSummary(planA), hashSearchPlanSummary({ ...planA, isOwner: false }));

  // A different field set changes the hash.
  const planC = JSON.parse(JSON.stringify(planA));
  planC.perConnectorPlans[0].planEntries[0].searchableFields = ["name"];
  assert.notEqual(hashSearchPlanSummary(planA), hashSearchPlanSummary(planC));
});
