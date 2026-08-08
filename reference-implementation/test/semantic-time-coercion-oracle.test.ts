// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure-logic oracle for coerceSemanticTimeValue
// (server/record-ingest-semantic-time.ts), the epoch-aware timestamp coercion
// that stamps a record's semantic_time at ingest. It is pure but untested by
// name. The load-bearing boundary is the epoch ms-vs-seconds threshold
// (SEMANTIC_TIME_EPOCH_MS_THRESHOLD = 1e12): a number at/above it is treated as
// epoch MILLISECONDS, below it as epoch SECONDS (x1000). An ISO string passes
// through trimmed; anything non-positive / non-finite / non-string-non-number
// yields null so the caller stores SEMANTIC_TIME_UNKNOWN (absence) rather than
// backfilling ingest time. No DB. Sentinel handling is pinned separately in
// semantic-time-absence-oracle.test.ts.

import assert from "node:assert/strict";
import test from "node:test";
import { coerceSemanticTimeValue, SEMANTIC_TIME_EPOCH_MS_THRESHOLD } from "../server/semantic-time-coercion.ts";

test("the epoch ms/seconds threshold is 1e12", () => {
  assert.equal(SEMANTIC_TIME_EPOCH_MS_THRESHOLD, 1e12);
});

test("coerceSemanticTimeValue passes an ISO string through trimmed and nulls a blank string", () => {
  assert.equal(coerceSemanticTimeValue("2026-07-02T00:00:00Z"), "2026-07-02T00:00:00Z");
  assert.equal(coerceSemanticTimeValue("  2026-07-02  "), "2026-07-02");
  assert.equal(coerceSemanticTimeValue("   "), null);
});

test("coerceSemanticTimeValue treats a number below the threshold as epoch SECONDS", () => {
  // 1751414400 seconds and 1751414400000 ms are the SAME instant.
  const asSeconds = coerceSemanticTimeValue(1_751_414_400);
  const asMs = coerceSemanticTimeValue(1_751_414_400_000);
  assert.equal(asSeconds, asMs);
  assert.equal(asSeconds, new Date(1_751_414_400 * 1000).toISOString());
});

test("coerceSemanticTimeValue treats a value at the threshold as epoch MILLISECONDS", () => {
  // Exactly 1e12 is milliseconds (year 2001), NOT seconds (year 33658).
  const atThreshold = coerceSemanticTimeValue(1e12);
  assert.equal(atThreshold, new Date(1e12).toISOString());
  if (!atThreshold) {
    throw new Error("expected coerceSemanticTimeValue(1e12) to be non-null");
  }
  assert.equal(atThreshold.startsWith("2001-"), true);
  // Just below the threshold is seconds -> multiplied by 1000 -> far future.
  assert.equal(coerceSemanticTimeValue(1e12 - 1), new Date((1e12 - 1) * 1000).toISOString());
});

test("coerceSemanticTimeValue yields null for non-positive, non-finite, and non-string/number inputs", () => {
  assert.equal(coerceSemanticTimeValue(0), null);
  assert.equal(coerceSemanticTimeValue(-5), null);
  assert.equal(coerceSemanticTimeValue(Number.NaN), null);
  assert.equal(coerceSemanticTimeValue(Number.POSITIVE_INFINITY), null);
  assert.equal(coerceSemanticTimeValue(null), null);
  assert.equal(coerceSemanticTimeValue(undefined), null);
  assert.equal(coerceSemanticTimeValue({}), null);
  assert.equal(coerceSemanticTimeValue(true), null);
});
