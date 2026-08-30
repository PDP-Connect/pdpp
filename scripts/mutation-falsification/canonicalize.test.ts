// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeJSON, digestOf, isHexDigest, sha256Hex } from "./canonicalize.ts";

test("canonicalizeJSON: sorts object keys by UTF-16 code unit regardless of insertion order", () => {
  const insertedBFirst = { b: 2, a: 1 };
  const insertedAFirst = { a: 1, b: 2 };
  assert.equal(canonicalizeJSON(insertedBFirst), canonicalizeJSON(insertedAFirst));
  assert.equal(canonicalizeJSON(insertedBFirst), '{"a":1,"b":2}');
});

test("canonicalizeJSON: nested objects and arrays canonicalize with sorted keys at every level", () => {
  const value = { arr: [3, 1, 2], nested: { z: null, inner: true } };
  assert.equal(canonicalizeJSON(value), '{"arr":[3,1,2],"nested":{"inner":true,"z":null}}');
});

test("canonicalizeJSON: array element order is preserved (not sorted)", () => {
  assert.equal(canonicalizeJSON([3, 1, 2]), "[3,1,2]");
});

test("canonicalizeJSON: strings escape exactly like JSON, including unicode", () => {
  const value = { emoji: "🎉", greeting: 'hi\nthere "quoted"' };
  assert.equal(canonicalizeJSON(value), '{"emoji":"🎉","greeting":"hi\\nthere \\"quoted\\""}');
});

test("canonicalizeJSON: booleans and null serialize literally", () => {
  assert.equal(canonicalizeJSON({ t: true, f: false, n: null }), '{"f":false,"n":null,"t":true}');
});

test("canonicalizeJSON: negative zero canonicalizes as 0, matching ECMA-262 Number::toString", () => {
  assert.equal(canonicalizeJSON(-0), "0");
  assert.equal(canonicalizeJSON({ z: -0 }), '{"z":0}');
});

test("canonicalizeJSON: large-magnitude numbers use ECMA-262 exponential formatting", () => {
  assert.equal(canonicalizeJSON(1e21), "1e+21");
  assert.equal(canonicalizeJSON(1.5), "1.5");
});

test("canonicalizeJSON: non-finite numbers are rejected (JSON has no NaN/Infinity)", () => {
  assert.throws(() => canonicalizeJSON(Number.NaN));
  assert.throws(() => canonicalizeJSON(Number.POSITIVE_INFINITY));
});

test("canonicalizeJSON: undefined object values are dropped, matching JSON.stringify", () => {
  assert.equal(canonicalizeJSON({ a: 1, b: undefined }), '{"a":1}');
});

test("canonicalizeJSON: undefined array entries become null, matching JSON.stringify", () => {
  assert.equal(canonicalizeJSON([1, undefined, 3]), "[1,null,3]");
});

test("canonicalizeJSON: rejects a bare top-level undefined", () => {
  assert.throws(() => canonicalizeJSON(undefined));
});

// ── Golden vectors: hand-computed with `node -e` against node:crypto's
// sha256, independent of this file's own implementation, so these tests
// cannot pass merely because digestOf is self-consistent with itself. ──

test("golden vector A: sha256 of a simple two-key canonical object", () => {
  const value = { b: 2, a: 1 };
  assert.equal(canonicalizeJSON(value), '{"a":1,"b":2}');
  assert.equal(digestOf(value), "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777");
});

test("golden vector B: sha256 of a nested object with an array, unsorted source key order", () => {
  const value = { nested: { z: null, inner: true }, arr: [3, 1, 2] };
  assert.equal(canonicalizeJSON(value), '{"arr":[3,1,2],"nested":{"inner":true,"z":null}}');
  assert.equal(digestOf(value), "b3d346063f3dccbe4fa7ab0ca8402cb7d3de2325b5c9fcb724e4ef3b0c9acb1a");
});

test("golden vector C: sha256 of a string-escaping and unicode payload", () => {
  const value = { greeting: 'hi\nthere "quoted"', emoji: "🎉" };
  assert.equal(canonicalizeJSON(value), '{"emoji":"🎉","greeting":"hi\\nthere \\"quoted\\""}');
  assert.equal(digestOf(value), "569fd2453ca4b0f4e29a04ea11243ed68ade367bc9b9f7b46dacec5a303dac2a");
});

test("sha256Hex: matches a directly hand-computed digest of a fixed string", () => {
  // sha256("hello") — a widely known, independently verifiable test vector.
  assert.equal(sha256Hex("hello"), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
});

test("digestOf: stable under key reordering (integrity is over the canonical form, not source order)", () => {
  assert.equal(digestOf({ a: 1, b: 2, c: 3 }), digestOf({ c: 3, a: 1, b: 2 }));
});

test("isHexDigest: accepts a 64-character lowercase hex string and rejects everything else", () => {
  assert.ok(isHexDigest("a".repeat(64)));
  assert.ok(!isHexDigest("A".repeat(64)));
  assert.ok(!isHexDigest("a".repeat(63)));
  assert.ok(!isHexDigest(123));
  assert.ok(!isHexDigest(null));
});
