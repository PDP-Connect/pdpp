// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { runFactsCacheKey } from "../server/ref-control.ts";

test("owner collection-rate facts do not cross-contaminate duplicate run ids", () => {
  const cache = new Map<string, { collection_rate: { records_per_sec: number } }>();
  const runId = "run_duplicate_owner_fact";
  const instanceA = "cin_owner_a";
  const instanceB = "cin_owner_b";

  cache.set(runFactsCacheKey(runId, instanceA), { collection_rate: { records_per_sec: 5 } });
  cache.set(runFactsCacheKey(runId, instanceB), { collection_rate: { records_per_sec: 11 } });

  assert.equal(cache.get(runFactsCacheKey(runId, instanceA))?.collection_rate.records_per_sec, 5);
  assert.equal(cache.get(runFactsCacheKey(runId, instanceB))?.collection_rate.records_per_sec, 11);
});
