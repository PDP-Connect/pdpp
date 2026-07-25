// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Focused self-check for the `noAwaitInLoops` conformance gate's duplicate
 * detection (`scripts/check-no-await-in-loops-conformance.ts`).
 *
 * Regression target: two identical allowlist rows for
 * `src/collector-runner.ts:1984:7` previously went unnoticed because the
 * gate folded both the allowlist and the live Biome findings straight into
 * a Set/Map, which silently collapses duplicates rather than reporting
 * them. Biome happens to emit that exact location twice for one real loop,
 * so the duplicate allowlist row's count "matched" and no discrepancy was
 * ever surfaced.
 *
 * These tests exercise the pure counting helper the gate's duplicate check
 * is built on (`countByLocationKey`) directly — not a full Biome run — so
 * they run fast and prove the failure mode is caught regardless of what
 * Biome currently reports.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { countByLocationKey, locationKey } from "../scripts/check-no-await-in-loops-conformance.ts";

test("countByLocationKey: unique locations each count 1, no key is dropped", () => {
  const entries = [
    { path: "a.ts", line: 1, column: 1 },
    { path: "a.ts", line: 2, column: 1 },
    { path: "b.ts", line: 1, column: 1 },
  ];
  const counts = countByLocationKey(entries);
  assert.equal(counts.size, 3, "three distinct locations must produce three keys");
  for (const entry of entries) {
    assert.equal(counts.get(locationKey(entry)), 1);
  }
});

test("countByLocationKey: a duplicated (path, line, column) reports count 2, not silently collapsed to 1", () => {
  const duplicateEntry = { path: "src/collector-runner.ts", line: 1984, column: 7 };
  const entries = [duplicateEntry, { ...duplicateEntry }, { path: "other.ts", line: 1, column: 1 }];
  const counts = countByLocationKey(entries);

  assert.equal(counts.size, 2, "two distinct location keys, even though three entries were provided");
  assert.equal(
    counts.get(locationKey(duplicateEntry)),
    2,
    "the duplicated location's count must be 2 — proving it is visible, not masked by a Set/Map that only tracks presence"
  );
});

test("mutation: an allowlist-shaped array with a duplicate row is caught by the same duplicate-detection logic the gate runs first", () => {
  // Mirrors the exact defect this test guards against: a checked-in
  // allowlist array with the same (path, line, column) listed twice.
  const mutatedAllowlist = [
    {
      path: "src/collector-runner.ts",
      line: 1984,
      column: 7,
      category: "shared_mutable_accumulator",
      note: "drainClaimedOutboxItem(): loop body mutates a shared accumulator the next iteration reads",
    },
    {
      path: "src/collector-runner.ts",
      line: 1984,
      column: 7,
      category: "shared_mutable_accumulator",
      note: "drainClaimedOutboxItem(): loop body mutates a shared accumulator the next iteration reads",
    },
    {
      path: "src/collector-runner.ts",
      line: 2484,
      column: 18,
      category: "shared_mutable_accumulator",
      note: "input.queue.dequeueReady(): loop body mutates a shared accumulator the next iteration reads",
    },
  ];

  // This is exactly the check scripts/check-no-await-in-loops-conformance.ts's
  // main() runs FIRST, before any live Biome invocation, precisely so a
  // duplicate allowlist row fails closed rather than being masked by a live
  // finding count that happens to add up.
  const allowlistKeyCounts = countByLocationKey(mutatedAllowlist);
  const duplicateAllowlistEntries = [...allowlistKeyCounts.entries()].filter(([, count]) => count > 1);

  assert.equal(
    duplicateAllowlistEntries.length,
    1,
    "the mutated allowlist has exactly one duplicated location key and the check must find it"
  );
  const [duplicate] = duplicateAllowlistEntries;
  assert.ok(duplicate, "expected one duplicate entry");
  const [duplicateKey, duplicateCount] = duplicate;
  assert.equal(duplicateKey, "src/collector-runner.ts:1984:7");
  assert.equal(duplicateCount, 2);
});

test("mutation: the real checked-in allowlist has zero duplicate location keys (regression guard)", async () => {
  const { NO_AWAIT_IN_LOOPS_ALLOWLIST } = await import("../scripts/no-await-in-loops-allowlist.ts");
  const counts = countByLocationKey(NO_AWAIT_IN_LOOPS_ALLOWLIST);
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1);
  assert.deepEqual(
    duplicates,
    [],
    "scripts/no-await-in-loops-allowlist.ts must not contain any duplicate (path, line, column) rows"
  );
});
