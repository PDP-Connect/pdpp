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
