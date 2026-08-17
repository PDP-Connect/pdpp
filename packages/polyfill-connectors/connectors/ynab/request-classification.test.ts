// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CollectContext } from "../../src/connector-runtime.ts";
import { isYnabRetryableError, ynabCollect } from "./index.ts";

test("YNAB request-budget enrichment failures preserve retryable classification", () => {
  assert.equal(isYnabRetryableError(new Error("ynab_rate_limited")), true);
  assert.equal(isYnabRetryableError(new Error("fetch failed")), true);
  assert.equal(isYnabRetryableError(new Error("ynab_http_503: retryable status 503")), true);
  assert.equal(isYnabRetryableError(new Error("ynab_http_400: invalid budget")), false);
});

test("YNAB transaction collection does not hide a rate-limited account-type enrichment request", async () => {
  const budgetId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const paths: string[] = [];
  const request = <T>(path: string): Promise<T> => {
    paths.push(path);
    if (path === "/budgets") {
      return Promise.resolve({ data: { budgets: [{ id: budgetId }] } } as T);
    }
    if (path === `/budgets/${budgetId}/accounts`) {
      throw new Error("ynab_rate_limited");
    }
    throw new Error(`unexpected fixture path: ${path}`);
  };
  const ctx: CollectContext = {
    assist: () => Promise.reject(new Error("not used")),
    capture: null,
    completeAssistance: () => Promise.resolve(),
    credentials: { YNAB_PERSONAL_ACCESS_TOKEN: "fixture-token" },
    detailGaps: [],
    emit: async () => undefined,
    emitRecord: async () => undefined,
    emittedAt: "2026-08-10T00:00:00Z",
    progress: async () => undefined,
    requestDetailGapPage: async () => [],
    requested: new Map([["transactions", { name: "transactions" }]]),
    scope: { streams: [{ name: "transactions" }] },
    sendInteraction: () => Promise.reject(new Error("not used")),
    state: {},
  };

  await assert.rejects(() => ynabCollect(ctx, request), /ynab_rate_limited/);
  assert.deepEqual(paths, ["/budgets", `/budgets/${budgetId}/accounts`]);
});
