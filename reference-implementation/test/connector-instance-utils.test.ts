// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure connector-instance id/key derivation helpers.
 *
 * These helpers are the canonical key derivation shared by the SQLite and
 * Postgres bootstrap paths (and the connector-instance store). They are pure
 * (no I/O), so they are exercised directly here. The assertions pin:
 *   - stableJson canonical ordering + null/array/scalar shapes,
 *   - the cin_ id prefix + 24-hex-char truncation width,
 *   - source-kind classification boundaries,
 *   - nonEmptyString trimming semantics,
 *   - the spine-source shape parsing precedence (canonical > legacy > inferred),
 *   - deriveSpineSource payload-then-row fallback precedence.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveSpineSource,
  hashKey,
  isSourceKind,
  makeConnectorInstanceId,
  makeConnectorInstanceSourceBindingKey,
  nonEmptyString,
  parseSpineSourceShape,
  stableJson,
} from "../server/connector-instance-utils.ts";

test("stableJson emits keys in sorted order regardless of insertion order", () => {
  const a = stableJson({ a: 2, b: 1 });
  const b = stableJson({ a: 2, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":2,"b":1}');
});

test("stableJson maps null and undefined to empty object literal", () => {
  assert.equal(stableJson(null), "{}");
  assert.equal(stableJson(undefined), "{}");
});

test("stableJson recurses into arrays and nested objects", () => {
  assert.equal(stableJson([{ x: 2, y: 1 }, "z"]), '[{"x":2,"y":1},"z"]');
});

test("stableJson serializes scalars via JSON.stringify", () => {
  assert.equal(stableJson("hi"), '"hi"');
  assert.equal(stableJson(7), "7");
  assert.equal(stableJson(true), "true");
});

test("hashKey returns a stable 64-char sha256 hex digest", () => {
  const digest = hashKey("abc");
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(digest, hashKey("abc"));
  assert.notEqual(digest, hashKey("abd"));
});

test("makeConnectorInstanceSourceBindingKey is order-insensitive over binding keys", () => {
  const k1 = makeConnectorInstanceSourceBindingKey({ a: 2, b: 1 });
  const k2 = makeConnectorInstanceSourceBindingKey({ a: 2, b: 1 });
  assert.equal(k1, k2);
  // null binding hashes the empty-object literal.
  assert.equal(makeConnectorInstanceSourceBindingKey(null), hashKey("{}"));
});

test("makeConnectorInstanceId carries the cin_ prefix and a 24-hex-char body", () => {
  const id = makeConnectorInstanceId("owner", "gmail", "connector", "bk");
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.match(id, /^cin_[0-9a-f]{24}$/);
  // Deterministic + sensitive to every field.
  assert.equal(id, makeConnectorInstanceId("owner", "gmail", "connector", "bk"));
  assert.notEqual(id, makeConnectorInstanceId("owner2", "gmail", "connector", "bk"));
  assert.notEqual(id, makeConnectorInstanceId("owner", "gmail", "provider_native", "bk"));
});

test("nonEmptyString trims and rejects blank / non-string values", () => {
  assert.equal(nonEmptyString("  x  "), "x");
  assert.equal(nonEmptyString("   "), null);
  assert.equal(nonEmptyString(""), null);
  assert.equal(nonEmptyString(5), null);
  assert.equal(nonEmptyString(null), null);
});

test("isSourceKind accepts only the two canonical kinds", () => {
  assert.equal(isSourceKind("connector"), true);
  assert.equal(isSourceKind("provider_native"), true);
  assert.equal(isSourceKind("provider"), false);
  assert.equal(isSourceKind(""), false);
  assert.equal(isSourceKind(null), false);
});

test("parseSpineSourceShape prefers canonical kind+id when valid", () => {
  assert.deepEqual(parseSpineSourceShape({ connector_id: "other", id: "gmail", kind: "connector" }), {
    id: "gmail",
    kind: "connector",
  });
});

test("parseSpineSourceShape falls back to legacy binding_kind mapping", () => {
  assert.deepEqual(parseSpineSourceShape({ binding_kind: "connector", connector_id: "gmail" }), {
    id: "gmail",
    kind: "connector",
  });
  assert.deepEqual(parseSpineSourceShape({ binding_kind: "provider_native", provider_id: "apple" }), {
    id: "apple",
    kind: "provider_native",
  });
});

test("parseSpineSourceShape infers kind from an unambiguous single id", () => {
  assert.deepEqual(parseSpineSourceShape({ connector_id: "gmail" }), { id: "gmail", kind: "connector" });
  assert.deepEqual(parseSpineSourceShape({ provider_id: "apple" }), { id: "apple", kind: "provider_native" });
  // Ambiguous: both ids present without canonical/legacy discriminator -> null.
  assert.equal(parseSpineSourceShape({ connector_id: "g", provider_id: "a" }), null);
});

test("parseSpineSourceShape rejects non-object shapes", () => {
  assert.equal(parseSpineSourceShape(null), null);
  assert.equal(parseSpineSourceShape("x"), null);
  assert.equal(parseSpineSourceShape([{ id: "g", kind: "connector" }]), null);
});

test("deriveSpineSource prefers payload.source over source_binding and row", () => {
  const payload = {
    source: { id: "fromsource", kind: "connector" },
    source_binding: { id: "frombinding", kind: "connector" },
  };
  const row = { source_id: "fromrow", source_kind: "connector" };
  assert.deepEqual(deriveSpineSource(payload, row), { id: "fromsource", kind: "connector" });
});

test("deriveSpineSource falls back to row source_kind/source_id when payload has nothing", () => {
  assert.deepEqual(deriveSpineSource({}, { source_id: "apple", source_kind: "provider_native" }), {
    id: "apple",
    kind: "provider_native",
  });
});

test("deriveSpineSource treats runtime actor row as a connector source", () => {
  assert.deepEqual(deriveSpineSource({}, { actor_id: "gmail", actor_type: "runtime" }), {
    id: "gmail",
    kind: "connector",
  });
  // Non-runtime actor is not treated as a connector source.
  assert.equal(deriveSpineSource({}, { actor_id: "gmail", actor_type: "user" }), null);
});

test("deriveSpineSource returns null when no shape resolves", () => {
  assert.equal(deriveSpineSource(null, {}), null);
});
