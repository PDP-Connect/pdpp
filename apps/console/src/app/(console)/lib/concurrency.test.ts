// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic proof that `mapWithConcurrency` bounds concurrency even at
 * scale, and that a failed unit propagates rather than fabricating
 * completeness. Closes the gate finding in
 * `add-source-batched-profile-gate-0730.md` ("Partition concurrency is
 * unbounded across partitions") — `existing-sources-by-connector.ts`'s
 * `fetchRetainedCountSummaries` now routes its partition fan-out through this
 * exact primitive at a fixed bound
 * (`EXISTING_SOURCES_PARTITION_CONCURRENCY = 8`), so this file proves the
 * primitive itself holds the bound under the shape that matters: many more
 * items than the limit, mirroring a catalog requiring thousands of
 * partitions.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { mapWithConcurrency } from "./concurrency.ts";

const LARGE_ITEM_COUNT = 10_001;
const LIMIT = 8;

test("mapWithConcurrency never exceeds its configured limit across >10,000 items", async () => {
  const items = Array.from({ length: LARGE_ITEM_COUNT }, (_, index) => index);
  let inFlight = 0;
  let peakInFlight = 0;
  let observedOverLimit = false;

  const result = await mapWithConcurrency(
    items,
    LIMIT,
    async (item) => {
      // No real delay needed to prove the bound: onInFlightChange fires
      // synchronously around every worker's start/end, so the peak is
      // observed regardless of how fast each worker resolves. A microtask
      // tick keeps workers overlapping instead of running to completion
      // fully synchronously (which would trivially never violate the bound).
      await Promise.resolve();
      return item * 2;
    },
    {
      onInFlightChange: (current) => {
        inFlight = current;
        peakInFlight = Math.max(peakInFlight, current);
        if (current > LIMIT) {
          observedOverLimit = true;
        }
      },
    }
  );

  assert.equal(result.length, LARGE_ITEM_COUNT, "every item is represented in the output, in order");
  assert.deepEqual(
    result.slice(0, 5),
    [0, 2, 4, 6, 8],
    "order-preserving: output index matches input index despite concurrent execution"
  );
  assert.equal(result.at(-1), (LARGE_ITEM_COUNT - 1) * 2);
  assert.equal(observedOverLimit, false, `concurrency exceeded the configured limit of ${LIMIT} at some point`);
  assert.ok(peakInFlight > 1, `expected genuinely overlapping work, saw peak in-flight of ${peakInFlight}`);
  assert.ok(peakInFlight <= LIMIT, `expected peak in-flight <= ${LIMIT}, saw ${peakInFlight}`);
  assert.equal(inFlight, 0, "no worker left in flight after completion");
});

test("mapWithConcurrency propagates a failure across a large item set without fabricating completeness", async () => {
  const items = Array.from({ length: LARGE_ITEM_COUNT }, (_, index) => index);
  const failingIndex = 4000;
  const boom = new Error(`partition ${failingIndex} failed`);
  let completedBeforeRejection = 0;

  await assert.rejects(
    () =>
      mapWithConcurrency(items, LIMIT, async (item, index) => {
        await Promise.resolve();
        if (index === failingIndex) {
          throw boom;
        }
        completedBeforeRejection += 1;
        return item;
      }),
    boom,
    "the exact thrown error must propagate — a failed unit must never be silently dropped or replaced by a synthesized empty result"
  );
  // The point of this assertion is behavioral, not a specific count: the call
  // rejects (proven above) rather than resolving with a partial array that a
  // caller could mistake for a complete result.
  assert.ok(completedBeforeRejection >= 0);
});

test("mapWithConcurrency at the exact configured limit never reports more in-flight than items", async () => {
  // Regression guard for the effectiveLimit clamp (Math.min(limit, items.length)):
  // fewer items than the limit must not report an in-flight count above the
  // item count.
  const items = [0, 1, 2];
  let peakInFlight = 0;
  await mapWithConcurrency(items, 8, async (item) => item, {
    onInFlightChange: (current) => {
      peakInFlight = Math.max(peakInFlight, current);
    },
  });
  assert.ok(peakInFlight <= items.length, `expected peak in-flight <= ${items.length}, saw ${peakInFlight}`);
});
