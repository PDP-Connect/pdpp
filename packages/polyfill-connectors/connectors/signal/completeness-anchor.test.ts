// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Completeness-anchor tests for the Signal connector.
 *
 * Two concerns, deliberately tested apart:
 *
 *  1. `validateSourceTotal` — the fail-closed guard on the source-measured
 *     row total. A missing or malformed count must THROW, never silently
 *     become zero (which would read as "proven empty").
 *
 *  2. `parseEmittedIds` / `mergeEmittedIds` — the durable emitted-id cursor
 *     that makes the below-watermark backfill check a SET comparison. The
 *     set is the whole point: a scalar count of the same facts is a
 *     tautology (`sourceTotal - belowWatermark` IS the in-window row count
 *     when both are read from one database in one instant), and it also
 *     cannot tell an upstream deletion from a real gap. PDPP retains
 *     records the source deletes, so held-but-gone-upstream must never
 *     alarm.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeEmittedIds, parseEmittedIds, validateSourceTotal } from "./index.ts";

// ─── validateSourceTotal: fail closed ────────────────────────────────────

test("validateSourceTotal accepts a normal non-negative integer", () => {
  assert.equal(validateSourceTotal(4739, "messages"), 4739);
});

test("validateSourceTotal accepts a proven-empty zero", () => {
  assert.equal(validateSourceTotal(0, "messages"), 0);
});

test("validateSourceTotal throws on undefined rather than defaulting to zero", () => {
  assert.throws(() => validateSourceTotal(undefined, "messages"), /signal_source_total_not_number/);
});

test("validateSourceTotal throws on null rather than defaulting to zero", () => {
  assert.throws(() => validateSourceTotal(null, "messages"), /signal_source_total_not_number/);
});

test("validateSourceTotal throws on a string count", () => {
  assert.throws(() => validateSourceTotal("4739", "messages"), /signal_source_total_not_number/);
});

test("validateSourceTotal throws on NaN", () => {
  assert.throws(() => validateSourceTotal(Number.NaN, "messages"), /signal_source_total_not_finite/);
});

test("validateSourceTotal throws on Infinity", () => {
  assert.throws(() => validateSourceTotal(Number.POSITIVE_INFINITY, "messages"), /signal_source_total_not_finite/);
});

test("validateSourceTotal throws on a fractional count", () => {
  assert.throws(() => validateSourceTotal(12.5, "messages"), /signal_source_total_not_integer/);
});

test("validateSourceTotal throws on a negative count", () => {
  assert.throws(() => validateSourceTotal(-1, "messages"), /signal_source_total_negative/);
});

test("validateSourceTotal names the failing measurement in the error", () => {
  assert.throws(() => validateSourceTotal(undefined, "messages_below_watermark"), /messages_below_watermark/);
});

// ─── parseEmittedIds: tolerant read, safe default ────────────────────────

test("parseEmittedIds reads a normal id array", () => {
  const parsed = parseEmittedIds(["a", "b", "c"]);
  assert.deepEqual([...parsed].sort(), ["a", "b", "c"]);
});

test("parseEmittedIds returns an empty set for a legacy cursor with no id list", () => {
  assert.equal(parseEmittedIds(undefined).size, 0);
});

test("parseEmittedIds returns an empty set for a malformed (non-array) value", () => {
  assert.equal(parseEmittedIds({ nope: true }).size, 0);
  assert.equal(parseEmittedIds("a,b,c").size, 0);
});

test("parseEmittedIds drops non-string and empty entries rather than trusting them", () => {
  const parsed = parseEmittedIds(["a", 7, null, "", "b"]);
  assert.deepEqual([...parsed].sort(), ["a", "b"]);
});

test("parseEmittedIds dedupes repeated ids", () => {
  assert.equal(parseEmittedIds(["a", "a", "a"]).size, 1);
});

// ─── mergeEmittedIds: carry forward, bounded ─────────────────────────────

test("mergeEmittedIds carries prior ids forward alongside this run's", () => {
  const merged = mergeEmittedIds(new Set(["old1", "old2"]), ["new1"]);
  assert.deepEqual([...merged].sort(), ["new1", "old1", "old2"]);
});

test("mergeEmittedIds keeps an empty prior set intact on a cold start", () => {
  assert.deepEqual(mergeEmittedIds(new Set(), ["a", "b"]), ["a", "b"]);
});

test("mergeEmittedIds truncates to the newest ids when the cursor cap binds", () => {
  // 200_000 is the cap; build one over it and assert the OLDEST are dropped,
  // never the newest — the watermark advances, so the newest ids are the
  // ones a backfill check still needs.
  const prior = new Set<string>();
  for (let i = 0; i < 200_000; i += 1) {
    prior.add(`old${String(i)}`);
  }
  const merged = mergeEmittedIds(prior, ["newest1", "newest2"]);
  assert.equal(merged.length, 200_000);
  assert.equal(merged.at(-1), "newest2");
  assert.equal(merged.at(-2), "newest1");
  assert.equal(merged.includes("old0"), false, "oldest id must be the one dropped");
  assert.equal(merged.includes("old1"), false, "second-oldest id must be dropped");
});

test("mergeEmittedIds does not truncate below the cap", () => {
  const merged = mergeEmittedIds(new Set(["a"]), ["b", "c"]);
  assert.equal(merged.length, 3);
});

// ─── The set-vs-count property this design exists for ────────────────────

test("a set difference reports a below-watermark backfill that a count cannot see", () => {
  // Source ids at or below the watermark after a re-link backfill added
  // three OLD messages. A count of the same instant is blind to this: the
  // backfill raises both the source total and the below-watermark count by
  // three, so `total - below` is unchanged.
  const sourceBelowWatermark = ["m1", "m2", "m3", "backfilled1", "backfilled2", "backfilled3"];
  const priorEmitted = new Set(["m1", "m2", "m3"]);

  const unreachable = sourceBelowWatermark.filter((id) => !priorEmitted.has(id));
  assert.deepEqual(unreachable, ["backfilled1", "backfilled2", "backfilled3"]);

  // The count view of the very same facts, showing it cannot fire.
  const totalBefore = 3 + 10; // 3 below-watermark + 10 in-window
  const belowBefore = 3;
  const totalAfter = 6 + 10;
  const belowAfter = 6;
  assert.equal(totalBefore - belowBefore, totalAfter - belowAfter, "the count check is blind to the backfill");
});

test("an id present in holdings but deleted upstream produces no finding", () => {
  // Preservation: PDPP keeps records the source later deletes. The check is
  // one-directional by construction — it only asks which SOURCE ids were
  // never emitted, so a vanished id simply is not in the source list.
  const sourceBelowWatermark = ["m1", "m3"]; // m2 deleted from Signal Desktop
  const priorEmitted = new Set(["m1", "m2", "m3"]);

  const unreachable = sourceBelowWatermark.filter((id) => !priorEmitted.has(id));
  assert.deepEqual(unreachable, [], "an upstream deletion must never be reported as a gap");
});
