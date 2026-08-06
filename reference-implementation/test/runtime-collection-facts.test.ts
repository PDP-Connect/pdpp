// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { parseCollectionRatePayload } from "../server/runtime-collection-facts.ts";

const baseRate = {
  ceiling_interval_ms: 60_000,
  ceiling_rate_per_min: 60,
  current_interval_ms: 1000,
  effective_rate_per_min: 30,
  object: "collection_rate",
};

test("collection-rate reader treats missing or malformed backoff as honest null", () => {
  const malformedBackoffs: unknown[] = [
    undefined,
    null,
    {},
    { reason: "throttle" },
    { at_interval_ms: Number.NaN, reason: "throttle" },
    { at_interval_ms: 1000 },
    [],
    "throttle",
  ];

  for (const last_backoff of malformedBackoffs) {
    const parsed = parseCollectionRatePayload({ ...baseRate, last_backoff });
    assert.deepEqual(parsed?.last_backoff, null, `malformed backoff should be ignored: ${String(last_backoff)}`);
  }
});

test("collection-rate reader preserves a complete backoff", () => {
  const parsed = parseCollectionRatePayload({
    ...baseRate,
    last_backoff: { at_interval_ms: 1000, reason: "throttle" },
  });
  assert.ok(parsed);
  assert.equal(parsed.ceiling_interval_ms, 60_000);
  assert.deepEqual(parsed.last_backoff, { at_interval_ms: 1000, reason: "throttle" });
});
