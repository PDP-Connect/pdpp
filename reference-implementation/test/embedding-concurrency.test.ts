// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { intraOpNumThreadsForWorkLimit, resolveEmbeddingConcurrency } from "../server/embedding-concurrency.ts";

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

test("shipped Fly.io reference config (1 vCPU, 512MiB) resolves to workLimit=1 regardless of the ONNX-thread math", () => {
  const plan = resolveEmbeddingConcurrency(1, 512 * MIB);
  assert.equal(plan.workLimit, 1);
  assert.equal(plan.intraOpNumThreads, 1);
});

test("a memory-constrained target caps workLimit even with generous CPU", () => {
  // 8 CPUs would otherwise select workLimit=8, but ~1GiB only has room for
  // ~2 workers at the measured ~350MiB-per-worker + 150MiB parent budget.
  const plan = resolveEmbeddingConcurrency(8, 1 * GIB);
  assert.equal(plan.workLimit, 2);
  // The CPU budget (8) is still divided across the memory-capped workLimit
  // (2), not against the CPU-only step (8) — cooperating threads, not an
  // unused higher number.
  assert.equal(plan.intraOpNumThreads, 4);
});

test("a generous target (24 CPU, 124GiB) never exceeds the measured concurrency ceiling of 8", () => {
  const plan = resolveEmbeddingConcurrency(24, 124 * GIB);
  assert.equal(plan.workLimit, 8);
  assert.equal(plan.intraOpNumThreads, 3);
});

test("workLimit * intraOpNumThreads never exceeds the CPU budget, for every CPU count 1-24", () => {
  for (let cpu = 1; cpu <= 24; cpu += 1) {
    const plan = resolveEmbeddingConcurrency(cpu, 128 * GIB);
    assert.ok(
      plan.workLimit * plan.intraOpNumThreads <= cpu,
      `cpu=${cpu}: workLimit(${plan.workLimit}) * intraOpNumThreads(${plan.intraOpNumThreads}) exceeds budget`
    );
  }
});

test("workLimit is always >= 1 and intraOpNumThreads is always >= 1, even for a sub-1-core budget", () => {
  const plan = resolveEmbeddingConcurrency(0.0625, 512 * MIB);
  assert.equal(plan.workLimit, 1);
  assert.equal(plan.intraOpNumThreads, 1);
});

test("a near-zero memory budget still returns workLimit=1, never zero", () => {
  const plan = resolveEmbeddingConcurrency(8, 10 * MIB);
  assert.equal(plan.workLimit, 1);
});

test("intraOpNumThreadsForWorkLimit divides the SAME cpu budget an explicit override actually runs at", () => {
  // An operator who overrides PDPP_LOCAL_TRANSFORMER_WORK_LIMIT away from
  // this module's own derived default must still get threads sized to
  // whatever workLimit is ACTUALLY in effect, not to the unused default.
  assert.equal(intraOpNumThreadsForWorkLimit(1, 8), 8);
  assert.equal(intraOpNumThreadsForWorkLimit(2, 8), 4);
  assert.equal(intraOpNumThreadsForWorkLimit(8, 8), 1);
});

test("intraOpNumThreadsForWorkLimit floors and never returns less than 1", () => {
  assert.equal(intraOpNumThreadsForWorkLimit(5, 8), 1);
  assert.equal(intraOpNumThreadsForWorkLimit(100, 8), 1);
});

test("workLimit is always a member of {1,2,4,8} when memory is the binding constraint at a non-step raw worker count", () => {
  // Regression for a real (non-blocking, but genuine) gap an independent
  // review found: this module used to snap ONLY the CPU-derived candidate
  // through concurrencyStepFor before the min(), leaving the memory-derived
  // candidate as a raw Math.floor(...) value. Whenever memory was the
  // tighter constraint and its raw count landed on a non-step value (3, 5,
  // 6, 7, ...), the resulting workLimit was itself non-step — safe (proven
  // separately: the semaphore, not the executor, is always the binding
  // outer gate, so the mismatch could only manifest as unused executor
  // headroom) but not the exact agreement the two derivation call sites
  // are supposed to have. cpu=4, mem=1200MiB is the report's own worked
  // example: raw memoryAllowedWorkers floor((1200-150)/350) = 3 (non-step)
  // prior to this fix; workLimit must land on 2 (the nearest step at or
  // below 3), not 3.
  const plan = resolveEmbeddingConcurrency(4, 1200 * MIB);
  assert.equal(plan.workLimit, 2);
  assert.ok([1, 2, 4, 8].includes(plan.workLimit));
});

test("workLimit snaps to a step value for every raw memory-derived worker count in {3,5,6,7}, not just the pre-fix example", () => {
  // Sweeps every non-step integer in [3,8) that PER_WORKER_MEMORY_BUDGET_BYTES
  // can actually produce via Math.floor -- 4 and 8 are already step values
  // and covered by the other tests in this file, so the interesting cases
  // are exactly the non-step raw counts. A generous CPU budget (64) is used
  // so CPU never becomes the binding constraint here; only the memory path
  // is under test.
  const PARENT_BASELINE_MEMORY_BYTES = 150 * MIB;
  const PER_WORKER_MEMORY_BUDGET_BYTES = 350 * MIB;
  const cases = [
    { expected: 2, raw: 3 },
    { expected: 4, raw: 5 },
    { expected: 4, raw: 6 },
    { expected: 4, raw: 7 },
  ];
  for (const { expected, raw } of cases) {
    // +1 byte to land safely inside the floor() bucket for `raw`, away from
    // its lower boundary.
    const memoryBudgetBytes = PARENT_BASELINE_MEMORY_BYTES + raw * PER_WORKER_MEMORY_BUDGET_BYTES + 1;
    const plan = resolveEmbeddingConcurrency(64, memoryBudgetBytes);
    assert.ok(
      [1, 2, 4, 8].includes(plan.workLimit),
      `raw=${raw}: workLimit(${plan.workLimit}) is not a member of {1,2,4,8}`
    );
    assert.equal(
      plan.workLimit,
      expected,
      `raw=${raw}: expected workLimit to snap down to ${expected}, got ${plan.workLimit}`
    );
  }
});

test("workLimit is always a member of {1,2,4,8} across a broad cpu x memory sweep, whichever side binds", () => {
  const MEMORY_BUDGETS_MIB = [128, 300, 512, 700, 900, 1200, 1550, 1900, 2250, 2600, 2950, 4096, 8192, 16_384];
  for (let cpu = 1; cpu <= 16; cpu += 1) {
    for (const memMib of MEMORY_BUDGETS_MIB) {
      const plan = resolveEmbeddingConcurrency(cpu, memMib * MIB);
      assert.ok(
        [1, 2, 4, 8].includes(plan.workLimit),
        `cpu=${cpu}, mem=${memMib}MiB: workLimit(${plan.workLimit}) is not a member of {1,2,4,8}`
      );
    }
  }
});
