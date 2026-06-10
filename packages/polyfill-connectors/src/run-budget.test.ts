import assert from "node:assert/strict";
import { test } from "node:test";
import { RunBudget } from "./run-budget.js";

test("RunBudget: no caps — never stops, tripReason always null", () => {
  const budget = new RunBudget();
  for (let i = 0; i < 100; i += 1) {
    budget.recordRequest();
  }
  assert.equal(budget.shouldStop(), false, "uncapped budget never stops");
  assert.equal(budget.tripReason(), null, "uncapped budget trip reason is null");
});

test("RunBudget: maxRequests cap trips on the Nth recordRequest()", () => {
  const budget = new RunBudget({ maxRequests: 2 });
  assert.equal(budget.tripReason(), null, "0 < 2: open");
  budget.recordRequest();
  assert.equal(budget.tripReason(), null, "1 < 2: open");
  budget.recordRequest();
  assert.equal(budget.tripReason(), "max_requests", "2 >= 2: tripped");
  assert.equal(budget.shouldStop(), true);
});

test("RunBudget: maxWallClockMs trips when elapsed >= cap", () => {
  let nowMs = 1000;
  const budget = new RunBudget({ maxWallClockMs: 500, now: () => nowMs });
  assert.equal(budget.tripReason(), null, "elapsed 0 < 500: open and clock anchored");
  nowMs = 1400;
  assert.equal(budget.tripReason(), null, "elapsed 400 < 500: open");
  nowMs = 1500;
  assert.equal(budget.tripReason(), "max_wall_clock", "elapsed 500 >= 500: tripped");
  assert.equal(budget.shouldStop(), true);
});

test("RunBudget: clock anchors lazily on first tripReason() call, not on construction", () => {
  let nowMs = 0;
  const budget = new RunBudget({ maxWallClockMs: 100, now: () => nowMs });
  // Advance clock before any tripReason() call — should not count
  nowMs = 5000;
  // First tripReason() anchors here at 5000
  assert.equal(budget.tripReason(), null, "anchored at 5000, elapsed=0");
  nowMs = 5099;
  assert.equal(budget.tripReason(), null, "elapsed 99 < 100: open");
  nowMs = 5100;
  assert.equal(budget.tripReason(), "max_wall_clock", "elapsed 100 >= 100: tripped");
});

test("RunBudget: request cap takes priority when both caps trip simultaneously", () => {
  let nowMs = 0;
  // Anchor clock, then advance it past the wall-clock budget, then add a request.
  // At the moment of the second tripReason() call both caps are tripped.
  const budget = new RunBudget({ maxRequests: 1, maxWallClockMs: 100, now: () => nowMs });
  // Anchor clock
  assert.equal(budget.tripReason(), null, "0 requests, 0ms elapsed: both open");
  // Trip wall-clock
  nowMs = 200;
  // Trip request cap too
  budget.recordRequest();
  // Both caps are tripped; request cap should be reported first
  assert.equal(budget.tripReason(), "max_requests", "request cap takes priority over wall-clock");
});

test("RunBudget: count tracks recorded requests", () => {
  const budget = new RunBudget({ maxRequests: 10 });
  assert.equal(budget.count, 0);
  budget.recordRequest();
  budget.recordRequest();
  assert.equal(budget.count, 2);
});

test("RunBudget: elapsedMs returns 0 before first tripReason() call", () => {
  const budget = new RunBudget({ now: () => 9999 });
  assert.equal(budget.elapsedMs(), 0, "no elapsed before anchor");
});
