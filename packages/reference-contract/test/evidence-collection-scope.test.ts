// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildScopedCoverageClaim,
  type CollectionScope,
  classifyStreamScope,
  collectionScopeFingerprint,
  normalizeCollectionScope,
  scopeProofRemainsValid,
} from "../src/evidence/index.ts";

const TIMED: { consent_time_field: string } = { consent_time_field: "started_at" };
const UNTIMED: { consent_time_field: null } = { consent_time_field: null };

const SINCE_JUNE: CollectionScope = { since: "2026-06-01T00:00:00Z" };
const SINCE_JULY: CollectionScope = { since: "2026-07-01T00:00:00Z" };

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /^\s*\/\/.*$/gm;
const IMPORT_KEYWORD = /\bimport\b/;
const REQUIRE_CALL = /\brequire\s*\(/;

test("an unscoped boundary normalizes to null, and empty bounds are not a boundary", () => {
  assert.equal(normalizeCollectionScope(null), null);
  assert.equal(normalizeCollectionScope({}), null);
  assert.equal(normalizeCollectionScope({ since: "   ", source_roots: [] }), null);
});

test("an unparseable since is rejected rather than becoming a boundary that matches everything", () => {
  assert.equal(normalizeCollectionScope({ since: "last tuesday" }), null);
});

test("canonicalization makes a no-op edit produce the same fingerprint", () => {
  const a = collectionScopeFingerprint({ since: "2026-06-01T00:00:00Z", source_roots: ["b", "a"] });
  const b = collectionScopeFingerprint({ source_roots: ["a", "b", "a"], since: "  2026-06-01T00:00:00Z  " });
  assert.equal(a, b, "duplicate/reordered roots and padded bounds must not invalidate valid proof");
});

test("unscoped is a real fingerprint, not an absence", () => {
  // A full-corpus pass is itself a declared boundary; introducing a bound later
  // has to be detectable as a change.
  assert.equal(collectionScopeFingerprint(null), "unscoped");
  assert.equal(scopeProofRemainsValid(null, SINCE_JUNE), false);
});

// (d) a scope change INVALIDATES prior proof
test("proof measured under one boundary does not carry to a different boundary", () => {
  assert.equal(scopeProofRemainsValid(SINCE_JUNE, SINCE_JUNE), true);
  assert.equal(scopeProofRemainsValid(SINCE_JUNE, SINCE_JULY), false);
  assert.equal(
    scopeProofRemainsValid({ since: "2026-06-01T00:00:00Z" }, { since: "2026-06-01T00:00:00Z", source_roots: ["x"] }),
    false,
    "adding a root narrows the region; prior wider proof does not describe it"
  );
});

test("wider prior proof is NOT reinterpreted as proof of a narrower boundary", () => {
  // The wider run enforced a different emission filter and produced a different
  // coverage set. Containment reasoning here would be reinterpretation, not
  // measurement.
  assert.equal(scopeProofRemainsValid(SINCE_JUNE, { since: "2026-06-15T00:00:00Z" }), false);
});

// (c) out-of-scope data is NOT claimed as covered
test("a stream the manifest gives no time field is never claimed as covering a declared since", () => {
  assert.equal(classifyStreamScope(SINCE_JUNE, UNTIMED), "unscopable_time");
  const claim = buildScopedCoverageClaim({
    declared: SINCE_JUNE,
    declaration: UNTIMED,
    measured: SINCE_JUNE,
    stream: "skills",
  });
  assert.equal(
    claim.covers_declared_scope,
    false,
    "an unscopable stream holds real data but proves nothing about the declared bound"
  );
  assert.equal(claim.classification, "unscopable_time");
});

test("a stream with a manifest time field carries the declared boundary on its claim", () => {
  assert.equal(classifyStreamScope(SINCE_JUNE, TIMED), "scoped");
  const claim = buildScopedCoverageClaim({
    declared: SINCE_JUNE,
    declaration: TIMED,
    measured: SINCE_JUNE,
    stream: "sessions",
  });
  assert.equal(claim.covers_declared_scope, true);
  assert.equal(claim.measured_scope, "since=2026-06-01T00:00:00Z", "stored proof states what it covers");
});

test("a stale claim measured under an old boundary stops covering the declared one", () => {
  const claim = buildScopedCoverageClaim({
    declared: SINCE_JULY,
    declaration: TIMED,
    measured: SINCE_JUNE,
    stream: "sessions",
  });
  assert.equal(claim.covers_declared_scope, false);
  assert.equal(claim.measured_scope, "since=2026-06-01T00:00:00Z", "the claim still reports what it DID measure");
});

test("a roots-only boundary applies to every enumerated stream, timed or not", () => {
  const rootsOnly: CollectionScope = { source_roots: ["proj-a"] };
  assert.equal(classifyStreamScope(rootsOnly, UNTIMED), "scoped");
  assert.equal(classifyStreamScope(rootsOnly, TIMED), "scoped");
});

test("no declared boundary classifies every stream as unscoped", () => {
  assert.equal(classifyStreamScope(null, UNTIMED), "unscoped");
  assert.equal(classifyStreamScope(null, TIMED), "unscoped");
});

test("the module stays a pure zero-I/O leaf", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/evidence/collection-scope.ts", import.meta.url)), "utf8")
    .replace(BLOCK_COMMENT, "")
    .replace(LINE_COMMENT, "");
  assert.equal(IMPORT_KEYWORD.test(source), false, "collection-scope must import nothing");
  assert.equal(REQUIRE_CALL.test(source), false, "collection-scope must not require anything");
});
