// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { createRepairBudget } from "./repair-budget.ts";

test("createRepairBudget: default max of 1 — first tryConsume() succeeds, every later call fails", () => {
  const budget = createRepairBudget();
  assert.equal(budget.tryConsume(), true);
  assert.equal(budget.tryConsume(), false);
  assert.equal(budget.tryConsume(), false);
});

test("createRepairBudget: sharing ONE instance across N callers caps total spends at maxAttempts regardless of caller count", () => {
  const budget = createRepairBudget(1);
  const results = Array.from({ length: 6 }, () => budget.tryConsume());
  assert.deepEqual(
    results,
    [true, false, false, false, false, false],
    "only the first of 6 independent callers spends the shared budget"
  );
});

test("createRepairBudget: constructing a FRESH budget per caller defeats the cap — the exact bug this primitive exists to prevent", () => {
  const perCallerResults = Array.from({ length: 6 }, () => createRepairBudget().tryConsume());
  assert.deepEqual(
    perCallerResults,
    [true, true, true, true, true, true],
    "a fresh instance per caller has no shared memory, so every caller gets its own full budget"
  );
});

test("createRepairBudget: maxAttempts > 1 allows exactly that many spends, then refuses", () => {
  const budget = createRepairBudget(3);
  assert.equal(budget.tryConsume(), true);
  assert.equal(budget.tryConsume(), true);
  assert.equal(budget.tryConsume(), true);
  assert.equal(budget.tryConsume(), false);
});
